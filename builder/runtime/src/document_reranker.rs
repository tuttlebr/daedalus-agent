//! vLLM reranking with the retained retriever's failure fallback.
use crate::{
    config::{Config, truthy},
    document_search::Document,
    milvus_search::Field,
};
use serde_json::{Value, json};
use std::{collections::HashSet, io::Read, sync::Mutex, time::Duration};

pub struct Client {
    config: Config,
    settings: Value,
    idle: Mutex<Vec<reqwest::Client>>,
}

struct Lease<'a> {
    idle: &'a Mutex<Vec<reqwest::Client>>,
    client: Option<reqwest::Client>,
}
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        let mut idle = self.idle.lock().expect("reranker pool");
        if idle.len() < 10 {
            idle.push(self.client.take().unwrap());
        }
    }
}

impl Client {
    pub fn new(config: &Config, settings: &Value) -> Self {
        Self {
            config: config.clone(),
            settings: settings.clone(),
            idle: Mutex::new(Vec::new()),
        }
    }

    fn http(&self) -> Option<reqwest::Client> {
        if let Some(client) = self.idle.lock().expect("reranker pool").pop() {
            return Some(client);
        }
        let mut builder = reqwest::Client::builder()
            .http1_only()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(30))
            .read_timeout(Duration::from_secs(30))
            .pool_idle_timeout(None)
            .pool_max_idle_per_host(1);
        if let Some(path) = ["REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"]
            .into_iter()
            .map(|name| self.config.variable(name, ""))
            .find(|value| !value.is_empty())
        {
            let certificates = std::fs::read(path)
                .ok()
                .and_then(|pem| reqwest::Certificate::from_pem_bundle(&pem).ok());
            if let Some(certificates) = certificates {
                builder = builder.tls_certs_only(certificates);
            } else if self.settings["reranker_endpoint"]
                .as_str()?
                .to_ascii_lowercase()
                .starts_with("https://")
            {
                return None;
            }
        }
        builder.build().ok()
    }

    async fn response(&self, mut headers: http::HeaderMap, body: String) -> Option<String> {
        let lease = Lease {
            idle: &self.idle,
            client: Some(self.http()?),
        };
        let client = lease.client.as_ref().unwrap();
        let mut url = reqwest::Url::parse(self.settings["reranker_endpoint"].as_str()?).ok()?;
        let mut method = http::Method::POST;
        let mut body = Some(bytes::Bytes::from(body));
        for redirects in 0..=30 {
            if url.scheme() == "https"
                && let Some(path) = ["REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"]
                    .into_iter()
                    .map(|name| self.config.variable(name, ""))
                    .find(|value| !value.is_empty())
            {
                // A plain initial URL must not suppress a CA error on a later
                // HTTPS redirect. requests checks the bundle for every request.
                reqwest::Certificate::from_pem_bundle(&std::fs::read(path).ok()?).ok()?;
            }
            let mut request = client
                .request(method.clone(), url.clone())
                .headers(headers.clone());
            if let Some(body) = &body {
                request = request.body(body.clone());
            }
            let response = request.send().await.ok()?;
            let status = response.status();
            let location = response
                .headers()
                .get("location")
                .map(|value| std::str::from_utf8(value.as_bytes()).map(str::to_owned))
                .transpose()
                .ok()?;
            let encoding = response
                .headers()
                .get("content-encoding")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            // Consume each redirect body before following it. Dropping an
            // unread reqwest response can discard an otherwise reusable socket.
            let received = response.bytes().await.ok()?;
            if matches!(status.as_u16(), 301..=303 | 307 | 308)
                && let Some(location) = location.filter(|value| !value.is_empty())
            {
                if redirects == 30 {
                    return None;
                }
                let target = url.join(&location).ok()?;
                let upgrade = url.scheme() == "http"
                    && url.port_or_known_default() == Some(80)
                    && target.scheme() == "https"
                    && target.port_or_known_default() == Some(443);
                if url.host_str() != target.host_str()
                    || (!upgrade
                        && (url.scheme() != target.scheme()
                            || url.port_or_known_default() != target.port_or_known_default()))
                {
                    headers.remove(http::header::AUTHORIZATION);
                }
                if matches!(status.as_u16(), 301..=303) {
                    method = http::Method::GET;
                    body = None;
                    headers.remove(http::header::CONTENT_TYPE);
                    headers.remove(http::header::CONTENT_LENGTH);
                    headers.remove(http::header::TRANSFER_ENCODING);
                }
                url = target;
                continue;
            }
            let decoded = decompress(&encoding, received.to_vec())?;
            if status.is_client_error() || status.is_server_error() {
                return None;
            }
            return response_text(&decoded, content_type.as_deref());
        }
        None
    }

    async fn rankings(&self, query: &str, documents: &[Document]) -> Option<Vec<(usize, f64)>> {
        let top = if truthy(&self.settings["reranker_top_n"]) {
            self.settings["reranker_top_n"].clone()
        } else {
            json!(documents.len())
        };
        if top.to_string().starts_with('-') {
            return None;
        }
        let payload = json!({"model": self.settings["reranker_model"], "query": query,
            "documents": documents.iter().map(|doc| &doc.content).collect::<Vec<_>>(), "top_n": top});
        let key = self.settings["reranker_api_key"]
            .as_str()
            .filter(|key| !key.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| self.config.variable("NVIDIA_API_KEY", ""));
        let mut headers = http::HeaderMap::new();
        headers.insert("accept", http::HeaderValue::from_static("application/json"));
        headers.insert(
            "content-type",
            http::HeaderValue::from_static("application/json"),
        );
        headers.insert(
            "accept-encoding",
            http::HeaderValue::from_static("gzip, deflate"),
        );
        if !key.is_empty() {
            // requests/http.client serializes header values as Latin-1.
            let bytes = format!("Bearer {key}")
                .chars()
                .map(|c| u8::try_from(c as u32))
                .collect::<Result<Vec<_>, _>>()
                .ok()?;
            headers.insert("authorization", http::HeaderValue::from_bytes(&bytes).ok()?);
        }
        let decoded = self
            .response(
                headers,
                crate::memory_tools::json_text(&payload, false, true, true),
            )
            .await?;
        let mut rankings = parse(decoded.as_bytes(), documents.len())?;
        crate::reranker_order::sort(&mut rankings);
        rankings.truncate(
            top.as_u64()
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(usize::MAX),
        );
        Some(rankings)
    }

    pub async fn apply(&self, query: &str, documents: Vec<Document>) -> Vec<Document> {
        if !truthy(&self.settings["use_reranker"])
            || !truthy(&self.settings["reranker_endpoint"])
            || documents.is_empty()
        {
            return documents;
        }
        let Some(rankings) = self.rankings(query, &documents).await else {
            return documents;
        };
        let mut documents = documents.into_iter().map(Some).collect::<Vec<_>>();
        let minimum = self.settings["reranker_min_score"].as_f64().or_else(|| {
            self.settings["reranker_min_score"]
                .as_str()?
                .parse::<f64>()
                .ok()
        });
        rankings
            .into_iter()
            .enumerate()
            .filter(|(_, (_, score))| {
                minimum.is_none_or(|minimum| {
                    score.partial_cmp(&minimum) != Some(std::cmp::Ordering::Less)
                })
            })
            .map(|(position, (index, score))| {
                let mut document = documents[index].take().expect("validated unique ranking");
                for (name, value) in [
                    ("rerank_score", Field::Float(score)),
                    ("rerank_position", Field::Json(json!(position + 1))),
                ] {
                    if let Some((_, stored)) =
                        document.metadata.iter_mut().find(|(key, _)| key == name)
                    {
                        *stored = value;
                    } else {
                        document.metadata.push((name.into(), value));
                    }
                }
                document
            })
            .collect()
    }
}

