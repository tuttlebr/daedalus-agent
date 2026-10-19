//! Daedalus's interruptible agent runtime. Python is a leaf-tool service.

mod agent;
mod agent_skills;
mod authorization;
mod authorization_routes;
#[cfg(test)]
mod authorization_tests;
mod collection_api;
mod collections;
mod config;
mod control;
mod document_api;
mod document_batch;
mod document_codecs;
mod document_detection;
mod document_encoding;
mod document_index;
mod document_ingest_api;
mod document_iso2022;
mod document_json;
mod document_ownership;
mod document_pipeline;
mod document_process;
mod document_processor;
mod document_reranker;
mod document_reservations;
mod document_retriever;
mod document_search;
mod document_store;
mod document_text;
mod document_tools;
mod document_utf7;
mod domain_retriever;
mod embeddings;
mod events;
mod exploration;
mod harness;
mod hindsight;
mod llm_sandbox;
mod logging;
mod mcp;
mod mcp_http;
#[cfg(test)]
mod mcp_tests;
mod memory;
mod memory_api;
mod memory_tools;
#[cfg(test)]
mod migration;
mod milvus;
mod milvus_index;
mod milvus_index_proto;
mod milvus_index_transport;
mod milvus_proto;
mod milvus_search;
mod milvus_serialization;
mod milvus_timestamps;
mod milvus_writer;
mod nv_ingest;
mod nvidia_docs;
mod nws_weather;
mod oauth;
mod output;
mod output_retriever;
mod perplexity_search;
mod preparation;
mod profile_import;
mod protocol;
mod provider;
mod public_http;
mod reranker_order;
mod response_policy;
mod storage;
mod telemetry;
mod tool_contracts;
mod yaml;

