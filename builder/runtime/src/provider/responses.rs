//! Accumulate Responses items before converting the completed turn into Rig.
//!
//! Deltas are provisional; done events and the terminal output are snapshots.
//! Rig's streaming fold cannot replace text already emitted, and ignores some
//! snapshots after any delta. Keep the wire document here, publish a separate
//! text projection, and let Rig validate/decode the final document once.

use std::collections::BTreeMap;

use serde_json::{Value, json};

pub const TEXT_UPDATE: &str = "daedalus.responses_text";

#[derive(Default)]
pub struct Accumulator {
    items: BTreeMap<u64, Value>,
    visible: BTreeMap<(u64, usize), String>,
    text: String,
}

fn invalid() -> serde_json::Error {
    <serde_json::Error as serde::de::Error>::custom("Invalid Responses accumulation state")
}

fn index(event: &Value, field: &str) -> Result<usize, serde_json::Error> {
    event[field]
        .as_u64()
        .filter(|index| *index < 4096)
        .map(|index| index as usize)
        .ok_or_else(invalid)
}

fn part<'a>(
    item: &'a mut Value,
    field: &str,
    at: usize,
) -> Result<&'a mut Value, serde_json::Error> {
    let values = item
        .as_object_mut()
        .ok_or_else(invalid)?
        .entry(field)
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(invalid)?;
    values.resize_with(values.len().max(at + 1), || Value::Null);
    Ok(&mut values[at])
}

fn visible_text(part: &Value) -> Option<&str> {
    match part["type"].as_str()? {
        "output_text" => part["text"].as_str(),
        "refusal" => part["refusal"].as_str(),
        _ => None,
    }
}

impl Accumulator {
    fn item(&mut self, event: &Value, kind: &str) -> Result<&mut Value, serde_json::Error> {
        let slot = event["output_index"].as_u64().ok_or_else(invalid)?;
        let item = self.items.entry(slot).or_insert_with(|| {
            let mut item = json!({"type":kind, "status":"in_progress"});
            if kind == "message" {
                item["role"] = json!("assistant");
            }
            item
        });
        if item["type"] != kind {
            return Err(invalid());
        }
        if let Some(id) = event.get("item_id")
            && item.get("id").is_none()
        {
            item["id"] = id.clone();
        }
        Ok(item)
    }

    fn rebuild_visible(&mut self) {
        self.visible.clear();
        for (slot, item) in &self.items {
            if item["type"] == "message"
                && let Some(parts) = item["content"].as_array()
            {
                for (at, part) in parts.iter().enumerate() {
                    if let Some(text) = visible_text(part).filter(|text| !text.is_empty()) {
                        self.visible.insert((*slot, at), text.to_owned());
                    }
                }
            }
        }
    }

    fn snapshot(&mut self) -> Option<Value> {
        self.rebuild_visible();
        let mut next = String::new();
        let mut previous_slot = None;
        for ((slot, _), text) in &self.visible {
            if previous_slot.is_some_and(|previous| previous != slot) {
                next.push_str("\n\n");
            }
            next.push_str(text);
            previous_slot = Some(slot);
        }
        if next == self.text {
            return None;
        }
        let update = if let Some(suffix) = next.strip_prefix(&self.text) {
            json!({"type":TEXT_UPDATE,"text":suffix,"replace":false})
        } else {
            json!({"type":TEXT_UPDATE,"text":next,"replace":true})
        };
        self.text = next;
        Some(update)
    }

    /// Common token path is linear in the new fragment, not the whole answer.
    fn delta(&mut self, key: (u64, usize), delta: &str) -> Option<Value> {
        if delta.is_empty() {
            return None;
        }
        let last = self.visible.last_key_value().map(|(key, _)| *key);
        if last.is_some_and(|last| key < last) {
            return self.snapshot();
        }
        let separator = if last.is_some_and(|last| last.0 != key.0) {
            "\n\n"
        } else {
            ""
        };
        self.visible.entry(key).or_default().push_str(delta);
        self.text.push_str(separator);
        self.text.push_str(delta);
        Some(json!({"type":TEXT_UPDATE,"text":format!("{separator}{delta}"),"replace":false}))
    }