fn decompress(encoding: &str, mut body: Vec<u8>) -> Option<Vec<u8>> {
    fn read(mut decoder: impl Read) -> std::io::Result<Vec<u8>> {
        let mut output = Vec::new();
        decoder.read_to_end(&mut output)?;
        Ok(output)
    }
    fn gzip(mut input: &[u8]) -> std::io::Result<Vec<u8>> {
        let mut output = Vec::new();
        let mut completed = false;
        while !input.is_empty() {
            let mut decoder = flate2::bufread::GzDecoder::new(input);
            let mut member = Vec::new();
            match decoder.read_to_end(&mut member) {
                Ok(_) => {
                    output.extend(member);
                    completed = true;
                }
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                    output.extend(member);
                    break;
                }
                Err(_) if completed => break,
                Err(error) => return Err(error),
            }
            input = decoder.into_inner();
        }
        Ok(output)
    }
    for encoding in encoding.split(',').rev().map(str::trim) {
        body = match encoding.to_ascii_lowercase().as_str() {
            "gzip" => gzip(body.as_slice()),
            "deflate" => read(flate2::read::ZlibDecoder::new(body.as_slice()))
                .or_else(|_| read(flate2::read::DeflateDecoder::new(body.as_slice()))),
            _ => Ok(body),
        }
        .ok()?;
    }
    Some(body)
}

