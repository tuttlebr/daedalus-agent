//! Retained ingestion validation, collection resolution and summary contracts.
use crate::{
    collections, document_api, document_store,
    memory_api::{ApiResult, detail, validation_error},
    memory_tools::trim,
};
use anyhow::{Result, anyhow, bail};
use regex::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;

pub fn indexing_tasks(
    job: &mut Value,
    tokenizer: &str,
    chunk_size: &Value,
    chunk_overlap: &Value,
) -> Result<()> {
    let mut errors = Vec::new();
    let size = chunk_size.to_string();
    let overlap = chunk_overlap.to_string();
    if size.starts_with('-') || size == "0" {
        errors.push(("chunk_size", "Input should be greater than 0"));
    }
    if overlap.starts_with('-') && overlap != "-0" {
        errors.push((
            "chunk_overlap",
            "Input should be greater than or equal to 0",
        ));
    } else if !size.starts_with('-')
        && size != "0"
        && (overlap.len(), overlap.as_str()) >= (size.len(), size.as_str())
    {
        errors.push((
            "chunk_overlap",
            "Value error, chunk_overlap must be less than chunk_size",
        ));
    }
    if !errors.is_empty() {
        let options =
            json!({"tokenizer":tokenizer,"chunk_size":chunk_size,"chunk_overlap":chunk_overlap});
        let original = crate::memory_tools::json_text(&options, false, true, true);
        let messages = errors
            .into_iter()
            .map(|(field, message)| {
                let marked = original.replace(
                    &format!("\"{field}\""),
                    &format!("\u{1b}[34m\u{1b}[1m{field}\u{1b}[0m"),
                );
                format!("(Schema Error): {message}\n -> {marked}")
            })
            .collect::<Vec<_>>()
            .join("\n");
        bail!(messages);
    }
    let tasks = job["tasks"]
        .as_array_mut()
        .ok_or_else(|| anyhow!("invalid extraction job"))?;
    tasks.extend([
        json!({"type":"split","task_properties":{"tokenizer":tokenizer,"chunk_size":chunk_size,"chunk_overlap":chunk_overlap,"params":{}}}),
        json!({"type":"dedup","task_properties":{"content_type":"text","params":{"filter":false,"enable_bbox_dedup":true,"iou_threshold":0.45,"bbox_dedup_prefer_structured":true}}}),
        json!({"type":"embed","task_properties":{"filter_errors":false}}),
    ]);
    Ok(())
}

pub fn dedup(refs: &[Value]) -> Result<Vec<Value>> {
    use std::collections::HashSet;
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for reference in refs {
        let id = &reference["documentId"];
        if crate::config::truthy(id) {
            let key = match id {
                Value::String(s) => format!("s:{s}"),
                Value::Bool(b) => format!("n:{}", u8::from(*b)),
                Value::Number(n) => {
                    let raw = n.to_string();
                    if raw.contains(['.', 'e', 'E']) {
                        let n = n
                            .as_f64()
                            .ok_or_else(|| anyhow!("invalid document identity"))?;
                        if n.fract() == 0. {
                            format!("n:{n:.0}")
                        } else {
                            format!("n:{n}")
                        }
                    } else {
                        format!("n:{raw}")
                    }
                }
                Value::Array(_) => bail!("unhashable type: 'list'"),
                Value::Object(_) => bail!("unhashable type: 'dict'"),
                Value::Null => unreachable!(),
            };
            if !seen.insert(key) {
                continue;
            }
        }
        output.push(reference.clone());
    }
    Ok(output)
}

