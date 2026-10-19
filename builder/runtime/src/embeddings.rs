//! Shared role-aware embedding provider for native document search.
//! Preserve validation and exception classes consumed by the tool stream.
use crate::{document_tools, memory_tools::trim};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::Read,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

#[derive(Debug)]
pub struct Failure {
    pub class: &'static str,
    pub validation: Vec<Value>,
}
impl Failure {
    fn new(class: &'static str) -> Self {
        Self {
            class,
            validation: Vec::new(),
        }
    }
    #[cfg(test)]
    fn observation(&self) -> Value {
        if self.class == "ValidationError" {
            json!({"error":self.class,"validation":self.validation})
        } else {
            json!({"error":self.class})
        }
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Embedding provider {}", self.class)
    }
}
impl std::error::Error for Failure {}
type Result<T> = std::result::Result<T, Failure>;

/// One immutable preparation owns the registry. Tools using the same embedder
/// name share its clients and connection pool until that preparation is dropped.
pub struct Registry {
    configuration: Value,
    clients: Mutex<HashMap<String, Arc<Client>>>,
}
impl Registry {
    pub fn new(configuration: &Value) -> Self {
        Self {
            configuration: configuration.clone(),
            clients: Mutex::new(HashMap::new()),
        }
    }
    pub fn get(&self, name: &str) -> Result<Arc<Client>> {
        let mut clients = self.clients.lock().expect("embedding registry");
        if let Some(client) = clients.get(name) {
            return Ok(client.clone());
        }
        let configured = self
            .configuration
            .get("embedders")
            .ok_or_else(|| Failure::new("KeyError"))?;
        let entries = configured
            .as_object()
            .ok_or_else(|| Failure::new("TypeError"))?;
        let raw = entries.get(name).ok_or_else(|| Failure::new("KeyError"))?;
        let mut raw = raw
            .as_object()
            .cloned()
            .ok_or_else(|| Failure::new("TypeError"))?;
        raw.remove("_type");
        let client = Arc::new(Client::new(&Value::Object(raw))?);
        clients.insert(name.into(), client.clone());
        Ok(client)
    }
}
fn invalid() -> Failure {
    Failure::new("RuntimeError")
}

fn issue(kind: &str, field: &str) -> Value {
    let message = match kind {
        "string_type" => "Input should be a valid string",
        "missing" => "Field required",
        "float_type" => "Input should be a valid number",
        "float_parsing" => "Input should be a valid number, unable to parse string as a number",
        "greater_than" => "Input should be greater than 0",
        "int_type" => "Input should be a valid integer",
        "int_parsing" => "Input should be a valid integer, unable to parse string as an integer",
        "int_from_float" => "Input should be a valid integer, got a number with a fractional part",
        "int_parsing_size" => "Unable to parse input string as an integer, exceeded maximum size",
        "finite_number" => "Input should be a finite number",
        "greater_than_equal" => "Input should be greater than or equal to 1",
        "less_than_equal" => "Input should be less than or equal to 64",
        "bool_type" => "Input should be a valid boolean",
        "bool_parsing" => "Input should be a valid boolean, unable to interpret input",
        _ => unreachable!("known provider validation"),
    };
    let mut result = json!({"type":kind,"loc":[field],"msg":message});
    match kind {
        "greater_than" => result["ctx"] = json!({"gt":0.0}),
        "greater_than_equal" => result["ctx"] = json!({"ge":1}),
        "less_than_equal" => result["ctx"] = json!({"le":64}),
        _ => {}
    }
    result
}

