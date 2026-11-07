//! Stateless model inference. Caller tools are returned, never executed here.
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::Duration,
};

use axum::{
    Json,
    body::Body,
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use futures::StreamExt;
use serde_json::{Value, json};

use crate::{App, authenticate, error};

static ACTIVE: LazyLock<Mutex<HashMap<String, usize>>> = LazyLock::new(Default::default);
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .build()
        .expect("model HTTP client")
});

struct Slot(String);
impl Slot {
    fn acquire(user: String) -> Option<Self> {
        let mut active = ACTIVE.lock().unwrap();
        if active.values().sum::<usize>() >= crate::MAX_RUNS
            || active.get(&user).copied().unwrap_or(0) >= crate::RUNS_PER_USER
        {
            return None;
        }
        *active.entry(user.clone()).or_default() += 1;
        Some(Self(user))
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        let mut active = ACTIVE.lock().unwrap();
        if let Some(count) = active.get_mut(&self.0) {
            *count -= 1;
            if *count == 0 {
                active.remove(&self.0);
            }
        }
    }
}

pub async fn chat(state: State<App>, headers: HeaderMap, body: Json<Value>) -> Response {
    forward(state.0, headers, body.0, "chat/completions").await
}

pub async fn responses(state: State<App>, headers: HeaderMap, body: Json<Value>) -> Response {
    forward(state.0, headers, body.0, "responses").await
}

/// Inspect message/item content only, never caller function schemas or JSON
/// argument strings, where these names may be ordinary application data.
fn references_provider_resource(item: &Value) -> bool {
    item["type"] == "item_reference"
        || !item["file_id"].is_null()
        || !item["file"]["file_id"].is_null()
        || ["content", "output"].iter().any(|key| {
            item[*key]
                .as_array()
                .is_some_and(|parts| parts.iter().any(references_provider_resource))
        })
}

async fn forward(app: App, headers: HeaderMap, mut body: Value, path: &str) -> Response {
    let user = match authenticate(&app, &headers) {
        Ok(user) => user,
        Err(response) => return *response,
    };
    let Some(preparation) = &app.preparation else {
        return error(503, "Direct model requests require Rust preparation");
    };
    let config = &preparation.config;
    if config.variable("DAEDALUS_COMPAT_MODEL_ENABLED", "false") != "true" {
        return error(404, "Model endpoint is disabled");
    }
    if !body.is_object() || body["model"] != "daedalus-model" {
        return error(400, "Expected the daedalus-model alias");
    }
    // Provider resources share a service credential; never resolve caller IDs
    // across users. Inline histories remain byte-for-byte equivalent JSON.
    for key in ["previous_response_id", "conversation", "prompt"] {
        if !body[key].is_null() {
            return error(
                400,
                "Resend inline history; provider resource references are unsupported",
            );
        }
    }
    if ["messages", "input"].iter().any(|key| {
        body[*key]
            .as_array()
            .is_some_and(|items| items.iter().any(references_provider_resource))
    }) {
        return error(
            400,
            "Provider file and item references are unsupported; supply inline content",
        );
    }
    if !matches!(
        body.get("store"),
        None | Some(Value::Null | Value::Bool(false))
    ) || !matches!(
        body.get("background"),
        None | Some(Value::Null | Value::Bool(false))
    ) {
        return error(
            400,
            "Model requests require store=false and background=false",
        );
    }
    if let Some(tools) = body.get("tools").filter(|v| !v.is_null()) {
        let Some(tools) = tools.as_array() else {
            return error(400, "tools must be an array");
        };
        if tools.iter().any(|tool| tool["type"] != "function") {
            return error(400, "Only caller-executed function tools are supported");
        }
    }
    if headers.contains_key("x-conversation-id") || headers.contains_key("idempotency-key") {
        return error(
            400,
            "Model requests do not support saved conversations or idempotency keys",
        );
    }
    let Some(slot) = Slot::acquire(user) else {
        return error(429, "Model request capacity reached");
    };
    let model = config.main_model();
    let configured_name = config.variable("DAEDALUS_COMPAT_MODEL_NAME", "");
    body["model"] = json!(if configured_name.trim().is_empty() {
        model["model_name"].as_str().unwrap_or("")
    } else {
        &configured_name
    });
    body["store"] = json!(false);
    let url = format!(
        "{}/{path}",
        model["base_url"]
            .as_str()
            .unwrap_or("")
            .trim_end_matches('/')
    );
    let upstream = match HTTP
        .post(url)
        .bearer_auth(model["api_key"].as_str().unwrap_or(""))
        .json(&body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return error(502, "Model endpoint request failed"),
    };
    if !upstream.status().is_success() {
        // Provider diagnostics may contain private service URLs or credentials.
        let status = if upstream.status().is_client_error()
            && !matches!(upstream.status().as_u16(), 401 | 403)
        {
            upstream.status().as_u16()
        } else {
            502
        };
        return error(
            status,
            "Model endpoint rejected the request; check its supported request controls",
        );
    }
    if upstream
        .headers()
        .get("x-daedalus-ignored-parameters")
        .is_some_and(|v| !v.is_empty())
    {
        return error(502, "Configured model endpoint ignored request controls");
    }
    let content_type = upstream.headers().get("content-type").cloned();
    let streaming = body["stream"] == true;
    let expected_type = if streaming {
        "text/event-stream"
    } else {
        "application/json"
    };
    if !content_type
        .as_ref()
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with(expected_type))
    {
        return error(502, "Model endpoint returned an invalid content type");
    }
    // The slot and upstream stream drop together on completion or disconnect.
    let stream = futures::stream::unfold(
        (upstream.bytes_stream(), slot),
        |(mut stream, slot)| async move { stream.next().await.map(|chunk| (chunk, (stream, slot))) },
    );
    let mut response = Body::from_stream(stream).into_response();
    response
        .headers_mut()
        .insert("content-type", content_type.unwrap());
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-accel-buffering", "no".parse().unwrap());
    response
}
