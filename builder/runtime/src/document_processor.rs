//! Shared extraction and ingestion clients with per-collection write ownership.
use crate::{
    config::Config, document_encoding, document_store, document_text, memory_tools::trim,
    nv_ingest, storage::Store,
};
use anyhow::{Result, anyhow};
use base64::Engine;
use regex::Regex;
use serde_json::Value;
use std::{
    sync::{Arc, LazyLock},
    time::Duration,
};
use tokio::sync::OnceCell;

pub const FAILED: &str = "Document operation failed.";
pub struct Extraction {
    pub filename: String,
    pub pages: usize,
    pub markdown: String,
    pub truncated: bool,
    pub original_chars: usize,
    pub unencodable: bool,
    pub surrogates: crate::document_json::Surrogates,
}
pub struct Processor {
    config: Config,
    options: Arc<nv_ingest::Options>,
    store: OnceCell<Store>,
    client: OnceCell<nv_ingest::Client>,
    port: i64,
    connect_timeout: Option<Duration>,
    read_timeout: Option<Duration>,
    timeout: Duration,
    redis_url: Option<String>,
    recreate: bool,
    bucket: String,
    locks: crate::document_ownership::Collections,
}
pub(super) fn integer(config: &Config, name: &str, default: i64) -> Result<i64> {
    let value = config.variable(name, "");
    if trim(&value).is_empty() {
        return Ok(default);
    }
    let number = document_store::integer(&value).ok_or_else(|| anyhow!(FAILED))?;
    Ok(number.parse().unwrap_or(if number.starts_with('-') {
        i64::MIN
    } else {
        i64::MAX
    }))
}
fn boolean(config: &Config, name: &str, default: bool) -> bool {
    config.env.get(name).map_or(default, |value| {
        matches!(
            trim(value).to_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}
pub(super) fn number(config: &Config, name: &str, default: f64) -> Result<f64> {
    let value = config.variable(name, "");
    if trim(&value).is_empty() {
        return Ok(default);
    }
    static FLOAT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^[+-]?(?:(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:e[+-]?[0-9](?:_?[0-9])*)?|inf(?:inity)?|nan)$").unwrap()
    });
    let value = document_store::decimal(&value);
    if !FLOAT.is_match(&value) {
        return Err(anyhow!(FAILED));
    }
    value.replace('_', "").parse().map_err(|_| anyhow!(FAILED))
}
fn timeout(seconds: i64) -> Option<Duration> {
    (seconds != 0).then(|| Duration::from_secs(seconds.max(0) as u64))
}
impl Processor {
    pub fn new(config: &Config) -> Result<Self> {
        // The retained route constructs the entire config even for extraction,
        // so malformed settings for unused indexing fields must still fail.
        for name in [
            "DOCUMENT_INGEST_CHUNK_SIZE",
            "DOCUMENT_INGEST_CHUNK_OVERLAP",
            "EMBEDDING_DENSE_DIM",
            "DOCUMENT_INGEST_WORKER_POOL_SIZE",
            "DOCUMENT_INGEST_BATCH_CONCURRENCY",
            "DOCUMENT_INGEST_MAX_DOCUMENTS_PER_BATCH",
            "DOCUMENT_INGEST_MAX_RETRIES",
        ] {
            integer(config, name, 0)?;
        }
        number(config, "DOCUMENT_INGEST_RETRY_DELAY", 1.)?;
        let seconds = number(config, "DOCUMENT_INGEST_TIMEOUT_SECONDS", 300.)?.max(1.);
        Ok(Self {
            config: config.clone(),
            options: Arc::new(nv_ingest::Options {
                method: config.variable("DOCUMENT_INGEST_EXTRACT_METHOD", "pdfium"),
                pages: integer(config, "DOCUMENT_INGEST_PDF_PAGES_PER_CHUNK", 32)?,
                v2: boolean(config, "DOCUMENT_INGEST_USE_V2_API", false),
                filter: boolean(config, "DOCUMENT_INGEST_ENABLE_IMAGE_FILTER", true),
                caption: None,
                env: config.env.clone(),
            }),
            port: integer(config, "NV_INGEST_PORT", 7670)?,
            connect_timeout: timeout(integer(config, "DOCUMENT_INGEST_REDIS_CONNECT_TIMEOUT", 5)?),
            read_timeout: timeout(integer(config, "DOCUMENT_INGEST_REDIS_SOCKET_TIMEOUT", 30)?),
            // Infinity in the old config disables its practical deadline. Keep
            // an Instant-safe ceiling (about 31,000 years) for that case.
            timeout: Duration::from_secs_f64(seconds.min(1e12)),
            redis_url: None,
            recreate: false,
            // HTTP config passes the environment value explicitly, including
            // empty/whitespace strings; the named tool's default factory trims.
            bucket: config.variable("MINIO_BUCKET", "nv-ingest"),
            store: OnceCell::new(),
            client: OnceCell::new(),
            locks: Default::default(),
        })
    }
    pub fn for_tool(config: &Config, settings: &crate::document_tools::Settings) -> Result<Self> {
        let values = &settings.values;
        let mut config = config.clone();
        // Override every API-derived processor setting with the tool model's
        // normalized value. Unrelated HTTP settings must not change this tool.
        for (field, variable) in [
            ("nv_ingest_host", "NV_INGEST_HOST"),
            ("nv_ingest_port", "NV_INGEST_PORT"),
            ("extract_method", "DOCUMENT_INGEST_EXTRACT_METHOD"),
            ("pdf_pages_per_chunk", "DOCUMENT_INGEST_PDF_PAGES_PER_CHUNK"),
            ("use_v2_api", "DOCUMENT_INGEST_USE_V2_API"),
            ("enable_image_filter", "DOCUMENT_INGEST_ENABLE_IMAGE_FILTER"),
            ("chunk_size", "DOCUMENT_INGEST_CHUNK_SIZE"),
            ("chunk_overlap", "DOCUMENT_INGEST_CHUNK_OVERLAP"),
            ("embedder_dim", "EMBEDDING_DENSE_DIM"),
            ("tokenizer", "TOKENIZER"),
            (
                "default_collection_name",
                "DOCUMENT_INGEST_DEFAULT_COLLECTION",
            ),
            ("worker_pool_size", "DOCUMENT_INGEST_WORKER_POOL_SIZE"),
            ("batch_concurrency", "DOCUMENT_INGEST_BATCH_CONCURRENCY"),
            (
                "max_documents_per_batch",
                "DOCUMENT_INGEST_MAX_DOCUMENTS_PER_BATCH",
            ),
            ("ingest_max_retries", "DOCUMENT_INGEST_MAX_RETRIES"),
            ("ingest_retry_delay", "DOCUMENT_INGEST_RETRY_DELAY"),
            ("ingest_timeout_seconds", "DOCUMENT_INGEST_TIMEOUT_SECONDS"),
            (
                "redis_connect_timeout",
                "DOCUMENT_INGEST_REDIS_CONNECT_TIMEOUT",
            ),
            (
                "redis_socket_timeout",
                "DOCUMENT_INGEST_REDIS_SOCKET_TIMEOUT",
            ),
            ("milvus_uri", "MILVUS_URI"),
        ] {
            config.env.insert(
                variable.into(),
                values[field]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| values[field].to_string()),
            );
        }
        config.env.remove("MILVUS_USER");
        for (field, variable) in [
            ("milvus_username", "MILVUS_USERNAME"),
            ("milvus_password", "MILVUS_PASSWORD"),
            ("milvus_token", "MILVUS_TOKEN"),
        ] {
            config.env.remove(variable);
            if let Some(value) = values[field].as_str() {
                config.env.insert(variable.into(), value.into());
            }
        }
        let mut processor = Self::new(&config)?;
        processor.redis_url = Some(values["redis_url"].as_str().unwrap().into());
        processor.recreate = values["recreate_collection"].as_bool().unwrap();
        processor.bucket = values["minio_bucket"].as_str().unwrap().into();
        if values["enable_captioning"] == true
            && let (Some(endpoint), Some(model)) = (
                values["caption_endpoint_url"]
                    .as_str()
                    .filter(|s| !s.is_empty()),
                values["caption_model_name"]
                    .as_str()
                    .filter(|s| !s.is_empty()),
            )
        {
            Arc::get_mut(&mut processor.options).unwrap().caption = Some(nv_ingest::Caption {
                endpoint: endpoint.into(),
                model: model.into(),
                api_key: values["caption_api_key"].as_str().map(str::to_owned),
            });
        }
        Ok(processor)
    }
    async fn redis(&self) -> Result<&Store> {
        self.store
            .get_or_try_init(|| async {
                match &self.redis_url {
                    Some(url) => Store::from_url(url, ""),
                    None => Store::new(&self.config),
                }
            })
            .await
    }
    pub async fn immutable_record(&self, key: String) -> Result<Option<Value>> {
        let raw = self
            .redis()
            .await?
            .document(&key, self.connect_timeout, self.read_timeout)
            .await
            .map_err(|_| anyhow!("Redis unavailable"))?;
        raw.filter(|bytes| !bytes.is_empty())
            .map(|bytes| {
                serde_json::from_slice(&bytes).map_err(|_| anyhow!("Invalid stored document JSON"))
            })
            .transpose()
    }
    pub async fn ingest_single(
        &self,
        settings: &crate::document_tools::Settings,
        request: crate::document_process::Request,
    ) -> Result<crate::document_process::Outcome> {
        let values = &settings.values;
        let options = crate::document_process::Options {
            default_collection_name: values["default_collection_name"].as_str().unwrap().into(),
            chunk_size: values["chunk_size"].clone(),
            chunk_overlap: values["chunk_overlap"].clone(),
            ingest_max_retries: integer(&self.config, "DOCUMENT_INGEST_MAX_RETRIES", 2)?,
            ingest_retry_delay: number(&self.config, "DOCUMENT_INGEST_RETRY_DELAY", 1.)?,
            ingest_timeout_seconds: number(&self.config, "DOCUMENT_INGEST_TIMEOUT_SECONDS", 300.)?,
        };
        Ok(crate::document_process::run(self, &self.locks, &options, request, None).await)
    }
    pub async fn ingest(
        self: Arc<Self>,
        request: crate::document_batch::Request,
        progress: Option<crate::document_batch::Progress>,
    ) -> Result<String> {
        use crate::{document_batch, document_process};
        let integer_value = |name, default| -> Result<Value> {
            let raw = self.config.variable(name, "");
            if trim(&raw).is_empty() {
                return Ok(serde_json::json!(default));
            }
            let raw = document_store::integer(&raw).ok_or_else(|| anyhow!(FAILED))?;
            serde_json::from_str(&raw).map_err(|_| anyhow!(FAILED))
        };
        let chunk_size = integer_value("DOCUMENT_INGEST_CHUNK_SIZE", 1024)?;
        let chunk_overlap = integer_value("DOCUMENT_INGEST_CHUNK_OVERLAP", 150)?;
        let collection = self
            .config
            .variable("DOCUMENT_INGEST_DEFAULT_COLLECTION", "user_uploads");
        let batch = document_batch::Options {
            max_documents_per_batch: integer(
                &self.config,
                "DOCUMENT_INGEST_MAX_DOCUMENTS_PER_BATCH",
                20,
            )?,
            batch_concurrency: integer(&self.config, "DOCUMENT_INGEST_BATCH_CONCURRENCY", 1)?,
            default_collection_name: collection.clone(),
            chunk_size: chunk_size.clone(),
            chunk_overlap: chunk_overlap.clone(),
            recreate_collection: self.recreate,
        };
        let options = Arc::new(document_process::Options {
            default_collection_name: collection,
            chunk_size,
            chunk_overlap,
            ingest_max_retries: integer(&self.config, "DOCUMENT_INGEST_MAX_RETRIES", 2)?,
            ingest_retry_delay: number(&self.config, "DOCUMENT_INGEST_RETRY_DELAY", 1.)?,
            ingest_timeout_seconds: number(&self.config, "DOCUMENT_INGEST_TIMEOUT_SECONDS", 300.)?,
        });
        let process: document_batch::Process = Arc::new(move |request, callback| {
            let processor = self.clone();
            let options = options.clone();
            Box::pin(async move {
                let result = document_process::run(
                    processor.as_ref(),
                    &processor.locks,
                    &options,
                    document_process::Request {
                        reference: request.reference,
                        username: request.username,
                        collection_name: Some(request.collection_name),
                        collection_scope: Some(request.collection_scope),
                        chunk_size: request.chunk_size,
                        chunk_overlap: request.chunk_overlap,
                    },
                    Some(callback),
                )
                .await;
                // Batch responses contain summary counts, not the generated
                // Markdown, including when that Markdown cannot be UTF-8 encoded.
                let _markdown_unencodable = result.markdown_unencodable;
                Ok(document_batch::Outcome {
                    status: result.status.into(),
                    filename: result.filename,
                    chunks: result.chunks,
                    pages: result.pages,
                    failures: result.failures,
                    error: result.error,
                })
            })
        });
        document_batch::run(&batch, request, process, progress).await
    }
    async fn nv_client(&self) -> Result<&nv_ingest::Client> {
        self.client
            .get_or_try_init(|| async {
                nv_ingest::Client::new(
                    &self
                        .config
                        .variable("NV_INGEST_HOST", "nv-ingest.daedalus.svc.cluster.local"),
                    self.port,
                    integer(&self.config, "DOCUMENT_INGEST_WORKER_POOL_SIZE", 16)?,
                )
            })
            .await
    }
    pub async fn extract(
        &self,
        reference: &Value,
        user: &str,
        limit: Option<usize>,
    ) -> Result<Extraction> {
        self.extract_mode(reference, user, limit, false).await
    }
    pub async fn extract_tool(&self, reference: &Value, user: &str) -> Result<Extraction> {
        use crate::{config::truthy, profile_import::identifier};
        if !reference.is_object() || !truthy(reference) {
            return Err(anyhow!("Error: Invalid document reference provided."));
        }
        if !truthy(&reference["documentId"]) || !truthy(&reference["sessionId"]) {
            return Err(anyhow!(
                "Error: Document reference must contain documentId and sessionId."
            ));
        }
        let reference = serde_json::json!({"documentId":identifier(&reference["documentId"]),
            "sessionId":identifier(&reference["sessionId"])});
        self.extract_mode(&reference, user, Some(50_000), true)
            .await
    }
    async fn extract_mode(
        &self,
        reference: &Value,
        user: &str,
        limit: Option<usize>,
        tool: bool,
    ) -> Result<Extraction> {
        let unexpected = |error: anyhow::Error| {
            if tool {
                anyhow!("An unexpected error occurred: {error}")
            } else {
                error
            }
        };
        let document = reference["documentId"].as_str().unwrap();
        let session = reference["sessionId"].as_str().unwrap();
        let store = self.redis().await.map_err(unexpected)?;
        let record = store.document(&format!("document:{session}:{document}"), self.connect_timeout, self.read_timeout).await
            .map_err(|error| anyhow!("Error accessing document storage: {error}"))?
            .filter(|bytes| !bytes.is_empty())
            .ok_or_else(|| anyhow!("Error: Document not found in storage. The file may have expired or the session may be invalid. Please try uploading the document again."))?;
        let record: Value = serde_json::from_slice(&record).map_err(|error| {
            if tool {
                unexpected(error.into())
            } else {
                anyhow!(FAILED)
            }
        })?;
        if tool && !record.is_object() {
            return Err(unexpected(document_text::attribute_error(&record, "get")));
        }
        let (bytes, filename) =
            document_store::load_record(&self.config, &record, document, session, user).await?;
        let client = self.nv_client().await.map_err(|error| {
            if tool {
                unexpected(error)
            } else {
                anyhow!(FAILED)
            }
        })?;
        let work = async {
            let options = self.options.clone();
            let source = filename.clone();
            let job = tokio::task::spawn_blocking(move || {
                let kind = nv_ingest::document_type(&source)?;
                if ["text", "html"].contains(&kind.as_str()) {
                    let content = document_encoding::read_text(&bytes)
                        .map_err(|_| anyhow!("Failed to extract content from buffer {source}"))?;
                    nv_ingest::job(&source, "", &options)
                        .map(|job| nv_ingest::payload(&job, &content))
                } else {
                    // Base64 is ASCII. As four-byte code points it would need
                    // about 1 GiB of transient memory for a 200 MB upload.
                    let content = base64::engine::general_purpose::STANDARD.encode(bytes);
                    nv_ingest::job(&source, "", &options)
                        .map(|job| nv_ingest::payload(&job, content.bytes().map(u32::from)))
                }
            })
            .await
            .map_err(|_| anyhow!(FAILED))??;
            let results = client.extract_payload(&job, self.timeout).await?;
            // The old renderer raises Python type/attribute errors for malformed
            // metadata. Their native equivalents must not become HTTP 400 just
            // because a Rust diagnostic happens to contain the word "invalid".
            tokio::task::spawn_blocking(move || {
                document_text::markdown(&results.results)
                    .map(|(text, pages)| (text, pages, results.surrogates))
            })
            .await
            .map_err(|_| anyhow!(FAILED))?
            .map_err(|error| if tool { error } else { anyhow!(FAILED) })
        };
        let (raw, pages, surrogates) = tokio::time::timeout(self.timeout, work)
            .await
            .map_err(|_| {
                anyhow!(
                    "Error extracting document with NvIngest: timed out after {:.0} seconds.",
                    self.timeout.as_secs_f64()
                )
            })?
            .map_err(|error| anyhow!("Error extracting document with NvIngest: {error}"))?;
        let original_chars = raw.chars().count();
        let (markdown, truncated) = document_text::limit(&raw, limit);
        let unencodable = markdown.chars().any(|c| surrogates.contains_key(&c));
        Ok(Extraction {
            filename,
            pages,
            markdown,
            truncated,
            original_chars,
            unencodable,
            surrogates,
        })
    }
}