pub struct Settings {
    pub values: Value,
}
impl Settings {
    pub fn new(raw: &Value) -> Result<Self> {
        let Some(raw) = raw.as_object() else {
            return Err(Failure {
                class: "ValidationError",
                validation: vec![
                    json!({"type":"model_type","loc":[],"msg":"Input should be a valid dictionary or instance of DaedalusVLLMEmbedderConfig","ctx":{"class_name":"DaedalusVLLMEmbedderConfig"}}),
                ],
            });
        };
        let mut values = json!({"api_key":null,"timeout_seconds":60.0,"truncate_prompt_tokens":null,"max_concurrency":8,"verify_ssl":true});
        let mut errors = Vec::new();
        for field in [
            "api_key",
            "base_url",
            "model_name",
            "timeout_seconds",
            "truncate_prompt_tokens",
            "max_concurrency",
            "verify_ssl",
        ] {
            let key =
                if field == "model_name" && !raw.contains_key(field) && raw.contains_key("model") {
                    "model"
                } else {
                    field
                };
            let Some(input) = raw.get(key) else {
                if ["base_url", "model_name"].contains(&field) {
                    errors.push(issue("missing", key));
                }
                continue;
            };
            if input.is_null() && ["api_key", "truncate_prompt_tokens"].contains(&field) {
                continue;
            }
            let parsed = match field {
                "api_key" | "base_url" | "model_name" => input
                    .is_string()
                    .then(|| input.clone())
                    .ok_or("string_type"),
                "timeout_seconds" => document_tools::number(input)
                    .map_err(|_| {
                        if input.is_string() {
                            "float_parsing"
                        } else {
                            "float_type"
                        }
                    })
                    .and_then(|value| {
                        let number = value
                            .as_f64()
                            .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
                            .unwrap();
                        if number > 0. {
                            Ok(value)
                        } else {
                            Err("greater_than")
                        }
                    }),
                "truncate_prompt_tokens" | "max_concurrency" => document_tools::integer(input)
                    .map_err(|_| {
                        if input.is_string() {
                            "int_parsing"
                        } else if let Some(number) = input.as_f64() {
                            if !number.is_finite() {
                                "finite_number"
                            } else if number.fract() != 0. {
                                "int_from_float"
                            } else {
                                "int_parsing_size"
                            }
                        } else {
                            "int_type"
                        }
                    })
                    .and_then(|value| {
                        if value == json!(0) || value.to_string().starts_with('-') {
                            Err("greater_than_equal")
                        } else if field == "max_concurrency"
                            && value.as_u64().is_none_or(|n| n > 64)
                        {
                            Err("less_than_equal")
                        } else {
                            Ok(value)
                        }
                    }),
                "verify_ssl" => {
                    document_tools::coerce(input, &json!({"type":"boolean"})).map_err(|_| {
                        if input.is_string()
                            || input.as_f64().is_some_and(|n| {
                                n.fract() == 0.
                                    && (-9223372036854775808.0..9223372036854775808.0).contains(&n)
                            })
                        {
                            "bool_parsing"
                        } else {
                            "bool_type"
                        }
                    })
                }
                _ => unreachable!(),
            };
            match parsed {
                Ok(value) => values[field] = value,
                Err(kind) => errors.push(issue(kind, key)),
            }
        }
        if errors.is_empty() {
            Ok(Self { values })
        } else {
            Err(Failure {
                class: "ValidationError",
                validation: errors,
            })
        }
    }
    fn seconds(&self) -> f64 {
        self.values["timeout_seconds"].as_f64().unwrap_or_else(|| {
            self.values["timeout_seconds"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap()
        })
    }
    #[cfg(test)]
    fn observation(&self) -> Value {
        let mut values = self.values.clone();
        if !self.seconds().is_finite() {
            values["timeout_seconds"] = json!({"$float":"inf"});
        }
        json!({"ok":values})
    }
}

fn endpoint(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/embeddings") {
        base.into()
    } else if base.ends_with("/v1") {
        format!("{base}/embeddings")
    } else {
        format!("{base}/v1/embeddings")
    }
}
fn payload(model: &str, text: &str, role: &str, truncate: &Value) -> Value {
    let mut result =
        json!({"model":model,"messages":[{"role":role,"content":[{"type":"text","text":text}]}]});
    if !truncate.is_null() {
        result["truncate_prompt_tokens"] = truncate.clone();
    }
    result
}

