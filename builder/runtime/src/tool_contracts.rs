//! Contracts are checked before scheduling calls; invalid calls never execute.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

use anyhow::{Result, bail};
use rig_core::completion::ToolDefinition;
use rig_core::message::ToolCall;
use rig_core::message::ToolChoice;
use serde_json::Value;

pub static POLICY: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../resources/tool-policy.json"))
        .expect("bundled tool policy is valid JSON")
});

/// Reduce first-step schema distraction for explicitly named capabilities.
/// This is only a model-facing menu, never an instruction to execute anything.
/// The full authorized catalogue returns on the next iteration, including after
/// a rejected proposal for an initially hidden capability.
pub fn initial_menu(tools: &[ToolDefinition], query: &str) -> Option<HashSet<String>> {
    let words: HashSet<_> = query
        .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-'))
        .filter(|word| !word.is_empty())
        .collect();
    let mut selected: HashSet<String> = tools
        .iter()
        .filter(|tool| {
            words.contains(tool.name.as_str())
                || tool.name.strip_suffix("__connect").is_some_and(|group| {
                    words
                        .iter()
                        .any(|word| word.starts_with(&format!("{group}__")))
                })
        })
        .map(|tool| tool.name.clone())
        .collect();
    if selected.is_empty() {
        return None;
    }
    for name in ["agent_skills_tool", "tool_output_retriever_tool"] {
        if tools.iter().any(|tool| tool.name == name) {
            selected.insert(name.into());
        }
    }
    Some(selected)
}

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
pub struct Recovery {
    pending: HashSet<String>,
    disabled: HashSet<String>,
}

impl Recovery {
    /// Each tool gets one correction. Repeated invalid tools are disabled for
    /// this run without terminating independent work. Valid siblings can run.
    pub fn allows(&self, name: &str) -> bool {
        !self.disabled.contains(name)
    }

    /// Unrelated successful calls cannot hide a repeated invalid proposal.
    pub fn exhausted(&mut self, calls: &[ToolCall], problems: &[String]) -> bool {
        let invalid: HashSet<_> = calls
            .iter()
            .zip(problems)
            .filter(|(_, problem)| !problem.is_empty())
            .map(|(call, _)| call.function.name.to_string())
            .collect();
        for (call, problem) in calls.iter().zip(problems) {
            if problem.is_empty() && !invalid.contains(call.function.name.as_str()) {
                self.pending.remove(call.function.name.as_str());
            }
        }
        let mut exhausted = false;
        for name in invalid {
            if !self.pending.insert(name.clone()) {
                self.disabled.insert(name);
                exhausted = true;
            }
        }
        exhausted
    }
}

/// Compiled argument validators shared across runs. Every run checks the same
/// configured schemas, and compiling them was repeated work before the first
/// model request. Keys are schema digests, so runs and users share only
/// validators of byte-identical schemas; validators hold no request state.
static VALIDATORS: LazyLock<std::sync::Mutex<HashMap<[u8; 32], Arc<jsonschema::Validator>>>> =
    LazyLock::new(Default::default);
const MAX_CACHED_VALIDATORS: usize = 1024;

/// A format-agnostic validator for one tool argument schema.
pub fn validator(schema: &Value) -> Result<Arc<jsonschema::Validator>> {
    use sha2::{Digest, Sha256};
    let key: [u8; 32] = Sha256::digest(serde_json::to_vec(schema)?).into();
    if let Some(validator) = VALIDATORS.lock().unwrap().get(&key) {
        return Ok(validator.clone());
    }
    let validator = Arc::new(
        jsonschema::options()
            .should_validate_formats(false)
            .build(schema)
            .map_err(|_| anyhow::anyhow!("Tool catalog contains an invalid schema"))?,
    );
    let mut cache = VALIDATORS.lock().unwrap();
    // MCP servers can change schemas over time; bound the retained set.
    if cache.len() >= MAX_CACHED_VALIDATORS {
        cache.clear();
    }
    Ok(cache.entry(key).or_insert(validator).clone())
}

