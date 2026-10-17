//! Content-free experiment identity. Never serialize PreparedRun or its model key.
use crate::agent::PreparedRun;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub fn digest(value: &Value) -> String {
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(fields) => {
                let mut keys: Vec<_> = fields.keys().collect();
                keys.sort();
                Value::Object(
                    keys.into_iter()
                        .map(|k| (k.clone(), canonical(&fields[k])))
                        .collect(),
                )
            }
            Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
            other => other.clone(),
        }
    }
    format!(
        "{:x}",
        Sha256::digest(canonical(value).to_string().as_bytes())
    )
}

pub fn identity(prepared: &PreparedRun, workflow: &Value) -> String {
    let context: serde_json::Map<String, Value> = [
        "max_history",
        "max_history_tokens",
        "tool_output_compaction_enabled",
        "tool_output_compaction_min_chars",
        "tool_output_compaction_max_items",
        "tool_output_compaction_min_savings_chars",
        "tool_output_compaction_max_ratio",
        "tool_output_compaction_max_original_chars",
        "tool_output_cache_ttl_seconds",
    ]
    .into_iter()
    .filter_map(|key| workflow.get(key).map(|v| (key.into(), v.clone())))
    .collect();
    digest(&json!({
        "version": 1,
        "instructions": prepared.instructions,
        "tools": prepared.tools,
        "policy": *crate::tool_contracts::POLICY,
        "model_alias": prepared.model.model_name,
        "api_type": prepared.model.api_type,
        "endpoint_digest": digest(&json!(prepared.model.base_url)),
        "max_iterations": prepared.max_iterations,
        "parallel_tool_calls": prepared.parallel_tool_calls,
        "context_policy": context,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_tracks_policy_but_excludes_keys_and_conversations() {
        let mut run: PreparedRun = serde_json::from_value(json!({
            "model": {"base_url":"https://model.invalid/v1", "api_key":"secret-a", "model_name":"alias"},
            "instructions":"Use evidence", "messages":[], "tools":[], "max_iterations":8
        })).unwrap();
        let original = identity(&run, &json!({}));
        run.model.api_key = "secret-b".into();
        run.messages.push(crate::agent::ChatMessage {
            role: "user".into(),
            content: "Private content".into(),
        });
        assert_eq!(
            original,
            identity(&run, &json!({"unrelated_secret":"private"}))
        );
        assert_ne!(
            original,
            identity(&run, &json!({"tool_output_compaction_enabled":false}))
        );
        run.instructions.push_str(" and cite sources");
        assert_ne!(original, identity(&run, &json!({})));
        assert_eq!(digest(&json!({"a":1,"b":2})), digest(&json!({"b":2,"a":1})));
    }
}