fn response_text(body: &[u8], content_type: Option<&str>) -> Option<String> {
    fn replace(raw: &[u8], name: &str) -> Option<String> {
        let Some(name) = crate::document_codecs::canonical(name) else {
            return Some(String::from_utf8_lossy(raw).into_owned());
        };
        if let Ok(text) = crate::document_codecs::decode(name, raw, false) {
            return Some(text);
        }
        if matches!(name, "utf_8" | "utf_8_sig") {
            let raw = if name == "utf_8_sig" {
                raw.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(raw)
            } else {
                raw
            };
            return Some(String::from_utf8_lossy(raw).into_owned());
        }
        if name == "ascii" {
            return Some(
                raw.iter()
                    .map(|&b| if b < 128 { char::from(b) } else { '\u{fffd}' })
                    .collect(),
            );
        }
        if name.starts_with("utf_16") || name.starts_with("utf_32") {
            let mut raw = raw;
            let mut little = !name.ends_with("_be");
            if name == "utf_16" {
                if raw.starts_with(&[0xff, 0xfe]) {
                    raw = &raw[2..];
                } else if raw.starts_with(&[0xfe, 0xff]) {
                    raw = &raw[2..];
                    little = false;
                }
            } else if name == "utf_32" {
                if raw.starts_with(&[0xff, 0xfe, 0, 0]) {
                    raw = &raw[4..];
                } else if raw.starts_with(&[0, 0, 0xfe, 0xff]) {
                    raw = &raw[4..];
                    little = false;
                }
            }
            let width = if name.starts_with("utf_16") { 2 } else { 4 };
            let word = |raw: &[u8]| {
                if width == 2 {
                    u32::from(if little {
                        u16::from_le_bytes([raw[0], raw[1]])
                    } else {
                        u16::from_be_bytes([raw[0], raw[1]])
                    })
                } else if little {
                    u32::from_le_bytes(raw[..4].try_into().unwrap())
                } else {
                    u32::from_be_bytes(raw[..4].try_into().unwrap())
                }
            };
            let mut text = String::new();
            while !raw.is_empty() {
                if raw.len() < width {
                    text.push('\u{fffd}');
                    break;
                }
                let value = word(raw);
                raw = &raw[width..];
                if width == 2 && (0xd800..=0xdbff).contains(&value) {
                    if raw.len() < 2 {
                        text.push('\u{fffd}');
                        break;
                    }
                    let tail = word(raw);
                    if (0xdc00..=0xdfff).contains(&tail) {
                        text.push(
                            char::from_u32(0x10000 + ((value - 0xd800) << 10) + tail - 0xdc00)
                                .unwrap(),
                        );
                        raw = &raw[2..];
                        continue;
                    }
                }
                text.push(char::from_u32(value).unwrap_or('\u{fffd}'));
            }
            return Some(text);
        }
        None
    }
    let mut charset = None;
    if let Some(content_type) = content_type {
        let mut fields = content_type.split(';');
        let media = fields.next().unwrap_or_default().trim();
        for field in fields {
            if let Some((key, value)) = field.split_once('=')
                && key.trim().eq_ignore_ascii_case("charset")
            {
                charset = Some(value.trim().trim_matches(['\'', '"']).to_owned());
            }
        }
        if charset.is_none() {
            charset = if media.contains("text") {
                Some("latin_1".into())
            } else if media.contains("application/json") {
                Some("utf_8".into())
            } else {
                None
            };
        }
    }
    if let Some(charset) = charset.filter(|value| !value.is_empty()) {
        return replace(body, &charset);
    }
    if body.len() > 3 {
        let sample = &body[..4];
        let encoding = if sample == [0, 0, 0xfe, 0xff] || sample == [0xff, 0xfe, 0, 0] {
            Some("utf_32")
        } else if body.starts_with(&[0xef, 0xbb, 0xbf]) {
            Some("utf_8_sig")
        } else if body.starts_with(&[0xff, 0xfe]) || body.starts_with(&[0xfe, 0xff]) {
            Some("utf_16")
        } else {
            match sample.iter().filter(|&&byte| byte == 0).count() {
                0 => Some("utf_8"),
                2 if sample[0] == 0 && sample[2] == 0 => Some("utf_16_be"),
                2 if sample[1] == 0 && sample[3] == 0 => Some("utf_16_le"),
                3 if sample[..3] == [0, 0, 0] => Some("utf_32_be"),
                3 if sample[1..] == [0, 0, 0] => Some("utf_32_le"),
                _ => None,
            }
        };
        if let Some(encoding) = encoding
            && let Ok(text) = crate::document_codecs::decode(encoding, body, false)
        {
            return Some(text);
        }
    }
    let detected = crate::document_encoding::detect(body).ok().flatten();
    replace(body, detected.as_deref().unwrap_or("utf_8"))
}