#[derive(serde::Deserialize)]
pub struct Success {
    pub id: String,
    pub chunks: usize,
    pub pages: usize,
}
#[derive(serde::Deserialize)]
pub struct Failure {
    pub id: String,
    pub error: String,
}
pub struct Summary<'a> {
    pub total: usize,
    pub successful: &'a [Success],
    pub failed: &'a [Failure],
    pub chunks: usize,
    pub pages: usize,
    pub collection: &'a str,
    pub chunk_size: &'a Value,
    pub chunk_overlap: &'a Value,
}
impl Summary<'_> {
    pub fn render(&self) -> String {
        use std::fmt::Write;
        let Self {
            total,
            successful,
            failed,
            chunks,
            pages,
            collection,
            chunk_size,
            chunk_overlap,
        } = self;
        let mut text;
        if failed.is_empty() {
            text = format!(
                "✅ Successfully processed all {total} documents\n\n📄 **Summary:**\n- {total} documents indexed\n- {pages} pages\n- Total chunks indexed: {chunks}\n- Collection: '{collection}'\n- Chunk size: {chunk_size} with {chunk_overlap} overlap\n\n"
            );
            if successful.len() <= 10 {
                text.push_str("📋 **Processed files:**\n");
                for doc in *successful {
                    writeln!(
                        text,
                        "- {} ({} chunks, {} pages)",
                        doc.id, doc.chunks, doc.pages
                    )
                    .unwrap();
                }
            }
            text.push_str("\nAll documents are now searchable in your knowledge base!");
        } else if !successful.is_empty() {
            let count = successful.len();
            let errors = failed.len();
            text = format!(
                "⚠️ Partially completed batch processing\n\n📄 **Summary:**\n- Successfully processed: {count}/{total} documents\n- {count} documents indexed\n- {pages} pages\n- Failed: {errors} documents\n- Total chunks indexed: {chunks}\n- Collection: '{collection}'\n\n"
            );
            if count <= 10 {
                text.push_str("✅ **Successfully processed:**\n");
                for doc in *successful {
                    writeln!(
                        text,
                        "- {} ({} chunks, {} pages)",
                        doc.id, doc.chunks, doc.pages
                    )
                    .unwrap();
                }
                text.push('\n');
            }
            if errors <= 10 {
                text.push_str("❌ **Failed documents:**\n");
                for doc in *failed {
                    writeln!(
                        text,
                        "- {}: {}...",
                        doc.id,
                        crate::output::clip(&doc.error, 100)
                    )
                    .unwrap();
                }
            }
            text.push_str(
                "\nSuccessfully processed documents are searchable in your knowledge base.",
            );
        } else {
            text = format!(
                "❌ Failed to process any documents\n\n📄 **Summary:**\n- Attempted: {total} documents\n- All failed\n\n"
            );
            if failed.len() <= 10 {
                text.push_str("**Errors:**\n");
                for doc in *failed {
                    writeln!(
                        text,
                        "- {}: {}...",
                        doc.id,
                        crate::output::clip(&doc.error, 100)
                    )
                    .unwrap();
                }
            }
            text.push_str("\nPlease check the documents and try again.");
        }
        text
    }
}

