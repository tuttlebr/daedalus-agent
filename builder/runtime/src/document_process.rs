//! Per-document ingestion. NV-Ingest extraction runs under the caller's
//! deadline without the collection; ownership spans the Milvus write, which
//! runs to completion even after its HTTP waiter disconnects or times out.
use crate::{
    collections,
    config::{Config, truthy},
    document_batch::Progress,
    document_ownership::{self, Collections, WaitError},
    document_store, document_text,
    profile_import::identifier,
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{future::Future, time::Duration};

#[derive(Deserialize)]
pub struct Request {
    #[serde(skip)]
    pub append_to_collection: bool,
    #[serde(rename = "documentRef")]
    pub reference: Value,
    pub username: String,
    pub collection_name: Option<String>,
    pub collection_scope: Option<String>,
    pub chunk_size: Option<Value>,
    pub chunk_overlap: Option<Value>,
}
#[derive(Deserialize)]
#[serde(default)]
pub struct Options {
    pub default_collection_name: String,
    pub chunk_size: Value,
    pub chunk_overlap: Value,
    pub ingest_max_retries: i64,
    pub ingest_retry_delay: f64,
    pub ingest_timeout_seconds: f64,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            default_collection_name: "user_uploads".into(),
            chunk_size: json!(1024),
            chunk_overlap: json!(150),
            ingest_max_retries: 2,
            ingest_retry_delay: 1.,
            ingest_timeout_seconds: 300.,
        }
    }
}
#[derive(Debug, Serialize)]
pub struct Outcome {
    pub status: &'static str,
    pub filename: Value,
    pub chunks: usize,
    pub failures: usize,
    pub pages: usize,
    pub collection: String,
    pub markdown: String,
    #[serde(skip)]
    pub markdown_unencodable: bool,
    #[serde(skip)]
    pub surrogates: crate::document_json::Surrogates,
    pub error: String,
}
#[derive(Clone)]
pub struct Build {
    pub append_to_collection: bool,
    /// Shared by every attempt: a retry must not copy the entire upload.
    pub bytes: bytes::Bytes,
    pub filename: String,
    pub collection_name: String,
    pub chunk_size: Value,
    pub chunk_overlap: Value,
}
pub struct Ingested {
    pub results: Value,
    pub failures: usize,
    pub surrogates: crate::document_json::Surrogates,
}
pub struct FetchError {
    pub storage: bool,
    pub message: String,
}
// Keep the service boundaries at the same places as the retained processor:
// storage initialization/read, NV client initialization, build, then execution.
pub trait Services: Sync {
    type Engine: Engine;
    fn config(&self) -> &Config;
    fn fetch(
        &self,
        key: &str,
    ) -> impl Future<Output = std::result::Result<Option<Vec<u8>>, FetchError>> + Send;
    fn initialize(&self) -> impl Future<Output = Result<Self::Engine>> + Send;
}
pub trait Engine: Clone + Send + Sync + 'static {
    type Pipeline: Pipeline;
    fn build(&self, input: Build) -> impl Future<Output = Result<Self::Pipeline>> + Send;
}
pub trait Pipeline: Send {
    type Extraction: Extraction;
    /// NV-Ingest extraction, chunking and embedding. It writes nothing to
    /// Milvus, so a timed-out or cancelled extraction is simply dropped.
    fn extract(self, progress: Stages) -> impl Future<Output = Result<Self::Extraction>> + Send;
}
pub trait Extraction: Send + 'static {
    /// The Milvus write, run to completion while owning the collection.
    fn write(self, progress: Stages) -> impl Future<Output = Result<Ingested>> + Send;
}

/// A service-side timeout has the same no-retry behavior as a waiter timeout.
#[derive(Debug)]
pub struct PipelineTimeout;
impl std::fmt::Display for PipelineTimeout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Document pipeline timed out")
    }
}
impl std::error::Error for PipelineTimeout {}

