//! Rust-owned run preparation; the optional executor only supplies tool schemas.
use crate::{
    agent::{ChatMessage, ModelConfig, PreparedRun},
    config::{Config, integer, names, number, truthy},
    memory::Memory,
    output::OutputStore,
};
use anyhow::{Result, anyhow, bail};
use http::HeaderMap;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc, time::Duration};

pub struct Preparation {
    pub config: Config,
    pub memory: Memory,
    pub outputs: OutputStore,
    pub telemetry: Option<crate::telemetry::Telemetry>,
    pub mcp: Option<Arc<crate::mcp::Mcp>>,
}

pub struct ModelSelection {
    pub requested: Option<String>,
    pub effective: String,
    pub source: &'static str,
    pub promotion_count: i64,
    pub triggering_skill: Option<String>,
}
impl ModelSelection {
    pub fn new(config: &Config, body: &Value, daily: bool, autonomy: bool) -> Self {
        // A complete autonomous provider override resolves to the baseline's
        // fixed default selection, including telemetry and disabled promotions.
        if autonomy
            && !config
                .variable("AUTONOMOUS_LLM_MODEL_MODEL", "")
                .trim()
                .is_empty()
        {
            return Self {
                requested: Some("default".into()),
                effective: "default".into(),
                source: "default",
                promotion_count: 0,
                triggering_skill: None,
            };
        }
        let requested = body["additional_props"]["model_profile"]
            .as_str()
            .map(str::to_owned);
        let mapped = config.workflow()["request_model_profiles"]
            [if daily { "daily_summary" } else { "default" }]
        .as_str();
        Self {
            effective: requested.as_deref().or(mapped).unwrap_or("default").into(),
            source: if requested.is_some() {
                "explicit"
            } else if mapped.is_some() {
                "request_profile"
            } else {
                "default"
            },
            requested,
            promotion_count: 0,
            triggering_skill: None,
        }
    }
    pub fn skill_loaded(&mut self, config: &Config, skills: &[String]) -> Option<String> {
        if self.requested.is_some() || self.effective != "default" {
            return None;
        }
        let skill = skills
            .iter()
            .find(|s| config.workflow()["skill_model_profiles"][s.as_str()] == "deep")?;
        self.effective = "deep".into();
        self.source = "skill_load";
        self.promotion_count += 1;
        self.triggering_skill = Some(skill.clone());
        Some(self.effective.clone())
    }
}

pub fn history(messages: &[Value], max_messages: usize, max_tokens: usize) -> Vec<Value> {
    let candidates = &messages[messages.len().saturating_sub(max_messages)..];
    let mut result = Vec::new();
    let mut tokens = 0;
    for message in candidates.iter().rev() {
        let cost = 8 + serde_json::to_vec(message)
            .unwrap_or_default()
            .len()
            .div_ceil(3);
        if !result.is_empty() && tokens + cost > max_tokens {
            break;
        }
        tokens += cost;
        result.push(message.clone());
    }
    result.reverse();
    while result.len() > 1
        && !["human", "system", "user"].contains(
            &result[0]["role"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .as_str(),
        )
    {
        result.remove(0);
    }
    result
}

pub fn profile(query: &str, autonomy: bool) -> &'static str {
    let normalized = query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if !autonomy
        && [
            "daily summary",
            "daily summaries",
            "daily briefing",
            "daily briefings",
            "daily brief",
            "daily summry",
            "morning briefing",
            "morning brief",
            "catch me up on today",
        ]
        .iter()
        .any(|s| normalized.contains(s))
    {
        "daily_summary"
    } else {
        "default"
    }
}

pub fn clock_schema(name: &str, raw: &Value) -> Value {
    json!({"name": name, "description": raw.get("description").and_then(Value::as_str).unwrap_or(""), "parameters": {"additionalProperties": false, "properties": {}, "title": "nowInput", "type": "object"}})
}