#[derive(Default)]
pub struct Catalog {
    entries: HashMap<String, (Value, String, Arc<jsonschema::Validator>)>,
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
        let validator = validator(&tool.parameters)?;
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
            let Some((schema, _, validator)) = self.entries.get(name) else {
                return "Tool is unavailable. Choose an advertised tool.".into();
            };
            if !call.function.arguments.is_object() {
                return "Arguments must be a JSON object.".into();
            }
            // Use only advertised schema content, never validation error Display:
            // the latter can echo private argument values. Include constraints
            // so union failures explain the accepted types and bounds.
            let paths: Vec<_> = validator.iter_errors(&call.function.arguments)
                .take(4).map(|error| {
                    let path = error.schema_path().to_string();
                    match schema.pointer(&path) {
                        Some(constraint) => {
                            let kind = match error.instance().as_ref() {
                                Value::Null => "null",
                                Value::Bool(_) => "boolean",
                                Value::Number(_) => "number",
                                Value::String(_) => "string",
                                Value::Array(_) => "array",
                                Value::Object(_) => "object",
                            };
                            format!("{path}: {constraint} (received {kind})")
                        },
                        None => path,
                    }
                }).collect();
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
    fn runs_share_compiled_validators_for_identical_schemas() {
        let first = validator(&tool().parameters).unwrap();
        // A later run's catalogue reuses the compiled validator.
        let mut catalog = Catalog::default();
        assert!(catalog.add(&tool()).unwrap());
        assert!(Arc::ptr_eq(&first, &catalog.entries["read"].2));
        assert!(Arc::ptr_eq(&first, &validator(&tool().parameters).unwrap()));
        // A different schema never receives another schema's validator.
        let other = json!({"type":"object","required":["name"]});
        let distinct = validator(&other).unwrap();
        assert!(!Arc::ptr_eq(&first, &distinct));
        assert!(distinct.is_valid(&json!({"name":"x"})));
        assert!(!distinct.is_valid(&json!({"id":1})));
        assert!(validator(&json!({"type":7})).is_err());
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
    fn recovery_disables_only_repeated_invalid_tools_and_preserves_siblings() {
        let mut recovery = Recovery::default();
        let clock = || call("clock-id", "clock", json!({}));
        let search = || call("search-id", "search", json!({}));
        let bad = || "Invalid argument".to_string();
        assert!(!recovery.exhausted(&[clock(), search()], &[bad(), String::new()]));
        assert!(recovery.allows("clock"));
        assert!(recovery.exhausted(&[clock(), search()], &[bad(), String::new()]));
        assert!(!recovery.allows("clock"));
        assert!(recovery.allows("search"));
        // Other tools can correct successfully and recover at a later stage.
        assert!(!recovery.exhausted(&[search()], &[bad()]));
        assert!(!recovery.exhausted(&[search()], &[String::new()]));
        assert!(!recovery.exhausted(&[search()], &[bad()]));
        assert!(recovery.allows("search"));
        assert!(recovery.exhausted(&[search()], &[bad()]));
        assert!(!recovery.allows("search"));
        // Disabled tools stay disabled even if a later proposal is valid.
        assert!(!recovery.exhausted(&[clock()], &[String::new()]));
        assert!(!recovery.allows("clock"));
    }

    #[test]
    fn initial_menu_is_optional_exact_and_keeps_discovery_helpers() {
        let named = |name: &str| ToolDefinition {
            name: name.into(),
            ..tool()
        };
        let tools = vec![
            named("clock"),
            named("agent_skills_tool"),
            named("tool_output_retriever_tool"),
            named("hue__connect"),
            named("unrelated"),
        ];
        assert!(initial_menu(&tools, "Explain clockwise rotation").is_none());
        let names = initial_menu(&tools, "Call `clock` with no arguments.").unwrap();
        assert_eq!(names.len(), 3);
        assert!(names.contains("clock"));
        assert!(!names.contains("unrelated"));
        assert!(
            initial_menu(&tools, "Use hue__list_rooms")
                .unwrap()
                .contains("hue__connect")
        );
        // A reference or negation narrows the menu but still leaves invocation
        // optional. Never convert a textual mention into required tool choice.
        assert!(
            !Requirement::parse(
                &json!({"messages":[{"role":"user","content":"Explain clock without calling it"}]})
            )
            .unwrap()
            .pending()
        );
    }

    #[test]
    fn nullable_integer_feedback_includes_types_and_bounds_without_arguments() {
        let nullable = ToolDefinition {
            parameters: json!({"type":"object","properties":{
                "league_id":{"anyOf":[{"type":"integer","exclusiveMinimum":0},{"type":"null"}]},
                "season":{"anyOf":[{"type":"integer","minimum":2019,"maximum":2100},{"type":"null"}]}
            }}),
            ..tool()
        };
        let mut catalog = Catalog::default();
        catalog.add(&nullable).unwrap();
        let errors = catalog
            .check_batch(
                &[call(
                    "bad",
                    "read",
                    json!({"league_id":"private-league", "season":0}),
                )],
                std::slice::from_ref(&nullable),
            )
            .unwrap();
        assert!(errors[0].contains("integer"));
        assert!(errors[0].contains("null"));
        assert!(errors[0].contains("exclusiveMinimum"));
        assert!(errors[0].contains("2019"));
        assert!(errors[0].contains("2100"));
        assert!(!errors[0].contains("private-league"));
        assert!(errors[0].contains("received string"));
        assert!(errors[0].contains("received number"));
        for (id, args) in [
            ("omit", json!({})),
            ("null", json!({"league_id":null,"season":null})),
            ("valid", json!({"league_id":123,"season":2026})),
        ] {
            assert!(
                catalog
                    .check_batch(&[call(id, "read", args)], std::slice::from_ref(&nullable))
                    .unwrap()[0]
                    .is_empty()
            );
        }
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
