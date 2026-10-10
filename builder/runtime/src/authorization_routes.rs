//! Explicit HTTP ownership of OAuth callbacks, resets and exact-call execution.
use crate::{
    App, authorization,
    mcp::Mcp,
    oauth::{self, Emitter},
};
use axum::{
    Json,
    body::to_bytes,
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{sync::watch, task::JoinHandle};

const FAILED: &str =
    "The approved MCP operation did not confirm success. Check its current state before retrying.";
struct ExecutionGuard(watch::Sender<Value>);
impl Drop for ExecutionGuard {
    fn drop(&mut self) {
        let unfinished = !matches!(
            self.0.borrow()["status"].as_str(),
            Some("completed" | "failed")
        );
        if unfinished {
            self.0
                .send_replace(json!({"status":"failed","error":FAILED}));
        }
    }
}
struct Record {
    user: String,
    created: Instant,
    status: watch::Receiver<Value>,
    task: JoinHandle<()>,
}
#[derive(Default)]
pub struct Executions(Mutex<HashMap<String, Record>>);
impl Executions {
    fn start(
        &self,
        mcp: Arc<Mcp>,
        user: String,
        body: Execute,
        args: Value,
        token: String,
    ) -> Result<(String, watch::Receiver<Value>), ()> {
        let mut records = self.0.lock().unwrap();
        records.retain(|_, record| {
            !record.task.is_finished() || record.created.elapsed() < Duration::from_secs(3600)
        });
        if records.len() >= 1024 {
            return Err(());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = watch::channel(json!({"status":"running"}));
        let actor = user.clone();
        let guard = ExecutionGuard(sender.clone());
        let task = tokio::spawn(async move {
            let _guard = guard;
            let emit = Emitter::Execution(sender.clone());
            let result = tokio::time::timeout(
                Duration::from_secs(1800),
                mcp.call(
                    &format!("{}__{}", body.server_name, body.tool_name),
                    &args,
                    &actor,
                    &token,
                    &emit,
                ),
            )
            .await;
            let payload = if result.is_ok_and(|r| !r.is_error && !r.terminal) {
                json!({"status":"completed","result":{"status":"completed","serverName":body.server_name,"toolName":body.tool_name,"argumentsSha256":body.arguments_sha256}})
            } else {
                json!({"status":"failed","error":FAILED})
            };
            sender.send_replace(payload);
        });
        records.insert(
            id.clone(),
            Record {
                user,
                created: Instant::now(),
                status: receiver.clone(),
                task,
            },
        );
        Ok((id, receiver))
    }
    fn get(&self, id: &str, user: &str) -> Option<Value> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .filter(|r| r.user == user)
            .map(|r| payload(id, &r.status.borrow(), false))
    }
    pub async fn close(&self) {
        let tasks: Vec<_> = self
            .0
            .lock()
            .unwrap()
            .drain()
            .map(|(_, r)| r.task)
            .collect();
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            let _ = task.await;
        }
    }
}
fn payload(id: &str, status: &Value, initial: bool) -> Value {
    let mut value = status.clone();
    value["executionId"] = json!(id);
    if initial && value["status"] == "oauth_required" {
        let map = value.as_object_mut().unwrap();
        let url = map.remove("auth_url").unwrap_or(Value::Null);
        let state = map.remove("oauth_state").unwrap_or(Value::Null);
        map.insert("authUrl".into(), url);
        map.insert("oauthState".into(), state);
    }
    value
}
fn detail(status: u16, message: &str) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        Json(json!({"detail":message})),
    )
        .into_response()
}
fn actor(app: &App, headers: &HeaderMap) -> Result<String, Box<Response>> {
    use sha2::{Digest, Sha256};
    use subtle::ConstantTimeEq;
    if app.internal_token.is_empty() && !app.insecure {
        return Err(Box::new(detail(
            503,
            "Internal API authentication is not configured",
        )));
    }
    let token = crate::preparation::header(headers, "x-daedalus-internal-token");
    if !app.internal_token.is_empty()
        && !bool::from(
            Sha256::digest(app.internal_token.as_bytes()).ct_eq(&Sha256::digest(token.as_bytes())),
        )
    {
        return Err(Box::new(detail(401, "Internal API token is required")));
    }
    let user = crate::preparation::header(headers, "x-user-id");
    if user.is_empty() || user.len() > 256 {
        return Err(Box::new(detail(401, "Authenticated user is required")));
    }
    Ok(user.into())
}
fn manager(app: &App) -> Option<Arc<Mcp>> {
    app.preparation.as_ref().and_then(|p| p.mcp.clone())
}

