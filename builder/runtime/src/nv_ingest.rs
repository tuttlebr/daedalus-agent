//! Pinned NV-Ingest 26.3 extract-only jobs and REST lifecycle. Retryable transport
//! failures retain the SDK policy, bounded by the owning extraction's deadline.
use crate::memory_tools::{json_text, trim};
use anyhow::{Result, anyhow, bail};
use reqwest::{Client as HttpClient, Method, StatusCode};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::Semaphore;

/// Keep the SDK's UCS-4 text until the inner, ASCII-escaped JSON is written.
/// In particular, UTF-7 may decode to isolated surrogates. The outer HTTP JSON
/// remains ordinary UTF-8 because it carries the inner JSON as a string.
fn quote<P: std::borrow::Borrow<u32>>(out: &mut String, content: impl Iterator<Item = P>) {
    use std::fmt::Write;
    for point in content {
        let point = *point.borrow();
        match point {
            8 => out.push_str("\\b"),
            9 => out.push_str("\\t"),
            10 => out.push_str("\\n"),
            12 => out.push_str("\\f"),
            13 => out.push_str("\\r"),
            34 => out.push_str("\\\""),
            92 => out.push_str("\\\\"),
            32..=126 => out.push(char::from_u32(point).unwrap()),
            0..=0xffff => write!(out, "\\u{point:04x}").unwrap(),
            _ => {
                let n = point - 0x10000;
                write!(
                    out,
                    "\\u{:04x}\\u{:04x}",
                    0xd800 + (n >> 10),
                    0xdc00 + (n & 1023)
                )
                .unwrap();
            }
        }
    }
}
/// The document is written once into the output buffer: a 200 MB upload is
/// about 267 MB of base64, so intermediate copies dominate memory and time.
pub fn payload<P: std::borrow::Borrow<u32>>(
    job: &Value,
    content: impl IntoIterator<Item = P>,
) -> String {
    let content = content.into_iter();
    let mut out = String::with_capacity(content.size_hint().0.saturating_add(4096));
    let mut content = Some(content);
    let encode = |value: &Value| json_text(value, false, true, true);
    out.push('{');
    for (i, (key, value)) in job.as_object().unwrap().iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        out.push_str(&encode(&json!(key)));
        out.push_str(": ");
        if key != "job_payload" {
            out.push_str(&encode(value));
            continue;
        }
        out.push('{');
        for (j, (key, value)) in value.as_object().unwrap().iter().enumerate() {
            if j > 0 {
                out.push_str(", ");
            }
            out.push_str(&encode(&json!(key)));
            out.push_str(": ");
            if key != "content" {
                out.push_str(&encode(value));
                continue;
            }
            out.push_str("[\"");
            // A JSON object has one content key, which receives the document.
            if let Some(content) = content.take() {
                quote(&mut out, content);
            }
            out.push_str("\"]");
        }
        out.push('}');
    }
    out.push('}');
    out
}

/// Run document-sized CPU work on the blocking pool, so it cannot stall the
/// async workers that serve other runs. A panic propagates as it did inline.
pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    match tokio::task::spawn_blocking(work).await {
        Ok(value) => value,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}

/// The REST submission body, serialized once rather than on every transport
/// retry. Byte-identical to `serde_json::to_vec(&json!({"payload": job}))`.
pub fn submission(job: &str) -> bytes::Bytes {
    #[derive(serde::Serialize)]
    struct Submission<'a> {
        payload: &'a str,
    }
    serde_json::to_vec(&Submission { payload: job })
        .expect("a JSON string always serializes")
        .into()
}

