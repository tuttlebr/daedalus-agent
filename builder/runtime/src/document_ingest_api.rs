//! Public JSON and SSE ingestion, sharing the owned batch/document lifecycle.
use crate::{
    App,
    document_batch::{self, Progress},
    document_index,
    document_processor::{self, FAILED},
    memory_api::{actor, detail, read_body},
};
use axum::{
    Json, Router,
    body::Body,
    extract::{Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use std::{convert::Infallible, sync::Arc};
use tokio::sync::mpsc;

struct BatchTask(tokio::task::JoinHandle<()>);
impl Drop for BatchTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub fn routes() -> Router<App> {
    let mut router = Router::new();
    for path in ["/v1/documents/ingest", "/v1/documents/ingest/stream"] {
        router = router
            .route(path, any(handle))
            .route(&format!("{path}/"), any(handle));
    }
    router
}
fn respond((status, body): (u16, Value)) -> Response {
    (StatusCode::from_u16(status).unwrap(), Json(body)).into_response()
}
fn complete(output: String, collection: &str, total: usize) -> Value {
    json!({"status":document_index::classify(&output),"collection":collection,"documents":total,"output":output})
}
fn frame(event: &str, payload: &Value) -> bytes::Bytes {
    format!(
        "event: {event}\ndata: {}\n\n",
        crate::memory_tools::json_text(payload, false, false, true)
    )
    .into()
}
fn progress_payload(event: Value, total: usize) -> Value {
    json!({
        "completed":event["completed"].as_u64().unwrap_or(0),
        "total":event["total"].as_u64().filter(|n| *n != 0).unwrap_or(total as u64),
        "current":event["current"], "currentIndex":event["currentIndex"],
        "percent":event["percent"].as_u64().unwrap_or(0),
        "phase":event["phase"].as_str().filter(|s| !s.is_empty()).unwrap_or("processing"),
        "message":event["message"], "chunks":event["chunks"], "pages":event["pages"],
        "failures":event["failures"], "attempt":event["attempt"],
    })
}
async fn ingest(
    preparation: Arc<crate::preparation::Preparation>,
    request: document_batch::Request,
    callback: Option<Progress>,
) -> anyhow::Result<String> {
    let processor = preparation
        .documents
        .get_or_try_init(|| async {
            document_processor::Processor::new(&preparation.config).map(Arc::new)
        })
        .await?
        .clone();
    processor.ingest(request, callback).await
}
fn streaming(
    preparation: Arc<crate::preparation::Preparation>,
    request: document_batch::Request,
    collection: String,
    total: usize,
) -> Response {
    let queued = frame(
        "progress",
        &json!({"completed":0,"total":total,"current":null,"currentIndex":null,"percent":0,"phase":"queued",
        "message":format!("Queued {total} document{} for ingestion",if total==1 {""} else {"s"})}),
    );
    let (sender, receiver) = mpsc::unbounded_channel::<Option<bytes::Bytes>>();
    let callback: Progress = {
        let sender = sender.clone();
        Arc::new(move |event| {
            // The retained HTTP supervisor configures only its own logger.
            // The SDK's INFO-level indexing hook is therefore absent from the
            // public SSE stream, though it exists in internal runner progress.
            if event["phase"] == "indexing" {
                return Box::pin(async { Ok(()) });
            }
            let sent = sender.send(Some(frame("progress", &progress_payload(event, total))));
            Box::pin(async move { sent.map_err(|_| anyhow::anyhow!("Ingestion stream closed")) })
        })
    };
    let work = Box::pin(async move {
        let event = match ingest(preparation, request, Some(callback)).await {
            Ok(output) => frame("complete", &complete(output, &collection, total)),
            Err(_) => {
                tracing::warn!("Document ingestion stream failed");
                frame("error", &json!({"detail":FAILED}))
            }
        };
        let _ = sender.send(Some(event));
        let _ = sender.send(None);
    }) as BoxFuture<'static, ()>;
    // Start after the initial queued frame, then run independently of client
    // read speed, as the retained endpoint does. The body owns an abort guard:
    // disconnects cancel queued work while document_ownership retains a started
    // pipeline and its collection lock.
    let stream = futures::stream::unfold(
        (Some(queued), receiver, Some(work), None::<BatchTask>),
        |mut state| async move {
            if let Some(queued) = state.0.take() {
                return Some((Ok::<_, Infallible>(queued), state));
            }
            if let Some(work) = state.2.take() {
                state.3 = Some(BatchTask(tokio::spawn(work)));
            }
            state
                .1
                .recv()
                .await
                .flatten()
                .map(|event| (Ok(event), state))
        },
    );
    (
        [
            ("Content-Type", "text/event-stream; charset=utf-8"),
            ("Cache-Control", "no-cache"),
            ("Connection", "keep-alive"),
            ("X-Accel-Buffering", "no"),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}
async fn handle(State(app): State<App>, request: Request) -> Response {
    let Some(preparation) = app.preparation.as_ref() else {
        return crate::proxy(State(app), request).await;
    };
    let user = match actor(&app, request.headers()) {
        Ok(user) => user,
        Err(error) => return respond(error),
    };
    if request.uri().path().ends_with('/') {
        let target = format!(
            "{}{}",
            request.uri().path().trim_end_matches('/'),
            request
                .uri()
                .query()
                .map(|q| format!("?{q}"))
                .unwrap_or_default()
        );
        return axum::response::Redirect::temporary(&target).into_response();
    }
    if request.method() != Method::POST {
        let mut response = respond(detail(405, "Method Not Allowed"));
        response
            .headers_mut()
            .insert("Allow", "POST".parse().unwrap());
        return response;
    }
    let stream = request.uri().path().ends_with("/stream");
    let (parts, body) = request.into_parts();
    let input = match read_body(&parts.headers, body)
        .await
        .and_then(|body| document_index::validate(&body))
    {
        Ok(input) => input,
        Err(error) => return respond(error),
    };
    let limit = match document_processor::integer(
        &preparation.config,
        "DOCUMENT_INGEST_REQUEST_LIMIT",
        500,
    ) {
        Ok(limit) => limit,
        Err(_) => return respond(detail(500, FAILED)),
    };
    let default_collection = preparation
        .config
        .variable("DOCUMENT_INGEST_DEFAULT_COLLECTION", "user_uploads");
    let resolved = match document_index::resolve(&input, &user, limit, &default_collection) {
        Ok(resolved) => resolved,
        Err(error) => return respond(error),
    };
    let total = resolved[1].as_array().unwrap().len();
    let collection = resolved[2].as_str().unwrap().to_owned();
    let request = document_batch::Request {
        references: resolved[1].clone(),
        username: user,
        collection_name: Some(collection.clone()),
        // Provenance is validated for wire compatibility; ingestion does not use it.
        collection_scope: resolved[3].as_str().map(str::to_owned),
        chunk_size: input.get("chunk_size").cloned(),
        chunk_overlap: input.get("chunk_overlap").cloned(),
    };
    if stream {
        return streaming(preparation.clone(), request, collection, total);
    }
    // The retained non-streaming handler continues its entire batch after an
    // HTTP disconnect. Detaching this task when Axum drops the waiter preserves
    // that behavior; only the SSE body's abort guard cancels queued documents.
    match tokio::spawn(ingest(preparation.clone(), request, None)).await {
        Ok(Ok(output)) => respond((200, complete(output, &collection, total))),
        _ => {
            tracing::warn!("Document ingestion failed");
            respond(detail(500, FAILED))
        }
    }
}