impl crate::document_process::Services for Processor {
    type Engine = crate::document_pipeline::Engine;
    fn config(&self) -> &Config {
        &self.config
    }
    async fn fetch(
        &self,
        key: &str,
    ) -> std::result::Result<Option<Vec<u8>>, crate::document_process::FetchError> {
        use crate::document_process::FetchError;
        let store = self.redis().await.map_err(|error| FetchError {
            storage: false,
            message: error.to_string(),
        })?;
        store
            .document(key, self.connect_timeout, self.read_timeout)
            .await
            .map_err(|error| FetchError {
                storage: true,
                message: error.to_string(),
            })
    }
    async fn initialize(&self) -> Result<Self::Engine> {
        crate::document_pipeline::Engine::new(
            &self.config,
            self.options.clone(),
            self.nv_client().await?.clone(),
            self.recreate,
            self.bucket.clone(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        document_process::Services, document_tools::Settings, milvus_index_transport::Connection,
    };
    use serde_json::json;
    use std::collections::HashMap;

    #[tokio::test]
    async fn retained_named_tool_pipeline_options() {
        let mut fixture: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/document-tool-pipeline.json"
        ))
        .unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        for case in fixture["cases"].as_array().unwrap() {
            let env: HashMap<String, String> = serde_json::from_value(case["env"].clone()).unwrap();
            let settings = Settings::new(&case["input"], &env).unwrap();
            let mut config = Config {
                raw: json!({}),
                policy_raw: json!({}),
                env,
                python_tools: false,
            };
            // Poison independent API settings: the named tool must use its own
            // defaults and explicit null credentials instead of these values.
            for name in [
                "DOCUMENT_INGEST_CHUNK_SIZE",
                "NV_INGEST_PORT",
                "DOCUMENT_INGEST_RETRY_DELAY",
            ] {
                config.env.insert(name.into(), "malformed".into());
            }
            for name in [
                "MILVUS_USER",
                "MILVUS_USERNAME",
                "MILVUS_PASSWORD",
                "MILVUS_TOKEN",
                "REDIS_URL",
                "REDIS_PORT",
                "REDIS_TLS_CA_FILE",
            ] {
                config
                    .env
                    .insert(name.into(), "ignored-global-value".into());
            }
            let processor = Processor::for_tool(&config, &settings).unwrap();
            assert_eq!(
                processor.redis_url.as_deref(),
                settings.values["redis_url"].as_str()
            );
            assert_eq!(processor.recreate, settings.values["recreate_collection"]);
            let engine = processor.initialize().await.unwrap();
            let filename = case["filename"].as_str().unwrap();
            let kind = nv_ingest::document_type(filename).unwrap();
            let content = if kind == "text" {
                "Synthetic".into()
            } else {
                base64::engine::general_purpose::STANDARD.encode("Synthetic")
            };
            let result =
                nv_ingest::job(filename, &content, &processor.options).and_then(|mut job| {
                    if case["extract_only"] == false {
                        engine.indexing_tasks(
                            &mut job,
                            &settings.values["chunk_size"],
                            &settings.values["chunk_overlap"],
                        )?;
                    }
                    Ok(job)
                });
            if let Some(expected) = case["expected"].get("ok") {
                assert_eq!(result.unwrap(), expected[&kind][0], "{case}");
                if let Some(writer) = case["expected"].get("writer") {
                    let arguments = Connection::from_config(&processor.config).arguments(true);
                    assert_eq!(arguments["uri"], writer["milvus_uri"]);
                    assert_eq!(
                        arguments["token"],
                        format!(
                            "{}:{}",
                            crate::profile_import::identifier(&writer["username"]),
                            crate::profile_import::identifier(&writer["password"])
                        )
                    );
                    assert_eq!(processor.recreate, writer["recreate"]);
                    assert_eq!(
                        integer(&processor.config, "EMBEDDING_DENSE_DIM", 2048).unwrap(),
                        writer["dense_dim"]
                    );
                }
            } else {
                assert_eq!(
                    result.unwrap_err().to_string(),
                    case["expected"]["message"].as_str().unwrap(),
                    "{case}"
                );
            }
        }
    }
}
