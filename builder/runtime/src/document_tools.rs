//! Native document tools, with shared retrieval clients and durable write receipts.
use crate::{
    config::truthy,
    document_json::Text,
    memory_tools::{json_text, trim},
    profile_import::identifier,
};
use anyhow::{Result, anyhow};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock},
};

/// Share one processor and its collection ownership across single/batch requests.
pub struct Adapter {
    config: crate::config::Config,
    settings: Settings,
    processor: Arc<crate::document_processor::Processor>,
    retrieval: tokio::sync::OnceCell<crate::milvus::Client>,
    retriever: tokio::sync::OnceCell<crate::document_retriever::Retriever>,
    embedders: Arc<crate::embeddings::Registry>,
}
impl Adapter {
    #[cfg(test)]
    pub fn new(config: &crate::config::Config, raw: &Value) -> Result<Self> {
        Self::with_embedders(
            config,
            raw,
            Arc::new(crate::embeddings::Registry::new(&config.raw)),
        )
    }
    pub fn with_embedders(
        config: &crate::config::Config,
        raw: &Value,
        embedders: Arc<crate::embeddings::Registry>,
    ) -> Result<Self> {
        let settings = Settings::new(raw, &config.env)?;
        let processor = Arc::new(crate::document_processor::Processor::for_tool(
            config, &settings,
        )?);
        Ok(Self {
            config: config.clone(),
            settings,
            processor,
            retrieval: tokio::sync::OnceCell::new(),
            retriever: tokio::sync::OnceCell::new(),
            embedders,
        })
    }

    pub fn schema(&self, name: &str) -> Value {
        self.settings.schema(name)
    }

    pub async fn call(&self, input: &Value, headers: &http::HeaderMap) -> Result<Text> {
        // Validate the public operation contract before choosing a handler.
        // Forward the original input: coercion inserts defaults for other
        // operations, which are deliberately absent from the wire arguments.
        let validated = arguments(input)?;
        match validated["operation"].as_str() {
            Some("search") => self.search(input, headers).await.map(Text::from),
            Some("list_collections") => self.list(input, headers).await.map(Text::from),
            Some("extract") => self.extract(input, headers).await.map(Text::from),
            Some("ingest") => self.ingest(input, headers).await,
            _ => unreachable!("validated document operation"),
        }
    }

    pub async fn search(&self, input: &Value, headers: &http::HeaderMap) -> Result<String> {
        let input = arguments(input)?;
        let user = crate::preparation::header(headers, "x-user-id");
        if user.is_empty() {
            return Ok("Error: user document request denied: authenticated user header x-user-id is required.".into());
        }
        let collection = crate::collections::resolve(
            input["collection_name"].as_str(),
            Some(user),
            self.settings.values["default_collection_name"].as_str(),
        );
        let query = trim(input["query"].as_str().unwrap_or_default());
        let query = if query.is_empty() {
            "summary of the document"
        } else {
            query
        };
        let retriever = self
            .retriever
            .get_or_try_init(|| async {
                let embedder = self
                    .embedders
                    .get(self.settings.values["embedder_name"].as_str().unwrap())
                    .map_err(crate::document_search::Failure::from)?;
                let client = self.retrieval_client().await.map_err(|error| {
                    crate::document_search::Failure::new(
                        match error.downcast_ref::<crate::milvus::ReadFailure>() {
                            Some(crate::milvus::ReadFailure::Configuration) => {
                                "ConnectionConfigException"
                            }
                            Some(crate::milvus::ReadFailure::Transport) => "_InactiveRpcError",
                            _ => "MilvusException",
                        },
                    )
                })?;
                Ok::<_, crate::document_search::Failure>(crate::document_retriever::Retriever::new(
                    &self.config,
                    client,
                    embedder,
                    self.settings.values.clone(),
                ))
            })
            .await?;
        let documents = retriever.search(query, &collection, &input).await?;
        Ok(crate::document_search::format(&documents, &collection))
    }

    /// Listing and search share an owned read connection, independent of the
    /// ingestion writer and the public metadata route's readiness probe.
    async fn retrieval_client(&self) -> Result<crate::milvus::Client> {
        Ok(self
            .retrieval
            .get_or_try_init(|| async {
                let connection: crate::milvus_index_transport::Connection =
                    serde_json::from_value(self.settings.values.clone())?;
                crate::milvus::Client::for_tool(&self.config, &connection.arguments(false)).await
            })
            .await?
            .clone())
    }