fn member<'a>(value: &'a Value, key: &str) -> Result<&'a Value> {
    match value {
        Value::Object(object) => object.get(key).ok_or_else(|| anyhow!("'{key}'")),
        Value::Array(_) => bail!("list indices must be integers or slices, not str"),
        Value::String(_) => bail!("string indices must be integers, not 'str'"),
        _ => bail!(
            "'{}' object is not subscriptable",
            crate::milvus_serialization::kind(value)
        ),
    }
}
fn check_get(value: &Value) -> Result<()> {
    if !value.is_object() {
        return Err(crate::document_text::attribute_error(value, "get"));
    }
    Ok(())
}
fn length(value: &Value) -> Result<usize> {
    match value {
        Value::Array(array) => Ok(array.len()),
        Value::Object(object) => Ok(object.len()),
        Value::String(text) => Ok(text.chars().count()),
        _ => bail!(
            "object of type '{}' has no len()",
            crate::milvus_serialization::kind(value)
        ),
    }
}
fn items(value: &Value) -> Result<Vec<Value>> {
    match value {
        Value::Array(array) => Ok(array.clone()),
        Value::Object(object) => Ok(object.keys().cloned().map(Value::String).collect()),
        Value::String(text) => Ok(text.chars().map(|c| json!(c.to_string())).collect()),
        _ => bail!(
            "'{}' object is not iterable",
            crate::milvus_serialization::kind(value)
        ),
    }
}
/// The SDK mutates content_metadata while preparing inserts. Preserve mutations
/// even on failure, as well as its field-access and validation order.
pub fn records(results: &mut Value) -> Result<Vec<Value>> {
    let mut records = Vec::new();
    fn group(group: &mut Value, records: &mut Vec<Value>) -> Result<()> {
        match group {
            Value::Null => (),
            Value::Object(_) => record(group, records)?,
            Value::Array(entries) => {
                for entry in entries {
                    record(entry, records)?;
                }
            }
            _ => {
                for mut entry in items(group)? {
                    record(&mut entry, records)?;
                }
            }
        }
        Ok(())
    }
    if let Value::Array(groups) = results {
        for value in groups {
            group(value, &mut records)?;
        }
    } else {
        for mut value in items(results)? {
            group(&mut value, &mut records)?;
        }
    }
    Ok(records)
}
fn record(entry: &mut Value, records: &mut Vec<Value>) -> Result<()> {
    use crate::config::truthy;
    let kind = member(entry, "document_type")?;
    let meta = member(entry, "metadata")?;
    let mut text = if kind == "text" {
        member(meta, "content")?
    } else if kind == "structured" {
        let text = member(member(meta, "table_metadata")?, "table_content")?;
        member(member(meta, "content_metadata")?, "subtype")?;
        text
    } else if kind == "image" {
        let subtype = member(member(meta, "content_metadata")?, "subtype")?;
        member(
            member(meta, "image_metadata")?,
            if subtype == "page_image" {
                "text"
            } else {
                "caption"
            },
        )?
    } else if kind == "audio" {
        member(member(meta, "audio_metadata")?, "audio_transcript")?
    } else {
        &Value::Null
    };
    let embedded = !member(meta, "embedding")?.is_null();
    if !truthy(text) || !embedded {
        member(member(meta, "source_metadata")?, "source_name")?;
        check_get(member(meta, "content_metadata")?)?;
        text = &Value::Null;
    }
    if truthy(text) && length(text)? > 65535 {
        check_get(member(meta, "source_metadata")?)?;
        check_get(member(meta, "content_metadata")?)?;
        text = &Value::Null;
    }
    let text = text.clone();
    let (location, dimensions) = if kind == "structured" {
        let table = member(meta, "table_metadata")?;
        let location = member(table, "table_location")?;
        let dimensions = member(table, "table_location_max_dimensions")?;
        member(member(meta, "content_metadata")?, "subtype")?;
        (location.clone(), dimensions.clone())
    } else if kind == "image" {
        let image = member(meta, "image_metadata")?;
        (
            member(image, "image_location")?.clone(),
            member(image, "image_location_max_dimensions")?.clone(),
        )
    } else {
        (Value::Null, Value::Null)
    };
    let (location, dimensions) = if !truthy(&location) && kind != "text" {
        member(member(meta, "source_metadata")?, "source_name")?;
        check_get(member(meta, "content_metadata")?)?;
        (Value::Null, Value::Null)
    } else {
        (location, dimensions)
    };
    let content_meta = member(meta, "content_metadata")?;
    if !content_meta.is_object() {
        if content_meta.is_array() {
            bail!("list indices must be integers or slices, not str");
        }
        bail!(
            "'{}' object does not support item assignment",
            crate::milvus_serialization::kind(content_meta)
        );
    }
    let content_meta = entry["metadata"]["content_metadata"]
        .as_object_mut()
        .unwrap();
    content_meta.insert("location".into(), location);
    content_meta.insert("max_dimensions".into(), dimensions);
    if truthy(&text) {
        let mut meta = entry["metadata"].as_object().unwrap().clone();
        meta.shift_remove("content")
            .ok_or_else(|| anyhow!("'content'"))?;
        let vector = meta.shift_remove("embedding").unwrap();
        let source = meta
            .shift_remove("source_metadata")
            .ok_or_else(|| anyhow!("'source_metadata'"))?;
        let mut content_meta = meta.shift_remove("content_metadata").unwrap();
        content_meta.as_object_mut().unwrap().extend(meta);
        records.push(
            json!({"text":text,"vector":vector,"source":source,"content_metadata":content_meta}),
        );
    }
    Ok(())
}