use std::{
    collections::HashMap,
    convert::Infallible,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures::{FutureExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, mpsc};
use tokio_stream::wrappers::ReceiverStream;
use tracing::Instrument;
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
    preparation: Option<Arc<preparation::Preparation>>,
    executions: Arc<authorization_routes::Executions>,
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

const RUNS_PER_USER: usize = 5;
const MAX_RUNS: usize = 64;

/// Admission for a new run. Interactive chats and background autonomy runs
/// use separate per-user pools: the frontend admits five chats per user
/// without counting the autonomy worker, so a long scheduled run must not
/// turn an admitted fifth chat into a backend rejection (or the reverse).
fn admission_rejection(
    runs: &HashMap<String, Arc<RunHandle>>,
    run_id: &str,
    handle: &RunHandle,
) -> Option<Response> {
    if runs.contains_key(run_id)
        || runs.values().any(|run| {
            !handle.conversation.is_empty()
                && run.user == handle.user
                && run.conversation == handle.conversation
        })
    {
        return Some(error(409, "A run is already active for this conversation"));
    }
    let same_pool = runs
        .values()
        .filter(|run| run.user == handle.user && run.autonomy == handle.autonomy)
        .count();
    if same_pool >= RUNS_PER_USER {
        return Some(error(
            429,
            if handle.autonomy {
                "Too many autonomous runs are active for this user."
            } else {
                "You already have five chats running. Wait for one to finish or stop a response before starting another."
            },
        ));
    }
    if runs.len() >= MAX_RUNS {
        return Some(error(429, "Agent capacity reached"));
    }
    None
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
    if tool_contracts::Requirement::parse(&body).is_err() {
        return error(400, "Invalid tool_choice");
    }
    if response_policy::ResponsePolicy::parse(&body).is_err() {
        return error(400, "Invalid response_mode");
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
    let autonomy = headers
        .get("x-daedalus-execution-scope")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|scope| scope.eq_ignore_ascii_case("autonomy"));
    let (commands, inbox) = mpsc::channel(32);
    let (sender, receiver) = mpsc::channel(128);
    let handle = Arc::new(RunHandle {
        telemetry: Mutex::new(None),
        user,
        conversation,
        autonomy,
        sender: commands,
        commands: Mutex::new(HashMap::new()),
        finished: std::sync::atomic::AtomicBool::new(false),
        cancellation: tokio::sync::watch::channel(false).0,
        metrics: control::Metrics::default(),
    });
    {
        let mut runs = app.runs.lock().await;
        if let Some(rejection) = admission_rejection(&runs, &run_id, &handle) {
            return rejection;
        }
        runs.insert(run_id.clone(), handle.clone());
    }
    let events = Events {
        run_id: run_id.clone(),
        sender,
    };
    let cleanup = app.preparation.is_none().then(|| {
        app.http
            .delete(format!("{}/runtime/run", app.tools_url))
            .headers(headers.clone())
    });
    let supervisor = handle.clone();
    let agent = Agent {
        http: app.http.clone(),
        tools_url: app.tools_url.clone(),
        headers,
        events: events.clone(),
        inbox,
        handle,
        pending: Vec::new(),
        revision: 0,
        preparation: app.preparation.clone(),
    };
    let streaming = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let message_count = messages.len();
    let runs = app.runs.clone();
    // Correlation must survive LOG_LEVEL=WARN/ERROR even when progress is off.
    let span = tracing::error_span!("agent_run", run_id = %run_id);
    tokio::spawn(
        async move {
            tracing::info!(event = "run_started", streaming, message_count);
            supervise(runs, run_id, supervisor, events, agent.run(body), cleanup).await;
        }
        .instrument(span),
    );
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
    let mut stream = Vec::new();
    while let Some(bytes) = receiver.recv().await {
        stream.extend_from_slice(&bytes);
    }
    let (status, body) = completion(&String::from_utf8_lossy(&stream));
    (StatusCode::from_u16(status).unwrap(), Json(body)).into_response()
}

/// Collect a run's SSE output into one Chat Completions response. The streaming
/// terminal reason, such as `mcp_approval_required`, survives, and events a
/// caller must act on (approval, OAuth, applied steering) stay in
/// `daedalus_events` in their stream order. Tool progress is omitted.
fn completion(stream: &str) -> (u16, Value) {
    let (mut id, mut content, mut finish, mut failed) = (Value::Null, String::new(), None, None);
    let mut events = Vec::new();
    for frame in stream.split("\n\n") {
        let mut name = "message";
        let mut data = None;
        for line in frame.lines() {
            if let Some(value) = line.strip_prefix("event: ") {
                name = value;
            } else if let Some(value) = line.strip_prefix("data: ") {
                data = serde_json::from_str::<Value>(value).ok();
            }
        }
        let Some(data) = data else { continue };
        match name {
            "message" => {
                id = data["id"].clone();
                let choice = &data["choices"][0];
                if let Some(delta) = choice["delta"]["content"].as_str() {
                    content.push_str(delta);
                }
                if let Some(reason) = choice["finish_reason"].as_str() {
                    finish = Some(reason.to_owned());
                }
            }
            "error" => failed = data["error"]["message"].as_str().map(str::to_owned),
            _ => events.push(json!({"event":name,"data":data})),
        }
    }
    let Some(finish) = finish.filter(|_| failed.is_none()) else {
        let message = failed
            .as_deref()
            .unwrap_or("Run ended without a terminal event");
        return (502, json!({"error":{"message":message}}));
    };
    let mut body = json!({"id":id,"object":"chat.completion","choices":[{"index":0,
        "message":{"role":"assistant","content":content},"finish_reason":finish}]});
    if !events.is_empty() {
        body["daedalus_events"] = json!(events);
    }
    (200, body)
}

/// Owns an admitted run until it ends. Every outcome, including a panic in
/// agent or native tool code, reaches the terminal event and releases the
/// user's slot; an unwound task would block its conversation until restart.
async fn supervise(
    runs: Runs,
    run_id: String,
    handle: Arc<RunHandle>,
    events: Events,
    run: impl std::future::Future<Output = anyhow::Result<()>>,
    cleanup: Option<reqwest::RequestBuilder>,
) {
    let started = Instant::now();
    let mut cancellation = handle.cancellation.subscribe();
    let run = std::panic::AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(1800), run))
        .catch_unwind();
    let result = tokio::select! {
        biased;
        _ = cancellation.wait_for(|cancelled| *cancelled) => {
            tracing::info!(event = "cancellation_received");
            Err(anyhow::anyhow!("Run cancelled by user"))
        },
        _ = events.sender.closed() => Err(anyhow::anyhow!("Client disconnected")),
        result = run => match result {
            Ok(result) => result.unwrap_or_else(|_| Err(anyhow::anyhow!("Agent run timed out"))),
            // A panic payload can quote private values; report only the fact.
            Err(_) => Err(anyhow::anyhow!("Agent execution panicked")),
        },
    };
    // Nothing reads the inbox any longer. Report later direction and Stop as
    // finished before terminal events, as a successful run already does.
    handle.finish().await;
    let outcome = if result.is_ok() {
        "completed"
    } else {
        "failed"
    };
    let mut log_outcome = outcome;
    if let Err(failure) = result {
        // Provider exceptions can contain full requests or credentials.
        // Only application-owned diagnostics cross the logging/UI boundary.
        let details = logging::failure(&failure);
        let message = match failure.root_cause().to_string().as_str() {
            "Run cancelled by user" => "Run cancelled by user",
            "Agent run timed out" => "Agent run timed out",
            "Agent iteration limit reached" => "Agent iteration limit reached",
            "Repeated identical tool failure" => "Repeated identical tool failure",
            "Invalid or repeated tool call ID" => {
                "Invalid or repeated tool call ID; the rejected batch was not executed"
            }
            "Required tool did not complete successfully" => {
                "Required tool did not complete successfully; no answer was accepted"
            }
            "Model response did not complete" => "Model response did not complete",
            "Model request timed out" => "Model request timed out",
            "Client disconnected" => "Client disconnected",
            _ if details.phase == "model_stream" && details.kind == "json" => {
                "Model response could not be decoded; completed output has been preserved"
            }
            _ if details.phase == "model_stream" && details.retryable => {
                "Model stream interrupted after retry limit; completed output has been preserved"
            }
            _ => "Agent execution failed; completed output has been preserved",
        };
        log_outcome = match message {
            "Run cancelled by user" => "cancelled",
            "Client disconnected" => "disconnected",
            _ => "failed",
        };
        if log_outcome == "failed" {
            tracing::warn!(
                event = "run_failed",
                phase = details.phase,
                error_kind = details.kind,
                http_status = details.status,
                retryable = details.retryable,
                reason = message
            );
        }
        // A stopped or disconnected consumer must not block cleanup
        // on a full output channel.
        let _ = tokio::time::timeout(Duration::from_secs(1), async {
            let _ = events
                .event("error", json!({"error":{"message":message}}))
                .await;
            let _ = events.finish("error").await;
        })
        .await;
    }
    let metrics = handle.metrics.snapshot();
    if let Some(mut telemetry_span) = handle.telemetry.lock().await.take() {
        telemetry::finish(&mut telemetry_span, log_outcome, &metrics);
    }
    tracing::info!(
        event = "run_finished",
        outcome = log_outcome,
        elapsed_ms = started.elapsed().as_millis() as u64,
        model_calls = metrics["model_calls"].as_u64(),
        tool_calls = metrics["tool_calls"].as_u64(),
        input_tokens = metrics["input_tokens"].as_u64(),
        output_tokens = metrics["output_tokens"].as_u64(),
        reported_usage_calls = metrics["reported_usage_calls"].as_u64()
    );
    if let Some(cleanup) = cleanup {
        let cleanup = cleanup
            .json(&json!({"outcome":outcome,"metrics":metrics}))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status);
        if let Err(error) = cleanup {
            let details = logging::failure(&error.into());
            tracing::warn!(
                event = "run_cleanup_failed",
                error_kind = details.kind,
                http_status = details.status
            );
        }
    }
    runs.lock().await.remove(&run_id);
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
    match handle.submit(&user, command).await {
        Ok(accepted) => {
            tracing::info!(event = "control_accepted", run_id, %command_id, duplicate = !accepted);
            Json(json!({"run_id":run_id,"command_id":command_id,"accepted":accepted,"status":"received"})).into_response()
        }
        Err(status) => error(status, "Steering command rejected"),
    }
}

