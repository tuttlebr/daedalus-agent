//! Owned document reads. Object metadata is checked before contacting storage;
//! responses are bounded while streaming, with no redirect or request replay.
use crate::{
    config::{Config, truthy},
    memory_tools::trim,
    profile_import::identifier,
};
use anyhow::{Result, anyhow, bail};
use base64::{Engine, alphabet, engine::general_purpose};
use futures::StreamExt;
use hmac::{Hmac, Mac};
use regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::LazyLock, time::Duration};

const EMPTY: &str = "Error: Retrieved document data is empty.";
const INVALID: &str = "Error: Retrieved document data is invalid.";
const OBJECT_ACCESS: &str =
    "Error accessing document object storage. Please upload the document again.";
const DEFAULT_MAX_BYTES: usize = 200 * 1024 * 1024;

pub fn can_access(record: &Value, user: &str) -> Result<bool> {
    let record = record
        .as_object()
        .ok_or_else(|| anyhow!("Document operation failed."))?;
    let owner = record
        .get("userId")
        .filter(|v| truthy(v))
        .map(identifier)
        .unwrap_or_default();
    let owner = trim(&owner);
    let user = trim(user);
    Ok(if owner.is_empty() {
        user.is_empty() || user.to_lowercase() == "anonymous"
    } else {
        owner == user
    })
}

fn variable(config: &Config, name: &str, fallback: &str) -> String {
    let value = config.variable(name, "");
    trim(if value.is_empty() { fallback } else { &value }).to_owned()
}

/// Canonical decimal integer, accepting Python's Unicode digits and separators.
/// Keep arbitrary-size values until the caller applies its own bounds.
pub(super) fn decimal(text: &str) -> String {
    static ZEROS: LazyLock<Vec<u32>> = LazyLock::new(|| {
        let resource: Value =
            serde_json::from_str(include_str!("../resources/document-text.json")).unwrap();
        resource["decimal_zeros"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u32)
            .collect()
    });
    trim(text)
        .chars()
        .map(|c| {
            let n = c as u32;
            ZEROS
                .iter()
                .find_map(|zero| {
                    (n >= *zero && n < *zero + 10).then(|| (b'0' + (n - zero) as u8) as char)
                })
                .unwrap_or(c)
        })
        .collect()
}
pub(super) fn integer(text: &str) -> Option<String> {
    static INTEGER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[+-]?[0-9]+(?:_[0-9]+)*$").unwrap());
    let ascii = decimal(text);
    if !INTEGER.is_match(&ascii) {
        return None;
    }
    let negative = ascii.starts_with('-');
    let digits = ascii.trim_start_matches(['+', '-']).replace('_', "");
    let digits = digits.trim_start_matches('0');
    Some(if digits.is_empty() {
        "0".into()
    } else if negative {
        format!("-{digits}")
    } else {
        digits.to_owned()
    })
}

fn maximum(config: &Config) -> usize {
    integer(&variable(config, "DOCUMENT_INGEST_MAX_SIZE_BYTES", ""))
        .filter(|n| n != "0" && !n.starts_with('-'))
        .map(|n| n.parse().unwrap_or(usize::MAX))
        .unwrap_or(DEFAULT_MAX_BYTES)
}
fn size_error(maximum: usize) -> anyhow::Error {
    anyhow!(
        "Error: Document exceeds the maximum allowed size ({maximum} bytes). Please upload a smaller file."
    )
}
fn safe_segment(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}
fn object_key(prefix: &str, user: &str, session: &str, document: &str) -> Result<String> {
    if !safe_segment(session) || !safe_segment(document) {
        bail!("Error: Document reference is invalid.");
    }
    let owner = format!("{:x}", Sha256::digest(user.as_bytes()));
    Ok(format!("{prefix}/{}/{session}/{document}", &owner[..32]))
}
fn text(record: &Value, key: &str, fallback: &str) -> String {
    record
        .get(key)
        .filter(|v| truthy(v))
        .map(identifier)
        .unwrap_or_else(|| fallback.into())
}