// requests uses Python's JSON decoder, which accepts nonfinite number tokens.
// Choose markers after inspecting decoded strings so a server-supplied string
// can never become a numeric score. Markers stay inside this parsing boundary.
// Every decoding failure, including an integer above Python's 4300-digit
// conversion limit, falls back to the vector order.
fn python_json(body: &[u8]) -> Option<(Value, String)> {
    fn rewrite(text: &str, marker: &str) -> Option<String> {
        let bytes = text.as_bytes();
        let mut output = String::with_capacity(text.len());
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
                b'[' | b']' | b'{' | b'}' | b',' | b':' | b' ' | b'\t' | b'\n' | b'\r'
            ) {
                at += 1;
            } else {
                while at < bytes.len()
                    && !matches!(
                        bytes[at],
                        b'[' | b']' | b'{' | b'}' | b',' | b':' | b' ' | b'\t' | b'\n' | b'\r'
                    )
                {
                    at += 1;
                }
                let token = text.get(start..at)?;
                if matches!(token, "NaN" | "Infinity" | "-Infinity") {
                    output.push_str(&if marker.is_empty() {
                        "null".into()
                    } else {
                        json!(format!("{marker}{token}")).to_string()
                    });
                    continue;
                }
            }
            output.push_str(text.get(start..at)?);
        }
        Some(output)
    }
    let decode = |raw: &[u8]| {
        crate::document_json::decode_with(raw, |bytes| {
            crate::document_json::parse_indexed_with(bytes, 1024, |value| {
                if let Value::Number(number) = &value {
                    let token = number.to_string();
                    let digits = token.trim_start_matches('-');
                    if digits.len() > 4300 && digits.bytes().all(|b| b.is_ascii_digit()) {
                        return None;
                    }
                }
                Some(value)
            })
        })
    };
    let text = String::from_utf8_lossy(body);
    let ordinary = rewrite(&text, "")?;
    let (ordinary, _) = decode(ordinary.as_bytes())?;
    let mut strings = Vec::new();
    let mut pending = vec![&ordinary];
    while let Some(value) = pending.pop() {
        match value {
            Value::String(value) => strings.push(value.as_str()),
            Value::Array(values) => pending.extend(values),
            Value::Object(values) => {
                strings.extend(values.keys().map(String::as_str));
                pending.extend(values.values());
            }
            _ => {}
        }
    }
    let mut marker = "daedalus-nonfinite-".to_owned();
    while strings.iter().any(|value| value.starts_with(&marker)) {
        marker.push('-');
    }
    let rewritten = rewrite(&text, &marker)?;
    let (value, _) = decode(rewritten.as_bytes())?;
    Some((value, marker))
}