    pub async fn list(&self, input: &Value, headers: &http::HeaderMap) -> Result<String> {
        arguments(input)?;
        let user = crate::preparation::header(headers, "x-user-id");
        if user.is_empty() {
            return Ok("Error: user document request denied: authenticated user header x-user-id is required.".into());
        }
        let listed = async { self.retrieval_client().await?.collections().await }.await;
        let Ok(mut names) = listed else {
            return Ok("Error listing Milvus collections.".into());
        };
        let private = crate::collections::resolve(
            None,
            Some(user),
            self.settings.values["default_collection_name"].as_str(),
        );
        names
            .retain(|name| name == &private || crate::collections::SHARED.contains(&name.as_str()));
        names.sort();
        Ok(if names.is_empty() {
            "No collections found.".into()
        } else {
            format!("Available collections:\n{}", names.join("\n"))
        })
    }

    pub async fn ingest(&self, input: &Value, headers: &http::HeaderMap) -> Result<Text> {
        use crate::{document_reservations, preparation::header};
        let input = arguments(input)?;
        let user = header(headers, "x-user-id");
        if user.is_empty() {
            return Ok("Error: user document request denied: authenticated user header x-user-id is required.".into());
        }
        let batch = truthy(&input["documentRefs"]);
        if !batch && !truthy(&input["documentRef"]) {
            return Ok("Error: documentRef or documentRefs is required for ingestion.".into());
        }
        let execution =
            if header(headers, "x-daedalus-execution-scope").eq_ignore_ascii_case("autonomy") {
                header(headers, "x-daedalus-execution-id")
            } else {
                ""
            };
        let reservation = if execution.is_empty() {
            None
        } else {
            let reserved = async {
                let prepared = document_reservations::prepare(
                    &self.config,
                    &self.settings,
                    &input,
                    user,
                    execution,
                    |key| self.processor.immutable_record(key),
                )
                .await?;
                document_reservations::reserve(&self.config, &prepared).await
            }
            .await;
            match reserved {
                Ok(reservation) => {
                    if let Some(result) = reservation.replay() {
                        return Ok(result);
                    }
                    Some(reservation)
                }
                Err(error) => {
                    return Ok(
                        format!("Error: document ingest idempotency unavailable: {error}.").into(),
                    );
                }
            }
        };
        let mut request = input;
        request["username"] = json!(user);
        let result = if batch {
            self.processor
                .clone()
                .ingest(serde_json::from_value(request)?, None)
                .await?
                .into()
        } else {
            let mut outcome = self
                .processor
                .ingest_single(&self.settings, serde_json::from_value(request)?)
                .await?;
            // Only Markdown owns these markers. The fallback filename may
            // contain a real private-use character after HTML removes a marker.
            let mut surrogates = std::mem::take(&mut outcome.surrogates);
            surrogates.retain(|marker, _| outcome.markdown.contains(*marker));
            Text::new(single(&serde_json::to_value(outcome)?), surrogates)
        };
        if let Some(reservation) = reservation
            && !document_reservations::complete(&self.config, &reservation, &result).await?
        {
            tracing::warn!(
                "Document ingest finished but its idempotency result couldn't be finalized"
            );
        }
        Ok(result)
    }

    pub async fn extract(&self, input: &Value, headers: &http::HeaderMap) -> Result<String> {
        let input = arguments(input)?;
        let user = crate::preparation::header(headers, "x-user-id");
        if user.is_empty() {
            return Ok("Error: user document request denied: authenticated user header x-user-id is required.".into());
        }
        if truthy(&input["documentRefs"]) {
            return Ok("Error: extract operation only accepts a single documentRef; use operation='ingest' for multi-document batches.".into());
        }
        if !truthy(&input["documentRef"]) {
            return Ok("Error: documentRef is required for extraction.".into());
        }
        match self
            .processor
            .extract_tool(&input["documentRef"], user)
            .await
        {
            Err(error) => Ok(error.to_string()),
            Ok(result) => Ok(extracted_with_surrogates(
                &json!({"status":"success",
                "filename":result.filename, "pages":result.pages, "markdown":result.markdown,
                "truncated":result.truncated,"original_chars":result.original_chars}),
                &result.surrogates,
            )),
        }
    }
}

static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../resources/document-tools.json")).unwrap()
});