struct Settings {
    endpoint: String,
    access: String,
    secret: String,
    token: String,
    bucket: String,
    prefix: String,
    region: String,
    secure: bool,
}
impl Settings {
    fn new(config: &Config) -> Result<Self> {
        let mut endpoint = variable(config, "DOCUMENT_OBJECT_ENDPOINT", "");
        let access = variable(config, "DOCUMENT_OBJECT_ACCESS_KEY", "");
        let secret = variable(config, "DOCUMENT_OBJECT_SECRET_KEY", "");
        let bucket = variable(config, "DOCUMENT_OBJECT_BUCKET", "");
        if [&endpoint, &access, &secret, &bucket]
            .iter()
            .any(|s| s.is_empty())
        {
            bail!("Error: Document object storage is not configured.");
        }
        let prefix = variable(config, "DOCUMENT_OBJECT_PREFIX", "daedalus-documents");
        if !safe_segment(&prefix) {
            bail!("Error: Document object storage prefix is invalid.");
        }
        let secure = endpoint.starts_with("https://");
        endpoint = endpoint
            .strip_prefix("https://")
            .or_else(|| endpoint.strip_prefix("http://"))
            .unwrap_or(&endpoint)
            .trim_end_matches('/')
            .to_owned();
        if endpoint.is_empty() || endpoint.contains('/') {
            bail!("Error: Document object storage endpoint is invalid.");
        }
        Ok(Self {
            endpoint: format!("{}://{endpoint}", if secure { "https" } else { "http" }),
            access,
            secret,
            token: variable(config, "DOCUMENT_OBJECT_SESSION_TOKEN", ""),
            bucket,
            prefix,
            region: variable(config, "DOCUMENT_OBJECT_REGION", "us-east-1"),
            secure,
        })
    }
}
struct Object {
    settings: Settings,
    key: String,
    size: usize,
    maximum: usize,
    timeout: Duration,
}
enum Source {
    Inline(Vec<u8>),
    Object(Box<Object>),
}
struct Load {
    filename: String,
    source: Source,
}
fn plan(
    config: &Config,
    record: &Value,
    document: &str,
    session: &str,
    user: &str,
    now_ms: f64,
) -> Result<Load> {
    let filename = text(record, "filename", &format!("{document}.bin"));
    let maximum = maximum(config);
    if let Some(encoded) = record
        .get("data")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        let stripped = trim(encoded);
        let estimate = stripped.chars().count() as i128 * 3 / 4
            - stripped.bytes().filter(|c| *c == b'=').count() as i128;
        if estimate > maximum as i128 {
            return Err(size_error(maximum));
        }
        // binascii accepts nonzero unused bits, and arbitrary padding after a
        // complete quartet, but rejects extra padding after a partial quartet.
        let unpadded = encoded.trim_end_matches('=');
        let encoded = if !unpadded.is_empty() && unpadded.len().is_multiple_of(4) {
            unpadded
        } else {
            encoded
        };
        let engine = general_purpose::GeneralPurpose::new(
            &alphabet::STANDARD,
            general_purpose::GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
        );
        let bytes = engine.decode(encoded).map_err(|_| anyhow!(INVALID))?;
        return Ok(Load {
            filename,
            source: Source::Inline(bytes),
        });
    }
    if record["storage"] != "object-v1" {
        bail!(EMPTY);
    }
    let settings = Settings::new(config)?;
    let key = object_key(&settings.prefix, user, session, document)?;
    if text(record, "objectKey", "") != key || text(record, "objectBucket", "") != settings.bucket {
        bail!("Error: Stored document object reference is invalid.");
    }
    let size = record["size"]
        .as_number()
        .map(ToString::to_string)
        .filter(|n| !n.contains(['.', 'e', 'E']))
        .ok_or_else(|| anyhow!("Error: Stored document size is invalid."))?;
    if size.starts_with('-') || size == "0" {
        bail!(EMPTY);
    }
    let size: usize = size.parse().map_err(|_| size_error(maximum))?;
    if size > maximum {
        return Err(size_error(maximum));
    }
    let expires = record["expiresAt"].as_f64().or_else(|| {
        record["expiresAt"]
            .as_bool()
            .map(|b| f64::from(u8::from(b)))
    });
    if expires.is_some_and(|expiry| expiry <= now_ms) {
        bail!("Error: Document has expired. Please upload the document again.");
    }
    let timeout = integer(&variable(
        config,
        "DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS",
        "300000",
    ))
    .and_then(|n| n.parse::<u64>().ok())
    .filter(|n| (100..=900000).contains(n))
    .ok_or_else(|| anyhow!("Error: Document object storage request timeout is invalid."))?;
    Ok(Load {
        filename,
        source: Source::Object(Box::new(Object {
            settings,
            key,
            size,
            maximum,
            timeout: Duration::from_millis(timeout),
        })),
    })
}