fn parse(body: &[u8], count: usize) -> Option<Vec<(usize, f64)>> {
    let (value, marker) = python_json(body)?;
    let mut seen = HashSet::new();
    value
        .get("results")?
        .as_array()?
        .iter()
        .map(|item| {
            let index = item.get("index")?.as_number()?.to_string();
            if index.contains(['.', 'e', 'E']) {
                return None;
            }
            let index = usize::try_from(index.parse::<i128>().ok()?).ok()?;
            if index >= count || !seen.insert(index) {
                return None;
            }
            let score = item.get("relevance_score")?;
            if let Some(token) = score.as_str().and_then(|value| value.strip_prefix(&marker)) {
                return Some((
                    index,
                    match token {
                        "NaN" => f64::NAN,
                        "Infinity" => f64::INFINITY,
                        "-Infinity" => f64::NEG_INFINITY,
                        _ => return None,
                    },
                ));
            }
            let score = score.as_number()?.to_string();
            let float: f64 = score.parse().ok()?;
            // Python float(bigint) raises, while JSON exponent overflow yields inf.
            if !score.contains(['.', 'e', 'E']) && !float.is_finite() {
                return None;
            }
            Some((index, float))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, extract::State, routing::post};
    use std::sync::Arc;
    use tokio::sync::Mutex as AsyncMutex;

    type Replies = Arc<AsyncMutex<(Vec<(u16, &'static str)>, Vec<(Option<String>, Value)>)>>;

    fn document(content: &str) -> Document {
        Document {
            content: Some(content.into()),
            metadata: vec![("distance".into(), Field::Float(0.5))],
        }
    }
    fn observed(documents: &[Document]) -> Vec<Value> {
        documents
            .iter()
            .map(|document| {
                let field = |name: &str| {
                    document
                        .metadata
                        .iter()
                        .find(|(key, _)| key == name)
                        .map(|(_, value)| match value {
                            Field::Float(score) if score.is_nan() => json!("nan"),
                            Field::Float(score) if score.is_infinite() => json!(score.to_string()),
                            Field::Float(score) => json!(score),
                            Field::Json(value) => value.clone(),
                            _ => unreachable!(),
                        })
                        .unwrap_or(Value::Null)
                };
                json!([
                    document.content,
                    field("rerank_score"),
                    field("rerank_position")
                ])
            })
            .collect()
    }

    /// Expected orders, positions and fallbacks were produced by the retained
    /// Python contract: nat_helpers.vllm_reranker.parse_vllm_rerank_response
    /// followed by MilvusRetriever._rerank's top_n slice and min_score filter.
    #[tokio::test]
    async fn retained_vllm_rerank_order_filters_and_fallbacks() {
        let replies: Replies = Arc::default();
        let server = Router::new()
            .route(
                "/rerank",
                post(
                    |State(replies): State<Replies>, headers: http::HeaderMap, body: String| async move {
                        let mut state = replies.lock().await;
                        state.1.push((
                            headers
                                .get("authorization")
                                .map(|value| value.to_str().unwrap().to_owned()),
                            serde_json::from_str(&body).unwrap(),
                        ));
                        let (status, body) = state.0.remove(0);
                        (
                            http::StatusCode::from_u16(status).unwrap(),
                            [("content-type", "application/json")],
                            body,
                        )
                    },
                ),
            )
            .with_state(replies.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/rerank", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let config = Config {
            raw: json!({}),
            policy_raw: json!({}),
            python_tools: false,
            env: [("NVIDIA_API_KEY".into(), "synthetic-rerank-key".into())].into(),
        };
        let documents = || {
            ["alpha", "beta", "gamma", "delta", "epsilon"]
                .into_iter()
                .map(document)
                .collect::<Vec<_>>()
        };
        let original = observed(&documents());
        let limited = Client::new(
            &config,
            &json!({"use_reranker":true,"reranker_endpoint":endpoint,"reranker_model":"synthetic-reranker",
                "reranker_top_n":3,"reranker_min_score":0.2}),
        );
        let unlimited = Client::new(
            &config,
            &json!({"use_reranker":true,"reranker_endpoint":endpoint,"reranker_model":"synthetic-reranker"}),
        );
        let nan = r#"{"results":[{"index":0,"relevance_score":0.1},{"index":1,"relevance_score":0.9},{"index":2,"relevance_score":NaN},{"index":3,"relevance_score":0.5},{"index":4,"relevance_score":0.5}]}"#;
        let ties = r#"{"results":[{"index":0,"relevance_score":0.3},{"index":4,"relevance_score":0.7},{"index":1,"relevance_score":0.3}]}"#;
        let infinite = r#"{"results":[{"index":2,"relevance_score":-Infinity},{"index":1,"relevance_score":Infinity}]}"#;
        let cases: Vec<(&Client, (u16, &'static str), Value)> = vec![
            (
                &limited,
                (200, nan),
                json!([["beta", 0.9, 1], ["gamma", "nan", 3]]),
            ),
            (
                &unlimited,
                (200, nan),
                json!([
                    ["beta", 0.9, 1],
                    ["alpha", 0.1, 2],
                    ["gamma", "nan", 3],
                    ["delta", 0.5, 4],
                    ["epsilon", 0.5, 5]
                ]),
            ),
            (
                &limited,
                (200, ties),
                json!([["epsilon", 0.7, 1], ["alpha", 0.3, 2], ["beta", 0.3, 3]]),
            ),
            (&limited, (200, infinite), json!([["beta", "inf", 1]])),
            (
                &unlimited,
                (200, infinite),
                json!([["beta", "inf", 1], ["gamma", "-inf", 2]]),
            ),
        ];
        for (index, (client, reply, expected)) in cases.into_iter().enumerate() {
            replies.lock().await.0.push(reply);
            let actual = client.apply("synthetic query", documents()).await;
            assert_eq!(json!(observed(&actual)), expected, "rerank case {index}");
        }
        // Invalid rankings and failed requests retain the vector order unchanged.
        for reply in [
            (
                200,
                r#"{"results":[{"index":0,"relevance_score":0.3},{"index":0,"relevance_score":0.7}]}"#,
            ),
            (200, r#"{"results":[{"index":5,"relevance_score":0.3}]}"#),
            (200, r#"{"results":[{"index":true,"relevance_score":0.3}]}"#),
            (200, r#"{"results":[{"index":1,"relevance_score":true}]}"#),
            (200, r#"{"results":[{"index":1.0,"relevance_score":0.2}]}"#),
            (200, r#"{"results":{}}"#),
            (500, r#"{"results":[{"index":1,"relevance_score":0.9}]}"#),
        ] {
            replies.lock().await.0.push(reply);
            let actual = limited.apply("synthetic query", documents()).await;
            assert_eq!(observed(&actual), original, "fallback {}", reply.1);
        }
        let state = replies.lock().await;
        assert!(state.0.is_empty());
        assert_eq!(state.1.len(), 12);
        assert!(state.1.iter().all(|(authorization, _)| {
            authorization.as_deref() == Some("Bearer synthetic-rerank-key")
        }));
        assert_eq!(
            state.1[0].1,
            json!({"model":"synthetic-reranker","query":"synthetic query",
                "documents":["alpha","beta","gamma","delta","epsilon"],"top_n":3})
        );
        assert_eq!(state.1[1].1["top_n"], json!(5));
        drop(state);
        task.abort();
    }
}
