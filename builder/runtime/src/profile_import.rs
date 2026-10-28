//! Authenticated bulk profile imports. Replacement stages and confirms a fresh
//! generation before deleting any old profile document; mutations never retry.
use crate::{
    App,
    config::truthy,
    hindsight,
    memory::{bank_id, digest},
    memory_api::{ApiResult, actor, detail, read_body, validation_error},
    memory_tools::{json_text, trim},
};
use anyhow::{Result, bail};
use axum::{
    Json, Router,
    extract::{Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub fn routes() -> Router<App> {
    Router::new()
        .route("/v1/profile/import", any(handle))
        .route("/v1/profile/import/", any(handle))
}
fn respond((status, body): (u16, Value)) -> Response {
    (StatusCode::from_u16(status).unwrap(), Json(body)).into_response()
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
            "/v1/profile/import{}",
            request
                .uri()
                .query()
                .map(|q| format!("?{q}"))
                .unwrap_or_default()
        );
        return axum::response::Redirect::temporary(&target).into_response();
    }
    if request.method() != Method::POST {
        let mut reply = respond(detail(405, "Method Not Allowed"));
        reply.headers_mut().insert("Allow", "POST".parse().unwrap());
        return reply;
    }
    let (parts, body) = request.into_parts();
    let input = match read_body(&parts.headers, body)
        .await
        .and_then(|input| validate(&input, preparation.profile_import_max))
    {
        Ok(input) => input,
        Err(error) => return respond(error),
    };
    if !preparation.memory.enabled {
        return respond(detail(500, "Profile import failed."));
    }
    match import(&preparation.memory_tools.hindsight, &user, &input).await {
        Ok(body) => respond((
            if body["status"] == "accepted" {
                202
            } else {
                200
            },
            body,
        )),
        Err(_) => {
            // Upstream bodies, credentials, and profile contents are private.
            tracing::warn!(event = "profile_import_failed");
            respond(detail(500, "Profile import failed."))
        }
    }
}
fn value_error(loc: Value, message: &str, input: &Value) -> Value {
    validation_error(
        "value_error",
        loc,
        &format!("Value error, {message}"),
        input,
        Some(json!({"error":{}})),
    )
}
fn model_error(loc: Value, input: &Value) -> Value {
    validation_error(
        "model_attributes_type",
        loc,
        "Input should be a valid dictionary or object to extract fields from",
        input,
        None,
    )
}
fn string(
    value: &Value,
    loc: Value,
    maximum: Option<usize>,
    errors: &mut Vec<Value>,
) -> Option<String> {
    let Some(text) = value.as_str() else {
        errors.push(validation_error(
            "string_type",
            loc,
            "Input should be a valid string",
            value,
            None,
        ));
        return None;
    };
    if let Some(maximum) = maximum {
        let length = text.chars().count();
        if length == 0 {
            errors.push(validation_error(
                "string_too_short",
                loc,
                "String should have at least 1 character",
                value,
                Some(json!({"min_length":1})),
            ));
            return None;
        }
        if length > maximum {
            errors.push(validation_error(
                "string_too_long",
                loc,
                &format!("String should have at most {maximum} characters"),
                value,
                Some(json!({"max_length":maximum})),
            ));
            return None;
        }
        if trim(text).is_empty() {
            errors.push(value_error(loc, "value must not be blank", value));
            return None;
        }
        return Some(trim(text).into());
    }
    Some(text.into())
}
fn validate(input: &Value, maximum: i64) -> ApiResult<Value> {
    let mut errors = vec![];
    let Some(map) = input.as_object() else {
        let error = if input.is_null() {
            validation_error("missing", json!(["body"]), "Field required", input, None)
        } else {
            model_error(json!(["body"]), input)
        };
        return Err((422, json!({"detail":[error]})));
    };
    let mut output = json!({"profile_version":null,"mode":"append","entries":[]});
    if let Some(version) = map.get("profile_version").filter(|v| !v.is_null()) {
        output["profile_version"] = json!(string(
            version,
            json!(["body", "profile_version"]),
            None,
            &mut errors
        ));
    }
    if let Some(mode) = map.get("mode") {
        if mode == "append" || mode == "replace" {
            output["mode"] = mode.clone();
        } else {
            errors.push(validation_error(
                "literal_error",
                json!(["body", "mode"]),
                "Input should be 'append' or 'replace'",
                mode,
                Some(json!({"expected":"'append' or 'replace'"})),
            ));
        }
    }
    let entries_loc = json!(["body", "entries"]);
    if let Some(entries) = map.get("entries") {
        if let Some(entries) = entries.as_array() {
            let start = errors.len();
            let mut normalized = vec![];
            for (i, entry) in entries.iter().enumerate() {
                let Some(entry_map) = entry.as_object() else {
                    errors.push(model_error(json!(["body", "entries", i]), entry));
                    continue;
                };
                let mut clean = json!({"tags":[],"metadata":{},"key_value_pairs":null});
                for (name, limit) in [("label", 200), ("memory", 4000)] {
                    let loc = json!(["body", "entries", i, name]);
                    if let Some(value) = entry_map.get(name) {
                        clean[name] = json!(string(value, loc, Some(limit), &mut errors));
                    } else {
                        errors.push(validation_error(
                            "missing",
                            loc,
                            "Field required",
                            entry,
                            None,
                        ));
                    }
                }
                if let Some(tags) = entry_map.get("tags") {
                    if let Some(tags) = tags.as_array() {
                        let mut normalized_tags = vec![];
                        for (j, tag) in tags.iter().enumerate() {
                            if let Some(tag) = string(
                                tag,
                                json!(["body", "entries", i, "tags", j]),
                                None,
                                &mut errors,
                            ) {
                                let tag = trim(&tag).to_owned();
                                if !tag.is_empty() && !normalized_tags.contains(&tag) {
                                    normalized_tags.push(tag);
                                }
                            }
                        }
                        clean["tags"] = json!(normalized_tags);
                    } else {
                        errors.push(validation_error(
                            "list_type",
                            json!(["body", "entries", i, "tags"]),
                            "Input should be a valid list",
                            tags,
                            None,
                        ));
                    }
                }
                for name in ["metadata", "key_value_pairs"] {
                    if let Some(value) = entry_map.get(name) {
                        if value.is_object() || name == "key_value_pairs" && value.is_null() {
                            clean[name] = value.clone();
                        } else {
                            errors.push(validation_error(
                                "dict_type",
                                json!(["body", "entries", i, name]),
                                "Input should be a valid dictionary",
                                value,
                                None,
                            ));
                        }
                    }
                }
                normalized.push(clean);
            }
            if errors.len() == start {
                if entries.is_empty() {
                    errors.push(validation_error(
                        "too_short",
                        entries_loc,
                        "List should have at least 1 item after validation, not 0",
                        &json!(entries),
                        Some(json!({"field_type":"List","min_length":1,"actual_length":0})),
                    ));
                } else if entries.len() as i128 > maximum as i128 {
                    errors.push(value_error(
                        entries_loc,
                        &format!("Too many profile entries: {} > {maximum}", entries.len()),
                        &json!(entries),
                    ));
                } else if normalized
                    .iter()
                    .map(|e| e["label"].as_str().unwrap())
                    .collect::<BTreeSet<_>>()
                    .len()
                    != entries.len()
                {
                    errors.push(value_error(
                        entries_loc,
                        "Profile entry labels must be unique",
                        &json!(entries),
                    ));
                }
            }
            output["entries"] = json!(normalized);
        } else {
            errors.push(validation_error(
                "list_type",
                entries_loc,
                "Input should be a valid list",
                entries,
                None,
            ));
        }
    } else {
        errors.push(validation_error(
            "missing",
            entries_loc,
            "Field required",
            input,
            None,
        ));
    }
    if errors.is_empty() {
        Ok(output)
    } else {
        Err((422, json!({"detail":errors})))
    }
}
fn batch(user: &str, input: &Value, operation: &str, imported_at: &str) -> Value {
    let mut items = Vec::new();
    for entry in input["entries"].as_array().unwrap() {
        let label = entry["label"].as_str().unwrap();
        let label_hash = format!("{:x}", Sha256::digest(label.as_bytes()));
        let request = if input["mode"] == "replace" {
            format!("{operation}:{label_hash}")
        } else {
            label_hash.clone()
        };
        let document_id = format!(
            "daedalus-profile-{}",
            digest(&[&bank_id(user), "profile", &request, &label_hash])
        );
        let mut metadata = entry["metadata"].as_object().unwrap().clone();
        metadata.entry("source").or_insert(json!("profile_import"));
        metadata.insert("label".into(), json!(label));
        metadata.insert("imported_at".into(), json!(imported_at));
        if truthy(&input["profile_version"]) {
            metadata
                .entry("profile_version")
                .or_insert(input["profile_version"].clone());
        }
        if let Some(pairs) = entry["key_value_pairs"]
            .as_object()
            .filter(|m| !m.is_empty())
        {
            let mut merged = metadata
                .get("key_value_pairs")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            merged.extend(pairs.clone());
            metadata.insert("key_value_pairs".into(), Value::Object(merged));
        }
        let mut strings = serde_json::Map::new();
        for (key, value) in metadata {
            if !trim(&key).is_empty() {
                let text = value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| json_text(&value, true, true, false));
                strings.insert(trim(&key).into(), json!(text));
            }
        }
        let mut tags = entry["tags"].as_array().unwrap().clone();
        if !tags.contains(&json!("user_profile")) {
            tags.insert(0, json!("user_profile"));
        }
        if let Some(category) = entry["metadata"]["category"]
            .as_str()
            .filter(|s| !s.is_empty())
            && !tags.contains(&json!(category))
        {
            tags.push(json!(category));
        }
        tags.insert(0, json!("source:profile-import"));
        let mut seen = BTreeSet::new();
        tags.retain(|v| seen.insert(v.as_str().unwrap().to_owned()));
        items.push(json!({
            "content": entry["memory"],
            "document_id": document_id,
            "context": "Daedalus authenticated profile import",
            "metadata": strings,
            "tags": tags,
            "observation_scopes": "shared",
            "update_mode": "replace",
            "timestamp": "unset"
        }));
    }
    json!({"items":items,"async":input["mode"] != "replace","operation_id":operation})
}
// Python str() is part of the upstream reply contract, including unusual IDs.
pub(crate) fn identifier(value: &Value) -> String {
    fn repr(value: &Value) -> String {
        let Some(text) = value.as_str() else {
            return identifier(value);
        };
        let quote = if text.contains('\'') && !text.contains('"') {
            '"'
        } else {
            '\''
        };
        static NONPRINTING: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new(r"[\p{C}\p{Z}]").unwrap());
        let mut result = quote.to_string();
        for c in text.chars() {
            match c {
                '\\' => result.push_str("\\\\"),
                '\n' => result.push_str("\\n"),
                '\r' => result.push_str("\\r"),
                '\t' => result.push_str("\\t"),
                c if c == quote => {
                    result.push('\\');
                    result.push(c);
                }
                c if c != ' ' && NONPRINTING.is_match(&c.to_string()) => {
                    let n = c as u32;
                    result.push_str(&if n <= 255 {
                        format!("\\x{n:02x}")
                    } else if n <= 65535 {
                        format!("\\u{n:04x}")
                    } else {
                        format!("\\U{n:08x}")
                    });
                }
                c => result.push(c),
            }
        }
        result.push(quote);
        result
    }
    match value {
        Value::String(s) => s.clone(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Null => "None".into(),
        Value::Number(_) => crate::output::compact(value),
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(repr).collect::<Vec<_>>().join(", ")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(k, v)| format!("{}: {}", repr(&json!(k)), repr(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}
async fn import(client: &hindsight::Client, user: &str, input: &Value) -> Result<Value> {
    let replace = input["mode"] == "replace";
    let mut previous = BTreeSet::new();
    if replace {
        let mut offset = 0usize;
        loop {
            let offset_string = offset.to_string();
            let page = client
                .request(
                    Method::GET,
                    user,
                    "documents",
                    None,
                    &[
                        ("limit", "100"),
                        ("offset", &offset_string),
                        ("tags", "source:profile-import"),
                        ("tags_match", "all_strict"),
                    ],
                    None,
                )
                .await?;
            let empty = vec![];
            let items = match page.get("items") {
                None => &empty,
                Some(items) => items
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("Invalid profile inventory"))?,
            };
            for item in items {
                if !item.is_object()
                    || !truthy(&item["id"])
                    || trim(&identifier(&item["id"])).is_empty()
                {
                    bail!("Invalid profile document");
                }
                previous.insert(identifier(&item["id"]));
            }
            if items.len() < 100 {
                break;
            }
            offset += items.len();
        }
    }
    let operation = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S+00:00")
        .to_string();
    let accepted = client
        .request(
            Method::POST,
            user,
            "memories",
            Some(batch(user, input, &operation, &now)),
            &[],
            Some(if replace { 120. } else { 15. }),
        )
        .await?;
    let operation = if replace {
        if accepted["success"] != Value::Bool(true)
            || ["pending", "running", "failed", "error"]
                .iter()
                .any(|s| accepted["status"] == *s)
            || accepted["status"].is_array()
            || accepted["status"].is_object()
            || truthy(&accepted["error"])
            || accepted["async"] == Value::Bool(true)
        {
            bail!("Profile retention unconfirmed");
        }
        for document in &previous {
            client
                .request(
                    Method::DELETE,
                    user,
                    &format!("documents/{}", hindsight::quote(document)),
                    None,
                    &[],
                    None,
                )
                .await?;
        }
        Value::Null
    } else {
        if !truthy(&accepted["operation_id"]) {
            bail!("Profile operation missing");
        }
        let value = identifier(&accepted["operation_id"]);
        if trim(&value).is_empty() {
            bail!("Profile operation missing");
        }
        json!(trim(&value))
    };
    let count = input["entries"].as_array().unwrap().len();
    Ok(
        json!({"status":if replace {"success"} else {"accepted"},"user_id":user,"imported":count,"replaced":previous.len(),"queued":if replace {0} else {count},"operation_id":operation,"profile_version":input["profile_version"]}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn expand(value: Value) -> Value {
        match value {
            Value::Object(map) if map.len() == 1 && map.contains_key("$string_parts") => json!(
                map["$string_parts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap())
                    .collect::<String>()
            ),
            Value::Object(map) => {
                Value::Object(map.into_iter().map(|(k, v)| (k, expand(v))).collect())
            }
            Value::Array(items) => Value::Array(items.into_iter().map(expand).collect()),
            other => other,
        }
    }
    #[tokio::test]
    async fn replacement_deletes_old_profile_only_after_confirmed_retention() {
        use crate::memory_api::tests::peers;
        fn confirmed(call: &Value, _: usize) -> Value {
            match (call["method"].as_str().unwrap(), call["query"].as_str()) {
                ("GET", Some(query)) if query.contains("offset=0") => json!({"items":
                    (0..100).map(|i| json!({"id":format!("old-{i:03}")})).collect::<Vec<_>>()}),
                ("GET", _) => json!({"items":[{"id":"old-100"}]}),
                ("POST", _) => json!({"success":true,"status":"completed"}),
                _ => json!({}),
            }
        }
        let body =
            json!({"mode":"replace","entries":[{"label":"Name","memory":"Synthetic Alice"}]});
        let (base, calls, peer) = peers::hindsight(confirmed).await;
        let app = peers::app(&base, "redis://127.0.0.1:1");
        assert_eq!(
            peers::send(&app, "POST", "/v1/profile/import", Some(body.clone())).await,
            (
                200,
                json!({"status":"success","user_id":"synthetic-alice","imported":1,"replaced":101,
                    "queued":0,"operation_id":null,"profile_version":null})
            )
        );
        let calls = calls.lock().await.clone();
        peer.abort();
        let bank = format!("/v1/default/banks/{}/", bank_id("synthetic-alice"));
        let shape: Vec<_> = calls
            .iter()
            .map(|call| {
                format!(
                    "{} {}",
                    call["method"].as_str().unwrap(),
                    call["path"].as_str().unwrap().strip_prefix(&bank).unwrap()
                )
            })
            .collect();
        assert_eq!(
            shape[..3],
            ["GET documents", "GET documents", "POST memories"]
        );
        assert_eq!(
            calls[1]["query"],
            "limit=100&offset=100&tags=source%3Aprofile-import&tags_match=all_strict"
        );
        assert_eq!(calls[2]["body"]["async"], false);
        let deleted: Vec<_> = shape[3..].to_vec();
        let expected: Vec<_> = (0..=100)
            .map(|i| format!("DELETE documents/old-{i:03}"))
            .collect();
        assert_eq!(deleted, expected);

        // Unconfirmed or asynchronous retention never removes the old profile.
        for reply in [
            (|call: &Value, _: usize| match call["method"].as_str().unwrap() {
                "GET" => json!({"items":[{"id":"old"}]}),
                _ => json!({"success":true,"async":true,"operation_id":"pending-operation"}),
            }) as fn(&Value, usize) -> Value,
            |call, _| match call["method"].as_str().unwrap() {
                "GET" => json!({"items":[{"id":"old"}]}),
                _ => json!({"success":true,"status":"pending"}),
            },
            |call, _| match call["method"].as_str().unwrap() {
                "GET" => json!({"items":[{"id":"old"}]}),
                _ => json!({"status":"completed"}),
            },
        ] {
            let (base, calls, peer) = peers::hindsight(reply).await;
            let app = peers::app(&base, "redis://127.0.0.1:1");
            assert_eq!(
                peers::send(&app, "POST", "/v1/profile/import", Some(body.clone())).await,
                (500, json!({"detail":"Profile import failed."}))
            );
            assert!(
                calls
                    .lock()
                    .await
                    .iter()
                    .all(|call| call["method"] != "DELETE"),
                "{calls:?}"
            );
            peer.abort();
        }

        // Appends are queued without inventory or deletion.
        let (base, calls, peer) =
            peers::hindsight(|_, _| json!({"operation_id":" operation-1 "})).await;
        let app = peers::app(&base, "redis://127.0.0.1:1");
        let append = json!({"entries":[{"label":"Name","memory":"Synthetic Alice"}]});
        assert_eq!(
            peers::send(&app, "POST", "/v1/profile/import", Some(append)).await,
            (
                202,
                json!({"status":"accepted","user_id":"synthetic-alice","imported":1,"replaced":0,
                    "queued":1,"operation_id":"operation-1","profile_version":null})
            )
        );
        let calls = calls.lock().await;
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["method"], "POST");
        assert_eq!(calls[0]["body"]["async"], true);
        peer.abort();
    }

    #[test]
    fn frozen_profile_import_contracts() {
        let fixture = expand(
            serde_json::from_str(include_str!("../tests/fixtures/profile-import.json")).unwrap(),
        );
        for (i, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            let result = validate(&case["input"], 250);
            if case["status"] == 200 {
                assert_eq!(result.unwrap(), case["expected"], "validation {i}");
            } else {
                let (status, body) = result.unwrap_err();
                assert_eq!(status, 422);
                assert_eq!(body, case["expected"], "validation {i}");
            }
        }
        for (i, case) in fixture["batches"].as_array().unwrap().iter().enumerate() {
            let actual = batch(
                "synthetic-alice",
                &validate(&case["input"], 250).unwrap(),
                fixture["operation"].as_str().unwrap(),
                fixture["imported_at"].as_str().unwrap(),
            );
            let expected = case["calls"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["method"] == "POST")
                .unwrap();
            assert_eq!(actual, expected["body"], "batch {i}");
        }
    }
}
