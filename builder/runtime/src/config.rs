//! Configuration compatibility boundary. Diagnostics never contain input values.
use anyhow::{Result, anyhow, bail};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub struct Config {
    pub raw: Value,
    pub policy_raw: Value,
    pub env: HashMap<String, String>,
    pub python_tools: bool,
}

pub fn merge(base: &mut Value, overlay: Value) {
    if let (Some(base), Some(overlay)) = (base.as_object_mut(), overlay.as_object()) {
        for (key, value) in overlay {
            if base.get(key).is_some_and(Value::is_object) && value.is_object() {
                merge(base.get_mut(key).unwrap(), value.clone());
            } else {
                base.insert(key.clone(), value.clone());
            }
        }
    } else {
        *base = overlay;
    }
}

fn expand(value: &mut Value, env: &HashMap<String, String>) {
    static VARIABLE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}").unwrap()
    });
    match value {
        Value::String(text) => {
            *text = VARIABLE
                .replace_all(text, |cap: &regex::Captures| {
                    env.get(&cap[1])
                        .filter(|v| !v.is_empty())
                        .cloned()
                        .unwrap_or_else(|| cap.get(2).map_or("", |m| m.as_str()).to_string())
                })
                .into_owned();
        }
        Value::Object(map) => map.values_mut().for_each(|v| expand(v, env)),
        Value::Array(values) => values.iter_mut().for_each(|v| expand(v, env)),
        _ => {}
    }
}

pub fn load(path: &Path, env: &HashMap<String, String>) -> Result<Value> {
    load_with_policy(path, env, false)
}

fn load_with_policy(path: &Path, env: &HashMap<String, String>, policy: bool) -> Result<Value> {
    fn visit(
        path: &Path,
        env: &HashMap<String, String>,
        seen: &mut HashSet<PathBuf>,
        policy: bool,
    ) -> Result<Value> {
        let path = path
            .canonicalize()
            .map_err(|_| anyhow!("Configuration file unavailable"))?;
        if seen.len() >= if policy { 5 } else { 16 } || !seen.insert(path.clone()) {
            bail!("Circular or excessively deep configuration inheritance");
        }
        let text = std::fs::read_to_string(&path)
            .map_err(|_| anyhow!("Configuration file unavailable"))?;
        let mut data = crate::yaml::parse(&text)?;
        let map = data
            .as_object_mut()
            .ok_or_else(|| anyhow!("Application configuration must be a mapping"))?;
        let base = map.remove("base");
        if let Some(base) = base.filter(truthy) {
            let base = base
                .as_str()
                .ok_or_else(|| anyhow!("Invalid configuration base"))?;
            let mut inherited = visit(&path.parent().unwrap().join(base), env, seen, policy)?;
            merge(&mut inherited, data);
            data = inherited;
        }
        if !policy {
            expand(&mut data, env);
        }
        seen.remove(&path);
        Ok(data)
    }
    visit(path, env, &mut HashSet::new(), policy)
}

/// `ALLOW_INSECURE_INTERNAL`, parsed as the Python services do:
/// `value.strip().lower() in ("1", "true", "yes")`.
pub fn allow_insecure_internal(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        ["1", "true", "yes"].contains(
            &crate::memory_tools::trim(value)
                .to_ascii_lowercase()
                .as_str(),
        )
    })
}

pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

pub fn number(value: &Value) -> Result<f64> {
    let n = match value {
        Value::Bool(b) => f64::from(*b),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .map_err(|_| anyhow!("Invalid numeric configuration"))?,
        _ => value
            .as_f64()
            .ok_or_else(|| anyhow!("Invalid numeric configuration"))?,
    };
    if !n.is_finite() {
        bail!("Invalid numeric configuration");
    }
    Ok(n)
}

