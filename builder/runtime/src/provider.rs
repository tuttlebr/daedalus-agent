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

#[derive(Clone)]
pub struct CompatibleOpenAi(pub OpenAiWire);

impl Wire for CompatibleOpenAi {
    type Op = Completion;
    type Payload = Encoded;
    type Frame = WireFrame;
    type Decoder<'id> = CompatibleDecoder<'id>;

    fn describe(&self) -> Descriptor<'_> {
        self.0.describe()
    }

    fn encode(&self, request: CompletionRequest, mode: Mode) -> Result<Encoded, EncodeError> {
        self.0.encode(request, mode)
    }

    fn decoder<'id>(&self) -> Self::Decoder<'id> {
        CompatibleDecoder {
            inner: self.0.decoder(),
            metadata: RefCell::new(EnvelopeMetadata::default()),
            responses: matches!(self.0, OpenAiWire::Responses(_)),
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
        self.inner.classify(frame)
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
        let Ok(Value::Object(mut event)) = serde_json::from_str(&frame.as_str()) else {
            return frame;
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
        CompatibleOpenAi(OpenAiWire::new(
            OpenAIConfig::new("fixture").with_route(Route::Responses),
            "fixture",
        ))
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
