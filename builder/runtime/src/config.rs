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
    match value {
        Value::String(text) => {
            let regex = Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}").unwrap();
            *text = regex
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
    /// Only the stateless, application-owned verifier can overlap same-kind calls.
    pub fn tool_concurrency(&self, name: &str) -> usize {
        let function = &self.raw["functions"][name];
        if function["_type"] == "source_verifier" {
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
        let python_tools = raw["functions"]
            .as_object()
            .is_some_and(|f| f.values().any(|v| v["_type"] != "current_datetime"))
            || env
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
        if self.python_tools && self.variable("DAEDALUS_TOOL_EXECUTOR", "python") == "disabled" {
            bail!("Configured required tools need the transitional Python executor");
        }
        for (name, function) in functions {
            if function["_type"] == "source_verifier"
                && let Some(value) = function.get("max_concurrency")
                && !value.as_u64().is_some_and(|n| (1..=8).contains(&n))
            {
                bail!("Invalid source verifier max_concurrency: expected an integer from 1 to 8");
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
        for field in ["request_model_profiles", "skill_model_profiles"] {
            let mappings = workflow
                .get(field)
                .unwrap_or(&empty)
                .as_object()
                .ok_or_else(|| anyhow!("Invalid model profiles"))?;
            for (key, value) in mappings {
                if (field == "request_model_profiles" && key != "daily_summary")
                    || !["default", "deep"].iter().any(|s| value == s)
                    || (value == "deep" && !routes.contains_key("deep"))
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