pub struct Client {
    settings: Settings,
    endpoint: String,
    headers: Value,
    pool: Pool,
    slots: Arc<tokio::sync::Semaphore>,
    timeout: Option<Duration>,
}
// Each leased HTTP client owns at most one connection. Returning a connection
// only after decompression succeeds lets us discard a corrupt response's
// connection without resetting other concurrent queries. httpx's default pool
// admits 100 connections and keeps at most 20 idle for five seconds.
struct Pool {
    idle: Mutex<Vec<(Instant, reqwest::Client)>>,
    timeout: Option<Duration>,
    verify_ssl: bool,
    certificates: Option<Vec<reqwest::Certificate>>,
}
impl Pool {
    fn build(&self) -> Result<reqwest::Client> {
        let mut builder = reqwest::Client::builder()
            .http1_only()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .danger_accept_invalid_certs(!self.verify_ssl)
            .pool_idle_timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(1);
        if let Some(certificates) = &self.certificates {
            builder = builder.tls_certs_only(certificates.clone());
        }
        if let Some(timeout) = self.timeout {
            builder = builder.connect_timeout(timeout).read_timeout(timeout);
        }
        builder.build().map_err(|_| Failure::new("ValueError"))
    }
    fn take(&self) -> Result<Lease<'_>> {
        let client = {
            let mut idle = self.idle.lock().expect("embedding pool");
            idle.retain(|(at, _)| at.elapsed() < Duration::from_secs(5));
            idle.pop().map(|(_, client)| client)
        };
        Ok(Lease {
            pool: self,
            client: Some(match client {
                Some(client) => client,
                None => self.build()?,
            }),
            reusable: false,
        })
    }
}
struct Lease<'a> {
    pool: &'a Pool,
    client: Option<reqwest::Client>,
    reusable: bool,
}
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if self.reusable {
            let mut idle = self.pool.idle.lock().expect("embedding pool");
            if idle.len() < 20 {
                idle.push((Instant::now(), self.client.take().unwrap()));
            }
        }
    }
}
impl Client {
    pub fn new(raw: &Value) -> Result<Self> {
        let settings = Settings::new(raw)?;
        let base = settings.values["base_url"].as_str().unwrap();
        let model = settings.values["model_name"].as_str().unwrap();
        if trim(base).is_empty() || trim(model).is_empty() {
            return Err(Failure::new("ValueError"));
        }
        let endpoint = endpoint(base);
        let mut headers = json!({"accept":"application/json","content-type":"application/json"});
        if let Some(key) = settings.values["api_key"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            if !key.is_ascii() {
                return Err(Failure::new("UnicodeEncodeError"));
            }
            headers["authorization"] = json!(format!("Bearer {key}"));
        }
        // CPython socket timeouts are signed 64-bit nanoseconds. The model
        // accepts larger floats, but the first query raises OverflowError.
        let seconds = settings.seconds();
        let timeout = Duration::try_from_secs_f64(seconds)
            .ok()
            .filter(|_| seconds * 1e9 < 9_223_372_036_854_775_808.0);
        let verify_ssl = settings.values["verify_ssl"] != false;
        let certificates = if verify_ssl && let Ok(path) = std::env::var("SSL_CERT_FILE") {
            let pem = std::fs::read(path).map_err(|_| Failure::new("FileNotFoundError"))?;
            Some(
                reqwest::Certificate::from_pem_bundle(&pem)
                    .map_err(|_| Failure::new("SSLError"))?,
            )
        } else {
            None
        };
        let pool = Pool {
            idle: Mutex::new(Vec::new()),
            timeout,
            verify_ssl,
            certificates,
        };
        pool.idle
            .lock()
            .expect("embedding pool")
            .push((Instant::now(), pool.build()?));
        Ok(Self {
            settings,
            endpoint,
            headers,
            pool,
            // httpx's 100-connection pool bounds concurrent queries. The
            // validated max_concurrency bounds only the retained provider's
            // document batches, which this query-only client never sends.
            slots: Arc::new(tokio::sync::Semaphore::new(100)),
            timeout,
        })
    }