pub fn base_prepare(
    config: &Config,
    body: &Value,
    autonomy: bool,
) -> Result<(PreparedRun, String)> {
    let messages = body["messages"]
        .as_array()
        .filter(|m| !m.is_empty())
        .ok_or_else(|| anyhow!("messages must be a nonempty array"))?;
    if messages.iter().any(|m| {
        !["user", "assistant"].contains(&m["role"].as_str().unwrap_or(""))
            || !m["content"].is_string()
    }) {
        bail!("Messages require a user or assistant role and text content");
    }
    let selected = history(
        messages,
        config.integer_limit("max_history", 50)?,
        config.integer_limit("max_history_tokens", 32000)?,
    );
    let query = selected
        .iter()
        .rev()
        .find(|m| m["role"] == "user")
        .and_then(|m| m["content"].as_str())
        .unwrap_or("")
        .to_string();
    let request_profile = profile(&query, autonomy);
    let workflow = config.workflow();
    let additional = &body["additional_props"];
    if !additional.is_null() && !additional.is_object() {
        bail!("additional_props must be an object");
    }
    let requested = additional.get("model_profile");
    if requested.is_some_and(|p| {
        serde_json::from_value::<crate::protocol::ModelProfile>(p.clone()).is_err()
    }) {
        bail!("Invalid model_profile");
    }
    let routes: HashMap<String, String> = workflow
        .get("model_routes")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").trim().to_string()))
                .collect()
        })
        .unwrap_or_default();
    let effective = requested
        .and_then(Value::as_str)
        .or_else(|| workflow["request_model_profiles"][request_profile].as_str())
        .unwrap_or("default");
    if effective != "default" && !routes.contains_key(effective) {
        bail!("Requested model profile is not configured");
    }
    let mut model = config.main_model().clone();
    let mut explicit = requested.is_some();
    let mut autonomous_model = false;
    if autonomy {
        let values = [
            "AUTONOMOUS_LLM_MODEL_BASE_URL",
            "AUTONOMOUS_LLM_MODEL_API_KEY",
            "AUTONOMOUS_LLM_MODEL_MODEL",
        ]
        .map(|key| config.variable(key, "").trim().to_owned());
        if values.iter().any(|s| !s.is_empty()) {
            if values.iter().any(String::is_empty) {
                bail!("Incomplete autonomous model configuration");
            }
            let url = reqwest::Url::parse(&values[0])
                .map_err(|_| anyhow!("Invalid autonomous model URL"))?;
            if url.query().is_some() || url.fragment().is_some() {
                bail!("Invalid autonomous model URL");
            }
            model["base_url"] = json!(values[0]);
            model["api_key"] = json!(values[1]);
            model["model_name"] = json!(values[2]);
            model["api_type"] = json!("responses");
            crate::config::validate_model(&model)?;
            explicit = true;
            autonomous_model = true;
        }
    }
    if !autonomous_model && effective != "default" {
        model["model_name"] = json!(routes[effective]);
    }
    let prepared = PreparedRun {
        model: ModelConfig {
            base_url: model["base_url"].as_str().unwrap_or("").into(),
            api_key: model["api_key"].as_str().unwrap_or("").into(),
            model_name: model["model_name"].as_str().unwrap_or("").into(),
            api_type: model
                .get("api_type")
                .and_then(Value::as_str)
                .unwrap_or("responses")
                .into(),
            max_retries: model
                .get("max_retries")
                .map(integer)
                .transpose()?
                .unwrap_or(3) as usize,
            request_timeout: model
                .get("request_timeout")
                .map(number)
                .transpose()?
                .unwrap_or(60.),
        },
        instructions: workflow
            .get("instructions")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        messages: selected
            .into_iter()
            .map(serde_json::from_value)
            .collect::<Result<Vec<ChatMessage>, _>>()?,
        tools: Vec::new(),
        max_iterations: config.integer_limit("max_iterations", 128)?,
        model_routes: routes,
        explicit_model_profile: explicit,
        daily_summary: request_profile == "daily_summary",
        final_tools: names(workflow.get("daily_summary_final_tools"))?,
        research_budget_seconds: config.limit("daily_summary_research_budget_seconds", 300.),
        repeated_error_limit: if workflow["loop_guard"].get("enabled").is_none_or(truthy) {
            workflow["loop_guard"]
                .get("repeated_error_limit")
                .map(integer)
                .transpose()?
                .unwrap_or(4)
                .max(0) as usize
        } else {
            0
        },
        parallel_tool_calls: workflow.get("parallel_tool_calls").is_none_or(truthy),
    };
    Ok((prepared, query))
}

