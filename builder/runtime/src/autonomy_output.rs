//! Autonomous results use validated tool arguments, never free-form model text.
use anyhow::{Result, bail};
use rig_core::completion::ToolDefinition;
use serde_json::Value;

pub const TOOL: &str = "submit_autonomous_result";
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Validation {
    pub problem: String,
}
pub const GUIDANCE: &str = "Finish this autonomous cycle by calling submit_autonomous_result alone, after other tools finish. Its arguments are the final result. Do not return the result as assistant text. Use completed evidence; do not repeat research or actions to format the result.";

pub fn definition(body: &Value, autonomy: bool) -> Result<Option<ToolDefinition>> {
    let Some(schema) = body.get("autonomy_output_schema") else {
        return Ok(None);
    };
    fn local_refs(value: &Value) -> bool {
        match value {
            Value::Object(fields) => fields.iter().all(|(key, value)| {
                if key == "$ref" || key == "$dynamicRef" {
                    value
                        .as_str()
                        .is_some_and(|reference| reference.starts_with('#'))
                } else {
                    local_refs(value)
                }
            }),
            Value::Array(items) => items.iter().all(local_refs),
            _ => true,
        }
    }
    if !autonomy
        || schema["type"] != "object"
        || !schema["properties"].is_object()
        || schema["additionalProperties"] != false
        || schema.to_string().len() > 32 * 1024
        || !local_refs(schema)
    {
        bail!("Invalid autonomous output schema");
    }
    crate::tool_contracts::validator(schema)?;
    Ok(Some(ToolDefinition {
        name: TOOL.into(),
        description: GUIDANCE.into(),
        parameters: schema.clone(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn whitespace_only_required_text_fails_the_worker_schema_pattern() {
        // The worker strips text before publication; its schema marks
        // required strings with a non-space pattern that this validator uses.
        let schema = json!({"type":"object","additionalProperties":false,
            "required":["summary"],
            "properties":{"summary":{"type":"string","minLength":1,"pattern":"\\S"}}});
        let tool = definition(&json!({"autonomy_output_schema":schema}), true)
            .unwrap()
            .unwrap();
        let validator = crate::tool_contracts::validator(&tool.parameters).unwrap();
        assert!(!validator.is_valid(&json!({"summary":" \n\t"})));
        assert!(validator.is_valid(&json!({"summary":" Done. "})));
    }

    #[test]
    fn output_schema_is_scoped_and_cannot_resolve_external_references() {
        let schema = json!({"type":"object", "properties":{"summary":{"type":"string"}},
            "required":["summary"], "additionalProperties":false});
        let body = json!({"autonomy_output_schema":schema});
        assert!(definition(&body, false).is_err());
        assert_eq!(definition(&body, true).unwrap().unwrap().parameters, schema);
        assert!(definition(&json!({}), false).unwrap().is_none());
        for value in [
            json!(null),
            json!({"type":"array"}),
            json!({
                "type":"object","properties":{},"additionalProperties":false,
                "$ref":"file:///private-schema.json"
            }),
        ] {
            assert!(definition(&json!({"autonomy_output_schema":value}), true).is_err());
        }
    }
}