fn integer(input: &Value, field: &str, zero: bool) -> Result<Value, Value> {
    let error = |kind, message, context| {
        validation_error(kind, json!(["body", field]), message, input, context)
    };
    let number = match input {
        Value::Bool(value) => json!(u8::from(*value)),
        Value::Number(value) => {
            let raw = value.to_string();
            if !raw.contains(['.', 'e', 'E']) {
                if raw == "-0" { json!(0) } else { input.clone() }
            } else {
                let value = value.as_f64().unwrap_or(f64::INFINITY);
                if !value.is_finite() || value.fract() != 0. {
                    return Err(error(
                        "int_from_float",
                        "Input should be a valid integer, got a number with a fractional part",
                        None,
                    ));
                }
                if !(-9223372036854775808.0..9223372036854775808.0).contains(&value) {
                    return Err(error(
                        "int_parsing_size",
                        "Unable to parse input string as an integer, exceeded maximum size",
                        None,
                    ));
                }
                if value == 0. {
                    json!(0)
                } else {
                    serde_json::from_str(&format!("{value:.0}")).unwrap()
                }
            }
        }
        Value::String(raw) => {
            static INT: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"^[+-]?[0-9](?:_?[0-9])*(?:\.0+)?$").unwrap());
            let raw = raw.trim();
            if !INT.is_match(raw) {
                return Err(error(
                    "int_parsing",
                    "Input should be a valid integer, unable to parse string as an integer",
                    None,
                ));
            }
            let raw = raw.split('.').next().unwrap().replace('_', "");
            let negative = raw.starts_with('-');
            let digits = raw.trim_start_matches(['-', '+']).trim_start_matches('0');
            let canonical = if digits.is_empty() {
                "0".to_owned()
            } else if negative {
                format!("-{digits}")
            } else {
                digits.to_owned()
            };
            serde_json::from_str(&canonical).unwrap()
        }
        _ => return Err(error("int_type", "Input should be a valid integer", None)),
    };
    if number.to_string().starts_with('-') || (!zero && number == json!(0)) {
        Err(if zero {
            error(
                "greater_than_equal",
                "Input should be greater than or equal to 0",
                Some(json!({"ge":0})),
            )
        } else {
            error(
                "greater_than",
                "Input should be greater than 0",
                Some(json!({"gt":0})),
            )
        })
    } else {
        Ok(number)
    }
}
fn reference(value: &Value, prefix: &[Value], errors: &mut Vec<Value>) -> Option<Value> {
    match document_api::validate(&json!({"documentRef":value}), true) {
        Ok(parsed) => Some(parsed["documentRef"].clone()),
        Err((_, body)) => {
            for mut error in body["detail"].as_array().unwrap().iter().cloned() {
                let mut loc = prefix.to_vec();
                loc.extend(error["loc"].as_array().unwrap().iter().skip(2).cloned());
                error["loc"] = json!(loc);
                errors.push(error);
            }
            None
        }
    }
}
pub fn validate(input: &Value) -> ApiResult<Value> {
    if !input.is_object() {
        let error = if input.is_null() {
            validation_error("missing", json!(["body"]), "Field required", input, None)
        } else {
            document_api::model_error(input, json!(["body"]))
        };
        return Err((422, json!({"detail":[error]})));
    }
    let mut errors = Vec::new();
    let mut output = json!({});
    if let Some(value) = input.get("documentRef").filter(|v| !v.is_null())
        && let Some(value) = reference(value, &[json!("body"), json!("documentRef")], &mut errors)
    {
        output["documentRef"] = value;
    }
    if let Some(value) = input.get("documentRefs").filter(|v| !v.is_null()) {
        if let Some(refs) = value.as_array() {
            output["documentRefs"] = json!(
                refs.iter()
                    .enumerate()
                    .filter_map(|(i, value)| reference(
                        value,
                        &[json!("body"), json!("documentRefs"), json!(i)],
                        &mut errors
                    ))
                    .collect::<Vec<_>>()
            );
        } else {
            errors.push(validation_error(
                "list_type",
                json!(["body", "documentRefs"]),
                "Input should be a valid list",
                value,
                None,
            ));
        }
    }
    let names = document_api::strings(
        input,
        &[
            ("collection_name", false),
            ("collection", false),
            ("collection_scope", false),
        ],
        &["body"],
        &mut errors,
    );
    output
        .as_object_mut()
        .unwrap()
        .extend(names.as_object().unwrap().clone());
    if let Some(value) = input.get("provenance").filter(|v| !v.is_null()) {
        if value.is_object() {
            output["provenance"] = value.clone();
        } else {
            errors.push(validation_error(
                "dict_type",
                json!(["body", "provenance"]),
                "Input should be a valid dictionary",
                value,
                None,
            ));
        }
    }
    let names = document_api::strings(input, &[("username", false)], &["body"], &mut errors);
    output
        .as_object_mut()
        .unwrap()
        .extend(names.as_object().unwrap().clone());
    for name in ["chunk_size", "chunk_overlap"] {
        if let Some(value) = input.get(name).filter(|v| !v.is_null()) {
            match integer(value, name, name == "chunk_overlap") {
                Ok(value) => output[name] = value,
                Err(error) => errors.push(error),
            }
        }
    }
    if errors.is_empty() {
        Ok(output)
    } else {
        Err((422, json!({"detail":errors})))
    }
}
pub fn resolve(input: &Value, user: &str, limit: i64) -> ApiResult<Value> {
    let username = input["username"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(user);
    let username = trim(username);
    if username != user {
        return Err(detail(403, "username must match x-user-id"));
    }
    let refs = if let Some(refs) = input["documentRefs"]
        .as_array()
        .filter(|refs| !refs.is_empty())
    {
        refs.clone()
    } else if let Some(reference) = input.get("documentRef") {
        vec![reference.clone()]
    } else {
        return Err(detail(400, "documentRef or documentRefs required"));
    };
    if refs.len() as i128 > limit as i128 {
        return Err(detail(
            413,
            &format!(
                "Too many documents in a single request: {} > {limit}. Split the upload into smaller batches.",
                refs.len()
            ),
        ));
    }
    let collection = input["collection_name"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| input["collection"].as_str().filter(|s| !s.is_empty()))
        .unwrap_or(username);
    let scope = collections::scope(collection, input["collection_scope"].as_str(), false)
        .map_err(|e| detail(400, &e.to_string()))?;
    if scope == "shared" {
        return Err(detail(
            403,
            "Shared collection writes are not permitted through user-facing document ingestion.",
        ));
    }
    Ok(json!([
        username,
        refs,
        collection,
        scope,
        input["provenance"]
    ]))
}
pub fn classify(output: &str) -> &'static str {
    let lower = output.to_lowercase();
    if lower.starts_with("error:") || lower.contains("failed to process any documents") {
        "failure"
    } else if lower.contains("partially completed batch processing") {
        "partial"
    } else {
        "success"
    }
}