pub fn error_content(error: &anyhow::Error) -> String {
    let class = if let Some(failure) = error.downcast_ref::<crate::document_search::Failure>() {
        if failure.class == "ValidationError" {
            return json_text(&json!(failure.validation), false, true, true);
        }
        failure.class
    } else if let Some(failure) = error.downcast_ref::<redis::RedisError>() {
        if failure.is_timeout() {
            "TimeoutError"
        } else if failure.is_io_error() {
            "ConnectionError"
        } else {
            "ResponseError"
        }
    } else {
        "RuntimeError"
    };
    format!("Tool failed ({class}). Check its arguments and service availability.")
}
static INPUT: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    jsonschema::options()
        .should_validate_formats(false)
        .build(&CONTRACT["schema"]["parameters"])
        .unwrap()
});
fn invalid() -> anyhow::Error {
    anyhow!("Invalid document tool configuration or arguments")
}
pub(super) fn integer(input: &Value) -> Result<Value> {
    match input {
        Value::Bool(value) => Ok(json!(u8::from(*value))),
        Value::Number(number) if !number.to_string().contains(['.', 'e', 'E']) => {
            Ok(if number.to_string() == "-0" {
                json!(0)
            } else {
                input.clone()
            })
        }
        Value::Number(number) => {
            let value = number.as_f64().ok_or_else(invalid)?;
            if value.fract() != 0.
                || !(-9223372036854775808.0..9223372036854775808.0).contains(&value)
            {
                return Err(invalid());
            }
            Ok(json!(value as i64))
        }
        Value::String(raw) => {
            static INT: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"^[+-]?[0-9](?:_?[0-9])*(?:\.0+)?$").unwrap());
            let raw = raw.trim();
            if !INT.is_match(raw) {
                return Err(invalid());
            }
            let raw = raw.split('.').next().unwrap().replace('_', "");
            let negative = raw.starts_with('-');
            let digits = raw.trim_start_matches(['-', '+']).trim_start_matches('0');
            let canonical = if digits.is_empty() {
                "0".into()
            } else if negative {
                format!("-{digits}")
            } else {
                digits.to_owned()
            };
            serde_json::from_str(&canonical).map_err(|_| invalid())
        }
        _ => Err(invalid()),
    }
}
pub(super) fn number(input: &Value) -> Result<Value> {
    let value = match input {
        Value::Bool(value) => f64::from(u8::from(*value)),
        Value::Number(number) => number.as_f64().ok_or_else(invalid)?,
        Value::String(raw) => {
            static FLOAT: LazyLock<Regex> = LazyLock::new(|| {
                Regex::new(r"(?i)^[+-]?(?:(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:e[+-]?[0-9](?:_?[0-9])*)?|inf(?:inity)?|nan)$").unwrap()
            });
            if !FLOAT.is_match(raw.trim()) {
                return Err(invalid());
            }
            raw.trim().replace('_', "").parse().map_err(|_| invalid())?
        }
        _ => return Err(invalid()),
    };
    // JSON cannot store nonfinite floats. Retain a canonical numeric string
    // internally so the typed consumer can recover the same configured value.
    Ok(if value.is_finite() {
        json!(value)
    } else if value.is_nan() {
        json!("nan")
    } else if value.is_sign_negative() {
        json!("-inf")
    } else {
        json!("inf")
    })
}
pub(super) fn coerce(input: &Value, schema: &Value) -> Result<Value> {
    if let Some(options) = schema["anyOf"].as_array() {
        return options
            .iter()
            .find_map(|option| coerce(input, option).ok())
            .ok_or_else(invalid);
    }
    let result = match schema["type"].as_str() {
        Some("null") if input.is_null() => Value::Null,
        Some("string") if input.is_string() => input.clone(),
        Some("integer") => integer(input)?,
        Some("number") => number(input)?,
        Some("boolean") => match input {
            Value::Bool(_) => input.clone(),
            Value::Number(_) if input.as_f64() == Some(0.) => json!(false),
            Value::Number(_) if input.as_f64() == Some(1.) => json!(true),
            Value::String(value) => match value.to_ascii_lowercase().as_str() {
                "0" | "f" | "false" | "n" | "no" | "off" => json!(false),
                "1" | "t" | "true" | "y" | "yes" | "on" => json!(true),
                _ => return Err(invalid()),
            },
            _ => return Err(invalid()),
        },
        Some("array") => json!(
            input
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .map(|item| coerce(item, &schema["items"]))
                .collect::<Result<Vec<_>>>()?
        ),
        Some("object") if input.is_object() => input.clone(),
        None => input.clone(),
        _ => return Err(invalid()),
    };
    // These configuration/input models only constrain integer bounds at zero.
    if schema
        .get("exclusiveMinimum")
        .is_some_and(|bound| bound == &json!(0))
        && (result == json!(0) || result.to_string().starts_with('-'))
        || schema
            .get("minimum")
            .is_some_and(|bound| bound == &json!(0))
            && result.to_string().starts_with('-')
    {
        return Err(invalid());
    }
    Ok(result)
}

