//! Memory Center and completed-turn retention APIs, with Python wire contracts.
use crate::{
    App, hindsight,
    memory_tools::{json_text, trim},
    output::{chars, clip},
};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::LazyLock};
use subtle::ConstantTimeEq;

pub(crate) type ApiResult<T> = Result<T, (u16, Value)>;
pub(crate) fn detail(status: u16, message: &str) -> (u16, Value) {
    (status, json!({"detail":message}))
}
fn response((status, mut body): (u16, Value)) -> Response {
    if status == 500 {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response();
    }
    let allow = body.as_object_mut().and_then(|m| m.remove("$allow"));
    let mut response = (StatusCode::from_u16(status).unwrap(), Json(body)).into_response();
    if let Some(Value::String(allow)) = allow {
        response
            .headers_mut()
            .insert("Allow", allow.parse().unwrap());
    }
    response
}
pub fn routes() -> Router<App> {
    let mut router = Router::new();
    for path in [
        "/v1/memory/retain-turn",
        "/v1/memory/operations/{operation_id}",
        "/v1/memory/operations/{operation_id}/retry",
        "/v1/memory-pages",
        "/v1/memory-pages/{page_id}",
        "/v1/memories",
        "/v1/memories/clear",
        "/v1/memories/{memory_id}",
        "/v1/memories/{memory_id}/invalidate",
        "/v1/memory-sources",
        "/v1/memory-sources/{document_id}",
    ] {
        router = router
            .route(path, any(handle))
            .route(&format!("{path}/"), any(handle));
    }
    router
}
pub(crate) fn actor(app: &App, headers: &HeaderMap) -> ApiResult<String> {
    if app.internal_token.is_empty() && !app.insecure {
        return Err(detail(503, "Internal API authentication is not configured"));
    }
    let token = crate::preparation::header(headers, "x-daedalus-internal-token");
    if !app.internal_token.is_empty()
        && !bool::from(
            Sha256::digest(app.internal_token.as_bytes()).ct_eq(&Sha256::digest(token.as_bytes())),
        )
    {
        return Err(detail(401, "Internal API token is required"));
    }
    let user = crate::preparation::header(headers, "x-user-id");
    if user.is_empty() {
        return Err(detail(401, "Authenticated user is required"));
    }
    Ok(user.into())
}
fn resource(value: &str, label: &str) -> ApiResult<String> {
    let value = trim(value);
    static ID: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$").unwrap());
    if !ID.is_match(value) {
        return Err(detail(400, &format!("invalid {label}")));
    }
    Ok(value.into())
}
/// urllib.parse.unquote: only `%` followed by two ASCII hex digits is decoded,
/// and invalid UTF-8 becomes U+FFFD. Paths may carry raw UTF-8, so never slice
/// the string at byte offsets; the resource pattern rejects non-ASCII IDs later.
fn decode(value: &str) -> String {
    fn hex(byte: u8) -> Option<u8> {
        (byte as char).to_digit(16).map(|digit| digit as u8)
    }
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let (Some(high), Some(low)) = (
                bytes.get(i + 1).copied().and_then(hex),
                bytes.get(i + 2).copied().and_then(hex),
            )
        {
            decoded.push(high << 4 | low);
            i += 3;
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}
pub(crate) fn validation_error(
    kind: &str,
    location: Value,
    message: &str,
    input: &Value,
    context: Option<Value>,
) -> Value {
    let mut error = json!({"type":kind,"loc":location,"msg":message,"input":input});
    if let Some(context) = context {
        error["ctx"] = context;
    }
    error
}
pub(crate) async fn read_body(headers: &HeaderMap, body: axum::body::Body) -> ApiResult<Value> {
    let bytes = to_bytes(body, 128 * 1024 * 1024)
        .await
        .map_err(|_| detail(413, "Request too large"))?;
    let input = if bytes.is_empty() {
        Value::Null
    } else if headers
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|value| {
            let media = value.split(';').next().unwrap().trim().to_ascii_lowercase();
            media != "application/json"
                && !(media.starts_with("application/") && media.ends_with("+json"))
        })
    {
        json!(String::from_utf8_lossy(&bytes))
    } else {
        serde_json::from_slice(&bytes).map_err(|_| {
            (
                422,
                json!({"detail":[{
                    "type":"json_invalid","loc":["body"],"msg":"JSON decode error","input":{},
                    "ctx":{"error":"Invalid JSON"}
                }]}),
            )
        })?
    };
    Ok(input)
}
fn validate_body(kind: &str, input: &Value) -> ApiResult<Value> {
    let Some(map) = input.as_object() else {
        let error = if input.is_null() {
            validation_error("missing", json!(["body"]), "Field required", input, None)
        } else {
            validation_error(
                "model_attributes_type",
                json!(["body"]),
                "Input should be a valid dictionary or object to extract fields from",
                input,
                None,
            )
        };
        return Err((422, json!({"detail":[error]})));
    };
    // (name, nullable, required, minimum characters, maximum characters, default)
    let fields: Vec<(&str, bool, bool, usize, usize, Value)> = match kind {
        "turn" => vec![
            ("request_id", false, true, 1, 256, Value::Null),
            ("conversation_id", true, false, 0, 256, Value::Null),
            ("assistant_message_id", true, false, 0, 256, Value::Null),
            ("user_content", true, false, 0, 12000, Value::Null),
            ("assistant_content", true, false, 0, 12000, Value::Null),
            ("content", true, false, 0, 12000, Value::Null),
        ],
        "edit" => vec![("text", false, true, 1, 12000, Value::Null)],
        "invalidate" => vec![(
            "reason",
            false,
            false,
            0,
            500,
            json!("user requested forget"),
        )],
        "clear" => vec![("confirmation", false, true, 0, usize::MAX, Value::Null)],
        _ => unreachable!(),
    };
    let mut output = json!({});
    let mut errors = Vec::new();
    for (name, nullable, required, min, max, default) in &fields {
        let loc = json!(["body", name]);
        let Some(value) = map.get(*name) else {
            if *required {
                errors.push(validation_error(
                    "missing",
                    loc,
                    "Field required",
                    input,
                    None,
                ));
            } else {
                output[*name] = default.clone();
            }
            continue;
        };
        if *nullable && value.is_null() {
            output[*name] = Value::Null;
            continue;
        }
        let Some(text) = value.as_str() else {
            errors.push(validation_error(
                "string_type",
                loc,
                "Input should be a valid string",
                value,
                None,
            ));
            continue;
        };
        let length = chars(text);
        if length < *min {
            errors.push(validation_error(
                "string_too_short",
                loc,
                &format!(
                    "String should have at least {min} character{}",
                    if *min == 1 { "" } else { "s" }
                ),
                value,
                Some(json!({"min_length":min})),
            ));
        } else if length > *max {
            errors.push(validation_error(
                "string_too_long",
                loc,
                &format!(
                    "String should have at most {max} character{}",
                    if *max == 1 { "" } else { "s" }
                ),
                value,
                Some(json!({"max_length":max})),
            ));
        } else {
            output[*name] = value.clone();
        }
    }
    for (name, value) in map {
        if !fields.iter().any(|f| f.0 == name) {
            errors.push(validation_error(
                "extra_forbidden",
                json!(["body", name]),
                "Extra inputs are not permitted",
                value,
                None,
            ));
        }
    }
    if errors.is_empty()
        && kind == "turn"
        && !crate::config::truthy(&output["user_content"])
        && !crate::config::truthy(&output["content"])
    {
        errors.push(validation_error(
            "value_error",
            json!(["body"]),
            "Value error, user_content or content is required",
            input,
            Some(json!({"error":{}})),
        ));
    }
    if errors.is_empty() {
        Ok(output)
    } else {
        Err((422, json!({"detail":errors})))
    }
}
fn query_integer(
    params: &HashMap<String, String>,
    name: &str,
    default: i64,
    min: i64,
    max: Option<i64>,
    errors: &mut Vec<Value>,
) -> String {
    let Some(value) = params.get(name) else {
        return default.to_string();
    };
    // Pydantic integer query coercion accepts signs, internal underscores, and
    // an all-zero fractional part; it does not accept scientific notation.
    static INT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[+-]?[0-9](?:_?[0-9])*(?:\.0+)?$").unwrap());
    let clean = value.trim();
    let integer = clean.split('.').next().unwrap().replace('_', "");
    let digits = integer
        .trim_start_matches(['+', '-'])
        .trim_start_matches('0');
    let integer = if digits.is_empty() {
        "0".into()
    } else {
        format!(
            "{}{digits}",
            if integer.starts_with('-') { "-" } else { "" }
        )
    };
    let parsed = INT.is_match(clean).then(|| {
        integer
            .parse::<i64>()
            .unwrap_or(if integer.starts_with('-') {
                i64::MIN
            } else {
                i64::MAX
            })
    });
    let loc = json!(["query", name]);
    let input = json!(value);
    match parsed {
        None => errors.push(validation_error(
            "int_parsing",
            loc,
            "Input should be a valid integer, unable to parse string as an integer",
            &input,
            None,
        )),
        Some(n) if n < min => errors.push(validation_error(
            "greater_than_equal",
            loc,
            &format!("Input should be greater than or equal to {min}"),
            &input,
            Some(json!({"ge":min})),
        )),
        Some(n) if max.is_some_and(|max| n > max) => {
            let max = max.unwrap();
            errors.push(validation_error(
                "less_than_equal",
                loc,
                &format!("Input should be less than or equal to {max}"),
                &input,
                Some(json!({"le":max})),
            ));
        }
        Some(_) => return integer,
    }
    default.to_string()
}
fn sanitized(value: &str) -> String {
    static CONTROL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\[(?:[iİı]dent[iİı]ty|memory_context|source_pol[iİı]cy)\]").unwrap()
    });
    static BOUNDARY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\n\[[A-Za-z_İıſK]+\]").unwrap());
    static DATA: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)data:[^\s)\]\x1c-\x1f]+").unwrap());
    static REDIS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)red[iİı]ss?://[^\s)\]\x1c-\x1f]+").unwrap());
    let mut cleaned = String::new();
    let mut tail = value;
    while let Some(start) = CONTROL.find(tail) {
        cleaned.push_str(&tail[..start.start()]);
        tail = &tail[start.end()..];
        tail = BOUNDARY
            .find(tail)
            .map(|end| &tail[end.start()..])
            .unwrap_or("");
    }
    cleaned.push_str(tail);
    let cleaned = DATA.replace_all(&cleaned, "[embedded data omitted]");
    let cleaned = REDIS.replace_all(&cleaned, "[internal reference omitted]");
    clip(trim(&cleaned), 5500)
}
fn turn_document(user: &str, assistant: &str) -> ApiResult<String> {
    let mut user = sanitized(user);
    let mut assistant = sanitized(assistant);
    if user.is_empty() {
        return Err(detail(400, "user content is empty after sanitization"));
    }
    loop {
        let mut messages = vec![json!({"role":"user","content":user})];
        if !assistant.is_empty() {
            messages.push(json!({"role":"assistant","content":assistant}));
        }
        let result = json_text(
            &json!({"schema":"daedalus.completed-turn.v1","status":"completed","messages":messages}),
            false,
            false,
            false,
        );
        let length = chars(&result);
        if length <= 12000 {
            return Ok(result);
        }
        let excess = length - 12000 + 1;
        if !assistant.is_empty() {
            assistant = clip(&assistant, chars(&assistant).saturating_sub(excess));
        } else {
            user = clip(&user, chars(&user).saturating_sub(excess).max(1));
        }
    }
}
fn py_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Null => "None".into(),
        _ => crate::output::compact(value),
    }
}
fn normalized_operation(value: &Value) -> ApiResult<Value> {
    let string = |key: &str, default: &str| {
        if crate::config::truthy(&value[key]) {
            py_string(&value[key])
        } else {
            default.into()
        }
    };
    let status = string("status", "not_found");
    let count = |key: &str| crate::config::integer(&value["result_metadata"][key]).unwrap_or(0);
    let units = count("unit_ids_count");
    let status = if status == "completed" && units == 0 {
        "zero_fact"
    } else if [
        "pending",
        "processing",
        "completed",
        "failed",
        "cancelled",
        "not_found",
    ]
    .contains(&status.as_str())
    {
        &status
    } else {
        "not_found"
    };
    let retries = if crate::config::truthy(&value["retry_count"]) {
        crate::config::integer(&value["retry_count"])
            .map_err(|_| detail(500, "Internal Server Error"))?
    } else {
        0
    };
    Ok(
        json!({"operation_id":string("operation_id",""),"status":status,"unit_ids_count":units,"extraction_errors_count":count("extraction_errors_count"),"retry_count":retries,"created_at":value["created_at"],"updated_at":value["updated_at"],"completed_at":value["completed_at"]}),
    )
}
fn project(value: &Value, fields: &[&str]) -> Value {
    Value::Object(
        fields
            .iter()
            .map(|k| ((*k).into(), value[*k].clone()))
            .collect(),
    )
}
fn valid_tree(tree: &Value) -> ApiResult<()> {
    if tree
        .get("roots")
        .is_some_and(|v| v.is_null() || v.is_boolean() || v.is_number())
    {
        Err(detail(500, "Internal Server Error"))
    } else {
        Ok(())
    }
}
fn flatten(nodes: &Value, pages: &mut Vec<Value>) {
    if let Some(nodes) = nodes.as_array() {
        for node in nodes.iter().filter(|v| v.is_object()) {
            if node["kind"] == "page" {
                pages.push(project(
                    node,
                    &["id", "name", "description", "tags", "timestamp", "is_stale"],
                ));
            }
            flatten(&node["children"], pages);
        }
    }
}
fn upstream(error: anyhow::Error) -> (u16, Value) {
    // HTTPX reports an incomplete HTTP response as a protocol error outside
    // the baseline's HindsightError mapping. Preserve its generic HTTP 500.
    if error
        .chain()
        .any(|e| e.to_string() == "connection closed before message completed")
    {
        return detail(500, "Internal Server Error");
    }
    match error
        .downcast_ref::<reqwest::Error>()
        .and_then(|e| e.status())
        .map(|s| s.as_u16())
    {
        Some(400) => detail(400, "Memory service rejected this request."),
        Some(404) => detail(404, "Memory resource was not found. Refresh and try again."),
        _ => detail(502, "memory service unavailable"),
    }
}
async fn handle(State(app): State<App>, request: Request) -> Response {
    if app.preparation.is_none() {
        return crate::proxy(State(app), request).await;
    }
    if let Err(error) = actor(&app, request.headers()) {
        return response(error);
    }
    if request.uri().path().ends_with('/') {
        let mut target = request.uri().path().trim_end_matches('/').to_owned();
        if let Some(query) = request.uri().query() {
            target.push('?');
            target.push_str(query);
        }
        return axum::response::Redirect::temporary(&target).into_response();
    }
    match dispatch(&app, request).await {
        Ok(body) => Json(body).into_response(),
        Err(error) => response(error),
    }
}
async fn dispatch(app: &App, request: Request) -> ApiResult<Value> {
    let user = actor(app, request.headers())?;
    let preparation = app.preparation.as_ref().unwrap();
    let memory = &preparation.memory;
    let client = &preparation.memory_tools.hindsight;
    let (parts, body) = request.into_parts();
    let path = parts.uri.path().trim_end_matches('/');
    let segments: Vec<_> = path.split('/').collect();
    let method = &parts.method;
    let collection = segments.get(2).copied().unwrap_or("");
    let resource_raw = segments.get(3).map(|s| decode(s)).unwrap_or_default();
    let allowed = match (
        collection,
        segments.len(),
        segments.get(3).copied(),
        segments.last().copied(),
    ) {
        ("memory", 4, Some("retain-turn"), _) => "POST",
        ("memory", 5, Some("operations"), _) => "GET",
        ("memory", 6, Some("operations"), Some("retry")) => "POST",
        ("memories", 3, _, _) | ("memory-sources" | "memory-pages", 3, _, _) => "GET",
        ("memories", 4, Some("clear"), _) => "POST, PATCH",
        ("memories", 4, _, _) => "PATCH",
        ("memories", 5, _, Some("invalidate")) => "POST",
        ("memory-sources", 4, _, _) => "GET, DELETE",
        ("memory-pages", 4, _, _) => "GET",
        _ => return Err(detail(404, "Not Found")),
    };
    if !allowed.split(", ").any(|s| s == method.as_str()) {
        let mut error = detail(405, "Method Not Allowed");
        error.1["$allow"] = json!(allowed.split(", ").next().unwrap());
        return Err(error);
    }
    let kind = match (collection, method, segments.len(), resource_raw.as_str()) {
        ("memory", &Method::POST, 4, "retain-turn") => Some("turn"),
        ("memories", &Method::PATCH, 4, _) => Some("edit"),
        ("memories", &Method::POST, 5, _) => Some("invalidate"),
        ("memories", &Method::POST, 4, "clear") => Some("clear"),
        _ => None,
    };
    let data = if let Some(kind) = kind {
        let input = read_body(&parts.headers, body).await?;
        validate_body(kind, &input)?
    } else {
        json!({})
    };
    let params: HashMap<_, _> = reqwest::Url::parse(&format!(
        "http://localhost/?{}",
        parts.uri.query().unwrap_or("")
    ))
    .unwrap()
    .query_pairs()
    .map(|(k, v)| (k.into_owned(), v.into_owned()))
    .collect();
    let listing = segments.len() == 3 && ["memories", "memory-sources"].contains(&collection);
    let mut errors = Vec::new();
    let limit = if listing {
        query_integer(&params, "limit", 25, 1, Some(100), &mut errors)
    } else {
        "25".into()
    };
    let offset = if listing {
        query_integer(&params, "offset", 0, 0, None, &mut errors)
    } else {
        "0".into()
    };
    if !errors.is_empty() {
        return Err((422, json!({"detail":errors})));
    }
    if !memory.enabled {
        return Err(detail(503, "Hindsight memory is not enabled"));
    }
    let actor_id = user.as_str();
    let call = |method, suffix: String, body, query: Vec<(String, String)>, timeout| async move {
        let query: Vec<_> = query
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        client
            .request(method, actor_id, &suffix, body, &query, timeout)
            .await
            .map_err(upstream)
    };
    let turn = if kind == Some("turn") {
        Some((
            resource(data["request_id"].as_str().unwrap(), "request ID")?,
            turn_document(
                data["user_content"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or(data["content"].as_str())
                    .unwrap_or(""),
                data["assistant_content"].as_str().unwrap_or(""),
            )?,
        ))
    } else {
        None
    };
    // Retention and page discovery initialize only missing managed defaults.
    if (turn.is_some() || collection == "memory-pages" && segments.len() == 3)
        && memory.initialize(&user).await.is_err()
    {
        tracing::warn!(event = "memory_bank_initialization_failed");
    }
    if let Some((request, content)) = turn {
        let id = format!(
            "daedalus-turn-{}",
            crate::memory::digest(&[&crate::memory::bank_id(&user), "turn", &request, &content])
        );
        let operation = uuid::Uuid::new_v5(
            &uuid::Uuid::parse_str("21b4c9b7-39a3-4c5e-8e31-66e2223e5040").unwrap(),
            id.as_bytes(),
        )
        .to_string();
        let result=call(Method::POST,"memories".into(),Some(json!({"items":[{"content":content,"document_id":id,"context":"Daedalus completed interactive turn","metadata":{"source":"interactive-turn","schema":"daedalus.completed-turn.v1","status":"completed","request_id":request,"conversation_id":data["conversation_id"].as_str().unwrap_or(""),"assistant_message_id":data["assistant_message_id"].as_str().unwrap_or("")},"tags":["source:interactive-turn"],"observation_scopes":"shared","update_mode":"replace","timestamp":chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()}],"async":true,"operation_id":operation})),vec![],Some(15.)).await?;
        return Ok(
            json!({"status":"accepted","operation_id":result["operation_id"],"document_id":id}),
        );
    }
    if collection == "memory" {
        let id = resource(&decode(segments[4]), "operation ID")?;
        let suffix = format!(
            "operations/{}{}",
            hindsight::quote(&id),
            if method == Method::POST { "/retry" } else { "" }
        );
        let result = call(
            method.clone(),
            suffix,
            (method == Method::POST).then(|| json!({})),
            vec![],
            None,
        )
        .await?;
        return if method == Method::POST {
            Ok(json!({"operation_id":id,"status":"pending"}))
        } else {
            normalized_operation(&result)
        };
    }
    if kind == Some("clear") {
        if data["confirmation"] != "DELETE ALL MY MEMORIES" {
            return Err(detail(400, "confirmation phrase does not match"));
        }
        // Same lifecycle as the retained Python memory_lifecycle.clear_user_memory.
        let result = client.clear_user_memory(&user, memory).await.map_err(|_| {
            detail(
                503,
                "memory deletion did not finish; cleanup must be retried",
            )
        })?;
        memory
            .initialize(&user)
            .await
            .map_err(|_| detail(500, "Internal Server Error"))?;
        return Ok(json!({"status":"cleared","result":result}));
    }
    if listing {
        let mut query = vec![
            ("limit".into(), limit.to_string()),
            ("offset".into(), offset.to_string()),
        ];
        if let Some(q) = params.get("q").filter(|s| !trim(s).is_empty()) {
            query.push(("q".into(), trim(q).into()));
        }
        if collection == "memories"
            && let Some(kind) = params
                .get("memory_type")
                .filter(|s| ["world", "experience", "observation"].contains(&s.as_str()))
        {
            query.push(("type".into(), kind.clone()));
        }
        return call(
            Method::GET,
            if collection == "memories" {
                "memories/list"
            } else {
                "documents"
            }
            .into(),
            None,
            query,
            None,
        )
        .await;
    }
    if collection == "memory-pages" && segments.len() == 3 {
        let tree = call(
            Method::GET,
            "knowledge-base/tree".into(),
            None,
            vec![],
            None,
        )
        .await?;
        valid_tree(&tree)?;
        let mut pages = Vec::new();
        flatten(&tree["roots"], &mut pages);
        return Ok(json!({"total":pages.len(),"items":pages}));
    }
    let label = match collection {
        "memories" => "memory ID",
        "memory-pages" => "page ID",
        _ => "document ID",
    };
    let id = resource(&resource_raw, label)?;
    let suffix = format!(
        "{}/{}",
        match collection {
            "memories" => "memories",
            "memory-pages" => "knowledge-base/pages",
            _ => "documents",
        },
        hindsight::quote(&id)
    );
    let body = match kind {
        Some("edit") => {
            let text = trim(data["text"].as_str().unwrap());
            if text.is_empty() {
                return Err(detail(400, "memory text is required"));
            }
            Some(json!({"text":text}))
        }
        Some("invalidate") => {
            let reason = data["reason"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("user requested forget");
            Some(json!({"state":"invalidated","reason":clip(trim(reason),500)}))
        }
        _ => None,
    };
    let result = call(
        if kind == Some("invalidate") {
            Method::PATCH
        } else {
            method.clone()
        },
        suffix,
        body,
        vec![],
        None,
    )
    .await?;
    Ok(if collection == "memory-pages" {
        project(
            &result,
            &[
                "id",
                "name",
                "type",
                "description",
                "tags",
                "timestamp",
                "body",
                "markdown",
            ],
        )
    } else {
        result
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    fn expand(value: Value) -> Value {
        match value {
            Value::Object(map) if map.len() == 1 && map.contains_key("$string_parts") => json!(
                map["$string_parts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s.as_str().unwrap())
                    .collect::<String>()
            ),
            Value::Object(map) => {
                Value::Object(map.into_iter().map(|(k, v)| (k, expand(v))).collect())
            }
            Value::Array(items) => Value::Array(items.into_iter().map(expand).collect()),
            other => other,
        }
    }
    pub(crate) mod peers {
        //! Local Hindsight and RESP peers for route-level tests.
        use axum::{Json, Router, body::Bytes, http::Uri};
        use serde_json::{Value, json};
        use std::sync::Arc;
        use tokio::{
            io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt},
            sync::Mutex,
        };

        pub type Calls = Arc<Mutex<Vec<Value>>>;
        /// Records each call as {method, path, query, body};
        /// `reply(call, call_index)` shapes the JSON reply.
        pub async fn hindsight(
            reply: fn(&Value, usize) -> Value,
        ) -> (String, Calls, tokio::task::JoinHandle<()>) {
            let calls = Calls::default();
            let seen = calls.clone();
            let router = Router::new().fallback(
                move |method: axum::http::Method, uri: Uri, body: Bytes| {
                    let seen = seen.clone();
                    async move {
                        let mut calls = seen.lock().await;
                        let call = json!({"method":method.as_str(),"path":uri.path(),"query":uri.query(),
                            "body":serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null)});
                        let reply = reply(&call, calls.len());
                        calls.push(call);
                        Json(reply)
                    }
                },
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
            (base, calls, task)
        }
        /// Minimal RESP2 peer: GET misses, SCAN is empty, DEL deletes nothing
        /// and every other command (handshake, SET, EVAL) succeeds.
        pub async fn redis() -> (
            String,
            Arc<Mutex<Vec<Vec<String>>>>,
            tokio::task::JoinHandle<()>,
        ) {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("redis://{}", listener.local_addr().unwrap());
            let commands = Arc::new(Mutex::new(Vec::new()));
            let seen = commands.clone();
            let task = tokio::spawn(async move {
                loop {
                    let (stream, _) = listener.accept().await.unwrap();
                    let seen = seen.clone();
                    tokio::spawn(async move {
                        let (read, mut write) = stream.into_split();
                        let mut read = tokio::io::BufReader::new(read);
                        let mut line = String::new();
                        loop {
                            line.clear();
                            if read.read_line(&mut line).await.unwrap_or(0) == 0 {
                                return;
                            }
                            let count: usize = line.trim_end()[1..].parse().unwrap();
                            let mut args = Vec::new();
                            for _ in 0..count {
                                line.clear();
                                read.read_line(&mut line).await.unwrap();
                                let length: usize = line.trim_end()[1..].parse().unwrap();
                                let mut data = vec![0; length + 2];
                                read.read_exact(&mut data).await.unwrap();
                                data.truncate(length);
                                args.push(String::from_utf8(data).unwrap());
                            }
                            let reply: &[u8] = match args[0].to_ascii_uppercase().as_str() {
                                "GET" => b"$-1\r\n",
                                "SCAN" => b"*2\r\n$1\r\n0\r\n*0\r\n",
                                "DEL" => b":0\r\n",
                                _ => b"+OK\r\n",
                            };
                            seen.lock().await.push(args);
                            write.write_all(reply).await.unwrap();
                        }
                    });
                }
            });
            (url, commands, task)
        }
        pub fn app(hindsight: &str, redis: &str) -> Router {
            let config = crate::config::Config::new(
                json!({"llms":{"main":{"base_url":"http://model.invalid","model_name":"fixture"}},
                    "workflow":{"_type":"daedalus_rust_agent","llm_name":"main"}}),
                [
                    ("HINDSIGHT_API_URL".into(), hindsight.into()),
                    ("HINDSIGHT_API_KEY".into(), "synthetic-memory-key".into()),
                    ("REDIS_URL".into(), redis.into()),
                ]
                .into(),
            )
            .unwrap();
            let http = reqwest::Client::new();
            crate::router(crate::App {
                preparation: Some(crate::preparation::Preparation::new(config).unwrap()),
                http,
                tools_url: "http://127.0.0.1:1".into(),
                internal_token: Arc::new("synthetic-internal".into()),
                insecure: false,
                runs: Arc::default(),
                executions: Arc::default(),
            })
        }
        pub async fn send(
            app: &Router,
            method: &str,
            path: &str,
            body: Option<Value>,
        ) -> (u16, Value) {
            use tower::ServiceExt;
            let request = axum::http::Request::builder()
                .method(method)
                .uri(path)
                .header("x-daedalus-internal-token", "synthetic-internal")
                .header("x-user-id", "synthetic-alice")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    body.map(|b| b.to_string()).unwrap_or_default(),
                ))
                .unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            let status = response.status().as_u16();
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            (
                status,
                serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            )
        }
    }

    #[tokio::test]
    async fn resource_ids_are_unquoted_without_slicing_raw_utf8() {
        let (base, calls, peer) = peers::hindsight(|_, _| json!({"id":"source-1"})).await;
        let app = peers::app(&base, "redis://127.0.0.1:1");
        // Raw UTF-8 after an incomplete escape previously panicked the handler
        // by slicing inside a multibyte character.
        assert_eq!(
            peers::send(
                &app,
                "PATCH",
                "/v1/memories/%a\u{e9}",
                Some(json!({"text":"x"}))
            )
            .await,
            (400, json!({"detail":"invalid memory ID"}))
        );
        // urllib.parse.unquote replaces undecodable bytes; the route's own ID
        // label and method checks apply, as in the retained Python API.
        assert_eq!(
            peers::send(&app, "GET", "/v1/memory-pages/%ff", None).await,
            (400, json!({"detail":"invalid page ID"}))
        );
        assert_eq!(
            peers::send(&app, "POST", "/v1/memory-pages/%ff", None).await,
            (405, json!({"detail":"Method Not Allowed"}))
        );
        // A signed pseudo-escape is not an escape; it must not decode to a
        // trimmed tab and silently address another operation.
        assert_eq!(
            peers::send(&app, "GET", "/v1/memory/operations/%+9abc", None).await,
            (400, json!({"detail":"invalid operation ID"}))
        );
        assert_eq!(
            peers::send(&app, "GET", "/v1/memory-sources/source%2D1", None).await,
            (200, json!({"id":"source-1"}))
        );
        let calls = calls.lock().await;
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert_eq!(calls[0]["method"], "GET");
        assert!(
            calls[0]["path"]
                .as_str()
                .unwrap()
                .ends_with("/documents/source-1"),
            "{calls:?}"
        );
        peer.abort();
    }

    #[tokio::test]
    async fn memory_clear_uses_the_shared_deletion_lifecycle() {
        fn reply(call: &Value, index: usize) -> Value {
            let (method, path) = (&call["method"], call["path"].as_str().unwrap());
            if index == 0 && path.ends_with("/knowledge-base/tree") {
                json!({"roots":[{"id":"root-1"},{"id":["a"]},{"id":""},{"id":0},{"id":" \u{1c}"},"x"]})
            } else if method == "DELETE" && path.ends_with("/memories") {
                json!({"deleted":3})
            } else {
                json!({})
            }
        }
        let (base, calls, peer) = peers::hindsight(reply).await;
        let (redis, commands, redis_peer) = peers::redis().await;
        let app = peers::app(&base, &redis);
        assert_eq!(
            peers::send(
                &app,
                "POST",
                "/v1/memories/clear",
                Some(json!({"confirmation":"delete all my memories"}))
            )
            .await,
            (400, json!({"detail":"confirmation phrase does not match"}))
        );
        assert!(calls.lock().await.is_empty());
        assert_eq!(
            peers::send(
                &app,
                "POST",
                "/v1/memories/clear",
                Some(json!({"confirmation":"DELETE ALL MY MEMORIES"}))
            )
            .await,
            (200, json!({"status":"cleared","result":{"deleted":3}}))
        );
        let calls = calls.lock().await.clone();
        let bank = format!(
            "/v1/default/banks/{}/",
            crate::memory::bank_id("synthetic-alice")
        );
        let deletion: Vec<_> = calls[..4]
            .iter()
            .map(|call| {
                format!(
                    "{} {}",
                    call["method"].as_str().unwrap(),
                    call["path"].as_str().unwrap().strip_prefix(&bank).unwrap()
                )
            })
            .collect();
        // Python's str() names a non-string root; blank and falsy IDs are
        // skipped. Bank defaults are restored only after deletion completes.
        assert_eq!(
            deletion,
            [
                "GET knowledge-base/tree",
                "DELETE memories",
                "DELETE knowledge-base/nodes/root-1",
                "DELETE knowledge-base/nodes/%5B%27a%27%5D",
            ]
        );
        assert_eq!(calls[4]["path"], format!("{bank}config"));
        let commands = commands.lock().await;
        let user = crate::memory::digest(&[&crate::memory::bank_id("synthetic-alice")]);
        for kind in ["session", "session-lock"] {
            assert!(
                commands.iter().any(|c| c[0] == "SCAN"
                    && c.contains(&format!("daedalus:memory:{kind}:v1:{user}:*"))),
                "{commands:?}"
            );
        }
        assert!(
            commands
                .iter()
                .any(|c| c[0] == "DEL" && c[1].starts_with("daedalus:memory:bootstrap:"))
        );
        drop(commands);
        peer.abort();

        // An invalid knowledge tree, or an unavailable cache store, is never
        // acknowledged as a completed deletion.
        let (base, calls, peer) = peers::hindsight(|call, _| {
            if call["path"]
                .as_str()
                .unwrap()
                .ends_with("/knowledge-base/tree")
            {
                json!({"roots":null})
            } else {
                json!({})
            }
        })
        .await;
        let failed = (
            503,
            json!({"detail":"memory deletion did not finish; cleanup must be retried"}),
        );
        let body = Some(json!({"confirmation":"DELETE ALL MY MEMORIES"}));
        let app = peers::app(&base, &redis);
        assert_eq!(
            peers::send(&app, "POST", "/v1/memories/clear", body.clone()).await,
            failed
        );
        assert_eq!(calls.lock().await.len(), 1);
        peer.abort();
        let (base, _, peer) = peers::hindsight(|_, _| json!({})).await;
        let app = peers::app(&base, "redis://127.0.0.1:1");
        assert_eq!(
            peers::send(&app, "POST", "/v1/memories/clear", body).await,
            failed
        );
        peer.abort();
        redis_peer.abort();
    }

    #[test]
    fn frozen_public_memory_contracts() {
        let fixture = expand(
            serde_json::from_str(include_str!("../tests/fixtures/memory-api.json")).unwrap(),
        );
        for (i, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            let input = &case["input"];
            let result = match case["kind"].as_str().unwrap() {
                "turn" => turn_document(input[0].as_str().unwrap(), input[1].as_str().unwrap())
                    .map(Value::String),
                "operation" => normalized_operation(input),
                "flatten" => {
                    let mut pages = vec![];
                    flatten(input, &mut pages);
                    Ok(json!(pages))
                }
                kind => validate_body(kind.strip_suffix("_body").unwrap(), input),
            };
            if let Some(expected) = case["expected"].get("ok") {
                assert_eq!(&result.unwrap(), expected, "case {i}");
            } else if let Some(expected) = case["expected"]["error"].as_array() {
                // Pydantic's model_validate uses root locations; HTTP prepends body.
                let (status, mut actual) = result.unwrap_err();
                assert_eq!(status, 422);
                for error in actual["detail"].as_array_mut().unwrap() {
                    error["loc"].as_array_mut().unwrap().remove(0);
                    if input.is_null() {
                        error["type"] = json!("model_type");
                        error["msg"] = json!("Input should be a valid dictionary or instance");
                    }
                }
                // Root model-instance prose depends on class name and is covered
                // by the real FastAPI/image HTTP comparison, not this pure helper.
                if input.is_object() {
                    assert_eq!(&actual["detail"], &json!(expected), "case {i}");
                }
            } else {
                assert!(result.is_err(), "case {i}");
            }
        }
    }
}
