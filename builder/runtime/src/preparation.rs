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

/// Total deadline for the loopback Python tool catalogue, including the body.
/// The shared client bounds only connection setup. This matches Rust MCP
/// discovery's 15-second connection deadline, plus margin for first use.
#[cfg(not(test))]
const CATALOGUE_TIMEOUT: Duration = Duration::from_secs(20);
#[cfg(test)]
const CATALOGUE_TIMEOUT: Duration = Duration::from_secs(1);

pub struct Preparation {
    pub config: Config,
    pub profile_import_max: i64,
    pub documents: tokio::sync::OnceCell<Arc<crate::document_processor::Processor>>,
    pub document_tools: HashMap<String, Arc<crate::document_tools::Adapter>>,
    pub domain_tools: HashMap<String, Arc<crate::domain_retriever::Adapter>>,
    pub docs_tools: HashMap<String, crate::nvidia_docs::Settings>,
    pub search_tools: HashMap<String, crate::perplexity_search::Settings>,
    pub skill_tools: HashMap<String, crate::agent_skills::Tool>,
    pub exploration_tools: HashMap<String, crate::exploration::Tool>,
    pub sandbox_tools: HashMap<String, crate::llm_sandbox::Tool>,
    pub weather_tools: HashMap<String, crate::nws_weather::Tool>,
    pub memory: Memory,
    pub memory_tools: crate::memory_tools::Tools,
    pub outputs: OutputStore,
    pub output_readers: HashMap<String, crate::output::OutputReader>,
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

pub fn private_sources_allowed(policy: &Value) -> bool {
    !policy["disabledSources"]
        .as_array()
        .is_some_and(|sources| sources.iter().any(|source| source == "workspace_data"))
        && policy["enabledSources"].as_array().is_none_or(|sources| {
            sources.is_empty() || sources.iter().any(|source| source == "workspace_data")
        })
}

pub fn clock_schema(name: &str, raw: &Value) -> Value {
    let description = raw
        .get("description")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            crate::tool_contracts::POLICY["clock_description"]
                .as_str()
                .unwrap()
        });
    json!({"name": name, "description": description, "parameters": {"additionalProperties": false, "properties": {}, "title": "nowInput", "type": "object"}})
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
    if additional.get("context_workflow_id").is_some_and(|value| {
        value
            .as_str()
            .is_none_or(|id| uuid::Uuid::parse_str(id).is_err())
    }) {
        bail!("Invalid context workflow identity");
    }
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
    let isolation = crate::routing::IsolationConfig::from_config(config)?;
    if isolation.is_none() && effective != "default" && !routes.contains_key(effective) {
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
    if isolation.is_none() && !autonomous_model && effective != "default" {
        model["model_name"] = json!(routes[effective]);
    }
    // Resolve privacy before memory loading or capability promotion. Legacy
    // client metadata cannot select or widen the trusted endpoint registry.
    if let Some(isolation) = isolation {
        let route = isolation.resolve_coordinator(effective)?;
        model = serde_json::to_value(route.model)?;
        explicit = true;
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
    pub fn new(config: Config) -> Result<Arc<Self>> {
        let mut output_readers = HashMap::new();
        let mut document_tools = HashMap::new();
        let mut domain_tools = HashMap::new();
        let mut docs_tools = HashMap::new();
        let mut search_tools = HashMap::new();
        let mut skill_tools = HashMap::new();
        let mut exploration_tools = HashMap::new();
        let mut sandbox_tools = HashMap::new();
        let mut weather_tools = HashMap::new();
        let embedders = Arc::new(crate::embeddings::Registry::new(&config.raw));
        if let Some(functions) = config.raw["functions"].as_object() {
            for (name, raw) in functions {
                if raw["_type"] == "nws_weather" {
                    weather_tools.insert(name.clone(), crate::nws_weather::Tool::new(raw)?);
                }
                if raw["_type"] == "sandbox_exploration" {
                    exploration_tools.insert(
                        name.clone(),
                        crate::exploration::Tool::new(raw, &config.env)?,
                    );
                }
                if raw["_type"] == "llm_sandbox" {
                    sandbox_tools.insert(
                        name.clone(),
                        crate::llm_sandbox::Tool::new(raw, &config.env)?,
                    );
                }
                if raw["_type"] == "agent_skills" {
                    skill_tools.insert(
                        name.clone(),
                        crate::agent_skills::Tool::new(raw, &config.env)?,
                    );
                }
                if raw["_type"] == "perplexity_search" {
                    search_tools.insert(
                        name.clone(),
                        crate::perplexity_search::Settings::new(raw, &config.env)?,
                    );
                }
                if raw["_type"] == "nvidia_docs" {
                    docs_tools.insert(name.clone(), crate::nvidia_docs::Settings::new(raw)?);
                }
                if raw["_type"] == "domain_retriever" {
                    domain_tools.insert(
                        name.clone(),
                        Arc::new(crate::domain_retriever::Adapter::with_embedders(
                            &config,
                            raw,
                            embedders.clone(),
                        )?),
                    );
                }
                if raw["_type"] == "tool_output_retriever" {
                    output_readers.insert(name.clone(), crate::output::OutputReader::new(&config)?);
                }
                if raw["_type"] == "nat_nv_ingest" {
                    document_tools.insert(
                        name.clone(),
                        Arc::new(crate::document_tools::Adapter::with_embedders(
                            &config,
                            raw,
                            embedders.clone(),
                        )?),
                    );
                }
            }
        }
        if let Some(mappings) = config.workflow()["skill_model_profiles"].as_object()
            && !mappings.is_empty()
        {
            let selected = names(config.workflow().get("tools"))?;
            let available = skill_tools
                .iter()
                .filter(|(name, tool)| selected.contains(name) && tool.settings.exposes_loading())
                .map(|(_, tool)| {
                    // Validation uses a separate configuration/parser in the retained
                    // registry. Do not initialize the tool's lazy catalog here.
                    crate::agent_skills::Parser::discover(std::path::Path::new(
                        tool.settings.values["skills_directory"].as_str().unwrap(),
                    ))
                    .map(|parser| parser.names())
                })
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            if mappings.keys().any(|name| !available.contains(name)) {
                bail!("Unknown or unavailable skill_model_profiles");
            }
        }
        Ok(Arc::new(Self {
            output_readers,
            documents: tokio::sync::OnceCell::new(),
            document_tools,
            domain_tools,
            docs_tools,
            search_tools,
            skill_tools,
            sandbox_tools,
            exploration_tools,
            weather_tools,
            profile_import_max: integer(&json!(
                config.variable("PROFILE_IMPORT_MAX_ENTRIES", "250")
            ))?,
            mcp: if config.variable("DAEDALUS_AUTHORIZATION", "rust") == "rust" {
                Some(crate::mcp::Mcp::new(&config)?)
            } else {
                None
            },
            telemetry: crate::telemetry::Telemetry::new(&config)?,
            outputs: OutputStore::new(&config)?,
            memory: Memory::new(&config)?,
            memory_tools: crate::memory_tools::Tools::new(&config)?,
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
        let protected = crate::routing::IsolationConfig::from_config(&self.config)?.is_some();
        crate::context_state::enforce(
            &self.config,
            header(headers, "x-user-id"),
            header(headers, "x-conversation-id"),
            body["additional_props"]["context_workflow_id"]
                .as_str()
                .unwrap_or_else(|| header(headers, "x-run-id")),
            protected,
        )
        .await?;
        let workflow = self.config.workflow();
        let selected = names(workflow.get(
            if prepared.daily_summary && workflow.get("daily_summary_tools").is_some() {
                "daily_summary_tools"
            } else {
                "tools"
            },
        ))?;
        // Neither operation depends on the other. Keep both futures owned by
        // this request so cancellation or a catalogue failure drops all work.
        let (tools, context) = tokio::try_join!(
            self.prepare_tools(http, tools_url, headers, body, &selected),
            async {
                if private_sources_allowed(&body["additional_props"]["sourcePolicy"]) {
                    self.prepare_memory(headers, &query, autonomy, protected)
                        .await
                } else {
                    Ok(None)
                }
            },
        )?;
        prepared.tools = tools;
        if let Some(context) = context
            && let Some(index) = prepared.messages.iter().rposition(|m| m.role == "user")
        {
            prepared.messages.insert(
                index,
                ChatMessage {
                    role: "user".into(),
                    content: context,
                },
            );
        }
        Ok(prepared)
    }

    async fn prepare_tools(
        &self,
        http: &reqwest::Client,
        tools_url: &str,
        headers: &HeaderMap,
        body: &Value,
        selected: &[String],
    ) -> Result<Vec<rig_core::completion::ToolDefinition>> {
        let mut schemas = HashMap::new();
        let mut external = Vec::new();
        let mut groups = Vec::new();
        for name in selected {
            let raw = &self.config.raw["functions"][name];
            if raw["_type"] == "current_datetime" {
                schemas.insert(name.clone(), vec![clock_schema(name, raw)]);
            } else if raw["_type"] == "tool_output_retriever" {
                schemas.insert(
                    name.clone(),
                    vec![crate::output_retriever::schema(name, raw)],
                );
            } else if crate::memory_tools::owns(raw["_type"].as_str().unwrap_or("")) {
                schemas.insert(name.clone(), vec![crate::memory_tools::schema(name, raw)]);
            } else if raw["_type"] == "nat_nv_ingest" {
                schemas.insert(name.clone(), vec![self.document_tools[name].schema(name)]);
            } else if raw["_type"] == "domain_retriever" {
                schemas.insert(name.clone(), vec![self.domain_tools[name].schema(name)]);
            } else if raw["_type"] == "nvidia_docs" {
                schemas.insert(name.clone(), vec![self.docs_tools[name].schema(name)?]);
            } else if raw["_type"] == "perplexity_search" {
                schemas.insert(name.clone(), vec![self.search_tools[name].schema(name)?]);
            } else if raw["_type"] == "agent_skills" {
                schemas.insert(name.clone(), vec![self.skill_tools[name].schema(name)?]);
            } else if raw["_type"] == "sandbox_exploration" {
                schemas.insert(
                    name.clone(),
                    vec![self.exploration_tools[name].schema(name)],
                );
            } else if raw["_type"] == "llm_sandbox" {
                schemas.insert(name.clone(), vec![self.sandbox_tools[name].schema(name)?]);
            } else if raw["_type"] == "nws_weather" {
                schemas.insert(name.clone(), vec![self.weather_tools[name].schema(name)?]);
            } else if self.mcp.is_some() && self.config.raw["function_groups"].get(name).is_some() {
                groups.push(name.clone());
            } else {
                external.push(name.clone());
            }
        }
        // The executor catalogue and both MCP discovery sets are independent
        // first-use I/O. Keep every future owned by this request so a failure
        // or cancellation drops the rest.
        let python = async {
            if external.is_empty() {
                return Ok(HashMap::new());
            }
            http.post(format!("{tools_url}/runtime/v1/catalog"))
                .timeout(CATALOGUE_TIMEOUT)
                .headers(headers.clone())
                .json(&json!({"version":1,"names":external}))
                .send()
                .await?
                .error_for_status()?
                .json::<HashMap<String, Vec<Value>>>()
                .await
                .map_err(anyhow::Error::from)
        };
        let discovered = async {
            let Some(mcp) = &self.mcp else {
                return Ok(HashMap::new());
            };
            // Explicit API tool selection must still work when its group is
            // deferred. Discovery reads schemas; execution retains its gate.
            let requirement = crate::tool_contracts::Requirement::parse(body)?;
            let (eager, deferred): (Vec<_>, Vec<_>) = groups.into_iter().partition(|group| {
                matches!(&requirement, crate::tool_contracts::Requirement::Named(name)
                    if name.starts_with(&format!("{group}__")) && name != &format!("{group}__connect"))
            });
            let user = header(headers, "x-user-id");
            let (mut deferred, eager) = tokio::join!(
                mcp.catalogue(&deferred, user, true),
                mcp.catalogue(&eager, user, false),
            );
            deferred.extend(eager);
            Ok::<_, anyhow::Error>(deferred)
        };
        let (catalogue, discovered) = tokio::try_join!(python, discovered)?;
        for name in external {
            let entries = catalogue
                .get(&name)
                .ok_or_else(|| anyhow!("Required tool catalogue missing"))?;
            schemas.insert(name, entries.clone());
        }
        schemas.extend(discovered);
        // Python orders all native tools before MCP tools; preserve this model-facing contract.
        let mut tools = Vec::new();
        for is_group in [false, true] {
            for name in selected {
                if self.config.raw["function_groups"].get(name).is_some() != is_group {
                    continue;
                }
                for schema in schemas.remove(name).unwrap_or_default() {
                    tools.push(serde_json::from_value(schema)?);
                }
            }
        }
        Ok(tools)
    }

    async fn prepare_memory(
        &self,
        headers: &HeaderMap,
        query: &str,
        autonomy: bool,
        protected: bool,
    ) -> Result<Option<String>> {
        if !autonomy {
            let budget = self
                .config
                .variable("DAEDALUS_MEMORY_CONTEXT_TIMEOUT_SECONDS", "2.5")
                .parse::<f64>()
                .unwrap_or(2.5)
                .max(0.1);
            let user = header(headers, "x-user-id");
            let conversation = header(headers, "x-conversation-id");
            match tokio::time::timeout(Duration::from_secs_f64(budget.min(3600.)), async {
                if protected {
                    self.memory.read_only_context(user, query).await
                } else {
                    self.memory.context(user, conversation, query).await
                }
            })
            .await
            {
                Ok(Ok(context)) if !context.is_empty() => {
                    return Ok(Some(context));
                }
                Ok(Ok(_)) => {}
                _ => tracing::warn!(event = "memory_context_unavailable"),
            }
        }
        Ok(None)
    }
}

pub fn header<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, extract::State, http::Uri, routing::post};
    use tokio::sync::Barrier;

    fn configuration(base: &str, redis: &str) -> Config {
        Config::new(
            json!({
                "llms":{"main":{"base_url":"http://model.invalid","model_name":"fixture"}},
                "functions":{"feed":{"_type":"rss_feed"},"clock":{"_type":"current_datetime"}},
                "workflow":{"_type":"daedalus_rust_agent","llm_name":"main","tools":["feed","clock"]}
            }),
            [
                ("REDIS_URL".into(), redis.into()),
                ("HINDSIGHT_API_URL".into(), base.into()),
                ("HINDSIGHT_API_KEY".into(), "synthetic-memory-key".into()),
                ("DAEDALUS_MEMORY_CONTEXT_TIMEOUT_SECONDS".into(), "30".into()),
            ].into(),
        ).unwrap()
    }

    fn protected_memory_configuration(base: &str, redis: &str) -> Config {
        let mut registered_redis = reqwest::Url::parse(redis).unwrap();
        registered_redis.set_username("").unwrap();
        registered_redis.set_password(None).unwrap();
        registered_redis.set_query(None);
        registered_redis.set_fragment(None);
        if registered_redis.port().is_none() {
            registered_redis.set_port(Some(6379)).unwrap();
        }
        if matches!(registered_redis.path(), "" | "/") {
            registered_redis.set_path("/0");
        }
        Config::new(
            json!({
                "llms":{"main":{"base_url":format!("{base}/v1"),"model_name":"local-fixture","api_type":"chat"}},
                "functions":{"clock":{"_type":"current_datetime"}},
                "workflow":{"_type":"daedalus_rust_agent","llm_name":"main","tools":["clock"],
                    "context_isolation":{"enabled":true,"policy_version":"memory-read-only-v1","coordinator":"local",
                        "destinations":{"local":{"llm":"main","trust":"trusted_local","transport":"direct"}},
                        "worker_profiles":{},"trusted_local_services":{"redis":registered_redis.as_str(),"hindsight":base}}}
            }),
            [
                ("REDIS_URL".into(), redis.into()),
                ("HINDSIGHT_API_URL".into(), base.into()),
                ("HINDSIGHT_API_KEY".into(), "synthetic-memory-key".into()),
                ("DAEDALUS_MEMORY_CONTEXT_TIMEOUT_SECONDS".into(), "0.1".into()),
            ].into(),
        ).unwrap()
    }

    /// Real HTTP rejects every bootstrap/generative endpoint, while Redis
    /// supplies actual durable enrollment and an older session-cache entry.
    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_preparation_reads_memory_and_fences_rollback_before_private_io() {
        use axum::response::IntoResponse;
        let redis = std::env::var("DAEDALUS_TEST_REDIS_URL").unwrap();
        let calls = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let seen = calls.clone();
        let router = Router::new().fallback(move |method: axum::http::Method, uri: Uri| {
            let seen = seen.clone();
            async move {
                seen.lock().await.push(format!("{method} {}", uri.path()));
                if method == axum::http::Method::GET && uri.path().ends_with("/knowledge-base/search") {
                    Json(json!({"results":[]})).into_response()
                } else if method == axum::http::Method::POST && uri.path().ends_with("/memories/recall") {
                    Json(json!({"results":[{"text":"Synthetic bounded memory fact","type":"world"}]})).into_response()
                } else {
                    axum::http::StatusCode::METHOD_NOT_ALLOWED.into_response()
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let peer = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut config = protected_memory_configuration(&base, &redis);
        config
            .env
            .insert("DAEDALUS_MEMORY_CONTEXT_TIMEOUT_SECONDS".into(), "5".into());
        let user = format!("memory-read-only-{}", uuid::Uuid::new_v4());
        let conversation = uuid::Uuid::new_v4().to_string();
        let store = crate::storage::Store::new(&config).unwrap();
        store
            .set(
                &format!(
                    "daedalus:memory:session:v1:{}:{}",
                    crate::memory::digest(&[&crate::memory::bank_id(&user)]),
                    crate::memory::digest(&[&conversation])
                ),
                &json!({"text":"Cached synthesis must not be reused","reflected_at":0}).to_string(),
                60,
            )
            .await
            .unwrap();
        let preparation = Preparation::new(config.clone()).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-user-id", user.parse().unwrap());
        headers.insert("x-conversation-id", conversation.parse().unwrap());
        headers.insert(
            "x-run-id",
            uuid::Uuid::new_v4().to_string().parse().unwrap(),
        );
        let body = json!({"messages":[{"role":"user","content":"Summarize my projects"}]});
        let run = preparation
            .prepare(&reqwest::Client::new(), &base, &headers, &body)
            .await
            .unwrap();
        assert_eq!(run.messages.len(), 2);
        assert!(
            run.messages[0]
                .content
                .contains("Synthetic bounded memory fact")
        );
        assert!(
            !run.messages[0]
                .content
                .contains("Cached synthesis must not be reused")
        );
        assert_eq!(run.model.base_url, format!("{base}/v1"));
        let initial_calls = calls.lock().await.clone();
        assert_eq!(initial_calls.len(), 2, "{initial_calls:?}");
        assert!(
            initial_calls[0].starts_with("GET ")
                && initial_calls[0].ends_with("/knowledge-base/search")
        );
        assert!(
            initial_calls[1].starts_with("POST ") && initial_calls[1].ends_with("/memories/recall")
        );

        let mut rollback = config.raw.clone();
        rollback["workflow"]
            .as_object_mut()
            .unwrap()
            .remove("context_isolation");
        let rollback = Preparation::new(Config::new(rollback, config.env).unwrap()).unwrap();
        headers.insert(
            "x-conversation-id",
            uuid::Uuid::new_v4().to_string().parse().unwrap(),
        );
        assert!(
            rollback
                .prepare(&reqwest::Client::new(), &base, &headers, &body)
                .await
                .is_err()
        );
        assert_eq!(
            *calls.lock().await,
            initial_calls,
            "enrolled rollback performed private IO"
        );
        peer.abort();
    }

    #[tokio::test]
    async fn protected_optional_memory_timeout_has_no_legacy_fallback() {
        let calls = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let seen = calls.clone();
        let router = Router::new().fallback(move |method: axum::http::Method, uri: Uri| {
            let seen = seen.clone();
            async move {
                seen.lock().await.push(format!("{method} {}", uri.path()));
                std::future::pending::<Json<Value>>().await
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let peer = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let (redis, policy_store) = crate::context_state::empty_policy_store().await;
        let config = protected_memory_configuration(&base, &redis);
        let preparation = Preparation::new(config).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-user-id", "synthetic-alice".parse().unwrap());
        let context = tokio::time::timeout(
            Duration::from_secs(2),
            preparation.prepare_memory(&headers, "Summarize my projects", false, true),
        )
        .await
        .expect("optional memory must retain its deadline")
        .unwrap();
        assert!(context.is_none());
        let calls = calls.lock().await;
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert!(calls[0].ends_with("/knowledge-base/search"));
        peer.abort();
        policy_store.abort();
    }

    #[tokio::test]
    async fn memory_and_catalogue_overlap_and_preserve_message_and_tool_order() {
        async fn catalogue(State(barrier): State<Arc<Barrier>>) -> Json<Value> {
            // A sequential implementation cannot pass this rendezvous: memory
            // must reach its HTTP peer while the catalogue is still pending.
            barrier.wait().await;
            Json(
                json!({"feed":[{"name":"feed","description":"Fixture feed","parameters":{"type":"object","properties":{}}}]}),
            )
        }
        async fn memory(
            State(barrier): State<Arc<Barrier>>,
            method: axum::http::Method,
            uri: Uri,
        ) -> Json<Value> {
            if uri.path().ends_with("/config") && method == axum::http::Method::GET {
                barrier.wait().await;
            }
            Json(if uri.path().ends_with("/knowledge-base/search") {
                json!({"results":[{"id":"fixture-page"}]})
            } else if uri.path().ends_with("/knowledge-base/pages/fixture-page") {
                json!({"name":"Fixture page","body":"Remembered project preference"})
            } else {
                json!({})
            })
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/runtime/v1/catalog", post(catalogue))
            .fallback(memory)
            .with_state(Arc::new(Barrier::new(2)));
        let peer = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let http = reqwest::Client::new();
        let (redis, policy_store) = crate::context_state::empty_policy_store().await;
        let preparation = Preparation::new(configuration(&base, &redis)).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-user-id", "fixture-user".parse().unwrap());
        headers.insert("x-run-id", "fixture-run".parse().unwrap());
        let body = json!({"messages":[
            {"role":"user","content":"Earlier question"},
            {"role":"assistant","content":"Earlier answer"},
            {"role":"user","content":"Review my project preferences"}
        ]});
        let run = tokio::time::timeout(
            Duration::from_secs(5),
            preparation.prepare(&http, &base, &headers, &body),
        )
        .await
        .expect("memory and catalogue must proceed together")
        .unwrap();
        peer.abort();
        policy_store.abort();
        assert_eq!(
            run.tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            ["feed", "clock"]
        );
        assert_eq!(run.messages.len(), 4);
        assert_eq!(run.messages[0].content, "Earlier question");
        assert_eq!(run.messages[1].content, "Earlier answer");
        assert!(
            run.messages[2]
                .content
                .contains("Remembered project preference")
        );
        assert_eq!(run.messages[3].content, "Review my project preferences");
    }

    #[tokio::test]
    async fn catalogue_failure_does_not_wait_for_optional_memory_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .route(
                "/runtime/v1/catalog",
                post(|State(barrier): State<Arc<Barrier>>| async move {
                    barrier.wait().await;
                    axum::http::StatusCode::SERVICE_UNAVAILABLE
                }),
            )
            .fallback(|State(barrier): State<Arc<Barrier>>| async move {
                barrier.wait().await;
                std::future::pending::<Json<Value>>().await
            })
            .with_state(Arc::new(Barrier::new(2)));
        let peer = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let http = reqwest::Client::new();
        let (redis, policy_store) = crate::context_state::empty_policy_store().await;
        let preparation = Preparation::new(configuration(&base, &redis)).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-user-id", "fixture-user".parse().unwrap());
        headers.insert("x-run-id", "fixture-run".parse().unwrap());
        let body = json!({"messages":[{"role":"user","content":"Review my project preferences"}]});
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            preparation.prepare(&http, &base, &headers, &body),
        )
        .await
        .expect("catalogue failure must cancel pending memory preparation");
        peer.abort();
        policy_store.abort();
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn an_unresponsive_catalogue_ends_preparation_at_its_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new().route(
            "/runtime/v1/catalog",
            post(std::future::pending::<Json<Value>>),
        );
        let peer = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let (redis, policy_store) = crate::context_state::empty_policy_store().await;
        let config = Config::new(
            json!({
                "llms":{"main":{"base_url":"http://model.invalid","model_name":"fixture"}},
                "functions":{"feed":{"_type":"rss_feed"}},
                "workflow":{"_type":"daedalus_rust_agent","llm_name":"main","tools":["feed"]}
            }),
            [
                ("REDIS_URL".into(), redis),
                ("DAEDALUS_MEMORY_MODE".into(), "disabled".into()),
            ]
            .into(),
        )
        .unwrap();
        let preparation = Preparation::new(config).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-user-id", "fixture-user".parse().unwrap());
        headers.insert("x-run-id", "fixture-run".parse().unwrap());
        let body = json!({"messages":[{"role":"user","content":"Read my feeds"}]});
        let started = tokio::time::Instant::now();
        // Without a total deadline, preparation waits for the run deadline.
        let result = tokio::time::timeout(
            CATALOGUE_TIMEOUT * 5,
            preparation.prepare(&reqwest::Client::new(), &base, &headers, &body),
        )
        .await
        .expect("an unresponsive catalogue must end preparation at its own deadline");
        peer.abort();
        policy_store.abort();
        assert!(result.is_err());
        assert!(started.elapsed() >= CATALOGUE_TIMEOUT);
    }

    /// Python catalogue plus one deferred group with initial tools and one
    /// eager group. All three need independent first-use network work.
    fn discovery(base: &str, redis: &str) -> Config {
        let server = json!({"url":format!("{base}/mcp")});
        Config::new(
            json!({
                "llms":{"main":{"base_url":"http://model.invalid","model_name":"fixture"}},
                "functions":{"feed":{"_type":"rss_feed"}},
                "function_groups":{
                    "lights":{"_type":"mcp_client","server":server,"defer_discovery":true,
                        "discovery_description":"Synthetic lights","initial_tools":["read"]},
                    "mail":{"_type":"per_user_mcp_client","server":server}
                },
                "workflow":{"_type":"daedalus_rust_agent","llm_name":"main",
                    "tools":["feed","lights","mail"]}
            }),
            [
                ("REDIS_URL".into(), redis.into()),
                ("DAEDALUS_MEMORY_MODE".into(), "disabled".into()),
            ]
            .into(),
        )
        .unwrap()
    }

    async fn mcp(Json(request): Json<Value>) -> axum::response::Response {
        use axum::response::IntoResponse;
        let Some(id) = request.get("id") else {
            return axum::http::StatusCode::ACCEPTED.into_response();
        };
        let result = match request["method"].as_str().unwrap_or("") {
            "initialize" => json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},
                "serverInfo":{"name":"synthetic","version":"1"}}),
            "tools/list" => {
                let tools = ["read", "write"].map(|name| {
                    json!({"name":name,"description":format!("Synthetic {name}"),
                        "inputSchema":{"type":"object"}})
                });
                json!({ "tools": tools })
            }
            _ => json!({}),
        };
        Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response()
    }

    #[tokio::test]
    async fn catalogue_sources_are_discovered_together_in_selected_order() {
        // A serial implementation cannot pass: the Python catalogue waits
        // until both MCP groups have begun their first-use initialization.
        let barrier = Arc::new(Barrier::new(3));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .route(
                "/runtime/v1/catalog",
                post(|State(barrier): State<Arc<Barrier>>| async move {
                    barrier.wait().await;
                    Json(json!({"feed":[{"name":"feed","description":"Fixture feed",
                        "parameters":{"type":"object","properties":{}}}]}))
                }),
            )
            .route(
                "/mcp",
                post(
                    |State(barrier): State<Arc<Barrier>>, Json(request): Json<Value>| async move {
                        if request["method"] == "initialize" {
                            barrier.wait().await;
                        }
                        mcp(Json(request)).await
                    },
                ),
            )
            .with_state(barrier);
        let peer = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let http = reqwest::Client::new();
        let (redis, policy_store) = crate::context_state::empty_policy_store().await;
        let preparation = Preparation::new(discovery(&base, &redis)).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-user-id", "fixture-user".parse().unwrap());
        headers.insert("x-run-id", "fixture-run".parse().unwrap());
        let body = json!({"messages":[{"role":"user","content":"Check my lights"}]});
        let run = tokio::time::timeout(
            Duration::from_secs(5),
            preparation.prepare(&http, &base, &headers, &body),
        )
        .await
        .expect("independent catalogue sources must proceed together")
        .unwrap();
        peer.abort();
        policy_store.abort();
        assert_eq!(
            run.tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            [
                "feed",
                "lights__read",
                "lights__connect",
                "mail__read",
                "mail__write"
            ]
        );
    }
}