fn encoded_path(bucket: &str, key: &str) -> String {
    let mut result = String::new();
    for segment in std::iter::once(bucket).chain(key.split('/')) {
        result.push('/');
        for byte in segment.bytes() {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                result.push(byte as char);
            } else {
                result.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    result
}
fn hmac(key: &[u8], message: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(message.as_bytes());
    mac.finalize().into_bytes().to_vec()
}
fn signed_headers(
    settings: &Settings,
    path: &str,
    timestamp: &str,
) -> Result<BTreeMap<String, String>> {
    let url = reqwest::Url::parse(&settings.endpoint)
        .map_err(|_| anyhow!("Error: Document object storage endpoint is invalid."))?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("Error: Document object storage endpoint is invalid.");
    }
    let host = match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap()),
        None => url.host_str().unwrap().to_owned(),
    };
    let hash = if settings.secure {
        "UNSIGNED-PAYLOAD".into()
    } else {
        format!("{:x}", Sha256::digest([]))
    };
    let mut headers = BTreeMap::from([
        ("host".into(), host),
        ("x-amz-content-sha256".into(), hash),
        ("x-amz-date".into(), timestamp.into()),
    ]);
    if !settings.token.is_empty() {
        headers.insert("x-amz-security-token".into(), settings.token.clone());
    }
    let names = headers.keys().cloned().collect::<Vec<_>>().join(";");
    let canonical_headers = headers
        .iter()
        .map(|(name, value)| {
            format!(
                "{name}:{}\n",
                value.split_whitespace().collect::<Vec<_>>().join(" ")
            )
        })
        .collect::<String>();
    let canonical = format!(
        "GET\n{path}\n\n{canonical_headers}\n{names}\n{}",
        headers["x-amz-content-sha256"]
    );
    let date = &timestamp[..8];
    let scope = format!("{date}/{}/s3/aws4_request", settings.region);
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{timestamp}\n{scope}\n{:x}",
        Sha256::digest(canonical)
    );
    let key = hmac(format!("AWS4{}", settings.secret).as_bytes(), date);
    let key = hmac(&key, &settings.region);
    let key = hmac(&key, "s3");
    let key = hmac(&key, "aws4_request");
    let signature = hmac(&key, &to_sign)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    headers.insert(
        "authorization".into(),
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={names}, Signature={signature}",
            settings.access
        ),
    );
    Ok(headers)
}
fn verify_size(object: &Object, bytes: &[u8]) -> Result<()> {
    if bytes.len() > object.maximum {
        return Err(size_error(object.maximum));
    }
    if bytes.len() != object.size {
        bail!("Error: Stored document length doesn't match its metadata.");
    }
    Ok(())
}
pub async fn load_record(
    config: &Config,
    record: &Value,
    document: &str,
    session: &str,
    user: &str,
) -> Result<(Vec<u8>, String)> {
    if !can_access(record, user)? {
        bail!(
            "Error: You do not have access to this document. Please upload the document again from your account."
        );
    }
    let load = plan(
        config,
        record,
        document,
        session,
        user,
        chrono::Utc::now().timestamp_millis() as f64,
    )?;
    let bytes = match load.source {
        Source::Inline(bytes) => bytes,
        Source::Object(object) => {
            let path = encoded_path(&object.settings.bucket, &object.key);
            let headers = signed_headers(
                &object.settings,
                &path,
                &chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string(),
            )?;
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(object.timeout.min(Duration::from_secs(10)))
                .timeout(object.timeout)
                .build()
                .map_err(|_| anyhow!(OBJECT_ACCESS))?;
            let mut request = client.get(format!("{}{path}", object.settings.endpoint));
            for (key, value) in headers {
                request = request.header(key, value);
            }
            let response = request.send().await.map_err(|_| anyhow!(OBJECT_ACCESS))?;
            if !response.status().is_success() {
                bail!(OBJECT_ACCESS);
            }
            let mut stream = response.bytes_stream();
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| anyhow!(OBJECT_ACCESS))?;
                if chunk.len() > object.maximum.saturating_sub(bytes.len()) {
                    return Err(size_error(object.maximum));
                }
                bytes.extend_from_slice(&chunk);
            }
            verify_size(&object, &bytes)?;
            bytes
        }
    };
    Ok((bytes, load.filename))
}

