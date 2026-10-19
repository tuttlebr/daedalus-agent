//! Document request and response contracts, shared by extraction and downloads.
use crate::{
    App,
    document_processor::FAILED,
    document_text,
    memory_api::{ApiResult, actor, detail, read_body, validation_error},
    memory_tools::trim,
};
use axum::{
    Json, Router,
    extract::{Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use regex::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;

pub fn routes() -> Router<App> {
    let mut router = Router::new();
    for path in ["/v1/documents/extract", "/v1/documents/markdown"] {
        router = router
            .route(path, any(handle))
            .route(&format!("{path}/"), any(handle));
    }
    router
}
fn respond((status, body): (u16, Value)) -> Response {
    (StatusCode::from_u16(status).unwrap(), Json(body)).into_response()
}
fn failure(error: &anyhow::Error) -> (u16, Value) {
    use crate::document_store::StorageError;
    let message = error.to_string();
    let lower = message.to_lowercase();
    // Ownership and storage outages are typed: an unavailable Redis or object
    // store is not an authorization failure, though its message says "access".
    let status = if let Some(storage) = error.downcast_ref::<StorageError>() {
        match storage {
            StorageError::Forbidden(_) => 403,
            StorageError::Unavailable(_) => 503,
        }
    } else if lower.contains("not found") || lower.contains("expired") {
        404
    } else if lower.contains("exceeds the maximum allowed size") {
        413
    } else if lower.contains("timed out") {
        504
    } else if ["invalid", "required", "empty"]
        .iter()
        .any(|word| lower.contains(word))
    {
        400
    } else {
        500
    };
    detail(status, if status == 500 { FAILED } else { &message })
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
    let download = request.uri().path().ends_with("/markdown");
    let (parts, body) = request.into_parts();
    let input = match read_body(&parts.headers, body)
        .await
        .and_then(|body| validate(&body, download))
    {
        Ok(input) => input,
        Err(error) => return respond(error),
    };
    let username = input["username"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(&user);
    if trim(username) != user {
        return respond(detail(403, "username must match x-user-id"));
    }
    let processor = match preparation
        .documents
        .get_or_try_init(|| async {
            crate::document_processor::Processor::new(&preparation.config).map(std::sync::Arc::new)
        })
        .await
    {
        Ok(processor) => processor,
        Err(_) => return respond(detail(500, FAILED)),
    };
    let limit = (!download).then(|| input["char_limit"].as_u64().unwrap_or(50_000) as usize);
    let result = match processor.extract(&input["documentRef"], &user, limit).await {
        Ok(result) => result,
        Err(error) => return respond(failure(&error)),
    };
    if result.unencodable {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response();
    }
    if !download {
        return respond((
            200,
            json!({"status":"success", "filename":result.filename, "pages":result.pages, "markdown":result.markdown, "truncated":result.truncated, "original_chars":result.original_chars}),
        ));
    }
    if result.truncated || result.markdown.chars().count() != result.original_chars {
        return respond(detail(
            500,
            "The document parser returned incomplete Markdown.",
        ));
    }
    if result.markdown.is_empty() {
        return respond(detail(
            422,
            "No extractable text or markdown content in this document.",
        ));
    }
    let headers = [
        ("content-type", "text/markdown; charset=utf-8".into()),
        (
            "content-disposition",
            format!(
                "attachment; filename=\"{}\"",
                document_text::filename(&result.filename)
            ),
        ),
        ("x-document-pages", result.pages.to_string()),
        ("x-original-chars", result.original_chars.to_string()),
        ("cache-control", "private, no-store".into()),
    ];
    (headers, result.markdown).into_response()
}

pub(super) fn model_error(input: &Value, loc: Value) -> Value {
    validation_error(
        "model_attributes_type",
        loc,
        "Input should be a valid dictionary or object to extract fields from",
        input,
        None,
    )
}
pub(super) fn strings(
    input: &Value,
    names: &[(&str, bool)],
    prefix: &[&str],
    errors: &mut Vec<Value>,
) -> Value {
    let mut output = json!({});
    for (name, required) in names {
        let mut loc = prefix.to_vec();
        loc.push(name);
        let loc = json!(loc);
        let Some(value) = input.get(name) else {
            if *required {
                errors.push(validation_error(
                    "missing",
                    loc,
                    "Field required",
                    input,
                    None,
                ));
            }
            continue;
        };
        if value.is_null() && !required {
            continue;
        }
        match value.as_str() {
            None => errors.push(validation_error(
                "string_type",
                loc,
                "Input should be a valid string",
                value,
                None,
            )),
            Some("") if *required => errors.push(validation_error(
                "string_too_short",
                loc,
                "String should have at least 1 character",
                value,
                Some(json!({"min_length": 1})),
            )),
            Some(_) => output[*name] = value.clone(),
        }
    }
    output
}
fn char_limit(input: &Value) -> Result<u32, Value> {
    let error = |kind, message, context| {
        validation_error(kind, json!(["body", "char_limit"]), message, input, context)
    };
    let n = match input {
        Value::Bool(value) => f64::from(u8::from(*value)),
        Value::Number(number) => {
            let n = number.as_f64().unwrap_or(f64::INFINITY);
            // Arbitrary-size JSON integers still receive the field's bound error.
            if number.to_string().contains(['.', 'e', 'E']) && n.fract() != 0. {
                return Err(error(
                    "int_from_float",
                    "Input should be a valid integer, got a number with a fractional part",
                    None,
                ));
            }
            if number.to_string().contains(['.', 'e', 'E'])
                && !(-9223372036854775808.0..9223372036854775808.0).contains(&n)
            {
                return Err(error(
                    "int_parsing_size",
                    "Unable to parse input string as an integer, exceeded maximum size",
                    None,
                ));
            }
            n
        }
        Value::String(value) => {
            static INTEGER: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"^[+-]?[0-9](?:_?[0-9])*(?:\.0+)?$").unwrap());
            if !INTEGER.is_match(value.trim()) {
                return Err(error(
                    "int_parsing",
                    "Input should be a valid integer, unable to parse string as an integer",
                    None,
                ));
            }
            value
                .trim()
                .replace('_', "")
                .parse()
                .unwrap_or(f64::INFINITY)
        }
        _ => return Err(error("int_type", "Input should be a valid integer", None)),
    };
    if n <= 0. {
        Err(error(
            "greater_than",
            "Input should be greater than 0",
            Some(json!({"gt": 0})),
        ))
    } else if n > 500_000. {
        Err(error(
            "less_than_equal",
            "Input should be less than or equal to 500000",
            Some(json!({"le": 500000})),
        ))
    } else {
        Ok(n as u32)
    }
}
pub fn validate(input: &Value, download: bool) -> ApiResult<Value> {
    if !input.is_object() {
        let error = if input.is_null() {
            validation_error("missing", json!(["body"]), "Field required", input, None)
        } else {
            model_error(input, json!(["body"]))
        };
        return Err((422, json!({"detail": [error]})));
    }
    let mut errors = Vec::new();
    let mut output = json!({});
    match input.get("documentRef") {
        None => errors.push(validation_error(
            "missing",
            json!(["body", "documentRef"]),
            "Field required",
            input,
            None,
        )),
        Some(value) if !value.is_object() => {
            errors.push(model_error(value, json!(["body", "documentRef"])))
        }
        Some(value) => {
            output["documentRef"] = strings(
                value,
                &[
                    ("documentId", true),
                    ("sessionId", true),
                    ("filename", false),
                    ("mimeType", false),
                    ("userId", false),
                ],
                &["body", "documentRef"],
                &mut errors,
            )
        }
    }
    if let Some(username) =
        strings(input, &[("username", false)], &["body"], &mut errors).get("username")
    {
        output["username"] = username.clone();
    }
    if !download && let Some(value) = input.get("char_limit").filter(|v| !v.is_null()) {
        match char_limit(value) {
            Ok(limit) => output["char_limit"] = json!(limit),
            Err(error) => errors.push(error),
        }
    }
    if errors.is_empty() {
        Ok(output)
    } else {
        Err((422, json!({"detail": errors})))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn storage_outages_are_unavailable_and_ownership_is_forbidden() {
        let config = crate::config::Config {
            raw: json!({}),
            policy_raw: json!({}),
            python_tools: false,
            env: [("REDIS_URL".to_string(), "redis://127.0.0.1:1".to_string())].into(),
        };
        let processor = crate::document_processor::Processor::new(&config).unwrap();
        // Redis cannot be reached.
        let error = processor
            .extract(&json!({"documentId":"d","sessionId":"s"}), "alice", None)
            .await
            .err()
            .unwrap();
        assert!(
            error
                .to_string()
                .starts_with("Error accessing document storage")
        );
        assert_eq!(failure(&error).0, 503);
        // Object storage failures share the same storage classification.
        let object = crate::document_store::unavailable(
            "Error accessing document object storage. Please upload the document again.",
        );
        assert_eq!(failure(&object).0, 503);
        // A record owned by someone else.
        let record = json!({"userId":"bob","filename":"a.txt","data":"dGV4dA=="});
        let error = crate::document_store::load_record(&config, &record, "d", "s", "alice")
            .await
            .unwrap_err();
        let (status, body) = failure(&error);
        assert_eq!(status, 403);
        assert_eq!(body["detail"], error.to_string());
        // Untyped messages keep their existing mapping.
        assert_eq!(
            failure(&anyhow::anyhow!("Error: Document not found")).0,
            404
        );
        assert_eq!(failure(&anyhow::anyhow!("operation timed out")).0, 504);
    }

    #[test]
    fn frozen_http_validation() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/documents.json")).unwrap();
        for (i, case) in fixture["validation"].as_array().unwrap().iter().enumerate() {
            let actual = validate(&case["input"], case["route"] == "markdown")
                .map(|value| (200, value))
                .unwrap_or_else(|error| error);
            assert_eq!(json!(actual.0), case["status"], "validation status {i}");
            assert_eq!(actual.1, case["expected"], "validation body {i}");
        }
    }
}