/// Python's int(value): truncate numeric values, but reject fractional strings.
pub fn integer(value: &Value) -> Result<i64> {
    if let Value::String(text) = value {
        return text
            .trim()
            .parse()
            .map_err(|_| anyhow!("Invalid integer configuration"));
    }
    let value = number(value)?;
    if value < i64::MIN as f64 || value >= i64::MAX as f64 {
        bail!("Invalid integer configuration");
    }
    Ok(value as i64)
}

pub fn names(value: Option<&Value>) -> Result<Vec<String>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    value
        .as_array()
        .ok_or_else(|| anyhow!("Expected a list of names"))?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| anyhow!("Expected a list of names"))
        })
        .collect()
}

impl Config {
    /// Only reviewed stateless tools can overlap same-kind calls.
    pub fn tool_concurrency(&self, name: &str) -> usize {
        let function = &self.raw["functions"][name];
        if matches!(
            function["_type"].as_str(),
            Some("source_verifier" | "webscrape")
        ) {
            function["max_concurrency"].as_u64().unwrap_or(1) as usize
        } else {
            1
        }
    }

    pub fn from_path(path: &Path) -> Result<Self> {
        let env = std::env::vars().collect();
        let policy_raw = load_with_policy(path, &env, true)?;
        let mut config = Self::new(load(path, &env)?, env)?;
        config.policy_raw = policy_raw;
        crate::authorization::Policies::new(&config.policy_raw)?;
        Ok(config)
    }
    pub fn new(raw: Value, env: HashMap<String, String>) -> Result<Self> {
        let python_tools = raw["functions"].as_object().is_some_and(|f| {
            f.values().any(|v| {
                !matches!(
                    v["_type"].as_str(),
                    Some(
                        "current_datetime"
                            | "tool_output_retriever"
                            | "nat_nv_ingest"
                            | "domain_retriever"
                            | "nvidia_docs"
                            | "perplexity_search"
                            | "agent_skills"
                            | "llm_sandbox"
                            | "sandbox_exploration"
                            | "nws_weather"
                    )
                ) && !crate::memory_tools::owns(v["_type"].as_str().unwrap_or(""))
            })
        }) || env
            .get("DAEDALUS_AUTHORIZATION")
            .is_some_and(|s| s == "python")
            && raw["function_groups"]
                .as_object()
                .is_some_and(|g| !g.is_empty());
        let config = Self {
            policy_raw: raw.clone(),
            raw,
            env,
            python_tools,
        };
        config.validate()?;
        match config.variable("DAEDALUS_AUTHORIZATION", "rust").as_str() {
            "rust" | "python" => {}
            _ => bail!("DAEDALUS_AUTHORIZATION must be rust or python"),
        }
        Ok(config)
    }
    pub fn variable(&self, key: &str, default: &str) -> String {
        self.env.get(key).cloned().unwrap_or_else(|| default.into())
    }
    /// Operator attestation for this service's complete LOCAL TEXT processing
    /// chain. This does not attest vision processing or a model alias name.
    pub fn hindsight_local_text_origin(&self) -> Result<Option<String>> {
        let value = self.variable("DAEDALUS_HINDSIGHT_LOCAL_TEXT_ORIGIN", "");
        if value.trim().is_empty() {
            return Ok(None);
        }
        crate::hindsight::local_origin(&value)
            .map(Some)
            .ok_or_else(|| anyhow!("Invalid Hindsight local text processing origin"))
    }
    pub fn workflow(&self) -> &Value {
        &self.raw["workflow"]
    }
    pub fn limit(&self, key: &str, default: f64) -> f64 {
        self.workflow()
            .get(key)
            .and_then(|v| number(v).ok())
            .unwrap_or(default)
    }
    pub fn integer_limit(&self, key: &str, default: usize) -> Result<usize> {
        self.workflow()
            .get(key)
            .map(integer)
            .transpose()?
            .map(|v| usize::try_from(v).map_err(|_| anyhow!("Invalid integer configuration")))
            .unwrap_or(Ok(default))
    }
    pub fn main_model(&self) -> &Value {
        &self.raw["llms"][self.workflow()["llm_name"].as_str().unwrap_or("")]
    }
    fn validate(&self) -> Result<()> {
        self.hindsight_local_text_origin()?;
        let workflow = self.workflow();
        if workflow["_type"] != "daedalus_rust_agent" {
            bail!("workflow._type must be daedalus_rust_agent");
        }
        for (name, default, maximum) in [
            ("max_iterations", 128., 512.),
            ("max_history", 50., 1000.),
            ("max_history_tokens", 32000., 1_000_000.),
            ("daily_summary_research_budget_seconds", 300., 1800.),
            ("daily_summary_synthesis_retry_timeout_seconds", 75., 600.),
        ] {
            let value = workflow
                .get(name)
                .map(number)
                .transpose()
                .map_err(|_| anyhow!("Invalid workflow.{name}"))?
                .unwrap_or(default);
            if !(1.0..=maximum).contains(&value) {
                bail!("Invalid workflow.{name}");
            }
        }
        let empty = json!({});
        let functions = self
            .raw
            .get("functions")
            .unwrap_or(&empty)
            .as_object()
            .ok_or_else(|| anyhow!("Invalid functions"))?;
        let groups = self
            .raw
            .get("function_groups")
            .unwrap_or(&empty)
            .as_object()
            .ok_or_else(|| anyhow!("Invalid function_groups"))?;
        if functions.keys().any(|k| groups.contains_key(k)) {
            bail!("Tool and MCP group names must be distinct");
        }
        // A workflow written for an older image would otherwise surface as an
        // unrelated executor or tool-service failure.
        if let Some(name) = functions
            .iter()
            .find_map(|(name, f)| (f["_type"] == "user_interaction").then_some(name))
        {
            bail!(
                "Retired function type user_interaction: remove functions.{name} and its workflow tool entries; users delete durable memory in the Memory Center"
            );
        }
        if self.python_tools && self.variable("DAEDALUS_TOOL_EXECUTOR", "python") == "disabled" {
            bail!("Configured required tools need the transitional Python executor");
        }
        // NV-Ingest's writer reads collection schemas from Milvus's default
        // database and cannot select another. Metadata, readiness and search
        // must therefore use that database too, or uploads would disappear.
        if !crate::collections::default_database(&self.variable("MILVUS_DATABASE", "")) {
            bail!(
                "MILVUS_DATABASE must be empty or default: document ingestion writes to Milvus's default database, which retrieval and collection metadata share"
            );
        }
        for (name, function) in functions {
            if function["_type"] == "nws_weather" {
                crate::nws_weather::Settings::new(function)?;
            }
            if function["_type"] == "agent_skills" {
                crate::agent_skills::Settings::new(function)?;
            }
            if function["_type"] == "sandbox_exploration" {
                crate::exploration::Tool::new(function, &self.env)?;
            }
            if function["_type"] == "llm_sandbox" {
                crate::llm_sandbox::Settings::new(function, &self.env)?;
            }
            if function["_type"] == "perplexity_search" {
                crate::perplexity_search::Settings::new(function, &self.env)?;
            }
            if function["_type"] == "nvidia_docs" {
                crate::nvidia_docs::Settings::new(function)?;
            }
            let database = |values: &Value| {
                if values["database_name"]
                    .as_str()
                    .is_some_and(|value| !crate::collections::default_database(value))
                {
                    bail!(
                        "functions.{name}.database_name must be empty or default: Milvus collections are read from the default database"
                    );
                }
                Ok(())
            };
            if function["_type"] == "domain_retriever" {
                database(&crate::domain_retriever::Settings::new(function, &self.env)?.values)?;
            }
            if function["_type"] == "nat_nv_ingest" {
                let settings = crate::document_tools::Settings::new(function, &self.env)?;
                database(&settings.values)?;
                // HTTP uploads and collection metadata use the environment
                // value; this tool's ingest, search and listing use the field.
                // A difference would hide each user's upload collection.
                let configured = settings.values["default_collection_name"].as_str();
                let uploads = self.variable("DOCUMENT_INGEST_DEFAULT_COLLECTION", "user_uploads");
                if crate::collections::upload_base(configured)
                    != crate::collections::upload_base(Some(&uploads))
                {
                    bail!(
                        "functions.{name}.default_collection_name must match DOCUMENT_INGEST_DEFAULT_COLLECTION, which uploads and collection metadata use"
                    );
                }
            }
            if crate::memory_tools::owns(function["_type"].as_str().unwrap_or("")) {
                crate::memory_tools::validate(function)?;
            }
            if function["_type"] == "tool_output_retriever" {
                crate::output_retriever::Settings::new(function)?;
            }
            if matches!(
                function["_type"].as_str(),
                Some("source_verifier" | "webscrape")
            ) && let Some(value) = function.get("max_concurrency")
                && !value.as_u64().is_some_and(|n| (1..=8).contains(&n))
            {
                bail!("Invalid stateless tool max_concurrency: expected an integer from 1 to 8");
            }
            if function["_type"] == "current_datetime" {
                if function
                    .as_object()
                    .unwrap()
                    .keys()
                    .any(|k| !["_type", "description", "verbose", "timezone"].contains(&k.as_str()))
                {
                    bail!("Invalid clock configuration");
                }
                if function.get("timezone").is_some_and(|v| !v.is_string())
                    || function
                        .get("description")
                        .is_some_and(|v| !v.is_null() && !v.is_string())
                {
                    bail!("Invalid clock configuration");
                }
            } else if !function["_type"].is_string() {
                bail!("Invalid function type: {name}");
            }
        }
        for (name, group) in groups {
            let deferred = group.get("defer_discovery").unwrap_or(&Value::Bool(false));
            if !deferred.is_boolean() {
                bail!("Invalid function_groups.{name}.defer_discovery");
            }
            let description = group
                .get("discovery_description")
                .and_then(Value::as_str)
                .unwrap_or("");
            if group
                .get("discovery_description")
                .is_some_and(|v| !v.is_string())
                || description.chars().count() > 2000
                || (deferred == true && description.trim().is_empty())
            {
                bail!("Invalid function_groups.{name}.discovery_description");
            }
            let initial = names(group.get("initial_tools"))?;
            let include = names(group.get("include"))?;
            let exclude = names(group.get("exclude"))?;
            if initial.iter().any(|n| {
                n.trim().is_empty()
                    || (!include.is_empty() && !include.contains(n))
                    || (include.is_empty() && exclude.contains(n))
            }) || initial.iter().collect::<HashSet<_>>().len() != initial.len()
                || (!initial.is_empty() && deferred != true)
            {
                bail!("Invalid function_groups.{name}.initial_tools");
            }
        }
        for key in ["tools", "daily_summary_tools", "daily_summary_final_tools"] {
            let items = names(workflow.get(key))?;
            if items.iter().collect::<HashSet<_>>().len() != items.len()
                || items
                    .iter()
                    .any(|n| !functions.contains_key(n) && !groups.contains_key(n))
            {
                bail!("Unknown or duplicate tool in workflow.{key}");
            }
        }
        if self.main_model().is_null() {
            bail!("Unknown main model");
        }
        let models = self.raw["llms"]
            .as_object()
            .ok_or_else(|| anyhow!("Invalid models"))?;
        for model in models.values() {
            validate_model(model)?;
        }
        let routes = workflow
            .get("model_routes")
            .unwrap_or(&empty)
            .as_object()
            .ok_or_else(|| anyhow!("Invalid model_routes"))?;
        for (key, value) in routes {
            if !["deep", "deep_max"].contains(&key.as_str())
                || value
                    .as_str()
                    .is_none_or(|s| s.trim().is_empty() || s.trim().chars().count() > 256)
            {
                bail!("Invalid model_routes");
            }
        }
        let isolated = crate::routing::IsolationConfig::from_config(self)?.is_some();
        for field in ["request_model_profiles", "skill_model_profiles"] {
            let mappings = workflow
                .get(field)
                .unwrap_or(&empty)
                .as_object()
                .ok_or_else(|| anyhow!("Invalid model profiles"))?;
            for (key, value) in mappings {
                if (field == "request_model_profiles" && key != "daily_summary")
                    || !["default", "deep"].iter().any(|s| value == s)
                    || (!isolated && value == "deep" && !routes.contains_key("deep"))
                {
                    bail!("Invalid automatic model mapping");
                }
            }
        }
        Ok(())
    }
}