/// The Python ASGI server percent-decodes a path once before routing, so
/// `/%72untime/...` reaches `/runtime/...`. Block the decoded form as well.
fn internal_path(path: &str) -> bool {
    let raw = path.as_bytes();
    let hex = |index: usize| raw.get(index).and_then(|byte| (*byte as char).to_digit(16));
    let mut decoded = Vec::with_capacity(raw.len());
    let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%'
            && let (Some(high), Some(low)) = (hex(index + 1), hex(index + 2))
        {
            decoded.push((high * 16 + low) as u8);
            index += 3;
        } else {
            decoded.push(raw[index]);
            index += 1;
        }
    }
    decoded == b"/runtime" || decoded.starts_with(b"/runtime/")
}

async fn proxy(State(app): State<App>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    // Check the path that is actually sent: URL parsing removes dot segments
    // (also percent-encoded ones), so `/./runtime/...` would pass a raw check.
    let Ok(upstream) = reqwest::Url::parse(&format!("{}{}", app.tools_url, parts.uri)) else {
        return error(400, "Invalid request path");
    };
    if internal_path(parts.uri.path()) || internal_path(upstream.path()) {
        return error(404, "Not found");
    }
    if app
        .preparation
        .as_ref()
        .is_some_and(|p| !p.config.python_tools)
    {
        return if parts.uri.path().starts_with("/v1/")
            || parts.uri.path().starts_with("/executions/")
        {
            (StatusCode::SERVICE_UNAVAILABLE,Json(json!({"error":{"message":"Capability unavailable in this profile","code":"capability_unavailable"}}))).into_response()
        } else {
            error(404, "Not found")
        };
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
        .request(parts.method, upstream)
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
        .route("/health/ready", get(readiness))
        .route("/auth/redirect", get(authorization_routes::callback))
        .route(
            "/v1/google-workspace/connections/{service}",
            axum::routing::delete(authorization_routes::reset),
        )
        .route(
            "/v1/mcp-approvals/{request_id}/execute",
            post(authorization_routes::execute),
        )
        .route("/executions/{id}", get(authorization_routes::get_execution))
        .merge(memory_api::routes())
        .merge(profile_import::routes())
        .merge(document_api::routes())
        .merge(document_ingest_api::routes())
        .merge(collection_api::routes())
        .fallback(proxy)
        .with_state(app)
}

async fn readiness(State(app): State<App>) -> Response {
    if std::path::Path::new("/tmp/daedalus-draining").exists() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status":"draining"})),
        )
            .into_response();
    }
    if app.internal_token.is_empty() && !app.insecure {
        return error(503, "Internal authentication is not configured");
    }
    let Some(preparation) = &app.preparation.clone() else {
        return proxy(
            State(app),
            Request::builder()
                .uri("/health/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    };
    if preparation.config.python_tools {
        let response = proxy(
            State(app),
            Request::builder()
                .uri("/health/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        return mcp_readiness(preparation, response).await;
    }
    // Minimal chat only requires Redis if configured; memory/output caches remain
    // optional. Full-profile readiness retains its required dependency policy.
    let redis_required = preparation.config.env.contains_key("REDIS_URL");
    if redis_required && preparation.outputs.store.ping().await.is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status":"unready","reason":"redis_unavailable"})),
        )
            .into_response();
    }
    let mut memory = json!({"state":if preparation.memory.enabled {"hindsight"} else {"disabled"}});
    let mut degraded = false;
    if preparation.memory.enabled {
        let mode = preparation
            .config
            .variable("DAEDALUS_MEMORY_READINESS_MODE", "degraded")
            .trim()
            .to_lowercase();
        if !["", "degraded", "required"].contains(&mode.as_str()) {
            return error(503, "Invalid memory readiness mode");
        }
        let available = preparation.memory.health().await.is_ok();
        memory["hindsight"] = json!(if available { "ready" } else { "unavailable" });
        if !available && mode == "required" {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"status":"unready","reason":"hindsight_unavailable","memory":memory})),
            )
                .into_response();
        }
        degraded = !available;
    }
    mcp_readiness(preparation, Json(json!({"status":if degraded {"degraded"} else {"ready"},"runtime":"rust","memory":memory,"capabilities":{"current_datetime":true,"python_executor":false}})).into_response()).await
}