pub struct Options {
    pub method: String,
    pub v2: bool,
    pub pages: i64,
    pub filter: bool,
    pub caption: Option<Caption>,
    pub env: HashMap<String, String>,
}
pub struct Caption {
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            method: "pdfium".into(),
            v2: false,
            pages: 32,
            filter: true,
            caption: None,
            env: HashMap::new(),
        }
    }
}
pub fn document_type(filename: &str) -> Result<String> {
    // posixpath.splitext does not treat a leading run of dots as an extension.
    let basename = filename.rsplit('/').next().unwrap();
    let extension = basename
        .rsplit_once('.')
        .filter(|(stem, _)| stem.chars().any(|c| c != '.'))
        .map(|(_, ext)| ext.to_lowercase())
        .unwrap_or_default();
    let kind = match extension.as_str() {
        "txt" | "md" | "json" | "sh" => "text",
        "jpg" => "jpeg",
        "bmp" | "docx" | "html" | "jpeg" | "pdf" | "png" | "pptx" | "svg" | "tiff" | "mp3"
        | "wav" | "mp4" | "mov" | "avi" | "mkv" => &extension,
        _ => bail!("Failed to determine file type for: {filename}"),
    };
    Ok(kind.into())
}
pub fn job(filename: &str, content: &str, options: &Options) -> Result<Value> {
    let kind = document_type(filename)?;
    let lower = filename.to_lowercase();
    let text = [".txt", ".md", ".html", ".json"]
        .iter()
        .any(|suffix| lower.ends_with(suffix));
    let mut method = if text {
        "pdfium"
    } else if ["docx", "pptx"].contains(&kind.as_str()) {
        "render_as_pdf"
    } else {
        &options.method
    };
    if method == "nemoretriever_parse" {
        method = "nemotron_parse";
    }
    if kind == "pdf"
        && ![
            "adobe",
            "nemotron_parse",
            "haystack",
            "llama_parse",
            "pdfium",
            "tika",
            "unstructured_io",
            "unstructured_local",
            "pdfium_hybrid",
            "ocr",
        ]
        .contains(&method)
    {
        // The old diagnostic's option order varies with Python's hash seed.
        bail!(
            "'{method}' is invalid for PDF. Options: {{'adobe', 'haystack', 'llama_parse', 'nemotron_parse', 'ocr', 'pdfium', 'pdfium_hybrid', 'tika', 'unstructured_io', 'unstructured_local'}}"
        );
    }
    let mut params = json!({
        "extract_text": true,
        "extract_images": false,
        "extract_images_method": "group",
        "extract_tables": false,
        "extract_tables_method": "yolox",
        "extract_charts": false,
        "extract_infographics": false,
        "extract_page_as_image": false,
        "text_depth": if text { "document" } else { "page" },
        "table_output_format": "markdown"
    });
    let env = |name: &str, default: Value| {
        options
            .env
            .get(name)
            .map(|value| json!(value))
            .unwrap_or(default)
    };
    match method {
        "unstructured_local" => {
            params["api_key"] = json!("");
            params["unstructured_url"] = json!("");
        }
        "unstructured_io" => {
            params["unstructured_api_key"] = env("UNSTRUCTURED_API_KEY", Value::Null);
            params["unstructured_url"] = env(
                "UNSTRUCTURED_URL",
                json!("https://api.unstructured.io/general/v0/general"),
            );
            params["unstructured_strategy"] = env("UNSTRUCTURED_STRATEGY", json!("auto"));
            params["unstructured_concurrency_level"] =
                env("UNSTRUCTURED_CONCURRENCY_LEVEL", json!(10));
        }
        "adobe" => {
            params["adobe_client_id"] = env("ADOBE_CLIENT_ID", Value::Null);
            // This spelling is the pinned SDK's wire field.
            params["adobe_client_secrect"] = env("ADOBE_CLIENT_SECRET", Value::Null);
        }
        _ => {}
    }
    let mut tasks = vec![
        json!({"type": "extract", "task_properties": {"method": method, "document_type": kind, "params": params}}),
    ];
    if ["pdfium_hybrid", "ocr"].contains(&method) {
        tasks.push(json!({"type": "ocr_data_extract", "task_properties": {"params": {}}}));
    }
    if method == "audio" {
        tasks.push(json!({"type": "audio_data_extract", "task_properties": {}}));
    }
    if options.filter {
        tasks.push(json!({"type": "filter", "task_properties": {"content_type": "image", "params": {"min_size": 128, "max_aspect_ratio": 5.0, "min_aspect_ratio": 0.2, "filter": false}}}));
    }
    if let Some(caption) = &options.caption {
        let mut properties = json!({});
        if let Some(key) = caption.api_key.as_ref().filter(|key| !key.is_empty()) {
            properties["api_key"] = json!(key);
        }
        properties["endpoint_url"] = json!(caption.endpoint);
        properties["model_name"] = json!(caption.model);
        tasks.push(json!({"type":"caption", "task_properties":properties}));
    }
    Ok(json!({
        "job_payload": {"source_name": [filename], "source_id": [filename], "content": [content], "document_type": [kind]},
        "job_id": "None", "tasks": tasks, "tracing_options": {},
        "pdf_config": if kind == "pdf" && options.v2 { json!({"split_page_count": options.pages.clamp(1, 128)}) } else { json!({}) }
    }))
}