pub fn validate_model(model: &Value) -> Result<()> {
    let endpoint = model["base_url"]
        .as_str()
        .and_then(|s| reqwest::Url::parse(s).ok())
        .ok_or_else(|| anyhow!("Invalid model base_url"))?;
    if !["http", "https"].contains(&endpoint.scheme())
        || endpoint.host_str().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        bail!("Invalid model base_url");
    }
    if !["responses", "chat"].contains(
        &model
            .get("api_type")
            .and_then(Value::as_str)
            .unwrap_or("responses"),
    ) || model["model_name"]
        .as_str()
        .is_none_or(|s| s.trim().is_empty())
    {
        bail!("Invalid model settings");
    }
    for (key, default, min, max) in [
        ("max_retries", 3., 0., 8.),
        ("request_timeout", 60., 1., 3600.),
    ] {
        let value = if key == "max_retries" {
            model
                .get(key)
                .map(integer)
                .transpose()?
                .map(|v| v as f64)
                .unwrap_or(default)
        } else {
            model.get(key).map(number).transpose()?.unwrap_or(default)
        };
        if !(min..=max).contains(&value) {
            bail!("Invalid model {key}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod concurrency_tests {
    use super::*;
    use serde_json::json;

    fn configured(kind: &str, limit: Value) -> Result<Config> {
        Config::new(
            json!({"llms":{"main":{"base_url":"http://model.invalid/v1","model_name":"fixture"}},
                "functions":{"test":{"_type":kind,"max_concurrency":limit}},
                "workflow":{"_type":"daedalus_rust_agent","llm_name":"main"}}),
            Default::default(),
        )
    }

    fn documents(function: Value, env: &[(&str, &str)]) -> Result<Config> {
        let mut function = function;
        function["_type"] = json!("nat_nv_ingest");
        Config::new(
            json!({"llms":{"main":{"base_url":"http://model.invalid/v1","model_name":"fixture"}},
                "functions":{"documents":function},
                "workflow":{"_type":"daedalus_rust_agent","llm_name":"main"}}),
            env.iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        )
    }

    #[test]
    fn upload_collection_sources_must_agree() {
        // The shipped pairing, including equivalent spellings of the base.
        documents(json!({"default_collection_name":"user_uploads"}), &[]).unwrap();
        documents(json!({}), &[]).unwrap();
        documents(
            json!({"default_collection_name":" Team Uploads "}),
            &[("DOCUMENT_INGEST_DEFAULT_COLLECTION", "team_uploads")],
        )
        .unwrap();
        // HTTP uploads would land in a collection tool search never reads.
        let error = documents(
            json!({"default_collection_name":"team_uploads"}),
            &[("DOCUMENT_INGEST_DEFAULT_COLLECTION", "user_uploads")],
        )
        .err()
        .expect("a split upload collection must be rejected")
        .to_string();
        assert!(
            error.contains("functions.documents.default_collection_name"),
            "{error}"
        );
        assert!(
            error.contains("DOCUMENT_INGEST_DEFAULT_COLLECTION"),
            "{error}"
        );
        assert!(
            documents(
                json!({}),
                &[("DOCUMENT_INGEST_DEFAULT_COLLECTION", "team_uploads")]
            )
            .is_err()
        );
    }

    #[test]
    fn milvus_database_must_be_the_ingestion_database() {
        for database in ["", " default ", "default"] {
            documents(json!({}), &[("MILVUS_DATABASE", database)]).unwrap();
        }
        let error = documents(json!({}), &[("MILVUS_DATABASE", "custom")])
            .err()
            .expect("a database ingestion cannot write must be rejected")
            .to_string();
        assert!(error.starts_with("MILVUS_DATABASE must be"), "{error}");
        assert!(!error.contains("custom"), "{error}");
        // Tool database fields were only an unqualified-name prefix guess.
        let error = documents(json!({"database_name":"custom"}), &[])
            .err()
            .expect("a document tool database must be the default")
            .to_string();
        assert!(
            error.contains("functions.documents.database_name"),
            "{error}"
        );
        let error = Config::new(
            json!({"llms":{"main":{"base_url":"http://model.invalid/v1","model_name":"fixture"}},
                "functions":{"domains":{"_type":"domain_retriever","uri":"http://milvus.invalid:19530",
                    "embedding_model":"embedder","database_name":"custom"}},
                "workflow":{"_type":"daedalus_rust_agent","llm_name":"main"}}),
            Default::default(),
        )
        .err()
        .expect("a domain database must be the default")
        .to_string();
        assert!(error.contains("functions.domains.database_name"), "{error}");
    }

    #[test]
    fn retired_tool_types_name_the_function_to_remove() {
        let error = configured("user_interaction", json!(1))
            .err()
            .expect("a retired tool type must be rejected")
            .to_string();
        assert!(
            error.contains("Retired function type user_interaction"),
            "{error}"
        );
        assert!(error.contains("functions.test"), "{error}");
        // The minimal image must report the retirement, not a missing executor.
        let error = Config::new(
            json!({"llms":{"main":{"base_url":"http://model.invalid/v1","model_name":"fixture"}},
                "functions":{"test":{"_type":"user_interaction"}},
                "workflow":{"_type":"daedalus_rust_agent","llm_name":"main"}}),
            HashMap::from([("DAEDALUS_TOOL_EXECUTOR".into(), "disabled".into())]),
        )
        .err()
        .expect("a retired tool type must be rejected")
        .to_string();
        assert!(
            error.contains("Retired function type user_interaction"),
            "{error}"
        );
    }

    #[test]
    fn reviewed_stateless_tools_have_bounded_concurrency() {
        for kind in ["source_verifier", "webscrape"] {
            assert_eq!(
                configured(kind, json!(4)).unwrap().tool_concurrency("test"),
                4
            );
            for invalid in [
                json!(0),
                json!(9),
                json!(-1),
                json!(true),
                json!(1.5),
                json!("4"),
                json!(null),
            ] {
                assert!(configured(kind, invalid).is_err());
            }
            let mut unset = configured(kind, json!(1)).unwrap();
            unset.raw["functions"]["test"]
                .as_object_mut()
                .unwrap()
                .remove("max_concurrency");
            assert_eq!(unset.tool_concurrency("test"), 1);
        }
        // MCP calls and native stateful tools stay serial.
        let config = configured("source_verifier", json!(8)).unwrap();
        assert_eq!(config.tool_concurrency("mcp__read"), 1);
        assert!(configured("nat_nv_ingest", json!(8)).is_err());
        // A custom tool cannot opt into overlapping shared state.
        assert_eq!(
            configured("fixture_stateful", json!(8))
                .unwrap()
                .tool_concurrency("test"),
            1
        );
    }

    #[test]
    fn insecure_internal_opt_out_matches_the_python_services() {
        for value in ["1", "true", "yes", " TRUE ", "Yes\n", "\ttrue\u{1f}"] {
            assert!(super::allow_insecure_internal(Some(value)), "{value:?}");
        }
        for value in ["", "0", "false", "on", "y", "true!", "t rue"] {
            assert!(!super::allow_insecure_internal(Some(value)), "{value:?}");
        }
        assert!(!super::allow_insecure_internal(None));
    }
}