async fn mcp_readiness(preparation: &preparation::Preparation, response: Response) -> Response {
    let Some(mcp) = &preparation.mcp else {
        return response;
    };
    let status = response.status();
    let bytes = match to_bytes(response.into_body(), 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return error(503, "Readiness unavailable"),
    };
    let mut body: Value = match serde_json::from_slice(&bytes) {
        Ok(body) => body,
        Err(_) => return error(503, "Readiness unavailable"),
    };
    body["mcp"] = mcp.capabilities();
    if body["mcp"]["missing_required"]
        .as_array()
        .is_some_and(|v| !v.is_empty())
    {
        body["status"] = json!("unready");
        body["reason"] = json!("required_mcp_capability_unavailable");
        return (StatusCode::SERVICE_UNAVAILABLE, Json(body)).into_response();
    }
    (status, Json(body)).into_response()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    logging::init();
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let mode = std::env::var("DAEDALUS_PREPARATION").unwrap_or_else(|_| "rust".into());
    let preparation = match mode.as_str() {
        "rust" => {
            let path = std::env::var("DAEDALUS_CONFIG_FILE")
                .unwrap_or_else(|_| "/workspace/config.yaml".into());
            let config = config::Config::from_path(std::path::Path::new(&path))?;
            if config.variable("DAEDALUS_AUTHORIZATION", "rust") == "rust" {
                mcp::validate(&config)?;
            }
            if std::env::args().any(|arg| arg == "--check-config") {
                if config.variable("DAEDALUS_AUTHORIZATION", "rust") == "rust" {
                    oauth::GoogleOAuth::new(&config)?;
                }
                println!(
                    "Configuration valid; preparation=rust; python_executor_required={}",
                    config.python_tools
                );
                return Ok(());
            }
            Some(preparation::Preparation::new(config)?)
        }
        "python" => {
            if std::env::var("DAEDALUS_AUTHORIZATION").is_ok_and(|v| v != "python") {
                anyhow::bail!("Python preparation requires Python authorization");
            }
            None
        }
        _ => anyhow::bail!("DAEDALUS_PREPARATION must be rust or python"),
    };
    let app = App {
        http,
        tools_url: std::env::var("DAEDALUS_TOOLS_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8001".into()),
        internal_token: Arc::new(
            std::env::var("DAEDALUS_INTERNAL_API_TOKEN")
                .unwrap_or_default()
                .trim()
                .to_owned(),
        ),
        insecure: config::allow_insecure_internal(
            std::env::var("ALLOW_INSECURE_INTERNAL").ok().as_deref(),
        ),
        runs: Arc::new(Mutex::new(HashMap::new())),
        preparation,
        executions: Arc::default(),
    };
    let host = std::env::var("DAEDALUS_HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let port = std::env::var("DAEDALUS_PORT").unwrap_or_else(|_| "8000".into());
    let listener = tokio::net::TcpListener::bind(format!("{host}:{port}")).await?;
    tracing::info!(
        event = "runtime_started",
        component = "rust_agent",
        port = listener.local_addr()?.port()
    );
    let shutdown_preparation = app.preparation.clone();
    let shutdown_runs = app.runs.clone();
    let shutdown_executions = app.executions.clone();
    let shutdown_mcp = app.preparation.as_ref().and_then(|p| p.mcp.clone());
    let maintenance = shutdown_mcp.clone().map(|mcp| {
        tokio::spawn(async move {
            loop {
                mcp.maintain().await;
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        })
    });
    axum::serve(listener, router(app))
        .with_graceful_shutdown(async move {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("install SIGTERM handler");
            tokio::select! { _ = terminate.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
            tracing::info!(event = "runtime_stopping", component = "rust_agent");
            for handle in shutdown_runs.lock().await.values() {
                let _ = handle.cancellation.send(true);
            }
            shutdown_executions.close().await;
            if let Some(maintenance) = maintenance {
                maintenance.abort();
                let _ = maintenance.await;
            }
            if let Some(mcp) = shutdown_mcp {
                mcp.close();
            }
        })
        .await?;
    if let Some(preparation) = shutdown_preparation {
        for tool in preparation.weather_tools.values() {
            tool.close().await;
        }
        if let Some(telemetry) = &preparation.telemetry {
            telemetry.shutdown().await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    fn run(user: &str, conversation: &str, autonomy: bool) -> Arc<RunHandle> {
        Arc::new(RunHandle {
            telemetry: Mutex::new(None),
            user: user.into(),
            conversation: conversation.into(),
            autonomy,
            sender: mpsc::channel(1).0,
            commands: Mutex::new(HashMap::new()),
            finished: std::sync::atomic::AtomicBool::new(false),
            cancellation: tokio::sync::watch::channel(false).0,
            metrics: control::Metrics::default(),
        })
    }

    #[test]
    fn autonomy_and_interactive_chats_use_separate_per_user_pools() {
        let status = |runs: &HashMap<String, Arc<RunHandle>>, handle: &RunHandle| {
            admission_rejection(runs, "new-run", handle).map(|r| r.status())
        };
        let mut runs = HashMap::new();
        runs.insert("auto".to_string(), run("alice", "", true));
        for index in 0..4 {
            runs.insert(
                format!("chat-{index}"),
                run("alice", &format!("c{index}"), false),
            );
        }
        // A scheduled run does not consume one of the five interactive chats.
        assert_eq!(status(&runs, &run("alice", "c4", false)), None);
        runs.insert("chat-4".to_string(), run("alice", "c4", false));
        assert_eq!(
            status(&runs, &run("alice", "c5", false)),
            Some(StatusCode::TOO_MANY_REQUESTS)
        );
        // Five open chats do not block the user's scheduled autonomy run.
        assert_eq!(status(&runs, &run("alice", "", true)), None);
        for index in 1..5 {
            runs.insert(format!("auto-{index}"), run("alice", "", true));
        }
        assert_eq!(
            status(&runs, &run("alice", "", true)),
            Some(StatusCode::TOO_MANY_REQUESTS)
        );
        // Other users and per-conversation exclusivity are unchanged.
        assert_eq!(status(&runs, &run("bob", "c0", false)), None);
        assert_eq!(
            status(&runs, &run("alice", "c0", true)),
            Some(StatusCode::CONFLICT)
        );
        for index in 0..(MAX_RUNS - runs.len()) {
            runs.insert(
                format!("other-{index}"),
                run(&format!("u{index}"), "", false),
            );
        }
        assert_eq!(
            status(&runs, &run("carol", "", false)),
            Some(StatusCode::TOO_MANY_REQUESTS)
        );
    }

    async fn defective_run() -> anyhow::Result<()> {
        panic!("synthetic agent defect")
    }

    #[tokio::test]
    async fn a_panicking_run_ends_its_stream_and_releases_its_slot() {
        let runs: Runs = Arc::default();
        let handle = run("alice", "conversation", false);
        runs.lock().await.insert("defective".into(), handle.clone());
        let (sender, mut receiver) = mpsc::channel(8);
        let events = Events {
            run_id: "defective".into(),
            sender,
        };
        let supervisor = tokio::spawn(supervise(
            runs.clone(),
            "defective".into(),
            handle,
            events,
            defective_run(),
            None,
        ));
        let mut stream = String::new();
        while let Some(bytes) = receiver.recv().await {
            stream.push_str(&String::from_utf8_lossy(&bytes));
        }
        supervisor
            .await
            .expect("the supervisor contains agent panics");
        assert!(stream.contains("event: error"), "{stream}");
        assert!(stream.contains("\"finish_reason\":\"error\""), "{stream}");
        assert!(stream.ends_with("data: [DONE]\n\n"), "{stream}");
        // The conversation and the user's slot are available again.
        let next = run("alice", "conversation", false);
        assert!(admission_rejection(&*runs.lock().await, "next", &next).is_none());
    }

    #[tokio::test]
    async fn non_streaming_responses_keep_the_terminal_reason_and_caller_events() {
        let (sender, mut receiver) = mpsc::channel(16);
        let events = Events {
            run_id: "run-1".into(),
            sender,
        };
        events
            .event(
                "oauth_required",
                json!({"auth_url":"https://accounts.example/o"}),
            )
            .await
            .unwrap();
        events
            .tool("call-1", "clock", true, json!({"output":"noon"}))
            .await
            .unwrap();
        events
            .event("steering", json!({"command_id":"c1","status":"applied"}))
            .await
            .unwrap();
        events
            .event("mcp_approval_required", json!({"marker":"<!--approval-->"}))
            .await
            .unwrap();
        events.delta("Approve the change.").await.unwrap();
        events.finish("mcp_approval_required").await.unwrap();
        drop(events);
        let mut stream = String::new();
        while let Some(bytes) = receiver.recv().await {
            stream.push_str(&String::from_utf8_lossy(&bytes));
        }

        let (status, body) = completion(&stream);
        assert_eq!(status, 200);
        assert_eq!(body["id"], "run-1");
        assert_eq!(body["choices"][0]["finish_reason"], "mcp_approval_required");
        assert_eq!(
            body["choices"][0]["message"]["content"],
            "Approve the change."
        );
        let names: Vec<_> = body["daedalus_events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["event"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            ["oauth_required", "steering", "mcp_approval_required"]
        );
        assert_eq!(
            body["daedalus_events"][0]["data"]["auth_url"],
            "https://accounts.example/o"
        );

        // A completed answer stays a plain completion.
        let (status, body) = completion(
            "event: message\ndata: {\"id\":\"r\",\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n\
             event: message\ndata: {\"id\":\"r\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
        );
        assert_eq!(
            (status, &body["choices"][0]["finish_reason"]),
            (200, &json!("stop"))
        );
        assert!(body.get("daedalus_events").is_none());
        // Failures and truncated runs are never reported as completed.
        assert_eq!(
            completion(
                "event: message\ndata: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n\
                 event: error\ndata: {\"error\":{\"message\":\"Agent run timed out\"}}\n\n\
                 event: message\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"error\"}]}\n\n"
            ),
            (502, json!({"error":{"message":"Agent run timed out"}}))
        );
        assert_eq!(completion("").0, 502);
    }

    #[tokio::test]
    async fn a_failed_run_reports_finished_to_later_commands() {
        let runs: Runs = Arc::default();
        let (commands, inbox) = mpsc::channel(8);
        let handle = Arc::new(RunHandle {
            telemetry: Mutex::new(None),
            user: "alice".into(),
            conversation: "conversation".into(),
            autonomy: false,
            sender: commands,
            commands: Mutex::new(HashMap::new()),
            finished: std::sync::atomic::AtomicBool::new(false),
            cancellation: tokio::sync::watch::channel(false).0,
            metrics: control::Metrics::default(),
        });
        runs.lock().await.insert("failed".into(), handle.clone());
        // A one-slot output channel holds the supervisor in its terminal events.
        let (sender, mut receiver) = mpsc::channel(1);
        let events = Events {
            run_id: "failed".into(),
            sender,
        };
        let failed = async move {
            let _inbox = inbox;
            anyhow::bail!("synthetic model failure")
        };
        let supervisor = tokio::spawn(supervise(
            runs.clone(),
            "failed".into(),
            handle.clone(),
            events,
            failed,
            None,
        ));
        let first = receiver.recv().await.unwrap();
        assert!(String::from_utf8_lossy(&first).contains("event: error"));
        assert!(runs.lock().await.contains_key("failed"));
        // The run has ended: neither direction nor Stop is "received".
        let steer = Command::Steer {
            command_id: Uuid::new_v4(),
            instruction: "Use source B".into(),
        };
        assert_eq!(handle.submit("alice", steer).await, Err(409));
        let cancel = Command::Cancel {
            command_id: Uuid::new_v4(),
        };
        assert_eq!(handle.submit("alice", cancel).await, Err(409));
        while receiver.recv().await.is_some() {}
        supervisor.await.unwrap();
        assert!(!runs.lock().await.contains_key("failed"));
    }

    #[tokio::test]
    async fn encoded_internal_paths_never_reach_the_tool_service() {
        let forwarded = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let recorder = forwarded.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tools_url = format!("http://{}", listener.local_addr().unwrap());
        let peer = tokio::spawn(async move {
            let service = Router::new().fallback(move |request: Request| {
                let recorder = recorder.clone();
                async move {
                    recorder
                        .lock()
                        .unwrap()
                        .push(request.uri().path().to_owned());
                    "forwarded"
                }
            });
            axum::serve(listener, service).await.unwrap()
        });
        let app = router(App {
            http: reqwest::Client::new(),
            tools_url,
            internal_token: Arc::new("synthetic-internal".into()),
            insecure: false,
            runs: Arc::default(),
            preparation: None,
            executions: Arc::default(),
        });
        for path in [
            "/runtime/v1/tools/call",
            "/%72untime/v1/tools/call",
            "/%72%75ntime/tools/call",
            "/runtime%2Fv1/tools/call",
            "/runtime%2fprepare",
            "/runtime",
            // The upstream URL parser removes dot segments, including encoded
            // ones, after this check would otherwise have run.
            "/./runtime/v1/tools/call",
            "/v1/../runtime/v1/tools/call",
            "/%2e/runtime/v1/tools/call",
            "/v1/%2E%2E/runtime/prepare",
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::post(path)
                        .header("x-daedalus-internal-token", "synthetic-internal")
                        .header("x-user-id", "synthetic-user")
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        }
        assert!(forwarded.lock().unwrap().is_empty());
        // Public adapters, including encoded non-internal paths, still proxy.
        for path in ["/v1/images/generations", "/v1/runtime%2Fname", "/runtimes"] {
            let response = app
                .clone()
                .oneshot(Request::post(path).body(Body::from("{}")).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{path}");
        }
        assert_eq!(forwarded.lock().unwrap().len(), 3);
        peer.abort();
    }
}