pub(super) struct ImmutableReference<'a> {
    pub document: &'a str,
    pub session: &'a str,
}
impl ImmutableReference<'_> {
    pub fn key(&self) -> String {
        format!("document:{}:{}", self.session, self.document)
    }
}
pub(super) fn immutable_reference(input: &Value) -> Result<ImmutableReference<'_>> {
    if !input.is_object() {
        bail!("Error: Invalid document reference provided.");
    }
    let (Some(document), Some(session)) =
        (input["documentId"].as_str(), input["sessionId"].as_str())
    else {
        bail!("Error: Document reference must contain documentId and sessionId.");
    };
    if !safe_segment(document) || !safe_segment(session) {
        bail!("Error: Document reference is invalid.");
    }
    Ok(ImmutableReference { document, session })
}
pub(super) fn immutable_identity(
    config: &Config,
    reference: &ImmutableReference<'_>,
    user: &str,
    record: Option<&Value>,
) -> Result<Value> {
    let record = record
        .ok_or_else(|| anyhow!("Error: Document not found in storage. Please upload it again."))?;
    if !record.is_object() || !can_access(record, user)? {
        bail!("Error: You do not have access to this document.");
    }
    let mut identity = serde_json::json!({
        "documentId":reference.document, "sessionId":reference.session, "size":record["size"]
    });
    if record["storage"] == "object-v1" {
        let (Some(key), Some(bucket)) = (
            record["objectKey"].as_str(),
            record["objectBucket"].as_str(),
        ) else {
            bail!("Error: Stored document object reference is invalid.");
        };
        let settings = Settings::new(config)?;
        let expected = object_key(
            &settings.prefix,
            user,
            reference.session,
            reference.document,
        )?;
        if key != expected || bucket != settings.bucket {
            bail!("Error: Stored document object reference is invalid.");
        }
        identity["storage"] = serde_json::json!("object-v1");
        identity["objectKey"] = serde_json::json!(key);
        identity["objectBucket"] = serde_json::json!(bucket);
        identity["etag"] = record["etag"].clone();
    } else if let Some(data) = record["data"].as_str().filter(|data| !data.is_empty()) {
        if let Some((start, first)) = data.chars().enumerate().find(|(_, c)| !c.is_ascii()) {
            let count = data
                .chars()
                .skip(start)
                .take_while(|c| !c.is_ascii())
                .count();
            let location = if count == 1 {
                let code = first as u32;
                let escaped = if code <= 0xff {
                    format!("\\x{code:02x}")
                } else if code <= 0xffff {
                    format!("\\u{code:04x}")
                } else {
                    format!("\\U{code:08x}")
                };
                format!("character '{escaped}' in position {start}")
            } else {
                format!("characters in position {start}-{}", start + count - 1)
            };
            bail!("'ascii' codec can't encode {location}: ordinal not in range(128)");
        }
        identity["storage"] = serde_json::json!("legacy-base64");
        identity["payloadSha256"] =
            serde_json::json!(format!("{:x}", Sha256::digest(data.as_bytes())));
    } else {
        bail!("Error: Retrieved document data is empty.");
    }
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
                Value::Object(map) => map.values_mut().for_each(expand),
                _ => {}
            }
        }
    }
    fn config(env: &Value) -> Config {
        Config {
            raw: Value::Null,
            policy_raw: Value::Null,
            env: serde_json::from_value(env.clone()).unwrap(),
            python_tools: false,
        }
    }
    #[test]
    fn frozen_storage_and_signatures() {
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/document-storage.json")).unwrap();
        expand(&mut fixture);
        for (i, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            let input = &case["input"];
            let cfg = config(&input["env"]);
            let mut calls = json!([]);
            let result = plan(&cfg, &input["record"], input["document"].as_str().unwrap(), input["session"].as_str().unwrap(), input["username"].as_str().unwrap(), 2_000_000_000_000.).and_then(|load| {
                let bytes = match load.source {
                    Source::Inline(bytes) => bytes,
                    Source::Object(object) => {
                        calls = json!([[object.settings.bucket, object.key]]);
                        let bytes = general_purpose::STANDARD.decode(input["body"].as_str().unwrap()).unwrap();
                        verify_size(&object, &bytes)?;
                        bytes
                    }
                };
                Ok(json!({"data": general_purpose::STANDARD.encode(bytes), "filename": load.filename}))
            });
            let actual = match result {
                Ok(value) => value,
                Err(error) => json!({"error": error.to_string(), "type": "DocumentStorageError"}),
            };
            assert_eq!(actual, case["expected"], "storage {i}: {input}");
            assert_eq!(calls, case["calls"], "storage calls {i}");
        }
        for case in fixture["signatures"].as_array().unwrap() {
            let settings = Settings::new(&config(&json!({
                "DOCUMENT_OBJECT_ENDPOINT": case["endpoint"],
                "DOCUMENT_OBJECT_ACCESS_KEY": "synthetic-access",
                "DOCUMENT_OBJECT_SECRET_KEY": "synthetic-secret",
                "DOCUMENT_OBJECT_BUCKET": "synthetic-documents",
                "DOCUMENT_OBJECT_REGION": case["region"],
                "DOCUMENT_OBJECT_SESSION_TOKEN": case["token"].as_str().unwrap_or("")
            })))
            .unwrap();
            let headers = signed_headers(
                &settings,
                case["path"].as_str().unwrap(),
                "20260102T030405Z",
            )
            .unwrap();
            for (name, value) in case["headers"].as_object().unwrap() {
                assert_eq!(
                    headers[&name.to_lowercase()],
                    value.as_str().unwrap(),
                    "{name}: {case}"
                );
            }
        }
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/documents.json")).unwrap();
        expand(&mut fixture);
        for case in fixture["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["kind"] == "owner")
        {
            let actual = can_access(&case["input"][0], case["input"][1].as_str().unwrap());
            if let Some(expected) = case["expected"].get("ok") {
                assert_eq!(json!(actual.unwrap()), *expected);
            } else {
                assert!(actual.is_err());
            }
        }
    }

    #[tokio::test]
    async fn object_download_is_signed_bounded_and_never_redirected_or_retried() {
        use axum::{
            Router,
            body::Body,
            extract::State,
            http::{HeaderMap, StatusCode, Uri},
            response::Response,
            routing::get,
        };
        use std::sync::{Arc, Mutex};
        let calls = Arc::new(Mutex::new(Vec::new()));
        async fn handler(
            State(calls): State<Arc<Mutex<Vec<HeaderMap>>>>,
            uri: Uri,
            headers: HeaderMap,
        ) -> Response {
            calls.lock().unwrap().push(headers);
            if uri.path().starts_with("/redirect/") {
                return Response::builder()
                    .status(StatusCode::TEMPORARY_REDIRECT)
                    .header("location", "/synthetic-documents/forged")
                    .body(Body::empty())
                    .unwrap();
            }
            if uri.path().starts_with("/failure/") {
                return Response::builder()
                    .status(StatusCode::SERVICE_UNAVAILABLE)
                    .body(Body::empty())
                    .unwrap();
            }
            if uri.path().starts_with("/slow/") {
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            Response::builder()
                .header("content-type", "application/octet-stream")
                .body(Body::from("data"))
                .unwrap()
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(
            axum::serve(
                listener,
                Router::new()
                    .route("/{*key}", get(handler))
                    .with_state(calls.clone()),
            )
            .into_future(),
        );
        let mut cfg = config(
            &json!({"DOCUMENT_OBJECT_ENDPOINT": endpoint, "DOCUMENT_OBJECT_ACCESS_KEY": "synthetic-access", "DOCUMENT_OBJECT_SECRET_KEY": "synthetic-secret", "DOCUMENT_OBJECT_BUCKET": "synthetic-documents"}),
        );
        let mut record = json!({"userId": "alice", "filename": "document.txt", "storage": "object-v1", "objectBucket": "synthetic-documents", "objectKey": object_key("daedalus-documents", "alice", "session", "document").unwrap(), "size": 4});
        assert_eq!(
            load_record(&cfg, &record, "document", "session", "alice")
                .await
                .unwrap(),
            (b"data".to_vec(), "document.txt".into())
        );
        let observed = calls.lock().unwrap().pop().unwrap();
        assert!(
            observed["authorization"]
                .to_str()
                .unwrap()
                .contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date")
        );
        assert!(!observed.contains_key("x-user-id"));
        assert!(
            load_record(&cfg, &record, "document", "session", "bob")
                .await
                .unwrap_err()
                .to_string()
                .contains("do not have access")
        );
        assert!(calls.lock().unwrap().is_empty());
        record["size"] = json!(3);
        assert!(
            load_record(&cfg, &record, "document", "session", "alice")
                .await
                .unwrap_err()
                .to_string()
                .contains("length doesn't match")
        );
        cfg.env
            .insert("DOCUMENT_INGEST_MAX_SIZE_BYTES".into(), "3".into());
        assert!(
            load_record(&cfg, &record, "document", "session", "alice")
                .await
                .unwrap_err()
                .to_string()
                .contains("maximum allowed size")
        );
        cfg.env.remove("DOCUMENT_INGEST_MAX_SIZE_BYTES");
        cfg.env
            .insert("DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS".into(), "100".into());
        for bucket in ["redirect", "failure", "slow"] {
            calls.lock().unwrap().clear();
            cfg.env
                .insert("DOCUMENT_OBJECT_BUCKET".into(), bucket.into());
            record["objectBucket"] = json!(bucket);
            assert_eq!(
                load_record(&cfg, &record, "document", "session", "alice")
                    .await
                    .unwrap_err()
                    .to_string(),
                OBJECT_ACCESS
            );
            assert_eq!(
                calls.lock().unwrap().len(),
                1,
                "no redirect/replay for {bucket}"
            );
        }
        server.abort();
    }
}
