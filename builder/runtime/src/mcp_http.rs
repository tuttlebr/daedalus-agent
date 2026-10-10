//! Bounded HTTP adapter for rmcp. Its stock client buffers JSON/error bodies
//! without a limit and discards extension result fields during deserialization.
//! Keep the accepted raw result for the baseline's lossless result envelope.
use futures::{StreamExt, stream::BoxStream};
use http::{HeaderName, HeaderValue};
use rmcp::{
    model::{ClientJsonRpcMessage, ServerJsonRpcMessage},
    transport::streamable_http_client::{
        StreamableHttpClient, StreamableHttpError, StreamableHttpPostResponse,
    },
};
use serde_json::Value;
use sse_stream::{Error as SseError, Sse, SseStream};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
type Error = StreamableHttpError<reqwest::Error>;
#[derive(Default)]
struct Capture {
    id: Value,
    result: Option<Value>,
}
#[derive(Clone)]
pub struct BoundedHttp {
    http: reqwest::Client,
    max_bytes: usize,
    capture: Arc<Mutex<Capture>>,
}
impl BoundedHttp {
    pub fn new(http: reqwest::Client, max_bytes: usize) -> Self {
        Self {
            http,
            max_bytes,
            capture: Arc::default(),
        }
    }
    pub fn take_result(&self) -> Option<Value> {
        self.capture.lock().unwrap().result.take()
    }
    fn observe(&self, message: &Value) {
        let mut capture = self.capture.lock().unwrap();
        if !capture.id.is_null()
            && message.get("id") == Some(&capture.id)
            && let Some(result) = message.get("result")
        {
            capture.result = Some(result.clone());
        }
    }
    fn observe_stream(
        &self,
        stream: BoxStream<'static, Result<Sse, SseError>>,
    ) -> BoxStream<'static, Result<Sse, SseError>> {
        let owner = self.clone();
        stream
            .inspect(move |event| {
                if let Ok(event) = event
                    && let Some(text) = &event.data
                    && let Ok(value) = serde_json::from_str(text)
                {
                    owner.observe(&value);
                }
            })
            .boxed()
    }
}
#[derive(Default)]
struct EventLimit {
    line: usize,
    event: usize,
    cr: bool,
    failed: bool,
}
impl EventLimit {
    fn accept(&mut self, bytes: &[u8], max: usize) -> bool {
        if self.failed {
            return false;
        }
        for &byte in bytes {
            if self.cr {
                self.cr = false;
                if byte == b'\n' {
                    continue;
                }
            }
            if byte == b'\r' || byte == b'\n' {
                self.event = if self.line == 0 {
                    0
                } else {
                    self.event.saturating_add(self.line + 1)
                };
                self.line = 0;
                self.cr = byte == b'\r';
            } else {
                self.line = self.line.saturating_add(1);
            }
            if self.event.saturating_add(self.line) > max {
                self.failed = true;
                return false;
            }
        }
        true
    }
}
impl StreamableHttpClient for BoundedHttp {
    type Error = reqwest::Error;
    async fn get_stream(
        &self,
        uri: Arc<str>,
        session: Option<Arc<str>>,
        last: Option<String>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<BoxStream<'static, Result<Sse, SseError>>, Error> {
        self.get_stream_with_max_sse_event_size(uri, session, last, auth, headers, self.max_bytes)
            .await
    }
    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session: Option<Arc<str>>,
        last: Option<String>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
        max: usize,
    ) -> Result<BoxStream<'static, Result<Sse, SseError>>, Error> {
        let stream = self
            .http
            .get_stream_with_max_sse_event_size(
                uri,
                session,
                last,
                auth,
                headers,
                max.min(self.max_bytes),
            )
            .await?;
        Ok(self.observe_stream(stream))
    }
    async fn delete_session(
        &self,
        uri: Arc<str>,
        session: Arc<str>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), Error> {
        self.http.delete_session(uri, session, auth, headers).await
    }
    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, Error> {
        self.post_message_with_max_sse_event_size(
            uri,
            message,
            session,
            auth,
            headers,
            self.max_bytes,
        )
        .await
    }
    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
        max: usize,
    ) -> Result<StreamableHttpPostResponse, Error> {
        let raw = serde_json::to_value(&message)?;
        if raw["method"] == "tools/call" {
            *self.capture.lock().unwrap() = Capture {
                id: raw["id"].clone(),
                result: None,
            };
        }
        let mut request = self
            .http
            .post(uri.as_ref())
            .header("accept", "application/json, text/event-stream");
        for (name, value) in headers {
            request = request.header(name, value);
        }
        if let Some(auth) = auth {
            request = request.bearer_auth(auth);
        }
        if let Some(session) = &session {
            request = request.header("mcp-session-id", session.as_ref());
        }
        let response = request.json(&message).send().await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND && session.is_some() {
            return Err(Error::SessionExpired);
        }
        if response.status() == reqwest::StatusCode::ACCEPTED
            || response.status() == reqwest::StatusCode::NO_CONTENT
        {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        // A non-success response is never an invitation to resend the POST.
        // Do not collect or format an untrusted HTTP error body.
        let response = response.error_for_status()?;
        if !(200..300).contains(&response.status().as_u16()) {
            return Err(Error::UnexpectedServerResponse(
                "MCP redirect rejected".into(),
            ));
        }
        let session = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let kind = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let notification = raw.get("method").is_some() && raw.get("id").is_none();
        if notification && response.content_length() == Some(0) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        let max = max.min(self.max_bytes);
        if kind.starts_with("text/event-stream") {
            let mut limit = EventLimit::default();
            let stream = response.bytes_stream().map(move |chunk| {
                let chunk = chunk.map_err(|_| std::io::Error::other("MCP stream interrupted"))?;
                if !limit.accept(&chunk, max) {
                    return Err(std::io::Error::other("MCP response exceeds size limit"));
                }
                Ok(chunk)
            });
            return Ok(StreamableHttpPostResponse::Sse(
                self.observe_stream(SseStream::from_bytes_stream(stream).boxed()),
                session,
            ));
        }
        if !kind.starts_with("application/json") {
            return Err(Error::UnexpectedContentType(None));
        }
        if response.content_length().is_some_and(|n| n > max as u64) {
            return Err(Error::UnexpectedServerResponse(
                "MCP response exceeds size limit".into(),
            ));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if bytes.len() + chunk.len() > max {
                return Err(Error::UnexpectedServerResponse(
                    "MCP response exceeds size limit".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let raw: Value = match serde_json::from_slice(&bytes) {
            Ok(raw) => raw,
            Err(_) if notification => return Ok(StreamableHttpPostResponse::Accepted),
            Err(_) => {
                return Err(Error::UnexpectedServerResponse(
                    "Invalid MCP response".into(),
                ));
            }
        };
        self.observe(&raw);
        let parsed: ServerJsonRpcMessage = serde_json::from_value(raw)
            .map_err(|_| Error::UnexpectedServerResponse("Invalid MCP response".into()))?;
        Ok(StreamableHttpPostResponse::Json(parsed, session))
    }
}

/// Pydantic MCP model field order and exclude_none=True, including extension
/// fields. Arbitrary JSON metadata/structured content retains its own nulls.
pub fn result_envelope(mut value: Value) -> Value {
    fn model(value: Value, fields: &[&str]) -> Value {
        let Some(mut source) = value.as_object().cloned() else {
            return value;
        };
        let mut output = serde_json::Map::new();
        for field in fields {
            if let Some(mut value) = source.remove(*field).filter(|v| !v.is_null()) {
                if *field == "uri"
                    && let Some(uri) = value.as_str()
                    && let Ok(url) = reqwest::Url::parse(uri)
                {
                    value = Value::String(url.into());
                }
                output.insert(
                    if *field == "_meta" { "meta" } else { field }.to_string(),
                    value,
                );
            }
        }
        output.extend(source.into_iter().filter(|(_, v)| !v.is_null()));
        Value::Object(output)
    }
    if let Some(content) = value["content"].as_array_mut() {
        for item in content {
            if let Some(a) = item.get_mut("annotations") {
                *a = model(a.take(), &["audience", "priority"]);
            }
            if let Some(resource) = item.get_mut("resource") {
                *resource = model(
                    resource.take(),
                    &["uri", "mimeType", "_meta", "text", "blob"],
                );
            }
            let fields: &[&str] = match item["type"].as_str() {
                Some("text") => &["type", "text", "annotations", "_meta"],
                Some("image" | "audio") => &["type", "data", "mimeType", "annotations", "_meta"],
                Some("resource") => &["type", "resource", "annotations", "_meta"],
                Some("resource_link") => &[
                    "name",
                    "title",
                    "uri",
                    "description",
                    "mimeType",
                    "size",
                    "icons",
                    "annotations",
                    "_meta",
                    "type",
                ],
                _ => &[],
            };
            *item = model(item.take(), fields);
        }
    }
    if value.get("isError").is_none() {
        value["isError"] = Value::Bool(false);
    }
    model(value, &["_meta", "content", "structuredContent", "isError"])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_size_limits_hold_across_every_chunk_boundary_and_line_ending() {
        for ending in ["\n", "\r", "\r\n"] {
            let frames = format!("data: 雪{ending}{ending}data: next{ending}{ending}");
            for split in 0..=frames.len() {
                let mut limit = EventLimit::default();
                assert!(limit.accept(&frames.as_bytes()[..split], 20));
                assert!(limit.accept(&frames.as_bytes()[split..], 20));
            }
            let oversized = format!("data: 123456{ending}data: 789012{ending}{ending}");
            for split in 0..=oversized.len() {
                let mut limit = EventLimit::default();
                let first = limit.accept(&oversized.as_bytes()[..split], 20);
                assert!(!(first && limit.accept(&oversized.as_bytes()[split..], 20)));
                assert!(
                    !limit.accept(b"\n\ndata: small\n\n", 20),
                    "An oversized event must permanently stop the stream"
                );
            }
        }
    }
}
