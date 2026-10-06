//! Daedalus's interruptible agent runtime. Python is a leaf-tool service.

mod agent;
mod control;
mod events;
mod provider;

use std::{collections::HashMap, convert::Infallible, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, mpsc};
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use agent::Agent;
use control::{Command, RunHandle, Runs};
use events::Events;

#[derive(Clone)]
struct App {
    http: reqwest::Client,
    tools_url: String,
    internal_token: Arc<String>,
    insecure: bool,
    runs: Runs,
}

fn error(status: u16, message: &str) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(json!({"error":{"message":message}})),
    )
        .into_response()
}

fn authenticate(app: &App, headers: &HeaderMap) -> Result<String, Box<Response>> {
    if app.internal_token.is_empty() {
        if !app.insecure {
            return Err(Box::new(error(
                503,
                "Internal authentication is not configured",
            )));
        }
    } else {
        let provided = headers
            .get("x-daedalus-internal-token")
            .map(|v| v.as_bytes())
            .unwrap_or_default();
        let expected = Sha256::digest(app.internal_token.as_bytes());
        if !bool::from(expected.ct_eq(&Sha256::digest(provided))) {
            return Err(Box::new(error(401, "Internal authentication required")));
        }
    }
    let user = headers
        .get("x-user-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();
    if user.is_empty() || user.len() > 256 {
        return Err(Box::new(error(401, "User identity required")));
    }
    Ok(user.to_owned())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
}

async fn chat(State(app): State<App>, mut headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let user = match authenticate(&app, &headers) {
        Ok(user) => user,
        Err(response) => return *response,
    };
    let Some(messages) = body.get("messages").and_then(Value::as_array) else {
        return error(400, "messages must be an array");
    };
    if messages.is_empty() || messages.len() > 1000 {
        return error(400, "Invalid message count");
    }
    let run_id = headers
        .get("x-daedalus-request-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let conversation = headers
        .get("x-conversation-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    if !valid_id(&run_id) || (!conversation.is_empty() && !valid_id(&conversation)) {
        return error(400, "Invalid run identity");
    }
    headers.insert(
        "x-daedalus-request-id",
        run_id.parse().expect("validated ASCII ID"),
    );
    // Host and content framing belong to the internal HTTP client, not the
    // caller's proxy connection.
    headers.remove(header::HOST);
    headers.remove(header::CONTENT_LENGTH);
    let (commands, inbox) = mpsc::channel(32);
    let (sender, receiver) = mpsc::channel(128);
    let handle = Arc::new(RunHandle {
        user,
        conversation,
        sender: commands,
        commands: Mutex::new(HashMap::new()),
        finished: std::sync::atomic::AtomicBool::new(false),
        metrics: control::Metrics::default(),
    });
    {
        let mut runs = app.runs.lock().await;
        if runs.contains_key(&run_id)
            || runs.values().any(|run| {
                !handle.conversation.is_empty()
                    && run.user == handle.user
                    && run.conversation == handle.conversation
            })
        {
            return error(409, "A run is already active for this conversation");
        }
        if runs.len() >= 64 {
            return error(429, "Agent capacity reached");
        }
        runs.insert(run_id.clone(), handle.clone());
    }
    let events = Events {
        run_id: run_id.clone(),
        sender,
    };
    let cleanup_headers = headers.clone();
    let cleanup_http = app.http.clone();
    let cleanup_url = format!("{}/runtime/run", app.tools_url);
    let metrics_handle = handle.clone();
    let agent = Agent {
        http: app.http.clone(),
        tools_url: app.tools_url.clone(),
        headers,
        events: events.clone(),
        inbox,
        handle,
        pending: Vec::new(),
        revision: 0,
    };
    let streaming = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let runs = app.runs.clone();
    tokio::spawn(async move {
        let result = tokio::time::timeout(Duration::from_secs(1800), agent.run(body)).await;
        let result = result.unwrap_or_else(|_| Err(anyhow::anyhow!("Agent run timed out")));
        let outcome = if result.is_ok() {
            "completed"
        } else {
            "failed"
        };
        if let Err(failure) = result {
            // Provider exceptions can contain full requests or credentials.
            // Only application-owned diagnostics cross the logging/UI boundary.
            let message = match failure.to_string().as_str() {
                "Run cancelled by user" => "Run cancelled by user",
                "Agent run timed out" => "Agent run timed out",
                "Agent iteration limit reached" => "Agent iteration limit reached",
                "Repeated identical tool failure" => "Repeated identical tool failure",
                "Model response did not complete" => "Model response did not complete",
                "Model request timed out" => "Model request timed out",
                _ => "Agent execution failed; completed output has been preserved",
            };
            let provider_error = failure.downcast_ref::<rig_core::error::ProviderError>();
            tracing::warn!(
                run_id,
                outcome = message,
                provider_error_kind = provider_error.map(|error| error.kind().code()),
                provider_status = provider_error
                    .and_then(|error| error.provider_response_status())
                    .map(|status| status.as_u16()),
                "Agent run ended"
            );
            let _ = events
                .event("error", json!({"error":{"message":message}}))
                .await;
            let _ = events.finish("error").await;
        }
        let _ = cleanup_http
            .delete(cleanup_url)
            .headers(cleanup_headers)
            .json(&json!({"outcome":outcome,"metrics":metrics_handle.metrics.snapshot()}))
            .timeout(Duration::from_secs(2))
            .send()
            .await;
        runs.lock().await.remove(&run_id);
    });
    if streaming {
        let stream = ReceiverStream::new(receiver).map(Ok::<_, Infallible>);
        return (
            [
                (header::CONTENT_TYPE, "text/event-stream"),
                (header::CACHE_CONTROL, "no-cache"),
                (header::HeaderName::from_static("x-accel-buffering"), "no"),
            ],
            Body::from_stream(stream),
        )
            .into_response();
    }
    let mut receiver = receiver;
    let mut content = String::new();
    let mut failed = None;
    while let Some(bytes) = receiver.recv().await {
        for line in String::from_utf8_lossy(&bytes).lines() {
            if let Some(data) = line.strip_prefix("data: ")
                && let Ok(value) = serde_json::from_str::<Value>(data)
            {
                if let Some(delta) = value["choices"][0]["delta"]["content"].as_str() {
                    content.push_str(delta);
                }
                if let Some(message) = value["error"]["message"].as_str() {
                    failed = Some(message.to_owned());
                }
            }
        }
    }
    if let Some(message) = failed {
        return error(502, &message);
    }
    Json(json!({"object":"chat.completion","choices":[{"index":0,
        "message":{"role":"assistant","content":content},"finish_reason":"stop"}]}))
    .into_response()
}

async fn control(
    State(app): State<App>,
    Path(run_id): Path<String>,
    headers: HeaderMap,
    Json(command): Json<Command>,
) -> Response {
    let user = match authenticate(&app, &headers) {
        Ok(user) => user,
        Err(response) => return *response,
    };
    let handle = app.runs.lock().await.get(&run_id).cloned();
    let Some(handle) = handle else {
        return error(404, "Active run not found");
    };
    let command_id = command.id();
    match handle.submit(&user,command).await {
        Ok(accepted)=>Json(json!({"run_id":run_id,"command_id":command_id,"accepted":accepted,"status":"received"})).into_response(),
        Err(status)=>error(status,"Steering command rejected"),
    }
}

async fn proxy(State(app): State<App>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    if parts.uri.path().starts_with("/runtime/") {
        return error(404, "Not found");
    }
    let mut headers = parts.headers;
    for name in [
        header::HOST,
        header::CONTENT_LENGTH,
        header::CONNECTION,
        header::TRANSFER_ENCODING,
    ] {
        headers.remove(name);
    }
    let bytes = match to_bytes(body, 128 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return error(413, "Request too large"),
    };
    let response = app
        .http
        .request(parts.method, format!("{}{}", app.tools_url, parts.uri))
        .headers(headers)
        .body(bytes)
        .send()
        .await;
    let Ok(response) = response else {
        return error(503, "Tool service unavailable");
    };
    let status = response.status();
    let mut headers = response.headers().clone();
    for name in [
        header::CONTENT_LENGTH,
        header::CONNECTION,
        header::TRANSFER_ENCODING,
    ] {
        headers.remove(name);
    }
    let mut result = Response::new(Body::from_stream(response.bytes_stream()));
    *result.status_mut() = status;
    *result.headers_mut() = headers;
    result
}

fn router(app: App) -> Router {
    Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"status":"healthy","runtime":"rust"})) }),
        )
        .route(
            "/v1/chat/completions",
            post(chat).layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route(
            "/v1/runs/{run_id}/control",
            post(control).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .fallback(proxy)
        .with_state(app)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "daedalus_runtime=info".into()),
        )
        .init();
    let app = App {
        http: reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
        tools_url: std::env::var("DAEDALUS_TOOLS_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8001".into()),
        internal_token: Arc::new(
            std::env::var("DAEDALUS_INTERNAL_API_TOKEN")
                .unwrap_or_default()
                .trim()
                .to_owned(),
        ),
        insecure: matches!(
            std::env::var("ALLOW_INSECURE_INTERNAL")
                .unwrap_or_default()
                .as_str(),
            "1" | "true" | "yes"
        ),
        runs: Arc::new(Mutex::new(HashMap::new())),
    };
    let host = std::env::var("DAEDALUS_HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let port = std::env::var("DAEDALUS_PORT").unwrap_or_else(|_| "8000".into());
    let listener = tokio::net::TcpListener::bind(format!("{host}:{port}")).await?;
    tracing::info!("Daedalus Rust runtime listening");
    axum::serve(listener, router(app))
        .with_graceful_shutdown(async {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("install SIGTERM handler");
            tokio::select! { _ = terminate.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
        })
        .await?;
    Ok(())
}
