//! Accept Responses gateways that omit non-content stream bookkeeping.
//!
//! Keep Rig's decoder and terminal/argument validation. Only absent sequence
//! numbers, timestamps, and message IDs already observed in this reply are
//! restored; never invent content, tool call IDs, output indices, or success.

use std::cell::RefCell;
use std::collections::HashMap;

use rig_core::completion::CompletionRequest;
use rig_core::error::{EncodeError, ProviderError};
use rig_core::operation::Completion;
use rig_core::providers::openai::wire::OpenAiWire;
use rig_core::wire::{Decoder, Descriptor, Encoded, Flow, Mode, Out, Wire, WireEvent, WireFrame};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Direct isolated transport never follows a provider redirect or delegates
/// context to an ambient HTTP proxy. Retries are owned by the runtime and keep
/// this same client and registered endpoint.
pub fn isolated_client(
    config: rig_core::providers::openai::OpenAIConfig,
) -> anyhow::Result<rig_core::providers::openai::OpenAI> {
    Ok(config.connect(rig_reqwest::ReqwestClient::from(isolated_http_client()?)))
}

pub fn isolated_http_client() -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .build()
        .map_err(|_| anyhow::anyhow!("Isolated provider transport unavailable"))
}

/// Provider/session identity for one isolated context. The authenticated user,
/// run, task and versioned context policy all participate; raw identities never
/// leave the runtime. A changed policy or task cannot resume an old session.
pub fn isolated_affinity_key(user: &str, run: &str, task: &str, policy: &str) -> String {
    let mut hash = Sha256::new();
    for part in ["daedalus-isolated-v1", user, run, task, policy] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

/// Opaque OpenAI-compatible `user` value for provider prompt-cache affinity.
/// Conversation IDs are scoped by authenticated user. Requests without a
/// conversation use their run ID, so unrelated runs never share a fixed key.
pub fn cache_affinity_key(user: &str, conversation: &str, run_id: &str) -> String {
    let mut hash = Sha256::new();
    for part in [
        "daedalus-cache-v1",
        user,
        if conversation.is_empty() {
            "run"
        } else {
            "conversation"
        },
        if conversation.is_empty() {
            run_id
        } else {
            conversation
        },
    ] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

/// Switchyard relays upstream transport failures as an SSE error inside HTTP
/// 200, without a status or retry hint. Recognize only its transport envelope;
/// translation failures and other provider errors must keep their own policy.
pub fn is_gateway_transport_error(error: &ProviderError) -> bool {
    if error
        .provider_response_status()
        .is_some_and(|status| !status.is_success())
    {
        return false;
    }
    let Ok(Some(body)) = error.provider_response_json() else {
        return false;
    };
    body["error"]["type"].as_str() == Some("SwitchyardError")
        && body["error"]["message"]
            .as_str()
            .is_some_and(|message| message.starts_with("upstream transport error: "))
}

pub fn retryable(error: &ProviderError) -> bool {
    error.is_retryable() || is_gateway_transport_error(error)
}

/// A rejected model response is safe to regenerate before any of its tools
/// execute. Keep this separate from transport retries: one decode recovery is
/// allowed for the entire run, within the configured model retry budget.
pub fn stream_decode_error(error: &ProviderError) -> bool {
    matches!(error, ProviderError::Json(_))
}

#[derive(Clone)]
pub struct CompatibleOpenAi {
    wire: OpenAiWire,
    session: Option<http::HeaderValue>,
    isolated: Option<IsolatedBinding>,
}

#[derive(Clone)]
struct IsolatedBinding {
    endpoint: String,
    model: String,
    affinity: String,
}

impl CompatibleOpenAi {
    /// Routing affinity is scoped like provider cache affinity, but sent as a
    /// gateway header. Keep it on this run's wire rather than a shared client.
    pub fn for_session(wire: OpenAiWire, user: &str, conversation: &str, run_id: &str) -> Self {
        let key = cache_affinity_key(user, conversation, run_id);
        Self {
            wire,
            session: Some(key.parse().expect("SHA-256 hex is a valid header")),
            isolated: None,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn for_isolated_session(
        wire: OpenAiWire,
        user: &str,
        run: &str,
        task: &str,
        policy: &str,
        endpoint: &str,
        model: &str,
    ) -> Self {
        Self {
            wire,
            session: None,
            isolated: Some(IsolatedBinding {
                endpoint: endpoint.trim_end_matches('/').to_owned(),
                model: model.to_owned(),
                affinity: isolated_affinity_key(user, run, task, policy),
            }),
        }
    }
}

impl Wire for CompatibleOpenAi {
    type Op = Completion;
    type Payload = Encoded;
    type Frame = WireFrame;
    type Decoder<'id> = CompatibleDecoder<'id>;

    fn describe(&self) -> Descriptor<'_> {
        self.wire.describe()
    }

    fn encode(&self, mut request: CompletionRequest, mode: Mode) -> Result<Encoded, EncodeError> {
        if let Some(binding) = &self.isolated {
            if request
                .model
                .as_ref()
                .is_some_and(|model| model != &binding.model)
            {
                return Err(EncodeError::request("Isolated provider model mismatch"));
            }
            request.model = Some(binding.model.clone());
            request.record_telemetry_content = false;
            let params = request.additional_params.get_or_insert_with(|| json!({}));
            let Some(params) = params.as_object_mut() else {
                return Err(EncodeError::request("Invalid isolated provider parameters"));
            };
            // An allowlist keeps remote continuation IDs, conversation state,
            // arbitrary provider metadata and caller cache keys out by default.
            if params.keys().any(|key| {
                ![
                    "store",
                    "parallel_tool_calls",
                    "truncation",
                    "user",
                    "reasoning",
                    "reasoning_effort",
                    "reasoning_history",
                    "chat_template_kwargs",
                    "thinking_token_budget",
                ]
                .contains(&key.as_str())
            }) {
                return Err(EncodeError::request(
                    "Forbidden isolated provider parameter",
                ));
            }
            if let Some(budget) = params.get("thinking_token_budget") {
                if !matches!(self.wire, OpenAiWire::Chat(_)) {
                    return Err(EncodeError::request(
                        "Isolated thinking token budget requires Chat route",
                    ));
                }
                if !crate::routing::valid_thinking_token_budget(budget) {
                    return Err(EncodeError::request(
                        "Invalid isolated thinking token budget",
                    ));
                }
            }
            if let Some(options) = params.get("chat_template_kwargs") {
                if !matches!(self.wire, OpenAiWire::Chat(_)) {
                    return Err(EncodeError::request(
                        "Isolated chat template options require Chat route",
                    ));
                }
                if !crate::routing::valid_chat_template_kwargs(options) {
                    return Err(EncodeError::request(
                        "Invalid isolated Chat template options",
                    ));
                }
            }
            params.insert("store".to_owned(), json!(false));
            params.insert("user".to_owned(), json!(binding.affinity));
        }
        let mut encoded = self.wire.encode(request, mode)?;
        if let Some(binding) = &self.isolated {
            let suffix = if matches!(self.wire, OpenAiWire::Responses(_)) {
                "responses"
            } else {
                "chat/completions"
            };
            if encoded.request.uri().to_string() != format!("{}/{suffix}", binding.endpoint) {
                return Err(EncodeError::request("Isolated provider endpoint mismatch"));
            }
        }
        if let Some(session) = &self.session {
            encoded
                .request
                .headers_mut()
                .insert("x-switchyard-session-id", session.clone());
        }
        Ok(encoded)
    }

    fn decoder<'id>(&self) -> Self::Decoder<'id> {
        CompatibleDecoder {
            inner: self.wire.decoder(),
            metadata: RefCell::new(EnvelopeMetadata::default()),
            responses: matches!(self.wire, OpenAiWire::Responses(_)),
        }
    }
}

pub struct CompatibleDecoder<'id> {
    inner: <OpenAiWire as Wire>::Decoder<'id>,
    metadata: RefCell<EnvelopeMetadata>,
    responses: bool,
}

impl<'id> Decoder<'id, Completion> for CompatibleDecoder<'id> {
    type Event = <<OpenAiWire as Wire>::Decoder<'id> as Decoder<'id, Completion>>::Event;

    fn classify(&self, frame: WireFrame) -> WireEvent<Self::Event> {
        let frame = if self.responses {
            self.metadata.borrow_mut().normalize(frame)
        } else {
            frame
        };
        let classified = self.inner.classify(frame);
        if let WireEvent::Corrupt(error) = &classified {
            let category = match error.classify() {
                serde_json::error::Category::Io => "io",
                serde_json::error::Category::Syntax => "syntax",
                serde_json::error::Category::Data => "schema",
                serde_json::error::Category::Eof => "eof",
            };
            // Parser messages can quote private values. Log only fixed labels
            // and numeric positions, never the frame or the error's Display.
            tracing::warn!(
                event = "model_frame_rejected",
                event_type = if self.responses {
                    self.metadata.borrow().event_type
                } else {
                    "chat_completion"
                },
                category,
                line = error.line(),
                column = error.column(),
            );
        }
        classified
    }

    fn decode(
        &mut self,
        event: Self::Event,
        out: Out<'id, Completion>,
    ) -> Result<Flow, ProviderError> {
        self.inner.decode(event, out)
    }

    fn eof(&mut self, out: Out<'id, Completion>) -> Result<Flow, ProviderError> {
        self.inner.eof(out)
    }
}

#[derive(Default)]
struct EnvelopeMetadata {
    sequence: u64,
    message_ids: HashMap<u64, String>,
    event_type: &'static str,
}

impl EnvelopeMetadata {
    fn message(&mut self, item: &mut Value, index: u64) {
        if item.get("type").and_then(Value::as_str) != Some("message") {
            return;
        }
        let Some(item) = item.as_object_mut() else {
            return;
        };
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            self.message_ids.insert(index, id.to_owned());
        } else if !item.contains_key("id")
            && let Some(id) = self.message_ids.get(&index)
        {
            item.insert("id".into(), json!(id));
        }
    }

    fn normalize(&mut self, frame: WireFrame) -> WireFrame {
        self.event_type = "invalid_json";
        let Ok(Value::Object(mut event)) = serde_json::from_str(&frame.as_str()) else {
            return frame;
        };
        // Select static strings; an upstream discriminator is untrusted text.
        self.event_type = match event.get("type").and_then(Value::as_str) {
            Some("response.created") => "response.created",
            Some("response.in_progress") => "response.in_progress",
            Some("response.completed") => "response.completed",
            Some("response.incomplete") => "response.incomplete",
            Some("response.failed") => "response.failed",
            Some("response.output_item.added") => "response.output_item.added",
            Some("response.output_item.done") => "response.output_item.done",
            Some("response.content_part.added") => "response.content_part.added",
            Some("response.content_part.done") => "response.content_part.done",
            Some("response.output_text.delta") => "response.output_text.delta",
            Some("response.output_text.done") => "response.output_text.done",
            Some("response.refusal.delta") => "response.refusal.delta",
            Some("response.refusal.done") => "response.refusal.done",
            Some("response.function_call_arguments.delta") => {
                "response.function_call_arguments.delta"
            }
            Some("response.function_call_arguments.done") => {
                "response.function_call_arguments.done"
            }
            Some("response.reasoning_summary_part.added") => {
                "response.reasoning_summary_part.added"
            }
            Some("response.reasoning_summary_part.done") => "response.reasoning_summary_part.done",
            Some("response.reasoning_summary_text.delta") => {
                "response.reasoning_summary_text.delta"
            }
            Some("response.reasoning_summary_text.done") => "response.reasoning_summary_text.done",
            Some("response.reasoning_text.delta") => "response.reasoning_text.delta",
            Some("response.reasoning_text.done") => "response.reasoning_text.done",
            _ => "other",
        };
        let Some(kind) = event.get("type").and_then(Value::as_str) else {
            return frame;
        };
        if !kind.starts_with("response.") {
            return frame;
        }
        let lifecycle = matches!(
            kind,
            "response.created"
                | "response.in_progress"
                | "response.completed"
                | "response.incomplete"
                | "response.failed"
        );
        let sequence = event
            .entry("sequence_number")
            .or_insert(json!(self.sequence));
        self.sequence = sequence.as_u64().unwrap_or(self.sequence).saturating_add(1);
        if let Some(index) = event.get("output_index").and_then(Value::as_u64)
            && let Some(item) = event.get_mut("item")
        {
            self.message(item, index);
        }
        if lifecycle && let Some(Value::Object(response)) = event.get_mut("response") {
            // Zero means unknown metadata; it is not used to decide completion.
            response.entry("created_at").or_insert(json!(0));
            if let Some(Value::Array(output)) = response.get_mut("output") {
                for (index, item) in output.iter_mut().enumerate() {
                    self.message(item, index as u64);
                }
            }
        }
        WireFrame::Text(Value::Object(event).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rig_core::providers::openai::{OpenAIConfig, Route};

    #[test]
    fn cache_affinity_is_stable_scoped_and_opaque() {
        let key = cache_affinity_key("alice", "conversation-1", "run-1");
        assert_eq!(key.len(), 64);
        assert!(key.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(key, cache_affinity_key("alice", "conversation-1", "run-2"));
        assert_ne!(key, cache_affinity_key("bob", "conversation-1", "run-1"));
        assert_ne!(key, cache_affinity_key("alice", "conversation-2", "run-1"));
        assert_ne!(
            cache_affinity_key("alice", "", "run-1"),
            cache_affinity_key("alice", "", "run-2"),
        );
        assert_ne!(
            cache_affinity_key("alice", "run-1", "run-1"),
            cache_affinity_key("alice", "", "run-1"),
        );
        assert_ne!(
            cache_affinity_key("ab", "c", "run"),
            cache_affinity_key("a", "bc", "run"),
        );
    }

    fn wire() -> CompatibleOpenAi {
        CompatibleOpenAi {
            wire: OpenAiWire::new(
                OpenAIConfig::new("fixture").with_route(Route::Responses),
                "fixture",
            ),
            session: None,
            isolated: None,
        }
    }

    #[test]
    fn routing_session_header_is_scoped_and_keeps_provider_auth() {
        for route in [Route::Responses, Route::Chat] {
            let mut previous = None;
            for (user, conversation, run) in [
                ("alice", "thread", "run-1"),
                ("alice", "thread", "run-2"),
                ("bob", "thread", "run-1"),
                ("alice", "other-thread", "run-1"),
                ("alice", "", "run-1"),
                ("alice", "", "run-2"),
            ] {
                let key = cache_affinity_key(user, conversation, run);
                let wire = CompatibleOpenAi::for_session(
                    OpenAiWire::new(OpenAIConfig::new("fixture").with_route(route), "fixture"),
                    user,
                    conversation,
                    run,
                );
                for mode in [Mode::Streaming, Mode::Unary] {
                    let encoded = wire
                        .encode(CompletionRequest::new("fixture"), mode)
                        .unwrap();
                    assert_eq!(encoded.request.headers()["x-switchyard-session-id"], key);
                    assert_eq!(encoded.request.headers()["authorization"], "Bearer fixture");
                }
                if run == "run-2" && !conversation.is_empty() {
                    assert_eq!(previous, Some(key.clone()));
                } else if let Some(prior) = &previous {
                    assert_ne!(prior, &key);
                }
                previous = Some(key);
            }
        }
    }

    #[test]
    fn isolated_sessions_never_reuse_user_run_task_or_policy_context() {
        let key = isolated_affinity_key("alice-private", "run-private", "task", "v1");
        assert_eq!(
            key,
            isolated_affinity_key("alice-private", "run-private", "task", "v1")
        );
        assert_eq!(key.len(), 64);
        assert!(!key.contains("private"));
        for (user, run, task, policy) in [
            ("bob", "run-private", "task", "v1"),
            ("alice-private", "other-run", "task", "v1"),
            ("alice-private", "run-private", "coordinator", "v1"),
            ("alice-private", "run-private", "task", "v2"),
        ] {
            assert_ne!(key, isolated_affinity_key(user, run, task, policy));
        }
    }

    fn isolated_wire(route: Route, endpoint: &str) -> CompatibleOpenAi {
        CompatibleOpenAi::for_isolated_session(
            OpenAiWire::new(
                OpenAIConfig::new("fixture")
                    .with_base_url("http://127.0.0.1:9000/v1")
                    .with_route(route),
                "registered-model",
            ),
            "alice-private",
            "run",
            "task",
            "v1",
            endpoint,
            "registered-model",
        )
    }

    #[test]
    fn isolated_wire_binds_destination_and_overrides_untrusted_session_affinity() {
        for route in [Route::Responses, Route::Chat] {
            let wire = isolated_wire(route, "http://127.0.0.1:9000/v1");
            let encoded = wire
                .encode(
                    CompletionRequest::new("public input").additional_params(json!({
                        "store":true,"user":"private-account-id"
                    })),
                    Mode::Unary,
                )
                .unwrap();
            let rig_core::wire::Body::Bytes(body) = encoded.request.body() else {
                panic!()
            };
            let body: Value = serde_json::from_slice(body).unwrap();
            assert_eq!(body["store"], false);
            assert_eq!(
                body["user"],
                isolated_affinity_key("alice-private", "run", "task", "v1")
            );
            assert_eq!(body["model"], "registered-model");
            assert!(
                !encoded
                    .request
                    .headers()
                    .contains_key("x-switchyard-session-id")
            );
            assert_eq!(encoded.request.headers()["authorization"], "Bearer fixture");
            assert!(
                !String::from_utf8_lossy(body.to_string().as_bytes())
                    .contains("private-account-id")
            );
            assert!(
                isolated_wire(route, "https://cloud.example/v1")
                    .encode(CompletionRequest::new("private"), Mode::Unary)
                    .is_err()
            );
        }
    }

    #[test]
    fn isolated_wire_rejects_continuations_policy_forgery_and_hidden_state() {
        let wire = isolated_wire(Route::Responses, "http://127.0.0.1:9000/v1");
        for forbidden in [
            "previous_response_id",
            "conversation",
            "metadata",
            "prompt_cache_key",
            "headers",
            "model",
            "input",
            "instructions",
            "destination_policy",
        ] {
            let request = CompletionRequest::new("public input")
                .additional_params(json!({forbidden:"PRIVATE-MARKER"}));
            let error = wire.encode(request, Mode::Unary).unwrap_err().to_string();
            assert!(!error.contains("PRIVATE-MARKER"));
        }
        let mut request = CompletionRequest::new("private");
        request.model = Some("cloud-model".into());
        assert!(wire.encode(request, Mode::Unary).is_err());
    }

    #[test]
    fn isolated_chat_preserves_numeric_thinking_budget_and_existing_output_cap() {
        let wire = isolated_wire(Route::Chat, "http://127.0.0.1:9000/v1");
        for mode in [Mode::Streaming, Mode::Unary] {
            for (tokens, output_cap) in [(0, 8192), (256, 8192), (8192, 8192), (256, 2048)] {
                let mut request =
                    CompletionRequest::new("private local input").additional_params(json!({
                        "thinking_token_budget":tokens,
                        "chat_template_kwargs":{"enable_thinking":true},
                    }));
                request.max_tokens = Some(output_cap);
                let encoded = wire.encode(request, mode).unwrap();
                let rig_core::wire::Body::Bytes(payload) = encoded.request.body() else {
                    panic!()
                };
                let body: Value = serde_json::from_slice(payload).unwrap();
                assert_eq!(body["thinking_token_budget"].as_u64(), Some(tokens));
                assert_eq!(body["chat_template_kwargs"]["enable_thinking"], true);
                assert_eq!(body["max_tokens"], output_cap);
                assert_eq!(body["model"], "registered-model");
                assert_eq!(body["store"], false);
                assert!(body.get("previous_response_id").is_none());
                assert!(body.get("metadata").is_none());
            }
        }
    }

    #[test]
    fn isolated_responses_rejects_even_valid_thinking_budgets() {
        let wire = isolated_wire(Route::Responses, "http://127.0.0.1:9000/v1");
        for mode in [Mode::Streaming, Mode::Unary] {
            for tokens in [0, 256, 8192] {
                let mut request =
                    CompletionRequest::new("private local input").additional_params(json!({
                        "thinking_token_budget":tokens,
                        "chat_template_kwargs":{"enable_thinking":true},
                    }));
                request.max_tokens = Some(8192);
                let error = wire.encode(request, mode).unwrap_err().to_string();
                assert!(error.contains("requires Chat route"));
                assert!(!error.contains("private local input"));
            }
        }
    }

    #[test]
    fn isolated_chat_preserves_boolean_medium_effort_without_changing_caps() {
        let wire = isolated_wire(Route::Chat, "http://127.0.0.1:9000/v1");
        for mode in [Mode::Streaming, Mode::Unary] {
            for medium in [false, true] {
                for output_cap in [2048, 8192] {
                    let mut request = CompletionRequest::new("private local input")
                        .additional_params(json!({"chat_template_kwargs":{
                            "enable_thinking":true,"medium_effort":medium
                        }}));
                    request.max_tokens = Some(output_cap);
                    let encoded = wire.encode(request, mode).unwrap();
                    let rig_core::wire::Body::Bytes(payload) = encoded.request.body() else {
                        panic!()
                    };
                    let body: Value = serde_json::from_slice(payload).unwrap();
                    assert_eq!(
                        body["chat_template_kwargs"]["enable_thinking"].as_bool(),
                        Some(true)
                    );
                    assert_eq!(
                        body["chat_template_kwargs"]["medium_effort"].as_bool(),
                        Some(medium)
                    );
                    assert_eq!(body["max_tokens"], output_cap);
                    assert_eq!(body["model"], "registered-model");
                    assert_eq!(body["store"], false);
                    assert!(body.get("thinking_token_budget").is_none());
                    assert!(body.get("metadata").is_none());
                }
            }
        }
    }

    #[test]
    fn isolated_wire_rejects_unsupported_or_forged_chat_template_options() {
        for route in [Route::Responses, Route::Chat] {
            let wire = isolated_wire(route, "http://127.0.0.1:9000/v1");
            for options in [
                Value::Null,
                json!([]),
                json!(true),
                json!({}),
                json!({"medium_effort":true}),
                json!({"enable_thinking":"PRIVATE-MARKER"}),
                json!({"enable_thinking":1}),
                json!({"enable_thinking":true,"medium_effort":"PRIVATE-MARKER"}),
                json!({"enable_thinking":true,"medium_effort":1}),
                json!({"enable_thinking":true,"medium_effort":null}),
                json!({"enable_thinking":true,"metadata":"PRIVATE-MARKER"}),
                json!({"enable_thinking":true,"reasoning_effort":"efficient"}),
            ] {
                let error = wire
                    .encode(
                        CompletionRequest::new("private local input")
                            .additional_params(json!({"chat_template_kwargs":options})),
                        Mode::Streaming,
                    )
                    .unwrap_err()
                    .to_string();
                assert!(!error.contains("PRIVATE-MARKER"));
            }
        }
        let wire = isolated_wire(Route::Responses, "http://127.0.0.1:9000/v1");
        for options in [
            json!({"enable_thinking":false}),
            json!({"enable_thinking":true,"medium_effort":true}),
        ] {
            for mode in [Mode::Streaming, Mode::Unary] {
                assert!(
                    wire.encode(
                        CompletionRequest::new("private local input")
                            .additional_params(json!({"chat_template_kwargs":options.clone()})),
                        mode
                    )
                    .is_err()
                );
            }
        }
    }

    #[test]
    fn isolated_wire_rejects_invalid_thinking_budget_before_encoding() {
        for route in [Route::Chat, Route::Responses] {
            let wire = isolated_wire(route, "http://127.0.0.1:9000/v1");
            for invalid in [
                json!(-1),
                json!(0.0),
                json!(256.0),
                json!(256.5),
                json!("PRIVATE-MARKER"),
                json!({"PRIVATE-MARKER":256}),
                json!([256]),
                json!(true),
                Value::Null,
                json!(8193),
                json!(u64::MAX),
            ] {
                let request = CompletionRequest::new("private local input")
                    .additional_params(json!({"thinking_token_budget":invalid}));
                let error = wire.encode(request, Mode::Unary).unwrap_err().to_string();
                assert!(!error.contains("PRIVATE-MARKER"));
            }
        }
    }

    #[tokio::test]
    async fn isolated_transport_does_not_follow_provider_redirects() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let captured = Arc::new(AtomicUsize::new(0));
        let external_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let external_addr = external_listener.local_addr().unwrap();
        let count = captured.clone();
        let external = tokio::spawn(async move {
            axum::serve(
                external_listener,
                axum::Router::new().fallback(move || {
                    let count = count.clone();
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        "unexpected"
                    }
                }),
            )
            .await
            .unwrap();
        });
        let local_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_addr = local_listener.local_addr().unwrap();
        let local = tokio::spawn(async move {
            axum::serve(
                local_listener,
                axum::Router::new().fallback(move || async move {
                    (
                        http::StatusCode::TEMPORARY_REDIRECT,
                        [("location", format!("http://{external_addr}/v1/responses"))],
                    )
                }),
            )
            .await
            .unwrap();
        });
        let client = isolated_client(
            OpenAIConfig::new("fixture").with_base_url(format!("http://{local_addr}/v1")),
        )
        .unwrap();
        let model = client.responses("fixture");
        let result = model.call(CompletionRequest::new("PRIVATE-MARKER")).await;
        assert!(result.is_err());
        assert_eq!(captured.load(Ordering::SeqCst), 0);
        local.abort();
        external.abort();
    }

    #[test]
    fn gateway_transport_errors_are_retryable_without_retrying_permanent_errors() {
        let transport = json!({"type":"error","error":{
            "type":"SwitchyardError",
            "message":"upstream transport error: error decoding response body"
        }});
        assert!(retryable(&ProviderError::from_provider_body(
            transport.to_string()
        )));
        assert!(retryable(&ProviderError::Truncated));
        assert!(!retryable(&ProviderError::from_http_response(
            http::StatusCode::BAD_REQUEST,
            transport.to_string()
        )));
        for body in [
            json!({"type":"error","error":{
                "type":"SwitchyardError","message":"failed to translate request"
            }}),
            json!({"error":{
                "type":"invalid_request_error","message":"upstream transport error: invalid input"
            }}),
            json!({"error":{"type":"SwitchyardError","message":"unknown"}}),
            json!({"type":"response.failed","response":{"error":{
                "code":"invalid_prompt","message":"invalid prompt"
            }}}),
        ] {
            assert!(!retryable(&ProviderError::from_provider_body(
                body.to_string()
            )));
        }
    }

    #[test]
    fn decode_recovery_is_separate_from_transport_and_request_failures() {
        let malformed = ProviderError::from(serde_json::from_str::<Value>("{").unwrap_err());
        assert!(stream_decode_error(&malformed));
        assert!(!retryable(&malformed));
        for error in [
            ProviderError::from_http_response(http::StatusCode::BAD_REQUEST, "private"),
            ProviderError::from_http_response(http::StatusCode::UNAUTHORIZED, "private"),
            ProviderError::Truncated,
        ] {
            assert!(!stream_decode_error(&error));
        }
    }

    #[test]
    fn gateway_metadata_is_restored_without_replacing_content_or_status() {
        let decoder = wire().decoder();
        for value in [
            json!({"type":"response.created","response":{
                "id":"resp_fixture","object":"response","status":"in_progress","model":"fixture","output":[]
            }}),
            json!({"type":"response.output_item.added","output_index":2,"item":{
                "type":"message","id":"msg_original","role":"assistant","status":"in_progress","content":[]
            }}),
            json!({"type":"response.output_text.delta","output_index":2,"content_index":0,"delta":"answer"}),
            json!({"type":"response.output_item.done","output_index":2,"item":{
                "type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"answer"}]
            }}),
        ] {
            assert!(matches!(
                decoder.classify(WireFrame::Text(value.to_string())),
                WireEvent::Known(_)
            ));
        }
        let mut metadata = decoder.metadata.borrow_mut();
        let raw = json!({"type":"response.completed","sequence_number":80,"response":{
            "id":"resp_fixture","object":"response","created_at":123,"status":"incomplete","model":"fixture",
            "output":[{"type":"message","id":"msg_other","role":"assistant","status":"incomplete","content":[]}]
        }});
        let normalized: Value = serde_json::from_str(
            &metadata
                .normalize(WireFrame::Text(raw.to_string()))
                .as_str(),
        )
        .unwrap();
        assert_eq!(normalized, raw);
    }

    #[test]
    fn missing_content_identity_and_malformed_known_frames_still_fail() {
        let decoder = wire().decoder();
        for value in [
            json!({"type":"response.output_text.delta","content_index":0,"delta":"answer"}),
            json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":42}),
            json!({"type":"response.output_item.done","output_index":0,"item":{
                "type":"message","role":"assistant","status":"completed","content":[]
            }}),
            json!({"type":"response.output_item.done","output_index":0,"item":{
                "type":"function_call","name":"tool","arguments":"{}","status":"completed"
            }}),
            json!({"type":"response.completed","response":{"id":"resp_fixture","object":"response","model":"fixture","output":[]}}),
            json!({"type":"response.created","sequence_number":"invalid","response":{
                "id":"resp_fixture","object":"response","status":"in_progress","model":"fixture","output":[]
            }}),
        ] {
            assert!(matches!(
                decoder.classify(WireFrame::Text(value.to_string())),
                WireEvent::Corrupt(_)
            ));
        }
        assert!(matches!(
            decoder.classify(WireFrame::Text("{invalid".into())),
            WireEvent::Corrupt(_)
        ));
    }
}