impl Preparation {
    pub fn new(config: Config, http: reqwest::Client) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            mcp: if config.variable("DAEDALUS_AUTHORIZATION", "rust") == "rust" {
                Some(crate::mcp::Mcp::new(&config)?)
            } else {
                None
            },
            telemetry: crate::telemetry::Telemetry::new(&config)?,
            outputs: OutputStore::new(&config)?,
            memory: Memory::new(&config, http)?,
            config,
        }))
    }

    pub async fn prepare(
        &self,
        http: &reqwest::Client,
        tools_url: &str,
        headers: &HeaderMap,
        body: &Value,
    ) -> Result<PreparedRun> {
        let autonomy =
            header(headers, "x-daedalus-execution-scope").eq_ignore_ascii_case("autonomy");
        let (mut prepared, query) = base_prepare(&self.config, body, autonomy)?;
        let workflow = self.config.workflow();
        let selected = names(workflow.get(
            if prepared.daily_summary && workflow.get("daily_summary_tools").is_some() {
                "daily_summary_tools"
            } else {
                "tools"
            },
        ))?;
        let mut schemas = HashMap::new();
        let mut external = Vec::new();
        let mut groups = Vec::new();
        for name in &selected {
            let raw = &self.config.raw["functions"][name];
            if raw["_type"] == "current_datetime" {
                schemas.insert(name.clone(), vec![clock_schema(name, raw)]);
            } else if self.mcp.is_some() && self.config.raw["function_groups"].get(name).is_some() {
                groups.push(name.clone());
            } else {
                external.push(name.clone());
            }
        }
        if !external.is_empty() {
            let catalogue: HashMap<String, Vec<Value>> = http
                .post(format!("{tools_url}/runtime/v1/catalog"))
                .headers(headers.clone())
                .json(&json!({"version":1,"names":external}))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            for name in external {
                let entries = catalogue
                    .get(&name)
                    .ok_or_else(|| anyhow!("Required tool catalogue missing"))?;
                schemas.insert(name, entries.clone());
            }
        }
        if let Some(mcp) = &self.mcp {
            schemas.extend(
                mcp.catalogue(&groups, header(headers, "x-user-id"), true)
                    .await,
            );
        }
        // Python orders all native tools before MCP tools; preserve this model-facing contract.
        for is_group in [false, true] {
            for name in &selected {
                if self.config.raw["function_groups"].get(name).is_some() != is_group {
                    continue;
                }
                for schema in schemas.remove(name).unwrap_or_default() {
                    prepared.tools.push(serde_json::from_value(schema)?);
                }
            }
        }
        if !autonomy {
            let budget = self
                .config
                .variable("DAEDALUS_MEMORY_CONTEXT_TIMEOUT_SECONDS", "2.5")
                .parse::<f64>()
                .unwrap_or(2.5)
                .max(0.1);
            let user = header(headers, "x-user-id");
            let conversation = header(headers, "x-conversation-id");
            match tokio::time::timeout(
                Duration::from_secs_f64(budget.min(3600.)),
                self.memory.context(user, conversation, &query),
            )
            .await
            {
                Ok(Ok(context)) if !context.is_empty() => {
                    if let Some(index) = prepared.messages.iter().rposition(|m| m.role == "user") {
                        prepared.messages.insert(
                            index,
                            ChatMessage {
                                role: "user".into(),
                                content: context,
                            },
                        );
                    }
                }
                Ok(Ok(_)) => {}
                _ => tracing::warn!(event = "memory_context_unavailable"),
            }
        }
        Ok(prepared)
    }
}

pub fn header<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim()
}
