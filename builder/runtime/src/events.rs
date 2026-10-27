use anyhow::Result;
use bytes::Bytes;
use serde_json::{Value, json};
use std::time::Instant;
use tokio::sync::mpsc;

#[derive(Clone)]
pub struct Events {
    pub run_id: String,
    sender: mpsc::Sender<Bytes>,
    deadline: Option<Instant>,
}

/// Text within one model response is tokenized arbitrarily. Separate completed
/// response blocks at the source, where model/tool boundaries are still known;
/// downstream consumers can then append every delta verbatim.
#[derive(Default)]
pub struct ResponseText {
    emitted: bool,
    separate: bool,
}

impl ResponseText {
    pub fn begin_block(&mut self) {
        self.separate = self.emitted;
    }

    pub async fn delta(&mut self, events: &Events, content: &str) -> Result<()> {
        if content.is_empty() {
            return Ok(());
        }
        if self.separate {
            events.delta("\n\n").await?;
            self.separate = false;
        }
        events.delta(content).await?;
        self.emitted = true;
        Ok(())
    }
}

impl Events {
    pub fn new(run_id: impl Into<String>, sender: mpsc::Sender<Bytes>) -> Self {
        Self {
            run_id: run_id.into(),
            sender,
            deadline: None,
        }
    }

    /// A clone keeps its original absolute bound; rebinding can only tighten it.
    pub fn with_deadline(mut self, deadline: Instant) -> Self {
        self.deadline = Some(self.deadline.map_or(deadline, |old| old.min(deadline)));
        self
    }

    pub(crate) fn with_sender(&self, sender: mpsc::Sender<Bytes>) -> Self {
        Self {
            run_id: self.run_id.clone(),
            sender,
            deadline: self.deadline,
        }
    }

    pub async fn closed(&self) {
        self.sender.closed().await;
    }

    pub async fn raw(&self, data: String) -> Result<()> {
        self.raw_bytes(Bytes::from(data)).await
    }

    /// Every event reaches this boundary after serialization, including native
    /// OAuth emitters, steering and already-encoded staged frames. A ready
    /// channel cannot publish after expiry, and backpressure cannot renew it.
    pub(crate) async fn raw_bytes(&self, data: Bytes) -> Result<()> {
        let Some(deadline) = self.deadline else {
            return self
                .sender
                .send(data)
                .await
                .map_err(|_| anyhow::anyhow!("Client disconnected"));
        };
        let expired =
            || anyhow::Error::from(crate::context_isolation::IsolationError::DeadlineExceeded);
        if Instant::now() >= deadline {
            return Err(expired());
        }
        let permit = tokio::select! {
            biased;
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => return Err(expired()),
            permit = self.sender.reserve() => permit.map_err(|_| anyhow::anyhow!("Client disconnected"))?,
        };
        if Instant::now() >= deadline {
            return Err(expired());
        }
        permit.send(data);
        Ok(())
    }

    pub async fn event(&self, event: &str, data: Value) -> Result<()> {
        self.raw(format!("event: {event}\ndata: {data}\n\n")).await
    }

