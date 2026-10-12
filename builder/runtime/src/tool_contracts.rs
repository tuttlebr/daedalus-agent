//! Contracts are checked before scheduling any member of a tool batch.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use anyhow::{Result, bail};
use rig_core::completion::ToolDefinition;
use rig_core::message::ToolCall;
use rig_core::message::ToolChoice;
use serde_json::Value;

pub static POLICY: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../resources/tool-policy.json"))
        .expect("bundled tool policy is valid JSON")
});

/// Explicit caller intent; natural language never grants tool permissions.
#[derive(Default)]
pub enum Requirement {
    #[default]
    Auto,
    None,
    Any,
    Named(String),
}

impl Requirement {
    pub fn parse(body: &Value) -> Result<Self> {
        match body.get("tool_choice") {
            None | Some(Value::Null) => Ok(Self::Auto),
            Some(Value::String(value)) if value == "auto" => Ok(Self::Auto),
            Some(Value::String(value)) if value == "none" => Ok(Self::None),
            Some(Value::String(value)) if value == "required" => Ok(Self::Any),
            Some(value) if value["type"] == "function" => {
                let name = value["function"]["name"]
                    .as_str()
                    .or_else(|| value["name"].as_str());
                if let Some(name) = name.filter(|name| !name.trim().is_empty()) {
                    Ok(Self::Named(name.into()))
                } else {
                    bail!("Invalid tool_choice")
                }
            }
            _ => bail!("Invalid tool_choice"),
        }
    }

    pub fn pending(&self) -> bool {
        matches!(self, Self::Any | Self::Named(_))
    }

    pub fn choice(&self) -> ToolChoice {
        match self {
            Self::Auto => ToolChoice::Auto,
            Self::None => ToolChoice::None,
            Self::Any => ToolChoice::Required,
            Self::Named(name) => ToolChoice::Specific {
                function_names: vec![name.clone()],
            },
        }
    }

    pub fn allows(&self, name: &str) -> bool {
        match self {
            Self::None => false,
            Self::Named(required) => required == name,
            _ => true,
        }
    }

    pub fn succeeded(&mut self, name: &str) {
        if self.pending() && self.allows(name) {
            *self = Self::Auto;
        }
    }
}

#[derive(Default)]
pub struct Catalog {
    entries: HashMap<String, (Value, String, jsonschema::Validator)>,
    call_ids: HashSet<String>,
}

impl Catalog {
    pub fn add(&mut self, tool: &ToolDefinition) -> Result<bool> {
        if tool.name.trim().is_empty() || tool.description.trim().is_empty() {
            bail!("Tool catalog contains an unnamed or undocumented tool");
        }
        if let Some((schema, description, _)) = self.entries.get(&tool.name) {
            if schema != &tool.parameters || description != &tool.description {
                bail!("Tool catalog contains conflicting definitions");
            }
            return Ok(false);
        }
        let validator = jsonschema::options()
            .should_validate_formats(false)
            .build(&tool.parameters)
            .map_err(|_| anyhow::anyhow!("Tool catalog contains an invalid schema"))?;
        self.entries.insert(
            tool.name.clone(),
            (tool.parameters.clone(), tool.description.clone(), validator),
        );
        Ok(true)
    }

    pub fn check_batch(
        &mut self,
        calls: &[ToolCall],
        allowed: &[ToolDefinition],
    ) -> Result<Vec<String>> {
        // Do not attempt repair of an ambiguous result binding, even if neither
        // call has run yet. Do not accept replayed IDs from earlier rounds.
        let mut batch_ids = HashSet::new();
        for call in calls {
            let id = call.id.to_string();
            if call.id.is_local()
                || id.trim().is_empty()
                || self.call_ids.contains(&id)
                || !batch_ids.insert(id)
            {
                bail!("Invalid or repeated tool call ID");
            }
        }
        self.call_ids.extend(batch_ids);
        Ok(calls.iter().map(|call| {
            let name = call.function.name.as_str();
            if !allowed.iter().any(|tool| tool.name == name) {
                return "Tool is unavailable in this phase. Choose an advertised tool.".into();
            }
            let Some((_, _, validator)) = self.entries.get(name) else {
                return "Tool is unavailable. Choose an advertised tool.".into();
            };
            if !call.function.arguments.is_object() {
                return "Arguments must be a JSON object.".into();
            }
            // Schema paths explain the constraint without echoing private
            // argument values or arbitrary property names from invalid input.
            let paths: Vec<_> = validator.iter_errors(&call.function.arguments)
                .take(4).map(|error| error.schema_path().to_string()).collect();
            if paths.is_empty() { String::new() } else {
                format!("Arguments violate the tool schema at {}. Supply only valid operation fields.", paths.join(", "))
            }
        }).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool() -> ToolDefinition {
        ToolDefinition {
            name: "read".into(),
            description: "Read one item by ID.".into(),
            parameters: json!({"type":"object","required":["id"],"properties":{"id":{"type":"integer"}},"additionalProperties":false}),
        }
    }
    fn call(id: &str, name: &str, args: Value) -> ToolCall {
        ToolCall::from_wire(
            id,
            rig_core::message::ToolFunction {
                name: rig_core::message::ToolName::new(name).unwrap(),
                arguments: args,
            },
        )
    }

    #[test]
    fn catalog_rejects_conflicts_and_empty_guidance() {
        let mut catalog = Catalog::default();
        assert!(catalog.add(&tool()).unwrap());
        assert!(!catalog.add(&tool()).unwrap());
        let mut changed = tool();
        changed.parameters = json!({});
        assert!(catalog.add(&changed).is_err());
        changed.name = "other".into();
        changed.description.clear();
        assert!(catalog.add(&changed).is_err());
    }

    #[test]
    fn batch_reports_invalid_arguments_without_values_and_reserves_ids() {
        let mut catalog = Catalog::default();
        catalog.add(&tool()).unwrap();
        let calls = vec![
            call("a", "read", json!({"id":1})),
            call("b", "read", json!({"id":"private-value"})),
        ];
        let errors = catalog.check_batch(&calls, &[tool()]).unwrap();
        assert!(errors[0].is_empty());
        assert!(errors[1].contains("type"));
        assert!(!errors[1].contains("private-value"));
        assert!(catalog.check_batch(&calls[..1], &[tool()]).is_err());
        assert!(
            catalog
                .check_batch(
                    &[call("c", "read", json!({})), call("c", "read", json!({}))],
                    &[tool()]
                )
                .is_err()
        );
        assert!(
            !catalog
                .check_batch(&[call("d", "unknown", json!({}))], &[tool()])
                .unwrap()[0]
                .is_empty()
        );
    }
}
