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
#[cfg(test)]
mod migration_spikes;
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
mod storage;
mod telemetry;
mod tool_contracts;
mod user_interaction;
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
use futures::StreamExt;
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
        telemetry: Mutex::new(None),
        user,
        conversation,
        sender: commands,
        commands: Mutex::new(HashMap::new()),
        finished: std::sync::atomic::AtomicBool::new(false),
        cancellation: tokio::sync::watch::channel(false).0,
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
        if runs.values().filter(|run| run.user == handle.user).count() >= 5 {
            return error(
                429,
                "You already have five chats running. Wait for one to finish or stop a response before starting another.",
            );
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
    let legacy_preparation = app.preparation.is_none();
    let cleanup_http = app.http.clone();
    let cleanup_url = format!("{}/runtime/run", app.tools_url);
    let metrics_handle = handle.clone();
    let mut cancellation = handle.cancellation.subscribe();
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
            let started = Instant::now();
            tracing::info!(event = "run_started", streaming, message_count);
            let result = tokio::select! {
                biased;
                _ = cancellation.wait_for(|cancelled| *cancelled) => {
                    tracing::info!(event = "cancellation_received");
                    Err(anyhow::anyhow!("Run cancelled by user"))
                },
                _ = events.sender.closed() => Err(anyhow::anyhow!("Client disconnected")),
                result = tokio::time::timeout(Duration::from_secs(1800), agent.run(body)) => {
                    result.unwrap_or_else(|_| Err(anyhow::anyhow!("Agent run timed out")))
                },
            };
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
                    "Invalid or repeated tool call ID" => "Invalid or repeated tool call ID; the rejected batch was not executed",
                    "Tool arguments remained invalid after correction" => "Tool arguments remained invalid after correction; the rejected batches were not executed",
                    "Required tool did not complete successfully" => "Required tool did not complete successfully; no answer was accepted",
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
                    let _ = events.event("error", json!({"error":{"message":message}})).await;
                    let _ = events.finish("error").await;
                }).await;
            }
            let metrics = metrics_handle.metrics.snapshot();
            if let Some(mut telemetry_span) = metrics_handle.telemetry.lock().await.take() {
                telemetry::finish(&mut telemetry_span,log_outcome,&metrics);
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
            if legacy_preparation {
            let cleanup = cleanup_http
                .delete(cleanup_url)
                .headers(cleanup_headers)
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
    match handle.submit(&user, command).await {
        Ok(accepted) => {
            tracing::info!(event = "control_accepted", run_id, %command_id, duplicate = !accepted);
            Json(json!({"run_id":run_id,"command_id":command_id,"accepted":accepted,"status":"received"})).into_response()
        }
        Err(status) => error(status, "Steering command rejected"),
    }
}

async fn proxy(State(app): State<App>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    if parts.uri.path().starts_with("/runtime/") {
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
            Some(preparation::Preparation::new(config, http.clone())?)
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
        insecure: matches!(
            std::env::var("ALLOW_INSECURE_INTERNAL")
                .unwrap_or_default()
                .as_str(),
            "1" | "true" | "yes"
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