pub fn dimension(desc: &Value, vector: &str) -> Result<Option<Value>> {
    if !desc.is_null() && !desc.is_object() {
        bail!("invalid collection schema");
    }
    let Some(fields) = desc.get("fields").filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    // Python iterates dictionary keys here, which are skipped as non-fields.
    let Some(fields) = fields.as_array() else {
        return if fields.is_object() || fields.is_string() {
            Ok(None)
        } else {
            Err(anyhow!("invalid schema fields"))
        };
    };
    let mut fallback = None;
    for field in fields.iter().filter(|v| v.is_object()) {
        let Some(params) = field.get("params").filter(|v| !v.is_null()) else {
            continue;
        };
        if !params.is_object() {
            bail!("invalid schema field parameters");
        }
        let Some(dim) = params.get("dim").filter(|v| !v.is_null()) else {
            continue;
        };
        let parsed = match dim {
            Value::Bool(value) => Some(json!(u8::from(*value))),
            Value::Number(n) => {
                let raw = n.to_string();
                if raw.contains(['.', 'e', 'E']) {
                    n.as_f64()
                        .filter(|n| n.is_finite())
                        .and_then(|n| serde_json::from_str(&format!("{:.0}", n.trunc())).ok())
                } else {
                    Some(dim.clone())
                }
            }
            Value::String(raw) => {
                document_store::integer(raw).and_then(|n| serde_json::from_str(&n).ok())
            }
            _ => None,
        };
        if let Some(value) = parsed {
            if field["name"] == vector {
                return Ok(Some(value));
            }
            if fallback.is_none() {
                fallback = Some(value);
            }
        }
    }
    Ok(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn fixture() -> Value {
        fn expand(value: Value) -> Value {
            match value {
                Value::Array(a) => Value::Array(a.into_iter().map(expand).collect()),
                Value::Object(mut o) => {
                    if let Some(parts) = o.remove("$string_parts") {
                        return json!(
                            parts
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|s| s.as_str().unwrap())
                                .collect::<String>()
                        );
                    }
                    Value::Object(o.into_iter().map(|(k, v)| (k, expand(v))).collect())
                }
                v => v,
            }
        }
        let mut data = expand(
            serde_json::from_str(include_str!("../tests/fixtures/document-index.json")).unwrap(),
        );
        let mut helpers = Vec::new();
        for source in [
            include_str!("../tests/fixtures/document-index-helpers-0.json"),
            include_str!("../tests/fixtures/document-index-helpers-1.json"),
            include_str!("../tests/fixtures/document-index-helpers-2.json"),
        ] {
            helpers.extend(
                expand(serde_json::from_str(source).unwrap())
                    .as_array()
                    .unwrap()
                    .iter()
                    .cloned(),
            );
        }
        data["helpers"] = json!(helpers);
        data
    }
    #[test]
    fn retained_ingest_request_contracts() {
        let data = fixture();
        for case in data["validation"].as_array().unwrap() {
            let (status, body) = validate(&case["input"])
                .map(|v| (200, v))
                .unwrap_or_else(|e| e);
            assert_eq!(json!(status), case["status"], "{case}");
            assert_eq!(body, case["expected"], "{case}");
        }
        for case in data["resolutions"].as_array().unwrap() {
            let input = validate(&case["input"]).unwrap();
            let result = resolve(&input, "alice", 500)
                .map(|v| json!({"ok":v}))
                .unwrap_or_else(|(s, v)| json!({"status":s,"detail":v["detail"]}));
            assert_eq!(result, case["expected"], "{case}");
        }
    }
    #[test]
    fn retained_ingest_dimensions_and_classification() {
        for case in fixture()["helpers"].as_array().unwrap() {
            let value = match case["kind"].as_str().unwrap() {
                "classify" => json!(classify(case["input"].as_str().unwrap())),
                "dimension" => {
                    json!(dimension(&case["input"][0], case["input"][1].as_str().unwrap()).unwrap())
                }
                _ => continue,
            };
            assert_eq!(value, case["expected"]["ok"], "{case}");
        }
    }
    #[test]
    fn retained_record_cleanup_errors_and_mutations() {
        fn expand(value: &mut Value, entry: &Value) {
            if let Some(changes) = value.get("$entry_delta") {
                let mut record = entry.clone();
                for change in changes.as_array().unwrap() {
                    let path = change[1].as_array().unwrap();
                    let mut parent = &mut record;
                    for segment in &path[..path.len() - 1] {
                        parent = &mut parent[segment.as_str().unwrap()];
                    }
                    let key = path.last().unwrap().as_str().unwrap();
                    if change[0] == "remove" {
                        parent.as_object_mut().unwrap().shift_remove(key);
                    } else {
                        parent[key] = change[2].clone();
                    }
                }
                *value = record;
            } else if let Value::Array(items) = value {
                for item in items {
                    expand(item, entry);
                }
            } else if let Value::Object(items) = value {
                for item in items.values_mut() {
                    expand(item, entry);
                }
            }
        }
        let mut failures = Vec::new();
        for raw in [
            include_str!("../tests/fixtures/milvus-records-0.json"),
            include_str!("../tests/fixtures/milvus-records-1.json"),
            include_str!("../tests/fixtures/milvus-records-2.json"),
            include_str!("../tests/fixtures/milvus-records-3.json"),
        ] {
            let mut fixture: Value = serde_json::from_str(raw).unwrap();
            crate::document_codecs::tests::expand(&mut fixture);
            let entry = fixture["entry"].clone();
            expand(&mut fixture["cases"], &entry);
            for case in fixture["cases"].as_array().unwrap() {
                let mut results = case["input"].clone();
                let actual = records(&mut results);
                if let Some(expected) = case["expected"].get("ok") {
                    match actual {
                        Ok(actual)
                            if serde_json::to_vec(&actual).unwrap()
                                == serde_json::to_vec(expected).unwrap() => {}
                        Ok(actual) => failures
                            .push(format!("{}: unexpected records: {actual:?}", case["name"])),
                        Err(error) => failures.push(format!("{}: {error}", case["name"])),
                    }
                } else {
                    let error = actual
                        .err()
                        .map(|e| e.to_string())
                        .unwrap_or_else(|| "Unexpectedly accepted".into());
                    if error != case["expected"]["message"].as_str().unwrap() {
                        failures.push(format!(
                            "{}: {error}\nexpected {}",
                            case["name"], case["expected"]["message"]
                        ));
                    }
                }
                if serde_json::to_vec(&results).unwrap()
                    != serde_json::to_vec(&case["mutated"]).unwrap()
                {
                    failures.push(format!("{}: mutated results differ", case["name"]));
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
    #[test]
    fn retained_ingest_summaries_and_records() {
        for case in fixture()["helpers"].as_array().unwrap() {
            let args = &case["input"];
            let actual = match case["kind"].as_str().unwrap() {
                "summary" => {
                    let successful: Vec<Success> = serde_json::from_value(args[1].clone()).unwrap();
                    let failed: Vec<Failure> = serde_json::from_value(args[2].clone()).unwrap();
                    Ok(json!(
                        Summary {
                            total: args[0].as_u64().unwrap() as usize,
                            successful: &successful,
                            failed: &failed,
                            chunks: args[3].as_u64().unwrap() as usize,
                            pages: args[4].as_u64().unwrap() as usize,
                            collection: args[5].as_str().unwrap(),
                            chunk_size: &args[6],
                            chunk_overlap: &args[7]
                        }
                        .render()
                    ))
                }
                "dedup" => dedup(args.as_array().unwrap()).map(|v| json!(v)),
                "records" => {
                    let mut results = args.clone();
                    records(&mut results).map(|v| json!({"records":v,"results":results}))
                }
                _ => continue,
            };
            if let Some(expected) = case["expected"].get("ok") {
                assert_eq!(
                    actual.unwrap_or_else(|e| panic!("{}: {e}", case["kind"])),
                    *expected,
                    "{case}"
                );
            } else {
                if case["kind"] == "records" {
                    assert_eq!(
                        actual.unwrap_err().to_string(),
                        case["expected"]["message"].as_str().unwrap(),
                        "{case}"
                    );
                } else {
                    assert!(actual.is_err(), "{case}");
                }
            }
        }
    }
    #[test]
    fn retained_indexing_jobs() {
        use base64::Engine;
        for case in fixture()["jobs"].as_array().unwrap() {
            let filename = case["filename"].as_str().unwrap();
            let kind = crate::nv_ingest::document_type(filename).unwrap();
            let content = if kind == "text" {
                "Synthetic document".to_owned()
            } else {
                base64::engine::general_purpose::STANDARD.encode("Synthetic document")
            };
            let mut job =
                crate::nv_ingest::job(filename, &content, &crate::nv_ingest::Options::default())
                    .unwrap();
            let actual = indexing_tasks(
                &mut job,
                "meta-llama/Llama-3.2-1B",
                &case["chunk_size"],
                &case["chunk_overlap"],
            );
            if let Some(expected) = case["expected"].get("ok") {
                actual.unwrap();
                assert_eq!(json!({kind:[job]}), *expected, "{case}");
            } else {
                assert_eq!(
                    actual.unwrap_err().to_string(),
                    case["expected"]["message"].as_str().unwrap(),
                    "{case}"
                );
            }
        }
    }
    #[test]
    fn retained_milvus_ingest_wire() {
        use base64::Engine;
        use prost::Message;
        let mut data: Value =
            serde_json::from_str(include_str!("../tests/fixtures/milvus-index.json")).unwrap();
        crate::document_codecs::tests::expand(&mut data);
        for case in data["cases"].as_array().unwrap() {
            for call in case["calls"].as_array().unwrap() {
                let method = call["method"].as_str().unwrap();
                for (response, name) in [(false, "base64"), (true, "response_base64")] {
                    let Some(encoded) = call[name].as_str() else {
                        continue;
                    };
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(encoded)
                        .unwrap();
                    assert_eq!(
                        crate::milvus_index_proto::reencode(method, response, &bytes),
                        bytes,
                        "{method} response={response}"
                    );
                }
                if method == "CreateCollection" {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(call["body"]["schema"].as_str().unwrap())
                        .unwrap();
                    let schema =
                        crate::milvus_index_proto::CollectionSchema::decode(bytes.as_slice())
                            .unwrap();
                    assert_eq!(schema.encode_to_vec(), bytes);
                }
            }
        }
    }
}