pub struct Settings {
    pub values: Value,
}
impl Settings {
    pub fn new(raw: &Value, env: &HashMap<String, String>) -> Result<Self> {
        let raw = raw.as_object().ok_or_else(invalid)?;
        let mut values = CONTRACT["defaults"].clone();
        let configured = |name: &str| env.get(name).filter(|value| !value.is_empty());
        for (field, variable, fallback) in [
            ("milvus_username", "MILVUS_USERNAME", Some("MILVUS_USER")),
            ("milvus_password", "MILVUS_PASSWORD", None),
            ("milvus_token", "MILVUS_TOKEN", None),
        ] {
            values[field] = json!(configured(variable).or_else(|| fallback.and_then(configured)));
        }
        for (field, variable, fallback) in [
            ("minio_endpoint", "MINIO_ENDPOINT", ""),
            ("minio_access_key", "MINIO_ACCESS_KEY", ""),
            ("minio_secret_key", "MINIO_SECRET_KEY", ""),
            ("minio_bucket", "MINIO_BUCKET", "nv-ingest"),
        ] {
            values[field] = json!(trim(
                configured(variable).map(String::as_str).unwrap_or(fallback)
            ));
        }
        let fields = &CONTRACT["configuration_schema"]["properties"];
        for (name, value) in raw {
            if name == "_type" && value == "nat_nv_ingest" {
                continue;
            }
            let field = fields.get(name).ok_or_else(invalid)?;
            values[name] = coerce(value, field)?;
        }
        Ok(Self { values })
    }
    pub fn schema(&self, name: &str) -> Value {
        let mut schema = CONTRACT["schema"].clone();
        schema["name"] = json!(name);
        if truthy(&self.values["description"]) {
            schema["description"] = self.values["description"].clone();
        }
        schema
    }
}
pub fn input_error(input: &Value) -> Option<String> {
    // The catalogue accepts mathematically integral floats, but Pydantic's
    // float-to-int conversion is bounded at i64 even for unbounded int fields.
    let errors: Vec<_> = ["top_k", "chunk_size", "chunk_overlap"].into_iter()
        .filter(|name| {
            input[*name].is_number() && input[*name].to_string().contains(['.', 'e', 'E'])
                && input[*name].as_f64().is_some_and(|value| value.is_finite()
                    && value.fract() == 0. && !(-9223372036854775808.0..9223372036854775808.0).contains(&value))
        })
        .map(|name| json!({"type":"int_parsing_size","loc":[name],"msg":"Unable to parse input string as an integer, exceeded maximum size"}))
        .collect();
    (!errors.is_empty()).then(|| json_text(&json!(errors), false, true, true))
}
pub fn arguments(input: &Value) -> Result<Value> {
    let validation = INPUT.iter_errors(input).take(8).map(|error| {
        let kind = if matches!(error.kind(), jsonschema::error::ValidationErrorKind::FalseSchema) { "None" } else { error.kind().keyword() };
        let mut current = input;
        let mut location = Vec::new();
        for part in error.instance_path().to_string().split('/').skip(1) {
            let part = part.replace("~1", "/").replace("~0", "~");
            if current.is_array() {
                let index: usize = part.parse().unwrap();
                location.push(json!(index));
                current = &current[index];
            } else {
                location.push(json!(part));
                current = &current[&part];
            }
        }
        json!({"type":"value_error","loc":location,"msg":format!("Value error, Argument contract: {kind}"),"ctx":{"error":format!("Argument contract: {kind}")}})
    }).collect::<Vec<_>>();
    if !validation.is_empty() {
        return Err(crate::document_search::Failure {
            class: "ValidationError",
            validation,
        }
        .into());
    }
    if let Some(error) = input_error(input) {
        return Err(crate::document_search::Failure {
            class: "ValidationError",
            validation: serde_json::from_str(&error)?,
        }
        .into());
    }
    let mut output = json!({});
    for (name, schema) in CONTRACT["schema"]["parameters"]["properties"]
        .as_object()
        .unwrap()
    {
        if let Some(value) = input.get(name) {
            output[name] = coerce(value, schema)?;
        } else if let Some(value) = schema.get("default") {
            output[name] = value.clone();
        }
    }
    Ok(output)
}