fn base_url(host: &str, port: i64) -> Result<String> {
    let host = trim(host);
    if host.is_empty() {
        bail!("Invalid NV-Ingest host.");
    }
    if host.to_ascii_lowercase().starts_with("http://")
        || host.to_ascii_lowercase().starts_with("https://")
    {
        let parsed = reqwest::Url::parse(host).map_err(|_| anyhow!("Invalid NV-Ingest host."))?;
        let hostname = parsed
            .host_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow!("Invalid NV-Ingest host."))?;
        // URL libraries elide an explicit default port; the Python helper keeps
        // it instead of using NV_INGEST_PORT. Read the original authority too.
        let authority = host
            .split_once("://")
            .unwrap()
            .1
            .split(['/', '?', '#'])
            .next()
            .unwrap()
            .rsplit('@')
            .next()
            .unwrap();
        let explicit_port = authority
            .rsplit_once(':')
            .and_then(|(_, n)| n.parse::<u16>().ok());
        let effective = explicit_port.map(i64::from).unwrap_or(port);
        let path = if parsed.path().trim_matches('/').is_empty() {
            ""
        } else {
            parsed.path()
        };
        // Deliberately retain the helper's IPv6 formatting. An unusable URL then
        // follows the same transport failure/deadline path as the pinned SDK.
        Ok(format!(
            "{}://{}:{effective}{path}",
            parsed.scheme(),
            hostname.trim_matches(['[', ']'])
        )
        .trim_end_matches('/')
        .to_owned())
    } else {
        Ok(format!("http://{host}:{port}")
            .trim_end_matches('/')
            .to_owned())
    }
}
fn terminal(status: u16) -> bool {
    matches!(status, 400..=418 | 421..=426 | 428 | 429 | 431 | 451 | 500 | 501 | 503 | 505..=508 | 510 | 511)
}

/// Takes the envelope so a large `data` array is moved rather than copied.
fn results(mut envelope: Value) -> Value {
    let Some(map) = envelope.as_object() else {
        return json!([]);
    };
    let status = map.get("status").unwrap_or(&Value::Null);
    let Some(status) = status.as_str() else {
        return json!([]);
    };
    // The pinned helper uses substring membership (`status in "failed"`), and
    // malformed descriptions fail its processing callback. Both omit the job.
    if "failed".contains(status) || map.get("description").is_some_and(|v| !v.is_string()) {
        return json!([]);
    }
    json!([envelope["data"].take()])
}