#[derive(Clone)]
pub struct Stages {
    callback: Option<Progress>,
    filename: Value,
    owned: bool,
}
impl Stages {
    pub fn worker(filename: Value, callback: Option<Progress>) -> Self {
        Self {
            filename,
            callback,
            owned: true,
        }
    }
    pub async fn emit(&self, phase: &str, message: &str, extra: Value) {
        let Some(callback) = &self.callback else {
            return;
        };
        let mut event = json!({"phase":phase});
        if !self.filename.is_null() {
            event["current"] = self.filename.clone();
        }
        if !message.is_empty() {
            event["message"] = json!(message);
        }
        event
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let forward = callback(event);
        // The retained worker allows two seconds for forwarding progress. A
        // stalled consumer cannot hold a started write indefinitely.
        let failed = if self.owned {
            !matches!(
                tokio::time::timeout(Duration::from_secs(2), forward).await,
                Ok(Ok(()))
            )
        } else {
            forward.await.is_err()
        };
        if failed {
            tracing::warn!("Ingestion progress callback failed; continuing");
        }
    }
}

fn first_len(value: &Value) -> usize {
    match &value[0] {
        Value::Array(v) => v.len(),
        Value::Object(v) => v.len(),
        Value::String(v) => v.chars().count(),
        _ => 0,
    }
}
async fn extract<E: Engine>(
    engine: E,
    input: Build,
    stages: Stages,
) -> Result<<E::Pipeline as Pipeline>::Extraction> {
    stages
        .emit(
            "preparing",
            "Building NV-Ingest extraction and Milvus upload pipeline",
            json!({}),
        )
        .await;
    let pipeline = engine.build(input).await?;
    stages
        .emit(
            "processing",
            "NV-Ingest is extracting, chunking, and embedding the document",
            json!({}),
        )
        .await;
    pipeline.extract(stages).await
}
async fn write<X: Extraction>(
    extraction: X,
    stages: Stages,
) -> Result<(
    String,
    usize,
    usize,
    usize,
    crate::document_json::Surrogates,
)> {
    let output = extraction.write(stages.clone()).await?;
    stages
        .emit(
            "postprocessing",
            "Converting extracted content to Markdown",
            json!({}),
        )
        .await;
    // The pipeline has already written its rows. A rendering failure must not
    // let the runner replay the pipeline and insert the same chunks again.
    let (markdown, pages, chunks, failures, surrogates) = tokio::task::spawn_blocking(move || {
        let (markdown, pages) = document_text::markdown(&output.results)?;
        Ok::<_, anyhow::Error>((
            markdown,
            pages,
            first_len(&output.results),
            output.failures,
            output.surrogates,
        ))
    })
    .await
    .map_err(anyhow::Error::from)
    .and_then(|rendered| rendered)
    .map_err(crate::milvus_index::CommittedWrite::new)?;
    stages
        .emit(
            "postprocessed",
            &format!("Prepared {chunks} chunks from {pages} pages"),
            json!({"chunks":chunks,"pages":pages,"failures":failures}),
        )
        .await;
    Ok((markdown, pages, chunks, failures, surrogates))
}