    pub async fn query(&self, text: &str) -> Result<Vec<f64>> {
        self.embed(text, "query").await
    }
    async fn embed(&self, text: &str, role: &str) -> Result<Vec<f64>> {
        let timeout = self.timeout.ok_or_else(|| Failure::new("OverflowError"))?;
        let _slot = tokio::time::timeout(timeout, self.slots.clone().acquire_owned())
            .await
            .map_err(|_| Failure::new("PoolTimeout"))?
            .map_err(|_| invalid())?;
        let mut lease = self.pool.take()?;
        let mut request = lease
            .client
            .as_ref()
            .unwrap()
            .post(&self.endpoint)
            .header("accept-encoding", "gzip, deflate, zstd");
        for (name, value) in self.headers.as_object().unwrap() {
            let value = value.as_str().unwrap();
            if value.ends_with([' ', '\t']) || value.contains(['\r', '\n', '\0']) {
                return Err(Failure::new("LocalProtocolError"));
            }
            request = request.header(name, value);
        }
        let body = payload(
            self.settings.values["model_name"].as_str().unwrap(),
            text,
            role,
            &self.settings.values["truncate_prompt_tokens"],
        );
        let response = request.json(&body).send().await.map_err(|e| {
            if e.is_builder()
                && (self.endpoint.starts_with("http://") || self.endpoint.starts_with("https://"))
            {
                Failure::new("ConnectError")
            } else {
                transport(&e)
            }
        })?;
        let status = response.status().as_u16();
        let encoding = response
            .headers()
            .get("content-encoding")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let body = response.bytes().await.map_err(|e| transport(&e))?;
        let decoded = decompress(&encoding, body.to_vec(), MAX_DECODED)?;
        lease.reusable = true;
        extract(status, &decoded)
    }
}
/// An embedding response is one vector; this bounds a decompression bomb.
const MAX_DECODED: usize = 16 * 1024 * 1024;

/// Undo each content encoding, failing once any decoded stage exceeds `limit`
/// bytes. Callers read untrusted responses in memory.
pub(crate) fn decompress(encoding: &str, mut body: Vec<u8>, limit: usize) -> Result<Vec<u8>> {
    let read = |decoder: &mut dyn Read| -> std::io::Result<Vec<u8>> {
        let mut output = Vec::new();
        decoder.take(limit as u64 + 1).read_to_end(&mut output)?;
        if output.len() > limit {
            return Err(std::io::Error::other("decoded response exceeds its limit"));
        }
        Ok(output)
    };
    for encoding in encoding.split(',').rev().map(str::trim) {
        body = match encoding.to_ascii_lowercase().as_str() {
            "gzip" => read(&mut flate2::read::GzDecoder::new(body.as_slice())),
            "deflate" => read(&mut flate2::read::ZlibDecoder::new(body.as_slice()))
                .or_else(|_| read(&mut flate2::read::DeflateDecoder::new(body.as_slice()))),
            "zstd" => zstd::stream::read::Decoder::new(body.as_slice())
                .and_then(|mut decoder| read(&mut decoder)),
            _ => Ok(body),
        }
        .map_err(|_| Failure::new("DecodingError"))?;
    }
    Ok(body)
}
fn transport(error: &reqwest::Error) -> Failure {
    Failure::new(if error.is_timeout() {
        if error.is_connect() {
            "ConnectTimeout"
        } else {
            "ReadTimeout"
        }
    } else if error.is_connect() {
        "ConnectError"
    } else if error.is_builder() {
        "UnsupportedProtocol"
    } else {
        "RemoteProtocolError"
    })
}

fn python_float(value: &Value) -> Result<f64> {
    if let Some(value) = value.as_bool() {
        return Ok(f64::from(value));
    }
    let raw = if let Some(value) = value.as_str() {
        crate::document_store::decimal(value)
    } else if value.is_number() {
        value.to_string()
    } else {
        return Err(invalid());
    };
    static FLOAT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^[+-]?(?:(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:e[+-]?[0-9](?:_?[0-9])*)?|inf(?:inity)?|nan)$").unwrap()
    });
    if !FLOAT.is_match(&raw) {
        return Err(invalid());
    }
    let number: f64 = raw.replace('_', "").parse().map_err(|_| invalid())?;
    if value.is_number() && !raw.contains(['.', 'e', 'E']) && !number.is_finite() {
        return Err(Failure::new("OverflowError"));
    }
    Ok(number)
}