    pub async fn delta(&self, content: &str) -> Result<()> {
        self.event(
            "message",
            json!({
                "id": self.run_id, "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": null}]
            }),
        )
        .await
    }

    pub async fn tool(&self, id: &str, name: &str, completed: bool, payload: Value) -> Result<()> {
        let phase = if completed { "Complete" } else { "Start" };
        let data = json!({"id": id, "parent_id": self.run_id,
            "name": format!("Function {phase}: {name}"), "payload": payload});
        self.raw(format!("intermediate_data: {data}\n\n")).await
    }

    pub async fn finish(&self, reason: &str) -> Result<()> {
        self.event(
            "message",
            json!({"id": self.run_id, "object": "chat.completion.chunk",
                "choices": [{"index":0,"delta":{},"finish_reason":reason,"daedalus_terminal":true}]
            }),
        )
        .await?;
        self.raw("data: [DONE]\n\n".into()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn expired_events_reject_ready_steering_oauth_heartbeat_and_terminal_frames() {
        for kind in ["steering", "oauth", "heartbeat", "text", "tool", "finish"] {
            let (sender, mut receiver) = mpsc::channel(4);
            let events = Events::new("synthetic", sender).with_deadline(Instant::now());
            let result = match kind {
                "steering" => {
                    events
                        .event("steering", json!({"instruction":"PRIVATE_STEERING_MARKER"}))
                        .await
                }
                "oauth" => {
                    crate::oauth::Emitter::Chat(events.clone())
                        .emit(json!({"auth_url":"https://accounts.example.invalid/synthetic"}))
                        .await
                }
                "heartbeat" => events.raw(": tool active\n\n".into()).await,
                "text" => events.delta("PRIVATE_TEXT_MARKER").await,
                "tool" => {
                    events
                        .tool("id", "tool", true, json!("PRIVATE_RESULT_MARKER"))
                        .await
                }
                "finish" => events.finish("stop").await,
                _ => unreachable!(),
            };
            assert_eq!(
                result.unwrap_err().root_cause().to_string(),
                "shared workflow deadline has expired",
                "{kind}"
            );
            assert!(receiver.try_recv().is_err(), "expired {kind} was published");
        }
    }

    #[tokio::test]
    async fn oauth_clones_and_retargeted_emitters_cannot_extend_the_original_deadline() {
        let (sender, mut original) = mpsc::channel(1);
        let deadline = Instant::now() + Duration::from_millis(25);
        let events = Events::new("synthetic", sender).with_deadline(deadline);
        let (sender, mut retargeted) = mpsc::channel(1);
        let clone = events
            .clone()
            .with_sender(sender)
            .with_deadline(deadline + Duration::from_secs(10));
        assert_eq!(clone.deadline, Some(deadline));
        tokio::time::sleep(Duration::from_millis(35)).await;
        let result = crate::oauth::Emitter::Chat(clone)
            .emit(json!({"auth_url":"synthetic"}))
            .await;
        assert_eq!(
            result.unwrap_err().root_cause().to_string(),
            "shared workflow deadline has expired"
        );
        assert!(original.try_recv().is_err());
        assert!(retargeted.try_recv().is_err());
    }

    #[tokio::test]
    async fn cloned_oauth_backpressure_cancels_at_the_bound_without_a_late_frame() {
        let (sender, mut receiver) = mpsc::channel(1);
        let events = Events::new("synthetic", sender);
        events
            .raw(": accepted before deadline\n\n".into())
            .await
            .unwrap();
        let bound = events.with_deadline(Instant::now() + Duration::from_millis(30));
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            crate::oauth::Emitter::Chat(bound.clone())
                .emit(json!({"auth_url":"LATE_OAUTH_MARKER"})),
        )
        .await
        .expect("the immutable deadline must cancel a blocked clone");
        assert_eq!(
            result.unwrap_err().root_cause().to_string(),
            "shared workflow deadline has expired"
        );
        assert_eq!(
            receiver.recv().await.unwrap(),
            ": accepted before deadline\n\n"
        );
        assert!(receiver.try_recv().is_err());
        // A producer whose encoding finishes after expiry is rejected even
        // when the real queue has become immediately writable again.
        assert!(
            bound
                .raw("LATE_EXECUTOR_OAUTH_MARKER".into())
                .await
                .is_err()
        );
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn unbound_legacy_oauth_still_waits_for_client_capacity() {
        let (sender, mut receiver) = mpsc::channel(1);
        let events = Events::new("synthetic", sender);
        events.raw(": occupied\n\n".into()).await.unwrap();
        let emitter = crate::oauth::Emitter::Chat(events.clone());
        let pending = emitter.emit(json!({"auth_url":"synthetic"}));
        tokio::pin!(pending);
        assert!(
            tokio::time::timeout(Duration::from_millis(30), &mut pending)
                .await
                .is_err()
        );
        receiver.recv().await.unwrap();
        pending.await.unwrap();
        let frame = receiver.recv().await.unwrap();
        assert!(String::from_utf8_lossy(&frame).contains("oauth_required"));
    }
}