pub async fn run<S: Services>(
    services: &S,
    locks: &Collections,
    options: &Options,
    request: Request,
    callback: Option<Progress>,
) -> Outcome {
    let collection = collections::resolve(
        request.collection_name.as_deref(),
        Some(&request.username),
        Some(&options.default_collection_name),
    );
    let initial = request
        .reference
        .get("filename")
        .cloned()
        .unwrap_or(json!(""));
    let failure = |error: String, filename: Value| Outcome {
        status: "failure",
        filename: if truthy(&filename) {
            filename
        } else {
            initial.clone()
        },
        chunks: 0,
        failures: 0,
        pages: 0,
        collection: collection.clone(),
        markdown: String::new(),
        markdown_unencodable: false,
        surrogates: Default::default(),
        error,
    };
    if let Err(error) = collections::scope(&collection, request.collection_scope.as_deref(), true) {
        return failure(format!("Error: {error}"), Value::Null);
    }
    if !request.reference.is_object() || !truthy(&request.reference) {
        return failure(
            "Error: Invalid document reference provided.".into(),
            Value::Null,
        );
    }
    let document = &request.reference["documentId"];
    let session = &request.reference["sessionId"];
    if !truthy(document) || !truthy(session) {
        return failure(
            "Error: Document reference must contain documentId and sessionId.".into(),
            Value::Null,
        );
    }
    if request.username.is_empty() {
        return failure(
            "Error: Valid username required for document processing.".into(),
            Value::Null,
        );
    }
    let mut stages = Stages {
        callback,
        filename: if truthy(&initial) {
            initial.clone()
        } else {
            document.clone()
        },
        owned: false,
    };
    stages
        .emit(
            "fetching",
            "Fetching upload from session storage",
            json!({}),
        )
        .await;
    let document = identifier(document);
    let session = identifier(session);
    let raw = match services.fetch(&format!("document:{session}:{document}")).await {
        Ok(Some(raw)) if !raw.is_empty() => raw,
        Ok(_) => return failure("Error: Document not found in storage. The file may have expired or the session may be invalid. Please try uploading the document again.".into(), Value::Null),
        Err(error) => return failure(format!("{}: {}", if error.storage { "Error accessing document storage" } else { "Error processing document data" }, error.message), Value::Null),
    };
    let record: Value = match serde_json::from_slice(&raw) {
        Ok(record) => record,
        Err(error) => {
            // serde counts the unexpected byte, while Python's decoder reports
            // the value's starting offset. More malformed-JSON cases are gated
            // by the storage/API fixtures before this module is enabled.
            let error = if error.is_syntax() && error.to_string().starts_with("expected ident") {
                "Expecting value: line 1 column 1 (char 0)".into()
            } else {
                error.to_string()
            };
            return failure(
                format!("Error processing document data: {error}"),
                Value::Null,
            );
        }
    };
    if !record.is_object() {
        return failure(
            format!(
                "Error processing document data: {}",
                document_text::attribute_error(&record, "get")
            ),
            Value::Null,
        );
    }
    if !document_store::can_access(&record, &request.username).unwrap_or(false) {
        return failure("Error: You do not have access to this document. Please upload the document again from your account.".into(), Value::Null);
    }
    let (bytes, filename) = match document_store::load_record(
        services.config(),
        &record,
        &document,
        &session,
        &request.username,
    )
    .await
    {
        Ok(loaded) => loaded,
        Err(error) => {
            let filename = record
                .get("filename")
                .filter(|v| truthy(v))
                .map(identifier)
                .unwrap_or_else(|| format!("{document}.bin"));
            return failure(error.to_string(), json!(filename));
        }
    };
    stages.filename = json!(filename);
    stages
        .emit(
            "fetched",
            &format!(
                "Fetched {filename} from document storage ({} bytes)",
                bytes.len()
            ),
            json!({}),
        )
        .await;
    stages
        .emit("preparing", "Preparing NV-Ingest pipeline", json!({}))
        .await;
    let engine = match services.initialize().await {
        Ok(engine) => engine,
        Err(error) => {
            return failure(
                format!("An unexpected error occurred: {error}"),
                Value::Null,
            );
        }
    };
    let input = Build {
        append_to_collection: request.append_to_collection,
        bytes: bytes.into(),
        filename: filename.clone(),
        collection_name: collection.clone(),
        chunk_size: request
            .chunk_size
            .filter(truthy)
            .unwrap_or_else(|| options.chunk_size.clone()),
        chunk_overlap: request
            .chunk_overlap
            .unwrap_or_else(|| options.chunk_overlap.clone()),
    };
    // max() also gives Python's max(1.0, NaN) fallback; clamp() would retain NaN.
    let seconds = options.ingest_timeout_seconds.max(1.);
    let timeout = Duration::from_secs_f64(seconds.min(1e12));
    let lock = locks.get(&collection);
    let mut last = "None".to_owned();
    for attempt in 0..=options.ingest_max_retries {
        stages
            .emit(
                "submitting",
                "Submitting document to NV-Ingest",
                json!({"attempt":attempt + 1}),
            )
            .await;
        let deadline = tokio::time::Instant::now() + timeout;
        let owned = Stages::worker(stages.filename.clone(), stages.callback.clone());
        // Build and extraction write nothing to Milvus. The deadline drops
        // them, so a stalled NV-Ingest job never holds the collection.
        let extracted = tokio::time::timeout_at(
            deadline,
            extract(engine.clone(), input.clone(), owned.clone()),
        )
        .await;
        let result = match extracted {
            Err(_) => {
                return failure(
                    format!(
                        "Error processing document with NvIngest: timed out after {:.0} seconds before indexing started. No chunks were written for this document.",
                        timeout.as_secs_f64()
                    ),
                    json!(filename),
                );
            }
            Ok(Err(error)) => Err(WaitError::Failed(error)),
            Ok(Ok(extraction)) => {
                if lock.try_lock().is_err() {
                    stages
                        .emit(
                            "waiting",
                            "Waiting for the collection write lock",
                            json!({"attempt":attempt + 1}),
                        )
                        .await;
                }
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                document_ownership::run(lock.clone(), remaining, move || write(extraction, owned))
                    .await
            }
        };
        let error = match result {
            Ok((markdown, pages, chunks, failures, surrogates)) => {
                let unencodable = markdown.chars().any(|c| surrogates.contains_key(&c));
                return Outcome {
                    status: if failures == 0 { "success" } else { "partial" },
                    filename: json!(filename),
                    chunks,
                    failures,
                    pages,
                    collection,
                    markdown,
                    markdown_unencodable: unencodable,
                    surrogates,
                    error: String::new(),
                };
            }
            Err(WaitError::Failed(error)) if error.downcast_ref::<PipelineTimeout>().is_none() => {
                error
            }
            _ => {
                return failure(
                    format!(
                        "Error processing document with NvIngest: timed out after {:.0} seconds. The SDK operation may still be running; collection ownership is retained until it finishes. Do not retry blindly.",
                        timeout.as_secs_f64()
                    ),
                    json!(filename),
                );
            }
        };
        last = error.to_string();
        // A transport failure can follow a committed write, and any failure
        // after confirmed rows certainly does. Retrying the whole pipeline
        // would defeat the writer's no-replay guarantee and duplicate chunks.
        if error
            .downcast_ref::<crate::milvus_index_transport::TransportFailure>()
            .is_some()
            || error
                .downcast_ref::<crate::milvus_index::CommittedWrite>()
                .is_some()
        {
            break;
        }
        if attempt < options.ingest_max_retries {
            stages
                .emit(
                    "retrying",
                    &format!(
                        "NV-Ingest attempt {}/{} failed; retrying",
                        attempt + 1,
                        options.ingest_max_retries + 1
                    ),
                    json!({"attempt":attempt + 1}),
                )
                .await;
            let delay = options.ingest_retry_delay.max(0.);
            tokio::time::sleep(Duration::from_secs_f64(delay.min(1e12))).await;
        }
    }
    failure(
        format!("Error processing document with NvIngest: {last}"),
        json!(filename),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::bail;
    use base64::Engine as _;
    use std::sync::{Arc, Mutex};
    use tokio::sync::Notify;

    #[derive(Default)]
    struct Observed {
        reads: Vec<Value>,
        builds: Vec<Value>,
        events: Vec<Value>,
        // Inputs stay alive, so a distinct buffer cannot reuse an address.
        inputs: Vec<Build>,
    }
    #[derive(Default)]
    struct Gate {
        started: Notify,
        release: Notify,
    }
    #[derive(Clone)]
    struct Fake {
        config: Config,
        case: Value,
        stored: Value,
        results: Value,
        observed: Arc<Mutex<Observed>>,
        /// Holds the owned Milvus write.
        gate: Option<Arc<Gate>>,
        /// Holds NV-Ingest extraction, before the collection is owned.
        extraction_gate: Option<Arc<Gate>>,
    }
    impl Fake {
        fn new(data: &Value, case: &Value) -> Self {
            Self {
                config: Config {
                    raw: json!({}),
                    policy_raw: json!({}),
                    env: Default::default(),
                    python_tools: false,
                },
                case: case.clone(),
                stored: data["stored"].clone(),
                results: data["result"].clone(),
                observed: Arc::new(Mutex::new(Observed::default())),
                gate: None,
                extraction_gate: None,
            }
        }
        fn callback(&self) -> Progress {
            let fake = self.clone();
            Arc::new(move |event| {
                let fake = fake.clone();
                Box::pin(async move {
                    fake.observed.lock().unwrap().events.push(event);
                    if fake.case["callback_error"] == true {
                        bail!("Synthetic callback failure")
                    }
                    Ok(())
                })
            })
        }
    }
    impl Services for Fake {
        type Engine = Self;
        fn config(&self) -> &Config {
            &self.config
        }
        async fn fetch(&self, key: &str) -> std::result::Result<Option<Vec<u8>>, FetchError> {
            if self.case["redis_initialization_error"] == true {
                return Err(FetchError {
                    storage: false,
                    message: "Synthetic Redis initialization failure".into(),
                });
            }
            self.observed
                .lock()
                .unwrap()
                .reads
                .push(json!(["JSON.GET", key]));
            if self.case["storage_error"] == true {
                return Err(FetchError {
                    storage: true,
                    message: "Synthetic storage failure".into(),
                });
            }
            Ok(match self.case.get("raw") {
                Some(Value::Null) => None,
                Some(raw) => Some(raw.as_str().unwrap().as_bytes().to_vec()),
                None => Some(
                    serde_json::to_vec(self.case.get("record").unwrap_or(&self.stored)).unwrap(),
                ),
            })
        }
        async fn initialize(&self) -> Result<Self> {
            if self.case["nv_initialization_error"] == true {
                bail!("Synthetic NV initialization failure")
            }
            Ok(self.clone())
        }
    }
    struct FakePipeline {
        fake: Fake,
        attempt: usize,
    }
    impl Engine for Fake {
        type Pipeline = FakePipeline;
        async fn build(&self, input: Build) -> Result<FakePipeline> {
            let mut observed = self.observed.lock().unwrap();
            observed.builds.push(json!({
                "document_bytes":base64::engine::general_purpose::STANDARD.encode(&input.bytes),
                "filename":input.filename, "collection_name":input.collection_name,
                "chunk_size":input.chunk_size,"chunk_overlap":input.chunk_overlap,
            }));
            observed.inputs.push(input);
            let attempt = observed.builds.len();
            if self.case["error_stage"] == "build"
                && attempt as u64 <= self.case["failed_attempts"].as_u64().unwrap_or(0)
            {
                bail!("Synthetic build failure")
            }
            Ok(FakePipeline {
                fake: self.clone(),
                attempt,
            })
        }
    }
    impl Pipeline for FakePipeline {
        type Extraction = Self;
        async fn extract(self, _progress: Stages) -> Result<Self> {
            if let Some(gate) = &self.fake.extraction_gate {
                gate.started.notify_one();
                gate.release.notified().await;
            }
            if self.attempt as u64 <= self.fake.case["failed_attempts"].as_u64().unwrap_or(0) {
                match self.fake.case["error_stage"].as_str() {
                    Some("ingest") => bail!("Synthetic ingest failure"),
                    Some("timeout") => return Err(PipelineTimeout.into()),
                    _ => (),
                }
            }
            Ok(self)
        }
    }
    impl Extraction for FakePipeline {
        async fn write(self, progress: Stages) -> Result<Ingested> {
            if let Some(gate) = &self.fake.gate {
                gate.started.notify_one();
                gate.release.notified().await;
            }
            if self.attempt as u64 <= self.fake.case["failed_attempts"].as_u64().unwrap_or(0)
                && self.fake.case["error_stage"] == "transport"
            {
                return Err(crate::milvus_index_transport::TransportFailure {
                    method: "Insert",
                    code: tonic::Code::Unavailable,
                }
                .into());
            }
            progress
                .emit(
                    "indexing",
                    "NV-Ingest extraction finished; writing chunks to Milvus",
                    json!({}),
                )
                .await;
            Ok(Ingested {
                results: self
                    .fake
                    .case
                    .get("results")
                    .unwrap_or(&self.fake.results)
                    .clone(),
                failures: first_len(self.fake.case.get("failures").unwrap_or(&Value::Null)),
                surrogates: self
                    .fake
                    .case
                    .get("surrogates")
                    .map(|v| serde_json::from_value(v.clone()).unwrap())
                    .unwrap_or_default(),
            })
        }
    }
    fn fixture() -> Value {
        let mut value =
            serde_json::from_str(include_str!("../tests/fixtures/document-process.json")).unwrap();
        crate::document_codecs::tests::expand(&mut value);
        value
    }
    #[tokio::test]
    async fn retained_per_document_outcomes_progress_and_service_arguments() {
        let data = fixture();
        for case in data["cases"].as_array().unwrap() {
            let fake = Fake::new(&data, case);
            let mut options = case.get("config").cloned().unwrap_or(json!({}));
            options["ingest_retry_delay"] = json!(0);
            let options: Options = serde_json::from_value(options).unwrap();
            let actual = run(
                &fake,
                &Collections::default(),
                &options,
                serde_json::from_value(case["request"].clone()).unwrap(),
                Some(fake.callback()),
            )
            .await;
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                case["expected"],
                "{}",
                case["name"]
            );
            let observed = fake.observed.lock().unwrap();
            let mut expected_events = case["events"].clone();
            let mut expected_builds = case["builds"].clone();
            if case["name"] == "render-error" {
                // The retained snapshot reran the whole pipeline after its
                // write when Markdown rendering failed, inserting the same
                // chunks again. Keep its first attempt, which ends the run.
                let events = expected_events.as_array_mut().unwrap();
                let first = events
                    .iter()
                    .position(|event| event["phase"] == "retrying")
                    .unwrap();
                events.truncate(first);
                expected_builds.as_array_mut().unwrap().truncate(1);
            }
            assert_eq!(json!(observed.events), expected_events, "{}", case["name"]);
            assert_eq!(json!(observed.reads), case["reads"], "{}", case["name"]);
            if case["name"] == "chunk-overrides" {
                // The retained snapshot replaced explicit zero with 150.
                assert_eq!(case["request"]["chunk_overlap"], 0);
                expected_builds[0]["chunk_overlap"] = json!(0);
            }
            assert_eq!(json!(observed.builds), expected_builds, "{}", case["name"]);
        }
    }
    #[tokio::test]
    async fn zero_overlap_reaches_the_pipeline() {
        let data = fixture();
        let mut case = data["cases"][0].clone();
        case["request"]["chunk_overlap"] = json!(0);
        let fake = Fake::new(&data, &case);
        let actual = run(
            &fake,
            &Collections::default(),
            &Options::default(),
            serde_json::from_value(case["request"].clone()).unwrap(),
            None,
        )
        .await;
        assert_eq!(actual.status, "success");
        let observed = fake.observed.lock().unwrap();
        assert_eq!(observed.builds.len(), 1);
        assert_eq!(observed.builds[0]["chunk_overlap"], 0);
    }

    #[tokio::test]
    async fn unencodable_markdown_keeps_success_counts_without_replaying_writes() {
        let data = fixture();
        let mut case = data["cases"][0].clone();
        let (results, units) = crate::document_json::decode_indexed(br#"[[{"document_type":"text","metadata":{"content":"Synthetic \ud800 text","content_metadata":{"page_number":0}}}]]"#).unwrap();
        case["results"] = results;
        case["surrogates"] = json!(units);
        let fake = Fake::new(&data, &case);
        let actual = run(
            &fake,
            &Collections::default(),
            &Options::default(),
            serde_json::from_value(case["request"].clone()).unwrap(),
            None,
        )
        .await;
        assert_eq!(actual.status, "success");
        assert!(actual.markdown_unencodable);
        assert_eq!(actual.chunks, 1);
        assert_eq!(fake.observed.lock().unwrap().builds.len(), 1);
    }

    #[tokio::test]
    async fn uncertain_write_does_not_retry_the_outer_pipeline() {
        let data = fixture();
        let mut case = data["cases"][0].clone();
        case["error_stage"] = json!("transport");
        case["failed_attempts"] = json!(1);
        let fake = Fake::new(&data, &case);
        let actual = run(
            &fake,
            &Collections::default(),
            &Options::default(),
            serde_json::from_value(case["request"].clone()).unwrap(),
            Some(fake.callback()),
        )
        .await;
        assert_eq!(actual.status, "failure");
        assert!(
            actual
                .error
                .contains("Milvus Insert failed with gRPC status 14")
        );
        let observed = fake.observed.lock().unwrap();
        assert_eq!(observed.builds.len(), 1);
        assert!(observed.events.iter().all(|e| e["phase"] != "retrying"));
    }
    #[tokio::test]
    async fn retries_share_one_copy_of_the_uploaded_document() {
        // Uploads can be hundreds of megabytes. A retry needs the same bytes,
        // but each attempt must not hold another full copy of the document.
        let data = fixture();
        let mut case = data["cases"][0].clone();
        case["error_stage"] = json!("ingest");
        case["failed_attempts"] = json!(2);
        let fake = Fake::new(&data, &case);
        let actual = run(
            &fake,
            &Collections::default(),
            &Options {
                ingest_retry_delay: 0.,
                ..Options::default()
            },
            serde_json::from_value(case["request"].clone()).unwrap(),
            None,
        )
        .await;
        assert_eq!(actual.status, "success");
        let observed = fake.observed.lock().unwrap();
        let buffers: Vec<_> = observed
            .inputs
            .iter()
            .map(|input| input.bytes.as_ptr())
            .collect();
        assert_eq!(buffers.len(), 3);
        assert!(buffers.iter().all(|buffer| *buffer == buffers[0]));
    }
    #[tokio::test]
    async fn rendering_failure_after_indexing_does_not_replay_the_write() {
        // The pipeline has written its rows before Markdown rendering. A later
        // failure must not rerun extraction and insert the same chunks again.
        let data = fixture();
        let mut case = data["cases"][0].clone();
        case["results"] = json!([[{"document_type":"text","metadata":{
            "content":5,"content_metadata":{"page_number":0}}}]]);
        let fake = Fake::new(&data, &case);
        let actual = run(
            &fake,
            &Collections::default(),
            &Options {
                ingest_retry_delay: 0.,
                ..Options::default()
            },
            serde_json::from_value(case["request"].clone()).unwrap(),
            Some(fake.callback()),
        )
        .await;
        assert_eq!(actual.status, "failure");
        assert_eq!(
            actual.error,
            "Error processing document with NvIngest: Invalid extraction text"
        );
        let observed = fake.observed.lock().unwrap();
        assert_eq!(observed.builds.len(), 1);
        assert!(observed.events.iter().all(|e| e["phase"] != "retrying"));
    }
    #[tokio::test]
    async fn abandoned_document_waiter_retains_pipeline_and_collection_ownership() {
        let data = fixture();
        let case = &data["cases"][0];
        for cancel in [true, false] {
            let mut fake = Fake::new(&data, case);
            let gate = Arc::new(Gate::default());
            fake.gate = Some(gate.clone());
            let locks = Arc::new(Collections::default());
            let lock = locks.get(case["expected"]["collection"].as_str().unwrap());
            let task = tokio::spawn({
                let fake = fake.clone();
                let locks = locks.clone();
                let request = serde_json::from_value(case["request"].clone()).unwrap();
                async move {
                    run(
                        &fake,
                        &locks,
                        &Options {
                            ingest_timeout_seconds: 1.,
                            ..Options::default()
                        },
                        request,
                        Some(fake.callback()),
                    )
                    .await
                }
            });
            gate.started.notified().await;
            if cancel {
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
            } else {
                let outcome = task.await.unwrap();
                assert_eq!(outcome.status, "failure");
                assert_eq!(
                    outcome.error,
                    "Error processing document with NvIngest: timed out after 1 seconds. The SDK operation may still be running; collection ownership is retained until it finishes. Do not retry blindly."
                );
            }
            assert!(lock.try_lock().is_err());
            assert_eq!(fake.observed.lock().unwrap().builds.len(), 1);
            gate.release.notify_one();
            let _guard = tokio::time::timeout(Duration::from_secs(2), lock.lock())
                .await
                .unwrap();
            assert_eq!(
                fake.observed.lock().unwrap().events.last().unwrap()["phase"],
                "postprocessed"
            );
        }
    }

    #[tokio::test]
    async fn stalled_extraction_never_owns_the_collection() {
        let data = fixture();
        let case = &data["cases"][0];
        let mut fake = Fake::new(&data, case);
        // NV-Ingest never finishes this document.
        let gate = Arc::new(Gate::default());
        fake.extraction_gate = Some(gate.clone());
        let locks = Collections::default();
        let collection = case["expected"]["collection"].as_str().unwrap();
        let options = Options {
            ingest_timeout_seconds: 1.,
            ..Options::default()
        };
        let waiting = run(
            &fake,
            &locks,
            &options,
            serde_json::from_value(case["request"].clone()).unwrap(),
            Some(fake.callback()),
        );
        tokio::pin!(waiting);
        tokio::select! {
            _ = &mut waiting => panic!("extraction must still be pending"),
            _ = gate.started.notified() => {}
        }
        // Another document for the same collection can write meanwhile.
        assert!(locks.get(collection).try_lock().is_ok());
        let outcome = waiting.await;
        assert_eq!(outcome.status, "failure");
        assert_eq!(
            outcome.error,
            "Error processing document with NvIngest: timed out after 1 seconds before indexing started. No chunks were written for this document."
        );
        assert!(outcome.error.to_lowercase().contains("timed out"));
        assert!(locks.get(collection).try_lock().is_ok());
        let observed = fake.observed.lock().unwrap();
        assert_eq!(observed.builds.len(), 1);
        assert!(observed.events.iter().all(|e| e["phase"] != "indexing"));
    }
}