#[derive(Clone)]
pub struct Client {
    http: HttpClient,
    base: String,
    workers: Arc<Semaphore>,
}
pub struct Extraction {
    pub results: Value,
    pub surrogates: crate::document_json::Surrogates,
}
pub struct Ingestion {
    pub extraction: Extraction,
    pub failures: usize,
    pub upload: bool,
}
impl Default for Extraction {
    fn default() -> Self {
        Self {
            results: json!([]),
            surrogates: Default::default(),
        }
    }
}
enum Reply {
    Success(Vec<u8>),
    Pending,
    Failed,
}
/// Delay before re-polling a job that is still running (HTTP 202).
const PENDING_POLL: Duration = Duration::from_millis(250);
impl Client {
    pub fn new(host: &str, port: i64, workers: i64) -> Result<Self> {
        if workers <= 0 {
            bail!("max_workers must be greater than 0");
        }
        Ok(Self {
            http: HttpClient::builder()
                .redirect(reqwest::redirect::Policy::limited(30))
                .retry(reqwest::retry::never())
                .connect_timeout(Duration::from_secs(300))
                .build()
                .map_err(|_| anyhow!("NV-Ingest client unavailable."))?,
            base: base_url(host, port)?,
            workers: Arc::new(Semaphore::new(
                usize::try_from(workers)
                    .unwrap_or(Semaphore::MAX_PERMITS)
                    .min(Semaphore::MAX_PERMITS),
            )),
        })
    }
    async fn request(&self, suffix: &str, payload: Option<&bytes::Bytes>) -> Reply {
        // The retained client shares one executor for submissions and fetches.
        // A task owns its slot through REST retries/backoff, and returns it on
        // a terminal response or a pending fetch before the next poll queues.
        let _worker = self
            .workers
            .acquire()
            .await
            .expect("NV worker pool stays open");
        let mut backoff = 1;
        loop {
            let method = if payload.is_some() {
                Method::POST
            } else {
                Method::GET
            };
            let mut request = self
                .http
                .request(method, format!("{}{suffix}", self.base))
                .header("content-type", "application/json");
            if let Some(payload) = payload {
                request = request.body(payload.clone());
            }
            if let Ok(response) = request.send().await {
                let status = response.status();
                // The requests client consumes the body even on 202/failure.
                if let Ok(bytes) = response.bytes().await {
                    if terminal(status.as_u16()) {
                        return Reply::Failed;
                    }
                    if status == StatusCode::OK {
                        return Reply::Success(bytes.to_vec());
                    }
                    if payload.is_none() && status == StatusCode::ACCEPTED {
                        return Reply::Pending;
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(32);
        }
    }
    async fn run(&self, body: bytes::Bytes, decode: crate::document_json::Decoder) -> Extraction {
        // The SDK default is v2 even when the application's use_v2_api is false.
        let Reply::Success(id) = self.request("/v2/submit_job", Some(&body)).await else {
            return Extraction::default();
        };
        drop(body);
        let id = String::from_utf8_lossy(&id).replace('"', "");
        if id.is_empty() {
            return Extraction::default();
        }
        loop {
            match self.request(&format!("/v2/fetch_job/{id}"), None).await {
                // The SDK re-polls a pending job immediately. Pace polls so a
                // long extraction does not issue a continuous request stream.
                Reply::Pending => tokio::time::sleep(PENDING_POLL).await,
                Reply::Failed => return Extraction::default(),
                Reply::Success(bytes) => {
                    // Large envelopes carry every chunk's embedding. Decode and
                    // select them off the async workers shared by other runs.
                    return blocking(move || {
                        decode(&bytes)
                            .map(|(envelope, surrogates)| Extraction {
                                results: results(envelope),
                                surrogates,
                            })
                            .unwrap_or_default()
                    })
                    .await;
                }
            }
        }
    }
    pub async fn extract_payload(&self, job: &str, timeout: Duration) -> Result<Extraction> {
        // There is no orphan thread: cancellation drops the active HTTP request
        // and stops every future retry owned by this extraction.
        let job = job.to_owned();
        tokio::time::timeout(timeout, async {
            let body = blocking(move || submission(&job)).await;
            self.run(body, crate::document_json::decode).await
        })
        .await
        .map_err(|_| {
            anyhow!(
                "Error extracting document with NvIngest: timed out after {:.0} seconds.",
                timeout.as_secs_f64()
            )
        })
    }
    #[cfg(test)]
    pub async fn ingest_payload(&self, job: &str) -> Ingestion {
        self.ingest_submission(submission(job)).await
    }
    /// `body` is a prepared [`submission`].
    pub async fn ingest_submission(&self, body: bytes::Bytes) -> Ingestion {
        // Each per-document pipeline submits one job. A successful job is
        // retained as one group, even when its data is empty or null. Omitted
        // jobs yield one (job_id, error) tuple, whose len() is the application's
        // failure count. Ingestor skips local upload when every job failed.
        // The document runner's deadline bounds this extraction, including
        // its transport retries; it runs before the collection is owned.
        let extraction = self.run(body, crate::document_json::decode_indexed).await;
        let upload = extraction.results.as_array().is_some_and(|r| !r.is_empty());
        Ingestion {
            extraction,
            failures: if upload { 0 } else { 2 },
            upload,
        }
    }
    #[cfg(test)]
    pub async fn extract(&self, job: &Value, timeout: Duration) -> Result<Value> {
        self.extract_payload(&json_text(job, false, true, true), timeout)
            .await
            .map(|output| output.results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    fn fixture(raw: &str) -> Value {
        fn expand(value: &mut Value) {
            if let Some(parts) = value.get("$string_parts").and_then(Value::as_array) {
                *value = json!(
                    parts
                        .iter()
                        .map(|v| v.as_str().unwrap())
                        .collect::<String>()
                );
            } else {
                match value {
                    Value::Array(values) => values.iter_mut().for_each(expand),
                    Value::Object(values) => values.values_mut().for_each(expand),
                    _ => {}
                }
            }
        }
        let mut value = serde_json::from_str(raw).unwrap();
        expand(&mut value);
        value
    }
    #[test]
    fn frozen_jobs_and_service_helpers() {
        let data = fixture(include_str!("../tests/fixtures/nv-ingest.json"));
        for case in data["urls"].as_array().unwrap() {
            let actual = base_url(
                case["host"].as_str().unwrap(),
                case["port"].as_i64().unwrap(),
            );
            if let Some(value) = case["expected"].get("ok") {
                assert_eq!(json!(actual.unwrap()), *value, "{case}");
            } else {
                assert!(actual.is_err(), "{case}");
            }
        }
        for status in 100..=599 {
            assert_eq!(
                terminal(status),
                data["terminal_statuses"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(status))
            );
        }
        for case in data["results"].as_array().unwrap() {
            assert_eq!(results(case["input"].clone()), case["expected"], "{case}");
            let rendered = crate::document_text::markdown(&results(case["input"].clone()));
            if let Some(expected) = case["markdown"].get("ok") {
                assert_eq!(json!(rendered.unwrap()), *expected, "rendered {case}");
            } else {
                assert!(rendered.is_err(), "rendered {case}");
            }
        }
        for case in data["jobs"].as_array().unwrap() {
            let options = Options {
                method: case["method"].as_str().unwrap().into(),
                v2: true,
                pages: case["pages"].as_i64().unwrap(),
                ..Options::default()
            };
            let filename = case["filename"].as_str().unwrap();
            let content = if document_type(filename)
                .is_ok_and(|kind| ["text", "html"].contains(&kind.as_str()))
            {
                "Synthetic".into()
            } else {
                base64::engine::general_purpose::STANDARD.encode("Synthetic")
            };
            let actual = job(filename, &content, &options);
            if let Some(value) = case["expected"].get("ok") {
                let actual = actual.unwrap();
                assert_eq!(actual, value[document_type(filename).unwrap()][0], "{case}");
            } else {
                assert!(actual.is_err(), "{case}");
            }
        }
        let data = fixture(include_str!("../tests/fixtures/documents.json"));
        for case in data["jobs"].as_array().unwrap() {
            let filename = case["filename"].as_str().unwrap();
            let options = Options {
                v2: case["v2"].as_bool().unwrap(),
                pages: 129,
                filter: case["filter"].as_bool().unwrap(),
                ..Options::default()
            };
            let content = if document_type(filename)
                .is_ok_and(|kind| ["text", "html"].contains(&kind.as_str()))
            {
                "Synthetic document 雪🌲"
            } else {
                case["data"].as_str().unwrap()
            };
            let actual = job(filename, content, &options);
            if let Some(value) = case["expected"].get("ok") {
                assert_eq!(
                    actual.unwrap(),
                    value[document_type(filename).unwrap()][0],
                    "{case}"
                );
            } else {
                assert!(actual.is_err(), "{case}");
            }
        }
    }

    #[test]
    fn payload_is_the_ascii_python_json_and_retains_surrogates() {
        let options = Options::default();
        for (filename, text) in [
            ("fixture.txt", ""),
            ("fixture.txt", "Synthetic \"quoted\" back\\slash"),
            (
                "fixture.md",
                "\u{0}\u{8}\t\n\u{b}\u{c}\r\u{1f} ~\u{7f}\u{80}\u{ff}",
            ),
            ("fixture.html", "雪🌲\u{ffff}\u{10000}\u{10ffff}"),
            ("fixture.pdf", "U3ludGhldGlj+/=="),
        ] {
            let points: Vec<u32> = text.chars().map(u32::from).collect();
            let expected = json_text(&job(filename, text, &options).unwrap(), false, true, true);
            let empty = job(filename, "", &options).unwrap();
            assert_eq!(payload(&empty, &points), expected, "{text:?}");
            assert_eq!(
                payload(&empty, text.chars().map(u32::from)),
                expected,
                "{text:?}"
            );
            assert_eq!(
                submission(&expected).to_vec(),
                serde_json::to_vec(&json!({"payload": expected})).unwrap()
            );
        }
        // UTF-7 can decode to isolated surrogates; JSON keeps their escapes.
        let actual = payload(
            &job("fixture.txt", "", &options).unwrap(),
            [0x41, 0xd800, 0xdfff, 0x1f332],
        );
        let escaped = ["d800", "dfff", "d83c", "df32"]
            .map(|unit| format!("{}u{unit}", char::from(92)))
            .concat();
        assert!(actual.contains(&format!("\"content\": [\"A{escaped}\"]")));
    }

    #[tokio::test]
    async fn retained_rest_failure_counts_and_local_upload_decisions() {
        use axum::{Router, body::Bytes, extract::State, http::Uri, routing::any};
        use std::sync::{Arc, Mutex};
        struct Peer {
            case: Value,
            calls: Vec<Value>,
            fault: Option<(String, u16)>,
        }
        async fn peer(
            State(state): State<Arc<Mutex<Peer>>>,
            method: Method,
            uri: Uri,
            _bytes: Bytes,
        ) -> (StatusCode, String) {
            let mut state = state.lock().unwrap();
            state.calls.push(json!([method.as_str(), uri.path()]));
            let status = if state
                .fault
                .as_ref()
                .is_some_and(|(m, _)| m == method.as_str())
            {
                StatusCode::from_u16(state.fault.take().unwrap().1).unwrap()
            } else {
                StatusCode::OK
            };
            let body = if method == Method::POST {
                "\"synthetic-job\"".into()
            } else if let Some(raw) = state.case["raw"].as_str() {
                raw.into()
            } else {
                state.case["envelope"].to_string()
            };
            (status, body)
        }
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/nv-ingest-failures.json"))
                .unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        let state = Arc::new(Mutex::new(Peer {
            case: Value::Null,
            calls: Vec::new(),
            fault: None,
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/{*path}", any(peer))
                    .with_state(state.clone()),
            )
            .into_future(),
        );
        let client = Client::new("127.0.0.1", i64::from(port), 8).unwrap();
        let mut job = job("fixture.txt", "Synthetic", &Options::default()).unwrap();
        crate::document_index::indexing_tasks(
            &mut job,
            "meta-llama/Llama-3.2-1B",
            &json!(1024),
            &json!(150),
        )
        .unwrap();
        let job = json_text(&job, false, true, true);
        for case in fixture["cases"].as_array().unwrap() {
            {
                let mut state = state.lock().unwrap();
                state.case = case.clone();
                state.calls.clear();
                state.fault = case
                    .get("fault")
                    .map(|v| (v[0].as_str().unwrap().into(), v[1].as_u64().unwrap() as u16));
            }
            let result = tokio::time::timeout(Duration::from_secs(5), client.ingest_payload(&job))
                .await
                .unwrap();
            assert_eq!(
                result.extraction.results, case["results"],
                "{}",
                case["name"]
            );
            assert_eq!(json!(result.failures), case["failures"], "{}", case["name"]);
            assert_eq!(json!(result.upload), case["upload"], "{}", case["name"]);
            assert_eq!(
                json!(state.lock().unwrap().calls),
                case["calls"],
                "{}",
                case["name"]
            );
        }
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn transport_retries_terminal_failures_and_owned_deadlines() {
        use axum::{
            Router, body::Bytes, extract::State, http::Uri, response::IntoResponse, routing::any,
        };
        use std::sync::{Arc, Mutex};
        #[derive(Default)]
        struct Peer {
            fault: Option<(Method, u16)>,
            calls: Vec<(Method, String, Option<Value>)>,
            reply: Value,
            block: bool,
            unavailable: bool,
        }
        async fn peer(
            State(state): State<Arc<Mutex<Peer>>>,
            method: Method,
            uri: Uri,
            bytes: Bytes,
        ) -> axum::response::Response {
            let (fault, reply, block, unavailable) = {
                let mut state = state.lock().unwrap();
                let body =
                    (!bytes.is_empty()).then(|| serde_json::from_slice::<Value>(&bytes).unwrap());
                state.calls.push((method.clone(), uri.path().into(), body));
                let fault = if state.fault.as_ref().is_some_and(|(m, _)| *m == method) {
                    state.fault.take().map(|(_, code)| code)
                } else {
                    None
                };
                (fault, state.reply.clone(), state.block, state.unavailable)
            };
            if block {
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
            if unavailable {
                return (StatusCode::BAD_GATEWAY, axum::Json(json!({}))).into_response();
            }
            if let Some(code) = fault {
                return (StatusCode::from_u16(code).unwrap(), axum::Json(json!({})))
                    .into_response();
            }
            if method == Method::POST {
                axum::Json(json!("synthetic-job")).into_response()
            } else {
                axum::Json(reply).into_response()
            }
        }
        let state = Arc::new(Mutex::new(Peer::default()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/{*path}", any(peer))
                    .with_state(state.clone()),
            )
            .into_future(),
        );
        let client = Client::new("127.0.0.1", i64::from(port), 8).unwrap();
        let job = job("fixture.txt", "Synthetic 雪🌲", &Options::default()).unwrap();
        let data = json!([{"document_type": "text", "metadata": {"content": "Synthetic 雪🌲", "content_metadata": {"page_number": 0}}}]);
        for (method, status, expected_calls, success) in [
            (Method::POST, 503, 1, false),
            (Method::GET, 500, 2, false),
            (Method::GET, 202, 3, true),
            (Method::POST, 502, 3, true),
            (Method::GET, 502, 3, true),
        ] {
            {
                let mut state = state.lock().unwrap();
                state.fault = Some((method, status));
                state.calls.clear();
                state.reply = json!({"status": "success", "data": data});
            }
            let result = client.extract(&job, Duration::from_secs(5)).await.unwrap();
            assert_eq!(
                result,
                if success { json!([data]) } else { json!([]) },
                "status {status}"
            );
            let state = state.lock().unwrap();
            assert_eq!(state.calls.len(), expected_calls);
            assert_eq!(state.calls[0].1, "/v2/submit_job");
            let actual: Value = serde_json::from_str(
                state.calls[0].2.as_ref().unwrap()["payload"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(actual, job);
        }
        {
            let mut state = state.lock().unwrap();
            state.calls.clear();
            state.block = true;
        }
        let error = client
            .extract(&job, Duration::from_millis(100))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert_eq!(
            state.lock().unwrap().calls.len(),
            1,
            "a hung submission must not be duplicated"
        );
        // A hung request cannot show whether expired work keeps retrying. Fail
        // every attempt with a retryable status instead: the next submission
        // is due one second after the first, after this deadline has passed.
        {
            let mut state = state.lock().unwrap();
            state.calls.clear();
            state.block = false;
            state.unavailable = true;
        }
        let error = client
            .extract(&job, Duration::from_millis(300))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(
            state.lock().unwrap().calls.len(),
            1,
            "deadline must stop later retries"
        );
        server.abort();
    }

    #[tokio::test]
    async fn cloned_clients_share_slots_for_submit_fetch_and_retry_backoff() {
        use axum::{Router, extract::State, response::IntoResponse, routing::any};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::sync::Notify;

        struct Peer {
            held: Method,
            backoff: bool,
            posts: AtomicUsize,
            entered: Notify,
            release: Semaphore,
        }
        async fn peer(State(state): State<Arc<Peer>>, method: Method) -> axum::response::Response {
            let post = if method == Method::POST {
                state.posts.fetch_add(1, Ordering::SeqCst)
            } else {
                0
            };
            if method == state.held {
                state.entered.notify_one();
                if state.backoff {
                    if post == 0 {
                        return (StatusCode::BAD_GATEWAY, axum::Json(json!({}))).into_response();
                    }
                } else {
                    state.release.acquire().await.unwrap().forget();
                }
            }
            axum::Json(if method == Method::POST {
                json!("synthetic-job")
            } else {
                json!({"status":"success","data":[]})
            })
            .into_response()
        }
        for (held, backoff) in [
            (Method::POST, false),
            (Method::GET, false),
            (Method::POST, true),
        ] {
            let state = Arc::new(Peer {
                held,
                backoff,
                posts: AtomicUsize::new(0),
                entered: Notify::new(),
                release: Semaphore::new(0),
            });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(
                axum::serve(
                    listener,
                    Router::new()
                        .route("/{*path}", any(peer))
                        .with_state(state.clone()),
                )
                .into_future(),
            );
            let client = Client::new("127.0.0.1", i64::from(port), 1).unwrap();
            let start = || {
                let client = client.clone();
                tokio::spawn(async move {
                    let job = job("fixture.txt", "Synthetic", &Options::default()).unwrap();
                    client.extract(&job, Duration::from_secs(5)).await.unwrap()
                })
            };
            let first = start();
            tokio::time::timeout(Duration::from_secs(2), state.entered.notified())
                .await
                .unwrap();
            let second = start();
            assert!(
                tokio::time::timeout(Duration::from_millis(100), state.entered.notified())
                    .await
                    .is_err(),
                "A cloned client bypassed the shared {} slot (backoff={backoff})",
                state.held
            );
            state.release.add_permits(2);
            assert_eq!(first.await.unwrap(), json!([[]]));
            assert_eq!(second.await.unwrap(), json!([[]]));
            server.abort();
        }
        assert!(Client::new("localhost", 7670, 0).is_err());
        assert!(Client::new("localhost", 7670, -1).is_err());
        assert!(Client::new("localhost", 7670, i64::MAX).is_ok());
    }

    #[tokio::test]
    async fn lost_submit_reply_retries_the_same_extract_job() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for index in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut block = [0; 4096];
                loop {
                    let n = socket.read(&mut block).await.unwrap();
                    assert_ne!(n, 0);
                    request.extend_from_slice(&block[..n]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .map(|n| n.parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(request).unwrap());
                if index == 0 {
                    continue;
                }
                let body = if index == 1 {
                    "\"synthetic-job\""
                } else {
                    "{\"status\":\"success\",\"data\":[]}"
                };
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
            requests
        });
        let client = Client::new("127.0.0.1", i64::from(port), 8).unwrap();
        let job = job("fixture.pdf", "U3ludGhldGlj", &Options::default()).unwrap();
        assert_eq!(
            client.extract(&job, Duration::from_secs(5)).await.unwrap(),
            json!([[]])
        );
        let requests = server.await.unwrap();
        assert!(requests[0].starts_with("POST /v2/submit_job "));
        assert!(requests[1].starts_with("POST /v2/submit_job "));
        assert!(requests[2].starts_with("GET /v2/fetch_job/synthetic-job "));
        assert_eq!(
            requests[0].split_once("\r\n\r\n").unwrap().1,
            requests[1].split_once("\r\n\r\n").unwrap().1
        );
    }
}