pub async fn callback(State(app): State<App>, request: Request) -> Response {
    let Some(mcp) = manager(&app) else {
        return crate::proxy(State(app), request).await;
    };
    let params: HashMap<_, _> = reqwest::Url::parse(&format!(
        "http://localhost/?{}",
        request.uri().query().unwrap_or("")
    ))
    .map(|url| {
        url.query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    })
    .unwrap_or_default();
    match mcp.oauth.callback(
        params.get("state").map(String::as_str).unwrap_or(""),
        params.get("code").map(String::as_str),
        params.get("error").map(String::as_str),
    ) {
        Ok(()) => Json(json!({"status":"authorization_received"})).into_response(),
        Err(_) => detail(400, oauth::STATE_ERROR),
    }
}
pub async fn reset(
    State(app): State<App>,
    Path(service): Path<String>,
    request: Request,
) -> Response {
    let Some(mcp) = manager(&app) else {
        return crate::proxy(State(app), request).await;
    };
    let user = match actor(&app, request.headers()) {
        Ok(user) => user,
        Err(response) => return *response,
    };
    match mcp.reset(&service, &user).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => match error.to_string().as_str() {
            "Unknown Google service" => detail(404, "Unknown Google Workspace service"),
            oauth::IN_USE => detail(409, oauth::IN_USE),
            _ => (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response(),
        },
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Execute {
    server_name: String,
    tool_name: String,
    canonical_arguments: String,
    arguments_sha256: String,
}
impl Execute {
    fn valid(&self) -> bool {
        [&self.server_name, &self.tool_name]
            .iter()
            .all(|s| (1..=128).contains(&s.chars().count()))
            && (2..=4_000_000).contains(&self.canonical_arguments.chars().count())
            && self.arguments_sha256.len() == 64
            && self
                .arguments_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}
pub async fn execute(
    State(app): State<App>,
    Path(request_id): Path<String>,
    request: Request,
) -> Response {
    let Some(mcp) = manager(&app) else {
        return crate::proxy(State(app), request).await;
    };
    let user = match actor(&app, request.headers()) {
        Ok(user) => user,
        Err(response) => return *response,
    };
    let token =
        crate::preparation::header(request.headers(), "x-daedalus-approval-token").to_string();
    let bytes = match to_bytes(request.into_body(), 32 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return detail(413, "Request too large"),
    };
    let body:Execute=match serde_json::from_slice(&bytes){Ok(body)if Execute::valid(&body)=>body,_=>return (StatusCode::UNPROCESSABLE_ENTITY,Json(json!({"detail":[{"type":"value_error","loc":["body"],"msg":"Invalid approval request"}]}))).into_response()};
    if request_id.is_empty() || request_id.chars().count() > 128 {
        return detail(400, "Invalid approval request ID");
    }
    let arguments: Value = match serde_json::from_str(&body.canonical_arguments) {
        Ok(args) => args,
        Err(_) => return detail(400, "Canonical MCP arguments are invalid"),
    };
    if !arguments.is_object() {
        return detail(400, "MCP arguments must be an object");
    }
    if authorization::hash(&body.canonical_arguments) != body.arguments_sha256 {
        return detail(409, "MCP arguments do not match their approved hash");
    }
    if mcp
        .approvals
        .policies
        .read_only(&body.server_name, &body.tool_name)
    {
        return detail(
            409,
            "Direct execution is limited to approval-gated operations",
        );
    }
    // Keep the two identity components distinct. A separator in the server
    // name must never redirect a valid credential to a different operation.
    if body.server_name.contains("__")
        || body.tool_name == "connect"
        || !mcp.owns(&format!("{}__{}", body.server_name, body.tool_name))
    {
        return detail(409, "Exact MCP approval credential is missing or invalid");
    }
    if let Err(error) = mcp
        .approvals
        .validate(
            &user,
            &token,
            &body.server_name,
            &body.tool_name,
            &body.arguments_sha256,
            false,
        )
        .await
    {
        if error.to_string() == "Redis unavailable" {
            return (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response();
        }
        return detail(409, "Exact MCP approval credential is missing or invalid");
    }
    let (id, mut status) = match app.executions.start(mcp, user, body, arguments, token) {
        Ok(record) => record,
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response();
        }
    };
    let _ = tokio::time::timeout(
        Duration::from_secs(130),
        status.wait_for(|s| s["status"] != "running"),
    )
    .await;
    let payload = payload(&id, &status.borrow(), true);
    let status = match payload["status"].as_str() {
        Some("completed") => StatusCode::OK,
        Some("failed") => StatusCode::UNPROCESSABLE_ENTITY,
        _ => StatusCode::ACCEPTED,
    };
    (status, Json(payload)).into_response()
}
pub async fn get_execution(
    State(app): State<App>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    if manager(&app).is_none() {
        return crate::proxy(State(app), request).await;
    }
    let user = match actor(&app, request.headers()) {
        Ok(user) => user,
        Err(response) => return *response,
    };
    match app.executions.get(&id, &user) {
        Some(value) => Json(value).into_response(),
        None => detail(404, "Execution not found"),
    }
}