    /// Return a visible update and, only at a real terminal event, the complete
    /// response. Empty terminal output is tolerated for compatible gateways
    /// that sent item snapshots but omit the terminal's repeated output.
    pub fn apply(
        &mut self,
        event: &Value,
    ) -> Result<(Option<Value>, Option<Value>), serde_json::Error> {
        let kind = event["type"].as_str().ok_or_else(invalid)?;
        match kind {
            "response.output_item.added" | "response.output_item.done" => {
                let slot = event["output_index"].as_u64().ok_or_else(invalid)?;
                self.items.insert(slot, event["item"].clone());
            }
            "response.content_part.added" | "response.content_part.done" => {
                let at = index(event, "content_index")?;
                *part(self.item(event, "message")?, "content", at)? = event["part"].clone();
            }
            "response.output_text.delta" | "response.refusal.delta" => {
                let at = index(event, "content_index")?;
                let slot = event["output_index"].as_u64().ok_or_else(invalid)?;
                let delta = event["delta"].as_str().ok_or_else(invalid)?;
                let refusal = kind == "response.refusal.delta";
                let field = if refusal { "refusal" } else { "text" };
                let target = part(self.item(event, "message")?, "content", at)?;
                if target.is_null() {
                    *target = if refusal {
                        json!({"type":"refusal","refusal":""})
                    } else {
                        json!({"type":"output_text","text":"","annotations":[]})
                    };
                }
                let Value::String(text) = &mut target[field] else {
                    return Err(invalid());
                };
                text.push_str(delta);
                return Ok((self.delta((slot, at), delta), None));
            }
            "response.output_text.done" | "response.refusal.done" => {
                let at = index(event, "content_index")?;
                let target = part(self.item(event, "message")?, "content", at)?;
                let refusal = kind == "response.refusal.done";
                let field = if refusal { "refusal" } else { "text" };
                if target.is_null() {
                    *target = json!({"type": if refusal { "refusal" } else { "output_text" }});
                }
                target[field] = event[field].clone();
            }
            "response.function_call_arguments.delta" | "response.function_call_arguments.done" => {
                let item = self.item(event, "function_call")?;
                if kind.ends_with(".done") {
                    item["arguments"] = event["arguments"].clone();
                } else {
                    let delta = event["delta"].as_str().ok_or_else(invalid)?;
                    if item.get("arguments").is_none() {
                        item["arguments"] = json!("");
                    }
                    let Value::String(text) = &mut item["arguments"] else {
                        return Err(invalid());
                    };
                    text.push_str(delta);
                }
                return Ok((None, None));
            }
            "response.reasoning_summary_part.added" | "response.reasoning_summary_part.done" => {
                let at = index(event, "summary_index")?;
                *part(self.item(event, "reasoning")?, "summary", at)? = event["part"].clone();
                return Ok((None, None));
            }
            "response.reasoning_summary_text.delta"
            | "response.reasoning_summary_text.done"
            | "response.reasoning_text.delta"
            | "response.reasoning_text.done" => {
                let summary = kind.starts_with("response.reasoning_summary");
                let at = index(
                    event,
                    if summary {
                        "summary_index"
                    } else {
                        "content_index"
                    },
                )?;
                let target = part(
                    self.item(event, "reasoning")?,
                    if summary { "summary" } else { "content" },
                    at,
                )?;
                if target.is_null() {
                    *target = json!({"type":if summary { "summary_text" } else { "reasoning_text" },"text":""});
                }
                if kind.ends_with(".done") {
                    target["text"] = event["text"].clone();
                } else {
                    let delta = event["delta"].as_str().ok_or_else(invalid)?;
                    let Value::String(text) = &mut target["text"] else {
                        return Err(invalid());
                    };
                    text.push_str(delta);
                }
                return Ok((None, None));
            }
            "response.completed" | "response.incomplete" => {
                let mut response = event["response"].clone();
                if let Some(output) = response["output"]
                    .as_array()
                    .filter(|output| !output.is_empty())
                {
                    self.items = output
                        .iter()
                        .cloned()
                        .enumerate()
                        .map(|(at, item)| (at as u64, item))
                        .collect();
                }
                response["output"] = self.items.values().cloned().collect();
                return Ok((self.snapshot(), Some(response)));
            }
            _ => return Ok((None, None)),
        }
        Ok((self.snapshot(), None))
    }
}
