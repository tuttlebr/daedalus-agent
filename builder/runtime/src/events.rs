use anyhow::Result;
use bytes::Bytes;
use serde_json::{Value, json};
use tokio::sync::mpsc;

#[derive(Clone)]
pub struct Events {
    pub run_id: String,
    pub sender: mpsc::Sender<Bytes>,
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
    pub async fn raw(&self, data: String) -> Result<()> {
        self.sender
            .send(Bytes::from(data))
            .await
            .map_err(|_| anyhow::anyhow!("Client disconnected"))
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