pub fn single(result: &Value) -> String {
    if result["status"] == "failure" {
        return identifier(&result["error"]);
    }
    let filename = identifier(&result["filename"]);
    let chunks = identifier(&result["chunks"]);
    let pages = identifier(&result["pages"]);
    let collection = identifier(&result["collection"]);
    if truthy(&result["markdown"]) {
        return format!(
            "{}\n\n---\n\n*1 document indexed • {pages} pages • {chunks} chunks in collection '{collection}'*",
            identifier(&result["markdown"])
        );
    }
    if result["status"] == "success" {
        return format!(
            "✅ Successfully processed document '{filename}'\n\n- 1 document indexed\n- {pages} pages\n- {chunks} text chunks\n- Stored in collection '{collection}'\n\nThe document is now searchable in your knowledge base!"
        );
    }
    let failures = identifier(&result["failures"]);
    format!(
        "⚠️ Partially processed document '{filename}'\n\n- 1 document indexed\n- {pages} pages\n- {chunks} chunks successful, {failures} failed\n- Stored in collection '{collection}'\n\nSome content may be missing from the search index."
    )
}
#[cfg(test)]
pub fn extracted(result: &Value) -> String {
    extracted_with_surrogates(result, &Default::default())
}
fn extracted_with_surrogates(
    result: &Value,
    surrogates: &crate::document_json::Surrogates,
) -> String {
    if result["status"] == "failure" {
        return identifier(&result["error"]);
    }
    let field = |name| json_text(&result[name], false, true, true);
    let markdown = result["markdown"]
        .as_str()
        .map(|text| crate::document_json::ascii_string(text, surrogates))
        .unwrap_or_else(|| field("markdown"));
    format!(
        "<<<DAEDALUS_EXTRACT_JSON>>>{{\"filename\": {}, \"pages\": {}, \"markdown\": {markdown}, \"truncated\": {}, \"original_chars\": {}}}<<<END>>>",
        field("filename"),
        field("pages"),
        field("truncated"),
        field("original_chars")
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    /// Run the frozen retriever-result formatting cases through the production
    /// formatter. Metadata stays opaque JSON, as in the retained Document model.
    fn search(results: &[Value], collection: &str) -> String {
        let documents = results
            .iter()
            .map(|result| crate::document_search::Document {
                content: match &result["page_content"] {
                    Value::Null => None,
                    Value::String(text) => Some(text.clone()),
                    other => panic!("Unsupported fixture page_content: {other}"),
                },
                metadata: result["metadata"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(key, value)| {
                        (
                            key.clone(),
                            crate::milvus_search::Field::Json(value.clone()),
                        )
                    })
                    .collect(),
            })
            .collect::<Vec<_>>();
        crate::document_search::format(&documents, collection)
    }
    enum SearchAdapter {
        Documents(Box<Adapter>),
        Domain(Box<crate::domain_retriever::Adapter>),
    }
    impl SearchAdapter {
        fn new(
            config: &crate::config::Config,
            raw: &Value,
            registry: Arc<crate::embeddings::Registry>,
        ) -> Result<Self> {
            if raw["_type"] == "domain_retriever" {
                crate::domain_retriever::Adapter::with_embedders(config, raw, registry)
                    .map(Box::new)
                    .map(Self::Domain)
            } else {
                Adapter::with_embedders(config, raw, registry)
                    .map(Box::new)
                    .map(Self::Documents)
            }
        }
        async fn call(&self, input: &Value, headers: &http::HeaderMap) -> Result<String> {
            match self {
                Self::Domain(tool) => tool.search(input).await,
                Self::Documents(tool) if input["operation"] == "list_collections" => {
                    tool.list(input, headers).await
                }
                Self::Documents(tool) => tool.search(input, headers).await,
            }
        }
    }
    #[tokio::test]
    #[ignore = "requires the real embedding and Milvus services in document_search_check.py"]
    async fn actual_search_adapter() {
        let fixture: Value = serde_json::from_slice(
            &std::fs::read(std::env::var("DAEDALUS_DOCUMENT_SEARCH_FIXTURE").unwrap()).unwrap(),
        )
        .unwrap();
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let control = fixture["control"].as_str().unwrap();
        let embedding = fixture["embedding_control"].as_str().unwrap();
        let reranking = fixture["reranking_control"].as_str().unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            crate::milvus_timestamps::clear();
            http.post(format!("{reranking}/__reset"))
                .json(&case["reranking"])
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            http.post(format!("{control}/reset"))
                .json(&case["settings"])
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            http.post(format!("{embedding}/__reset"))
                .json(&case["embedding"])
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            let config = crate::config::Config {
                raw: case["configuration"].clone(),
                policy_raw: json!({}),
                python_tools: false,
                env: serde_json::from_value(case["environment"].clone()).unwrap(),
            };
            let registry = Arc::new(crate::embeddings::Registry::new(&config.raw));
            let mut tools = HashMap::new();
            let mut results = Vec::new();
            let mut pending = Vec::new();
            for invocation in case["invocations"].as_array().unwrap() {
                if let Some(writes) = invocation["writes"].as_array().filter(|v| !v.is_empty()) {
                    for write in writes {
                        http.post(format!("{control}/configure"))
                            .json(&write["settings"])
                            .send()
                            .await
                            .unwrap()
                            .error_for_status()
                            .unwrap();
                        let result = crate::milvus_index_transport::tests::perform(
                            crate::milvus_index_transport::tests::configured(
                                write["uri"].as_str().unwrap(),
                            ),
                            write.clone(),
                        )
                        .await;
                        assert_eq!(
                            result.is_ok(),
                            write["success"].as_bool().unwrap(),
                            "Native mutation: {result:?}"
                        );
                        let state: Value = http
                            .get(format!("{control}/script"))
                            .send()
                            .await
                            .unwrap()
                            .json()
                            .await
                            .unwrap();
                        assert_eq!(
                            state,
                            json!({"remaining":0,"errors":[]}),
                            "Native mutation script"
                        );
                    }
                    http.post(format!("{control}/configure"))
                        .json(&case["settings"])
                        .send()
                        .await
                        .unwrap()
                        .error_for_status()
                        .unwrap();
                }
                if let Some(seconds) = invocation["sleep"].as_f64() {
                    tokio::time::sleep(std::time::Duration::from_secs_f64(seconds)).await;
                }
                let mut raw_headers = case["headers"].as_object().unwrap().clone();
                if let Some(overrides) = invocation["headers"].as_object() {
                    raw_headers.extend(overrides.clone());
                }
                let mut headers = http::HeaderMap::new();
                for (key, value) in raw_headers {
                    headers.insert(
                        http::HeaderName::from_bytes(key.as_bytes()).unwrap(),
                        value.as_str().unwrap().parse().unwrap(),
                    );
                }
                let name = invocation["tool"].as_str().unwrap_or("documents");
                let tool = tools
                    .entry(name.to_owned())
                    .or_insert_with(|| {
                        Arc::new(
                            SearchAdapter::new(
                                &config,
                                &config.raw["functions"][name],
                                registry.clone(),
                            )
                            .unwrap(),
                        )
                    })
                    .clone();
                let input = invocation["input"].clone();
                let duration_range = invocation["duration_range"].clone();
                let settle = invocation["settle"].as_f64();
                let execute = async move {
                    let started = std::time::Instant::now();
                    let result = tool.call(&input, &headers).await;
                    let observed = match result {
                        Ok(value) => json!({"result":value}),
                        Err(error) => {
                            let error = error
                                .downcast_ref::<crate::document_search::Failure>()
                                .expect("typed document search failure");
                            if error.class == "ValidationError" {
                                json!({"error":error.class,"validation":error.validation})
                            } else {
                                json!({"error":error.class})
                            }
                        }
                    };
                    if let Some(bounds) = duration_range.as_array() {
                        let elapsed = started.elapsed().as_secs_f64();
                        assert!(
                            elapsed >= bounds[0].as_f64().unwrap()
                                && elapsed <= bounds[1].as_f64().unwrap(),
                            "Native request took {elapsed:.3}s, expected {bounds:?}"
                        );
                        println!("Native reranker timed request: {elapsed:.3}s");
                    }
                    if let Some(seconds) = settle {
                        tokio::time::sleep(std::time::Duration::from_secs_f64(seconds)).await;
                    }
                    observed
                };
                if case["parallel"] == true {
                    pending.push(tokio::spawn(execute));
                } else {
                    results.push(execute.await);
                }
            }
            if case["parallel"] == true {
                let held = tokio::time::timeout(std::time::Duration::from_secs(10), async {
                    loop {
                        let calls: Vec<Value> = http
                            .get(format!("{control}/calls"))
                            .send()
                            .await
                            .unwrap()
                            .json()
                            .await
                            .unwrap();
                        if calls
                            .iter()
                            .filter(|call| call["method"] == "Search")
                            .count()
                            >= 8
                        {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    let calls: Vec<Value> = http
                        .get(format!("{control}/calls"))
                        .send()
                        .await
                        .unwrap()
                        .json()
                        .await
                        .unwrap();
                    calls
                        .iter()
                        .filter(|call| call["method"] == "Search")
                        .count()
                })
                .await;
                http.post(format!("{control}/release"))
                    .send()
                    .await
                    .unwrap()
                    .error_for_status()
                    .unwrap();
                assert_eq!(held.unwrap(), 8, "retriever search slots");
                for task in pending {
                    results.push(task.await.unwrap());
                }
            }
            assert_eq!(json!(results), case["expected"], "{}", case["name"]);
            let mut calls: Vec<Value> = http
                .get(format!("{control}/calls"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            calls.retain(|call| call["phase"] != "write");
            for call in &mut calls {
                if let Some(info) = call["body"]["client_info"].as_object() {
                    assert_eq!(info["sdk_type"], "Rust");
                    let mut retained = serde_json::Map::new();
                    if let Some(user) = info.get("user") {
                        retained.insert("user".into(), user.clone());
                    }
                    call["body"]["client_info"] = Value::Object(retained);
                }
                for (key, replacement) in [
                    ("identifier", "<session>"),
                    ("client-request-unixmsec", "<timestamp>"),
                ] {
                    if let Some(value) = call["metadata"].get_mut(key) {
                        assert!(value.as_str().unwrap().chars().all(|c| c.is_ascii_digit()));
                        *value = json!(replacement);
                    }
                }
            }
            assert_eq!(
                json!(calls),
                case["expected_milvus"],
                "Milvus {}",
                case["name"]
            );
            let mut calls: Value = http
                .get(format!("{embedding}/calls"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let mut expected = case["expected_embedding"].clone();
            if case["invocations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|invocation| {
                    invocation["writes"]
                        .as_array()
                        .is_some_and(|v| !v.is_empty())
                })
            {
                // Indexing can cross the five-second embedding pool expiry in
                // only one implementation. Socket identity is not a search
                // mutation contract; keep comparing every HTTP request field.
                // The cached/shared-registry and metadata-expiry cases above
                // still compare connection reuse without intervening writes.
                for trace in [&mut calls, &mut expected] {
                    for call in trace.as_array_mut().unwrap() {
                        call.as_object_mut().unwrap().remove("connection");
                    }
                }
            }
            assert_eq!(calls, expected, "Embeddings {}", case["name"]);
            let calls: Value = http
                .get(format!("{reranking}/calls"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(
                calls, case["expected_reranking"],
                "Reranking {}",
                case["name"]
            );
            println!("Native search coordinator: {}", case["name"]);
        }
    }
    #[tokio::test]
    #[ignore = "requires the real services in document_tool_ingestion_check.py"]
    async fn actual_ingestion_coordinator() {
        actual_document_adapter().await;
    }
    #[tokio::test]
    #[ignore = "requires the real services in document_tool_extraction_check.py"]
    async fn actual_extraction_adapter() {
        actual_document_adapter().await;
    }
    #[tokio::test]
    #[ignore = "requires the disposable service fixture in document_tool_listing_check.py"]
    async fn actual_listing_adapter() {
        actual_document_adapter().await;
    }
    async fn actual_document_adapter() {
        let fixture: Value = serde_json::from_slice(
            &std::fs::read(std::env::var("DAEDALUS_DOCUMENT_TOOL_FIXTURE").unwrap()).unwrap(),
        )
        .unwrap();
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let control = fixture["control"].as_str().unwrap();
        let nv = fixture["nv_control"].as_str().unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            http.post(format!("{control}/reset"))
                .json(&case["settings"])
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            http.post(format!("{nv}/__runner/reset"))
                .json(case)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            let config = crate::config::Config {
                raw: json!({}),
                policy_raw: json!({}),
                python_tools: false,
                env: serde_json::from_value(case["environment"].clone()).unwrap(),
            };
            let tool = Arc::new(Adapter::new(&config, &case["tool_config"]).unwrap());
            let mut headers = http::HeaderMap::new();
            for (key, value) in case["headers"].as_object().unwrap() {
                headers.insert(
                    http::HeaderName::from_bytes(key.as_bytes()).unwrap(),
                    value.as_str().unwrap().parse().unwrap(),
                );
            }
            let mut results = Vec::new();
            for index in 0..case["invocations"].as_u64().unwrap() {
                if let Some(user) = case["users"][index as usize].as_str() {
                    headers.insert("x-user-id", user.parse().unwrap());
                }
                if index == 0 && case["cancel"] == true {
                    let owner = tool.clone();
                    let input = case["input"].clone();
                    let context = headers.clone();
                    let task = tokio::spawn(async move { owner.ingest(&input, &context).await });
                    tokio::time::timeout(std::time::Duration::from_secs(15), async {
                        loop {
                            let held: Value = http
                                .get(format!("{nv}/__tool/held"))
                                .send()
                                .await
                                .unwrap()
                                .json()
                                .await
                                .unwrap();
                            if held["held"] == true {
                                break;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                        }
                    })
                    .await
                    .unwrap();
                    task.abort();
                    assert!(task.await.unwrap_err().is_cancelled());
                    results.push(json!({"cancelled":true}));
                } else {
                    let result = match case["input"]["operation"].as_str() {
                        Some("extract") => {
                            tool.extract(&case["input"], &headers).await.map(Text::from)
                        }
                        Some("list_collections") => {
                            tool.list(&case["input"], &headers).await.map(Text::from)
                        }
                        _ => tool.ingest(&case["input"], &headers).await,
                    };
                    results.push(match result {
                        Ok(result) => json!({"result":result.observation()}),
                        Err(_) => json!({"error":true}),
                    });
                }
            }
            if case["cancel"] == true {
                http.post(format!("{nv}/__tool/release"))
                    .send()
                    .await
                    .unwrap()
                    .error_for_status()
                    .unwrap();
                tokio::time::timeout(std::time::Duration::from_secs(15), async {
                    loop {
                        let state: Value = http
                            .get(format!("{control}/script"))
                            .send()
                            .await
                            .unwrap()
                            .json()
                            .await
                            .unwrap();
                        if state["remaining"] == 0 {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    }
                })
                .await
                .unwrap();
            }
            let calls: Value = http
                .get(format!("{nv}/__runner/calls"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let receipts: Value = http
                .get(format!("{nv}/__tool/receipts"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let mut actual = json!({"result":results, "events":[], "nv_calls":calls["nv_calls"],
                "object_calls":calls["object_calls"], "receipts":receipts});
            if case["capture_milvus"] == true {
                let mut calls: Value = http
                    .get(format!("{control}/calls"))
                    .send()
                    .await
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
                for call in calls.as_array_mut().unwrap() {
                    if let Some(info) = call["body"]
                        .get_mut("client_info")
                        .and_then(Value::as_object_mut)
                    {
                        assert_eq!(info["sdk_type"], "Rust");
                        info.retain(|key, _| key == "user");
                    }
                    for (key, value) in [
                        ("identifier", "<session>"),
                        ("client-request-unixmsec", "<timestamp>"),
                    ] {
                        if let Some(old) = call["metadata"].get_mut(key) {
                            assert!(old.as_str().unwrap().chars().all(|c| c.is_ascii_digit()));
                            *old = json!(value);
                        }
                    }
                }
                actual["milvus_calls"] = calls;
            }
            assert_eq!(actual, case["expected"], "{}", case["name"]);
            let state: Value = http
                .get(format!("{control}/script"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(
                state,
                json!({"remaining":0,"errors":[]}),
                "{}",
                case["name"]
            );
            println!("Native tool: {}", case["name"]);
        }
    }

    #[test]
    fn retained_document_adapter_contracts() {
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/document-tools.json")).unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        let defaults = Settings::new(&json!({}), &HashMap::new()).unwrap();
        assert_eq!(defaults.values, CONTRACT["defaults"]);
        assert_eq!(defaults.schema("user_documents"), CONTRACT["schema"]);
        let custom = Settings::new(
            &json!({"description":"Synthetic custom description"}),
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(custom.schema("renamed")["name"], "renamed");
        assert_eq!(
            custom.schema("renamed")["description"],
            "Synthetic custom description"
        );
        for case in fixture["configuration"].as_array().unwrap() {
            let actual = Settings::new(&case["input"], &HashMap::new());
            if let Some(expected) = case["expected"].get("ok") {
                let actual = actual.unwrap_or_else(|error| panic!("{}: {error}", case["input"]));
                for (name, expected) in expected.as_object().unwrap() {
                    assert_eq!(&actual.values[name], expected, "{}", case["input"]);
                }
            } else {
                assert!(actual.is_err(), "{}", case["input"]);
            }
        }
        for case in fixture["environment_defaults"].as_array().unwrap() {
            let env = serde_json::from_value(case["env"].clone()).unwrap();
            assert_eq!(
                Settings::new(&case["input"], &env).unwrap().values,
                case["expected"]
            );
        }
        for case in fixture["validation"].as_array().unwrap() {
            let actual = arguments(&case["input"]);
            if let Some(expected) = case["expected"].get("ok") {
                let actual = actual.unwrap_or_else(|error| panic!("{}: {error}", case["input"]));
                for (name, expected) in expected.as_object().unwrap() {
                    assert_eq!(&actual[name], expected, "{}", case["input"]);
                }
            } else {
                assert!(actual.is_err(), "{}", case["input"]);
                if let Some(errors) = case["expected"].get("validation_errors") {
                    assert_eq!(
                        input_error(&case["input"]),
                        Some(json_text(errors, false, true, true))
                    );
                }
            }
        }
        for case in fixture["formatting"].as_array().unwrap() {
            let input = &case["input"];
            let actual = match case["kind"].as_str().unwrap() {
                "single" => single(input),
                "extract" => extracted(input),
                "search" => search(
                    input["results"].as_array().unwrap(),
                    input["collection"].as_str().unwrap(),
                ),
                other => panic!("Unknown fixture {other}"),
            };
            assert_eq!(actual, case["expected"].as_str().unwrap(), "{case}");
        }
    }
}