fn json_bytes(raw: &[u8]) -> Option<Value> {
    let encoding = if raw.starts_with(&[0, 0, 0xfe, 0xff]) || raw.starts_with(&[0xff, 0xfe, 0, 0]) {
        "utf_32"
    } else if raw.starts_with(&[0xfe, 0xff]) || raw.starts_with(&[0xff, 0xfe]) {
        "utf_16"
    } else if raw.starts_with(&[0xef, 0xbb, 0xbf]) {
        "utf_8_sig"
    } else if raw.len() >= 4 && raw[0] == 0 {
        if raw[1] == 0 {
            "utf_32_be"
        } else {
            "utf_16_be"
        }
    } else if raw.len() >= 4 && raw[1] == 0 {
        if raw[2] == 0 && raw[3] == 0 {
            "utf_32_le"
        } else {
            "utf_16_le"
        }
    } else {
        "utf_8"
    };
    let text = crate::document_codecs::decode(encoding, raw, false).ok()?;
    let mut converted = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        let start = at;
        if bytes[at] == b'"' {
            at += 1;
            while at < bytes.len() {
                let byte = bytes[at];
                at += 1;
                if byte == b'\\' {
                    at += 1;
                } else if byte == b'"' {
                    break;
                }
            }
        } else if matches!(
            bytes[at],
            b'[' | b']' | b'{' | b'}' | b',' | b':' | b' ' | b'\n' | b'\r' | b'\t'
        ) {
            at += 1;
        } else {
            while at < bytes.len()
                && !matches!(
                    bytes[at],
                    b'[' | b']' | b'{' | b'}' | b',' | b':' | b' ' | b'\n' | b'\r' | b'\t'
                )
            {
                at += 1;
            }
            let token = text.get(start..at)?;
            if ["NaN", "Infinity", "-Infinity"].contains(&token) {
                converted.push('"');
                converted.push_str(token);
                converted.push('"');
                continue;
            }
            if token
                .trim_start_matches('-')
                .bytes()
                .all(|c| c.is_ascii_digit())
                && token.trim_start_matches('-').len() > 4300
            {
                return None;
            }
        }
        converted.push_str(text.get(start..at)?);
    }
    crate::document_json::decode_indexed(converted.as_bytes()).map(|(value, _)| value)
}
fn extract(status: u16, body: &[u8]) -> Result<Vec<f64>> {
    if status >= 400 {
        return Err(invalid());
    }
    let data = json_bytes(body).ok_or_else(invalid)?;
    let data = data["data"]
        .as_array()
        .filter(|v| v.len() == 1)
        .ok_or_else(invalid)?;
    data[0]["embedding"]
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or_else(invalid)?
        .iter()
        .map(python_float)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    #[tokio::test]
    #[ignore = "requires the disposable HTTP/TLS fixture in embeddings_check.py"]
    async fn actual_embedding_provider() {
        let fixture: Value = serde_json::from_slice(
            &std::fs::read(std::env::var("DAEDALUS_EMBEDDINGS_FIXTURE").unwrap()).unwrap(),
        )
        .unwrap();
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let control = fixture["control"].as_str().unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            http.post(format!("{control}/__reset"))
                .json(case)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            let mut results = Vec::new();
            let initialization = match Client::new(&case["config"]) {
                Err(error) => error.observation(),
                Ok(client) => {
                    let queries = case["queries"].as_array().unwrap();
                    let observe = |result: Result<Vec<f64>>| {
                        result
                        .map(|v| json!({"bits":v.into_iter().map(|n|format!("{:016x}",n.to_bits())).collect::<Vec<_>>()}))
                        .unwrap_or_else(|e|e.observation())
                    };
                    if case["parallel"].as_bool().unwrap_or(false) {
                        results = futures::future::join_all(
                            queries
                                .iter()
                                .map(|text| client.query(text.as_str().unwrap())),
                        )
                        .await
                        .into_iter()
                        .map(observe)
                        .collect();
                    } else {
                        for text in queries {
                            results.push(observe(client.query(text.as_str().unwrap()).await));
                        }
                    }
                    json!({"ok":true})
                }
            };
            let calls: Value = http
                .get(format!("{control}/__calls"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(
                json!({"initialization":initialization,"results":results,"calls":calls}),
                case["expected"],
                "{}",
                case["name"]
            );
            println!("Native embeddings: {}", case["name"]);
        }
    }
    #[tokio::test]
    async fn retained_embedding_provider_contracts() {
        fn numbers(value: &mut Value) {
            if let Some(number) = value.get("$integer").and_then(Value::as_str) {
                *value = serde_json::from_str(number).unwrap();
            } else {
                match value {
                    Value::Array(values) => values.iter_mut().for_each(numbers),
                    Value::Object(values) => values.values_mut().for_each(numbers),
                    _ => {}
                }
            }
        }
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/embeddings.json")).unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        numbers(&mut fixture);
        for case in fixture["configurations"].as_array().unwrap() {
            let actual = Settings::new(&case["input"])
                .map(|s| s.observation())
                .unwrap_or_else(|e| e.observation());
            assert_eq!(actual, case["expected"], "{}", case["input"]);
        }
        for case in fixture["construction"].as_array().unwrap() {
            let actual = Client::new(&case["input"])
                .map(|c| json!({"endpoint":c.endpoint,"headers":c.headers}))
                .unwrap_or_else(|e| e.observation());
            assert_eq!(actual, case["expected"], "{}", case["input"]);
        }
        for case in fixture["requests"].as_array().unwrap() {
            let actual = json!({"endpoint":endpoint(case["url"].as_str().unwrap()),"payload":payload(case["model"].as_str().unwrap(),case["text"].as_str().unwrap(),case["role"].as_str().unwrap(), &case["truncate"])});
            assert_eq!(actual, case["expected"]);
        }
        for case in fixture["responses"].as_array().unwrap() {
            let body = base64::engine::general_purpose::STANDARD
                .decode(case["body"].as_str().unwrap())
                .unwrap();
            let actual = extract(case["status"].as_u64().unwrap() as u16, &body).map(|v| json!({"bits":v.into_iter().map(|n|format!("{:016x}",n.to_bits())).collect::<Vec<_>>()})).unwrap_or_else(|e| e.observation());
            assert_eq!(actual, case["expected"], "{}", case["name"]);
        }
        for case in fixture["compression"].as_array().unwrap() {
            let body = base64::engine::general_purpose::STANDARD
                .decode(case["body"].as_str().unwrap())
                .unwrap();
            let actual = decompress(case["encoding"].as_str().unwrap(), body, MAX_DECODED)
                .and_then(|body|extract(200, &body))
                .map(|v|json!({"bits":v.into_iter().map(|n|format!("{:016x}",n.to_bits())).collect::<Vec<_>>()}))
                .unwrap_or_else(|e|e.observation());
            assert_eq!(actual, case["expected"], "{}", case["name"]);
        }
    }

    #[test]
    fn decoded_responses_are_bounded() {
        use std::io::Write;
        let zeros = vec![0u8; 4 * 1024 * 1024];
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        gzip.write_all(&zeros).unwrap();
        let gzip = gzip.finish().unwrap();
        let zstd = zstd::stream::encode_all(zeros.as_slice(), 19).unwrap();
        let mut deflate = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
        deflate.write_all(&zeros).unwrap();
        let deflate = deflate.finish().unwrap();
        for (encoding, body) in [("gzip", gzip), ("zstd", zstd), ("deflate", deflate)] {
            assert!(body.len() < 64 * 1024, "{encoding}");
            assert_eq!(
                decompress(encoding, body.clone(), zeros.len()).unwrap(),
                zeros,
                "{encoding}"
            );
            let error = decompress(encoding, body, zeros.len() - 1).unwrap_err();
            assert_eq!(error.observation()["error"], "DecodingError", "{encoding}");
        }
    }
}
