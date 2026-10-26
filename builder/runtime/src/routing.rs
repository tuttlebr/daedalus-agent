//! Trusted destination registry for isolated contexts.
//!
//! This is an equivalent enforceable route contract: each selection names one
//! reviewed provider endpoint and has no classifier, gateway, or cross-provider
//! fallback. A gateway model alias is never evidence of endpoint locality.

use std::{collections::HashMap, fmt, net::IpAddr};

use serde_json::{Value, json};

use crate::{agent::ModelConfig, config::Config};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyError {
    InvalidConfiguration,
    UnsupportedGateway,
    UntrustedCoordinator,
    NoPermittedDestination,
    UntrustedLocalService,
}
impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidConfiguration => "Invalid context isolation configuration",
            Self::UnsupportedGateway => "Context isolation requires a direct provider transport",
            Self::UntrustedCoordinator => "Coordinator endpoint is not a trusted local destination",
            Self::NoPermittedDestination => "No permitted destination supports this model profile",
            Self::UntrustedLocalService => {
                "Private application service is not a registered trusted local endpoint"
            }
        })
    }
}
impl std::error::Error for PolicyError {}

type Result<T> = std::result::Result<T, PolicyError>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Trust {
    Local,
    Cloud,
}

#[derive(Clone)]
struct Destination {
    model: ModelConfig,
    trust: Trust,
    extra_body: Value,
}

#[derive(Clone)]
pub struct IsolationConfig {
    pub policy_version: String,
    coordinator: String,
    destinations: HashMap<String, Destination>,
    worker_profiles: HashMap<String, String>,
    public_weather: Option<Value>,
    trusted_local_mcp_groups: HashMap<String, String>,
}

pub struct ResolvedRoute {
    pub model: ModelConfig,
    pub extra_body: Value,
    pub policy_version: String,
    pub destination_id: String,
    pub eligible_destinations: Vec<String>,
    pub requested_profile: String,
    pub selection_reason: &'static str,
    pub context_class: &'static str,
}

impl ResolvedRoute {
    pub fn record(&self, task_id: &str, phase: &str, attempt: impl TryInto<u64>) {
        let attempt = attempt.try_into().unwrap_or(u64::MAX);
        // The caller's task identifier is hashed even when it is already
        // opaque. No user/conversation IDs, URLs, prompts or findings are logged.
        let task_id = crate::harness::digest(&json!({"task":task_id}));
        let phase = match phase {
            "coordinator" => "coordinator",
            "public_worker" => "public_worker",
            "public_retrieval" => "public_retrieval",
            "public_comparison" => "public_comparison",
            "public_section_draft" => "public_section_draft",
            _ => "isolated",
        };
        let profile = match self.requested_profile.as_str() {
            "default" | "deep" | "deep_max" | "low" | "medium" | "high" | "xhigh" | "max" => {
                self.requested_profile.as_str()
            }
            _ => "unsupported",
        };
        tracing::info!(
            event = "context_route_selected", task_id, phase, attempt,
            context_class = self.context_class, policy_version = self.policy_version,
            eligible_targets = ?self.eligible_destinations, requested_profile = profile,
            classifier_choice = "not_applicable", classifier_probability = ?Option::<f64>::None,
            acceptance_threshold = ?Option::<f64>::None, selected_target = self.destination_id,
            selection_reason = self.selection_reason,
        );
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

fn keys(value: &Value, allowed: &[&str]) -> Result<()> {
    let object = value.as_object().ok_or(PolicyError::InvalidConfiguration)?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(PolicyError::InvalidConfiguration);
    }
    Ok(())
}

/// Private addressing is necessary, but not itself sufficient, for trust.
/// The administrator must additionally register the *actual* direct inference
/// endpoint as trusted_local. Internal gateways must not be registered here.
fn local_endpoint(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(ip) => ip.is_private() || ip.is_loopback(),
            IpAddr::V6(ip) => ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00,
        };
    }
    host == "localhost" || host.ends_with(".svc.cluster.local")
}

fn local_service_url(value: &str) -> Result<String> {
    let endpoint =
        reqwest::Url::parse(value.trim()).map_err(|_| PolicyError::UntrustedLocalService)?;
    if !["http", "https"].contains(&endpoint.scheme())
        || !local_endpoint(&endpoint)
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(PolicyError::UntrustedLocalService);
    }
    Ok(endpoint.to_string().trim_end_matches('/').to_owned())
}

/// Redis transport identity excludes credentials and connection options. The
/// operational URL remains untouched, including TLS CA configuration. Require
/// the actual local host, effective port and selected database to be registered.
fn redis_service_url(value: &str, registration: bool) -> Result<String> {
    let mut endpoint =
        reqwest::Url::parse(value.trim()).map_err(|_| PolicyError::UntrustedLocalService)?;
    if !["redis", "rediss"].contains(&endpoint.scheme())
        || !local_endpoint(&endpoint)
        || (registration
            && (!endpoint.username().is_empty()
                || endpoint.password().is_some()
                || endpoint.query().is_some()
                || endpoint.fragment().is_some()))
    {
        return Err(PolicyError::UntrustedLocalService);
    }
    let database = match endpoint.path().trim_matches('/') {
        "" => 0,
        database => database
            .parse::<i64>()
            .map_err(|_| PolicyError::UntrustedLocalService)?,
    };
    if database < 0 {
        return Err(PolicyError::UntrustedLocalService);
    }
    let port = endpoint.port().unwrap_or(6379);
    endpoint
        .set_username("")
        .map_err(|_| PolicyError::UntrustedLocalService)?;
    endpoint
        .set_password(None)
        .map_err(|_| PolicyError::UntrustedLocalService)?;
    endpoint.set_query(None);
    endpoint.set_fragment(None);
    endpoint
        .set_port(Some(port))
        .map_err(|_| PolicyError::UntrustedLocalService)?;
    endpoint.set_path(&format!("/{database}"));
    Ok(endpoint.to_string())
}

fn validate_local_services(config: &Config, raw: &Value) -> Result<()> {
    let mut trusted = HashMap::new();
    if let Some(services) = raw.get("trusted_local_services") {
        keys(
            services,
            &[
                "hindsight",
                "sandbox",
                "tool_executor",
                "telemetry",
                "redis",
            ],
        )?;
        for (name, endpoint) in services.as_object().unwrap() {
            trusted.insert(
                name.as_str(),
                if name == "redis" {
                    redis_service_url(
                        endpoint
                            .as_str()
                            .ok_or(PolicyError::UntrustedLocalService)?,
                        true,
                    )?
                } else {
                    local_service_url(
                        endpoint
                            .as_str()
                            .ok_or(PolicyError::UntrustedLocalService)?,
                    )?
                },
            );
        }
    }
    let redis_url = config.variable(
        "REDIS_URL",
        "redis://daedalus-redis.daedalus.svc.cluster.local",
    );
    let redis_port = config.variable("REDIS_PORT", "");
    let redis_url = crate::storage::redis_url_with_port(redis_url.trim(), redis_port.trim())
        .map_err(|_| PolicyError::UntrustedLocalService)?;
    if trusted.get("redis") != Some(&redis_service_url(&redis_url, false)?) {
        return Err(PolicyError::UntrustedLocalService);
    }
    let require = |name: &str, endpoint: &str| -> Result<()> {
        let endpoint = local_service_url(endpoint)?;
        if trusted.get(name) != Some(&endpoint) {
            return Err(PolicyError::UntrustedLocalService);
        }
        Ok(())
    };
    // The embedded loopback executor is part of this runtime image. Any
    // separately configured executor requires an explicit trust registration.
    let tools_url = config.variable("DAEDALUS_TOOLS_URL", "http://127.0.0.1:8001");
    let tools_endpoint =
        reqwest::Url::parse(&tools_url).map_err(|_| PolicyError::UntrustedLocalService)?;
    let loopback = tools_endpoint.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if loopback {
        local_service_url(&tools_url)?;
    } else {
        require("tool_executor", &tools_url)?;
    }
    if config
        .variable("DAEDALUS_MEMORY_MODE", "hindsight")
        .trim()
        .eq_ignore_ascii_case("hindsight")
        && !config.variable("HINDSIGHT_API_KEY", "").trim().is_empty()
    {
        let endpoint = config.variable("HINDSIGHT_API_URL", "");
        require(
            "hindsight",
            if endpoint.is_empty() {
                "http://hindsight-api.daedalus.svc.cluster.local:8888"
            } else {
                &endpoint
            },
        )?;
    }
    if let Some(functions) = config.raw["functions"].as_object() {
        for function in functions
            .values()
            .filter(|f| f["_type"] == "briefing_renderer")
        {
            let sandbox = function["sandbox_tool"]
                .as_str()
                .unwrap_or("llm_sandbox_tool");
            let raw = &config.raw["functions"][sandbox];
            if raw["_type"] != "llm_sandbox" {
                return Err(PolicyError::UntrustedLocalService);
            }
            let settings = crate::llm_sandbox::Settings::new(raw, &config.env)
                .map_err(|_| PolicyError::UntrustedLocalService)?;
            require(
                "sandbox",
                settings.values["base_url"]
                    .as_str()
                    .ok_or(PolicyError::UntrustedLocalService)?,
            )?;
        }
    }
    let telemetry = config.raw["telemetry"]["endpoint"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| config.variable("DAEDALUS_PHOENIX_ENDPOINT", ""));
    if !telemetry.is_empty() {
        require("telemetry", &telemetry)?;
    }
    Ok(())
}

/// A bounded output capability control, never context or destination authority.
/// Require a JSON integer rather than accepting numeric strings or floats.
pub(crate) fn valid_thinking_token_budget(value: &Value) -> bool {
    value.as_u64().is_some_and(|tokens| tokens <= 8192)
}

/// Only reviewed boolean template capabilities are accepted; these options
/// cannot carry context, a destination, or an arbitrary template override.
pub(crate) fn valid_chat_template_kwargs(value: &Value) -> bool {
    keys(value, &["enable_thinking", "medium_effort"]).is_ok()
        && value["enable_thinking"].is_boolean()
        && value.get("medium_effort").is_none_or(Value::is_boolean)
}

fn extra_body(value: Option<&Value>) -> Result<Value> {
    let Some(value) = value else {
        return Ok(json!({}));
    };
    keys(
        value,
        &[
            "reasoning_effort",
            "reasoning",
            "reasoning_history",
            "chat_template_kwargs",
            "thinking_token_budget",
        ],
    )?;
    if value.get("reasoning_effort").is_some_and(|v| {
        !["low", "medium", "high", "xhigh", "max"]
            .iter()
            .any(|s| v == s)
    }) || value
        .get("reasoning_history")
        .is_some_and(|v| v != "interleaved")
        || value
            .get("thinking_token_budget")
            .is_some_and(|v| !valid_thinking_token_budget(v))
    {
        return Err(PolicyError::InvalidConfiguration);
    }
    if let Some(reasoning) = value.get("reasoning") {
        keys(reasoning, &["effort"])?;
        if !["low", "medium", "high", "xhigh", "max"]
            .iter()
            .any(|s| reasoning["effort"] == *s)
        {
            return Err(PolicyError::InvalidConfiguration);
        }
    }
    if value
        .get("chat_template_kwargs")
        .is_some_and(|kwargs| !valid_chat_template_kwargs(kwargs))
    {
        return Err(PolicyError::InvalidConfiguration);
    }
    Ok(value.clone())
}

fn canonical_weather_args(raw: &Value) -> Result<Value> {
    static CONTRACT: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!("../resources/nws-weather.json")).unwrap()
    });
    static VALIDATOR: std::sync::LazyLock<jsonschema::Validator> = std::sync::LazyLock::new(|| {
        jsonschema::options()
            .should_validate_formats(false)
            .build(&CONTRACT["schema"]["parameters"])
            .unwrap()
    });
    keys(
        raw,
        &["latitude", "longitude", "days", "include_observations"],
    )?;
    if !VALIDATOR.is_valid(raw) {
        return Err(PolicyError::InvalidConfiguration);
    }
    let mut arguments = json!({});
    for (name, field) in CONTRACT["schema"]["parameters"]["properties"]
        .as_object()
        .unwrap()
    {
        arguments[name] = match raw.get(name) {
            Some(value) => crate::document_tools::coerce(value, field)
                .map_err(|_| PolicyError::InvalidConfiguration)?,
            None => field["default"].clone(),
        };
    }
    Ok(arguments)
}

fn local_mcp_groups(config: &Config, raw: &Value) -> Result<HashMap<String, String>> {
    let mut groups = HashMap::new();
    let Some(registry) = raw.get("trusted_local_mcp_groups") else {
        return Ok(groups);
    };
    for (name, registered) in registry
        .as_object()
        .ok_or(PolicyError::InvalidConfiguration)?
    {
        if !valid_id(name) || config.raw["function_groups"][name]["_type"] != "mcp_client" {
            return Err(PolicyError::UntrustedLocalService);
        }
        let registered = local_service_url(
            registered
                .as_str()
                .ok_or(PolicyError::UntrustedLocalService)?,
        )?;
        let actual = local_service_url(
            config.raw["function_groups"][name]["server"]["url"]
                .as_str()
                .ok_or(PolicyError::UntrustedLocalService)?,
        )?;
        if registered != actual {
            return Err(PolicyError::UntrustedLocalService);
        }
        groups.insert(name.clone(), actual);
    }
    Ok(groups)
}

impl IsolationConfig {
    pub fn from_config(config: &Config) -> Result<Option<Self>> {
        let raw = &config.workflow()["context_isolation"];
        if raw.is_null() {
            return Ok(None);
        }
        keys(
            raw,
            &[
                "enabled",
                "policy_version",
                "coordinator",
                "destinations",
                "worker_profiles",
                "trusted_local_services",
                "public_weather",
                "trusted_local_mcp_groups",
            ],
        )?;
        let enabled = raw["enabled"]
            .as_bool()
            .ok_or(PolicyError::InvalidConfiguration)?;
        if !enabled {
            return Ok(None);
        }
        validate_local_services(config, raw)?;
        let public_weather = raw
            .get("public_weather")
            .map(canonical_weather_args)
            .transpose()?;
        let trusted_local_mcp_groups = local_mcp_groups(config, raw)?;
        let policy_version = raw["policy_version"]
            .as_str()
            .filter(|s| valid_id(s))
            .ok_or(PolicyError::InvalidConfiguration)?
            .to_owned();
        let coordinator = raw["coordinator"]
            .as_str()
            .filter(|s| valid_id(s))
            .ok_or(PolicyError::InvalidConfiguration)?
            .to_owned();
        let mut destinations = HashMap::new();
        for (id, entry) in raw["destinations"]
            .as_object()
            .filter(|m| !m.is_empty())
            .ok_or(PolicyError::InvalidConfiguration)?
        {
            if !valid_id(id) {
                return Err(PolicyError::InvalidConfiguration);
            }
            keys(entry, &["llm", "trust", "transport", "extra_body"])?;
            if entry["transport"] != "direct" {
                return Err(PolicyError::UnsupportedGateway);
            }
            let trust = match entry["trust"].as_str() {
                Some("trusted_local") => Trust::Local,
                Some("approved_cloud") => Trust::Cloud,
                _ => return Err(PolicyError::InvalidConfiguration),
            };
            let name = entry["llm"]
                .as_str()
                .ok_or(PolicyError::InvalidConfiguration)?;
            let model = &config.raw["llms"][name];
            crate::config::validate_model(model).map_err(|_| PolicyError::InvalidConfiguration)?;
            let endpoint = reqwest::Url::parse(model["base_url"].as_str().unwrap())
                .map_err(|_| PolicyError::InvalidConfiguration)?;
            if endpoint.query().is_some() || endpoint.fragment().is_some() {
                return Err(PolicyError::InvalidConfiguration);
            }
            // Reject known gateway aliases even when the target is named local.
            let model_name = model["model_name"].as_str().unwrap();
            if model_name == "daedalus" || model_name.starts_with("daedalus/") {
                return Err(PolicyError::UnsupportedGateway);
            }
            if trust == Trust::Local && !local_endpoint(&endpoint) {
                return Err(PolicyError::UntrustedCoordinator);
            }
            if trust == Trust::Cloud && endpoint.scheme() != "https" && !local_endpoint(&endpoint) {
                return Err(PolicyError::InvalidConfiguration);
            }
            let api_type = model["api_type"].as_str().unwrap_or("responses");
            let extra_body = extra_body(entry.get("extra_body"))?;
            if api_type != "chat"
                && (extra_body.get("thinking_token_budget").is_some()
                    || extra_body.get("chat_template_kwargs").is_some())
            {
                // Rig's Responses encoder drops these vendor-specific controls.
                // Reject unsupported configurations rather than silently lose
                // the operator's declared bound.
                return Err(PolicyError::InvalidConfiguration);
            }
            destinations.insert(
                id.clone(),
                Destination {
                    model: ModelConfig {
                        base_url: endpoint.to_string().trim_end_matches('/').to_owned(),
                        api_key: model["api_key"].as_str().unwrap_or("").to_owned(),
                        model_name: model_name.to_owned(),
                        api_type: api_type.to_owned(),
                        max_retries: model
                            .get("max_retries")
                            .map(crate::config::integer)
                            .transpose()
                            .map_err(|_| PolicyError::InvalidConfiguration)?
                            .unwrap_or(3) as usize,
                        request_timeout: model
                            .get("request_timeout")
                            .map(crate::config::number)
                            .transpose()
                            .map_err(|_| PolicyError::InvalidConfiguration)?
                            .unwrap_or(60.),
                    },
                    trust,
                    extra_body,
                },
            );
        }
        if destinations
            .get(&coordinator)
            .is_none_or(|d| d.trust != Trust::Local)
        {
            return Err(PolicyError::UntrustedCoordinator);
        }
        let mut worker_profiles = HashMap::new();
        for (profile, destination) in raw["worker_profiles"]
            .as_object()
            .ok_or(PolicyError::InvalidConfiguration)?
        {
            let destination = destination
                .as_str()
                .ok_or(PolicyError::InvalidConfiguration)?;
            if !["low", "medium", "high", "xhigh", "max"].contains(&profile.as_str())
                || !destinations.contains_key(destination)
            {
                return Err(PolicyError::InvalidConfiguration);
            }
            worker_profiles.insert(profile.clone(), destination.to_owned());
        }
        Ok(Some(Self {
            policy_version,
            coordinator,
            destinations,
            worker_profiles,
            public_weather,
            trusted_local_mcp_groups,
        }))
    }

    fn resolved(&self, id: &str, profile: &str, local: bool) -> Result<ResolvedRoute> {
        let destination = self
            .destinations
            .get(id)
            .ok_or(PolicyError::NoPermittedDestination)?;
        if local && destination.trust != Trust::Local {
            return Err(PolicyError::NoPermittedDestination);
        }
        Ok(ResolvedRoute {
            model: destination.model.clone(),
            extra_body: destination.extra_body.clone(),
            policy_version: self.policy_version.clone(),
            destination_id: id.to_owned(),
            // No retry path may introduce another endpoint. The explicit
            // singleton is also the fallback intersection for this contract.
            eligible_destinations: vec![id.to_owned()],
            requested_profile: profile.to_owned(),
            selection_reason: if local {
                "privacy_local_direct"
            } else {
                "bounded_profile_direct"
            },
            context_class: if local {
                "LOCAL_ONLY"
            } else {
                "EXTERNAL_ALLOWED"
            },
        })
    }

    pub fn resolve_coordinator(&self, requested_profile: &str) -> Result<ResolvedRoute> {
        self.resolved(&self.coordinator, requested_profile, true)
    }

    pub fn resolve_worker(&self, profile: &str) -> Result<ResolvedRoute> {
        let destination = self
            .worker_profiles
            .get(profile)
            .ok_or(PolicyError::NoPermittedDestination)?;
        self.resolved(destination, profile, false)
    }

    pub fn public_weather(&self) -> Option<&Value> {
        self.public_weather.as_ref()
    }

    /// Registration attests the local recipient only. Tool inclusion, existing
    /// per-user authorization and read-only policy still require dispatch checks.
    pub fn allows_local_mcp(&self, group: &str) -> bool {
        self.trusted_local_mcp_groups.contains_key(group)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config::new(json!({
            "llms": {
                "main": {"base_url":"https://gateway.example/v1","model_name":"daedalus"},
                "private": {"base_url":"http://127.0.0.1:9000/v1","model_name":"private-model","api_type":"chat"},
                "public": {"base_url":"https://provider.example/v1","model_name":"public-model"}
            },
            "workflow": {"_type":"daedalus_rust_agent","llm_name":"main"}
        }), HashMap::new()).unwrap()
    }
    fn policy(config: &mut Config) {
        config.raw["workflow"]["context_isolation"] = json!({
            "enabled":true,"policy_version":"v1","coordinator":"local",
            "destinations": {
                "local":{"llm":"private","trust":"trusted_local","transport":"direct"},
                "cloud":{"llm":"public","trust":"approved_cloud","transport":"direct"}
            },
            "worker_profiles":{"low":"cloud","high":"cloud"}
            ,"trusted_local_services":{"redis":"redis://daedalus-redis.daedalus.svc.cluster.local:6379/0"}
        });
    }

    #[test]
    fn stronger_profiles_never_widen_private_destination() {
        let mut config = config();
        policy(&mut config);
        let routing = IsolationConfig::from_config(&config).unwrap().unwrap();
        for profile in ["default", "deep", "deep_max", "max", "forged-cloud"] {
            let route = routing.resolve_coordinator(profile).unwrap();
            assert_eq!(route.model.base_url, "http://127.0.0.1:9000/v1");
            assert_eq!(route.eligible_destinations, ["local"]);
            assert_eq!(route.context_class, "LOCAL_ONLY");
        }
        assert_eq!(
            routing.resolve_worker("low").unwrap().eligible_destinations,
            ["cloud"]
        );
        assert!(routing.resolve_worker("instant").is_err());
        assert!(routing.resolve_worker("missing").is_err());
    }

    #[test]
    fn isolated_preparation_does_not_require_legacy_gateway_aliases() {
        let mut config = config();
        policy(&mut config);
        config.raw["workflow"]["request_model_profiles"] = json!({"daily_summary":"deep"});
        let config = Config::new(config.raw, config.env).unwrap();
        let (prepared, _) = crate::preparation::base_prepare(&config,
            &json!({"messages":[{"role":"user","content":"Daily summary"}],"additional_props":{"model_profile":"deep_max"}}), false).unwrap();
        assert!(prepared.model_routes.is_empty());
        assert_eq!(prepared.model.model_name, "private-model");
        assert_eq!(prepared.model.base_url, "http://127.0.0.1:9000/v1");
    }

    #[test]
    fn endpoint_and_transport_determine_eligibility_not_target_names() {
        for endpoint in [
            "https://api.openai.com/v1",
            "https://local.example/v1",
            "http://8.8.8.8/v1",
        ] {
            let mut config = config();
            policy(&mut config);
            config.raw["llms"]["private"]["base_url"] = json!(endpoint);
            assert!(matches!(
                IsolationConfig::from_config(&config),
                Err(PolicyError::UntrustedCoordinator)
            ));
        }
        for transport in ["switchyard", "automatic", "", "unknown"] {
            let mut config = config();
            policy(&mut config);
            config.raw["workflow"]["context_isolation"]["destinations"]["local"]["transport"] =
                json!(transport);
            assert!(matches!(
                IsolationConfig::from_config(&config),
                Err(PolicyError::UnsupportedGateway)
            ));
        }
        let mut config = config();
        policy(&mut config);
        config.raw["llms"]["private"]["model_name"] = json!("daedalus/local");
        assert!(matches!(
            IsolationConfig::from_config(&config),
            Err(PolicyError::UnsupportedGateway)
        ));
    }

    #[test]
    fn missing_or_forged_configuration_fails_closed() {
        let mut config = config();
        assert!(IsolationConfig::from_config(&config).unwrap().is_none());
        config.raw["workflow"]["context_isolation"] = json!({"enabled":false});
        assert!(IsolationConfig::from_config(&config).unwrap().is_none());
        for invalid in [
            json!({"enabled":true}),
            json!({"enabled":"true"}),
            json!({"enabled":false,"unknown":true}),
        ] {
            config.raw["workflow"]["context_isolation"] = invalid;
            assert!(IsolationConfig::from_config(&config).is_err());
        }
        policy(&mut config);
        config.raw["workflow"]["context_isolation"]["destinations"]["local"]["extra_body"] =
            json!({"previous_response_id":"private"});
        assert!(IsolationConfig::from_config(&config).is_err());
    }

    #[test]
    fn thinking_token_budget_is_a_bounded_integer_without_route_authority() {
        for tokens in [0, 256, 8192] {
            let mut config = config();
            policy(&mut config);
            config.raw["workflow"]["context_isolation"]["destinations"]["local"]["extra_body"] = json!({"thinking_token_budget":tokens,"chat_template_kwargs":{"enable_thinking":true}});
            let route = IsolationConfig::from_config(&config)
                .unwrap()
                .unwrap()
                .resolve_coordinator("deep_max")
                .unwrap();
            assert_eq!(route.extra_body["thinking_token_budget"], tokens);
            assert_eq!(
                route.extra_body["chat_template_kwargs"]["enable_thinking"],
                true
            );
            assert_eq!(route.model.base_url, "http://127.0.0.1:9000/v1");
            assert_eq!(route.eligible_destinations, ["local"]);
            assert_eq!(route.context_class, "LOCAL_ONLY");
        }
        for invalid in [
            json!(-1),
            json!(0.0),
            json!(256.0),
            json!(256.5),
            json!("256"),
            json!(true),
            Value::Null,
            json!({"value":256}),
            json!([256]),
            json!(8193),
            json!(u64::MAX),
        ] {
            assert!(!valid_thinking_token_budget(&invalid));
            assert!(extra_body(Some(&json!({"thinking_token_budget":invalid}))).is_err());
        }
        assert!(
            extra_body(Some(&json!({
                "chat_template_kwargs":{"enable_thinking":true,"thinking_token_budget":256}
            })))
            .is_err()
        );
        for forbidden in [
            "previous_response_id",
            "metadata",
            "destination_policy",
            "model",
        ] {
            assert!(
                extra_body(Some(&json!({
                    "thinking_token_budget":256,forbidden:"PRIVATE-MARKER"
                })))
                .is_err()
            );
        }
    }

    #[test]
    fn thinking_token_budget_requires_an_explicit_chat_destination() {
        for tokens in [0, 256, 8192] {
            for destination in ["local", "cloud"] {
                let mut config = config();
                policy(&mut config);
                config.raw["llms"][if destination == "local" {
                    "private"
                } else {
                    "public"
                }]["api_type"] = json!("responses");
                config.raw["workflow"]["context_isolation"]["destinations"][destination]["extra_body"] =
                    json!({"thinking_token_budget":tokens});
                assert!(matches!(
                    IsolationConfig::from_config(&config),
                    Err(PolicyError::InvalidConfiguration)
                ));
            }
        }
        let mut config = config();
        policy(&mut config);
        config.raw["llms"]["private"]
            .as_object_mut()
            .unwrap()
            .remove("api_type");
        config.raw["workflow"]["context_isolation"]["destinations"]["local"]["extra_body"] =
            json!({"thinking_token_budget":256});
        assert!(matches!(
            IsolationConfig::from_config(&config),
            Err(PolicyError::InvalidConfiguration)
        ));
    }

    #[test]
    fn chat_template_capabilities_are_boolean_bounded_and_chat_only() {
        for thinking in [false, true] {
            for medium in [false, true] {
                let options = json!({"enable_thinking":thinking,"medium_effort":medium});
                assert!(valid_chat_template_kwargs(&options));
                let mut config = config();
                policy(&mut config);
                config.raw["workflow"]["context_isolation"]["destinations"]["local"]["extra_body"] =
                    json!({"chat_template_kwargs":options});
                let route = IsolationConfig::from_config(&config)
                    .unwrap()
                    .unwrap()
                    .resolve_coordinator("deep_max")
                    .unwrap();
                assert_eq!(route.extra_body["chat_template_kwargs"], options);
                assert_eq!(route.eligible_destinations, ["local"]);
            }
        }
        for invalid in [
            Value::Null,
            json!([]),
            json!(true),
            json!("PRIVATE-MARKER"),
            json!({}),
            json!({"medium_effort":true}),
            json!({"enable_thinking":"true"}),
            json!({"enable_thinking":1}),
            json!({"enable_thinking":true,"medium_effort":"true"}),
            json!({"enable_thinking":true,"medium_effort":1}),
            json!({"enable_thinking":true,"medium_effort":null}),
            json!({"enable_thinking":true,"metadata":"PRIVATE-MARKER"}),
            json!({"enable_thinking":true,"reasoning_effort":"efficient"}),
            json!({"enable_thinking":true,"thinking_token_budget":256}),
        ] {
            assert!(!valid_chat_template_kwargs(&invalid));
            assert!(extra_body(Some(&json!({"chat_template_kwargs":invalid}))).is_err());
        }
        for api in [Some("responses"), None] {
            for destination in ["local", "cloud"] {
                let mut config = config();
                policy(&mut config);
                let model = if destination == "local" {
                    "private"
                } else {
                    "public"
                };
                if let Some(api) = api {
                    config.raw["llms"][model]["api_type"] = json!(api);
                } else {
                    config.raw["llms"][model]
                        .as_object_mut()
                        .unwrap()
                        .remove("api_type");
                }
                config.raw["workflow"]["context_isolation"]["destinations"][destination]["extra_body"] =
                    json!({"chat_template_kwargs":{"enable_thinking":false}});
                assert!(matches!(
                    IsolationConfig::from_config(&config),
                    Err(PolicyError::InvalidConfiguration)
                ));
            }
        }
    }

    #[test]
    fn registry_accepts_only_registered_internal_direct_local_endpoints() {
        for endpoint in [
            "http://localhost:123/v1",
            "http://10.0.0.2/v1",
            "http://[::1]/v1",
            "http://[fd00::1]/v1",
            "http://inference.namespace.svc.cluster.local/v1",
        ] {
            let mut config = config();
            policy(&mut config);
            config.raw["llms"]["private"]["base_url"] = json!(endpoint);
            assert!(IsolationConfig::from_config(&config).is_ok(), "{endpoint}");
        }
        for suffix in ["?private=marker", "#marker"] {
            let mut config = config();
            policy(&mut config);
            config.raw["llms"]["private"]["base_url"] =
                json!(format!("http://127.0.0.1/v1{suffix}"));
            assert!(IsolationConfig::from_config(&config).is_err());
        }
    }

    #[test]
    fn private_auxiliary_services_require_exact_local_registration() {
        let mut config = config();
        policy(&mut config);
        config
            .env
            .insert("HINDSIGHT_API_KEY".into(), "PRIVATE-CREDENTIAL".into());
        config.env.insert(
            "HINDSIGHT_API_URL".into(),
            "https://cloud-memory.example".into(),
        );
        assert!(matches!(
            IsolationConfig::from_config(&config),
            Err(PolicyError::UntrustedLocalService)
        ));
        config.env.insert(
            "HINDSIGHT_API_URL".into(),
            "http://memory.daedalus.svc.cluster.local:8888".into(),
        );
        assert!(IsolationConfig::from_config(&config).is_err());
        config.raw["workflow"]["context_isolation"]["trusted_local_services"] = json!({
            "hindsight":"http://memory.daedalus.svc.cluster.local:8888",
            "redis":"redis://daedalus-redis.daedalus.svc.cluster.local:6379/0"
        });
        assert!(IsolationConfig::from_config(&config).is_ok());
        config.raw["functions"] = json!({
            "renderer":{"_type":"briefing_renderer","sandbox_tool":"sandbox"},
            "sandbox":{"_type":"llm_sandbox"}
        });
        assert!(IsolationConfig::from_config(&config).is_err());
        config.raw["workflow"]["context_isolation"]["trusted_local_services"]["sandbox"] =
            json!("http://llm-sandbox-llm-sandbox.llm-sandbox.svc.cluster.local:8080");
        assert!(IsolationConfig::from_config(&config).is_ok());
        config.env.insert(
            "LLM_SANDBOX_BASE_URL".into(),
            "https://cloud-sandbox.example".into(),
        );
        assert!(IsolationConfig::from_config(&config).is_err());
        config.env.remove("LLM_SANDBOX_BASE_URL");
        config.env.insert(
            "DAEDALUS_TOOLS_URL".into(),
            "http://tools.daedalus.svc.cluster.local:8001".into(),
        );
        assert!(IsolationConfig::from_config(&config).is_err());
        config.raw["workflow"]["context_isolation"]["trusted_local_services"]["tool_executor"] =
            json!("http://tools.daedalus.svc.cluster.local:8001");
        assert!(IsolationConfig::from_config(&config).is_ok());
        config.raw["telemetry"] =
            json!({"endpoint":"http://traces.daedalus.svc.cluster.local:6006/v1/traces"});
        assert!(IsolationConfig::from_config(&config).is_err());
        config.raw["workflow"]["context_isolation"]["trusted_local_services"]["telemetry"] =
            config.raw["telemetry"]["endpoint"].clone();
        assert!(IsolationConfig::from_config(&config).is_ok());
    }

    #[test]
    fn private_redis_store_requires_registered_actual_local_host_port_and_database() {
        let mut config = config();
        policy(&mut config);
        assert!(IsolationConfig::from_config(&config).is_ok());
        config.raw["workflow"]["context_isolation"]["trusted_local_services"] = json!({});
        assert!(matches!(
            IsolationConfig::from_config(&config),
            Err(PolicyError::UntrustedLocalService)
        ));
        for endpoint in [
            "rediss://private-user:PRIVATE-REDIS-SECRET@cloud-store.example:6380/4",
            "redis://8.8.8.8:6379/0",
        ] {
            config.env.insert("REDIS_URL".into(), endpoint.into());
            let error = IsolationConfig::from_config(&config).err().unwrap();
            assert_eq!(error, PolicyError::UntrustedLocalService);
            assert!(!error.to_string().contains("PRIVATE-REDIS-SECRET"));
            assert!(!error.to_string().contains("private-user"));
        }
        config
            .env
            .insert("REDIS_URL".into(), "redis://127.0.0.1:6379/4".into());
        for registration in [
            "redis://127.0.0.1:6380/4",
            "redis://127.0.0.1:6379/3",
            "redis://127.0.0.2:6379/4",
            "rediss://127.0.0.1:6379/4",
            "redis://user:PRIVATE-REGISTRY-SECRET@127.0.0.1:6379/4",
            "redis://127.0.0.1:6379/4?ssl_ca_certs=/private/path",
        ] {
            config.raw["workflow"]["context_isolation"]["trusted_local_services"]["redis"] =
                json!(registration);
            let error = IsolationConfig::from_config(&config).err().unwrap();
            assert_eq!(error, PolicyError::UntrustedLocalService);
            assert!(!error.to_string().contains("PRIVATE-REGISTRY-SECRET"));
            assert!(!error.to_string().contains("/private/path"));
        }
    }

    #[test]
    fn redis_registry_preserves_credentials_tls_options_and_existing_port_precedence() {
        let mut config = config();
        policy(&mut config);
        let operational = "rediss://private-user:PRIVATE-REDIS-SECRET@127.0.0.1/04?ssl_ca_certs=/private/ca.pem&protocol=resp3";
        config.env.insert("REDIS_URL".into(), operational.into());
        config.env.insert("REDIS_PORT".into(), "6380".into());
        config.raw["workflow"]["context_isolation"]["trusted_local_services"]["redis"] =
            json!("rediss://127.0.0.1:6380/4");
        assert!(IsolationConfig::from_config(&config).is_ok());
        assert_eq!(config.env["REDIS_URL"], operational);
        config.env.insert("REDIS_URL".into(), "rediss://private-user:PRIVATE-REDIS-SECRET@127.0.0.1:6390/4?ssl_ca_certs=/private/ca.pem".into());
        assert!(IsolationConfig::from_config(&config).is_err());
        config.raw["workflow"]["context_isolation"]["trusted_local_services"]["redis"] =
            json!("rediss://127.0.0.1:6390/4");
        assert!(IsolationConfig::from_config(&config).is_ok());
        config
            .env
            .insert("REDIS_URL".into(), "redis://127.0.0.1".into());
        config.env.remove("REDIS_PORT");
        config.raw["workflow"]["context_isolation"]["trusted_local_services"]["redis"] =
            json!("redis://127.0.0.1:6379/0");
        assert!(IsolationConfig::from_config(&config).is_ok());
    }

    #[test]
    fn public_weather_is_an_explicit_bounded_literal_with_canonical_tool_defaults() {
        let mut config = config();
        policy(&mut config);
        let routes = IsolationConfig::from_config(&config).unwrap().unwrap();
        assert!(routes.public_weather().is_none());
        config.raw["workflow"]["context_isolation"]["public_weather"] =
            json!({"latitude":42.0,"longitude":-83.0});
        let routes = IsolationConfig::from_config(&config).unwrap().unwrap();
        assert_eq!(
            routes.public_weather().unwrap(),
            &json!({
                "latitude":42.0,"longitude":-83.0,"days":4,"include_observations":false
            })
        );
        config.raw["workflow"]["context_isolation"]["public_weather"] = json!({
            "latitude":42.0,"longitude":-83.0,"days":7,"include_observations":true
        });
        let routes = IsolationConfig::from_config(&config).unwrap().unwrap();
        assert_eq!(routes.public_weather().unwrap()["days"], 7);
        assert_eq!(
            routes.public_weather().unwrap()["include_observations"],
            true
        );
        for invalid in [
            json!({}),
            json!({"latitude":42.0}),
            json!({"latitude":91,"longitude":-83}),
            json!({"latitude":42,"longitude":-181}),
            json!({"latitude":42,"longitude":-83,"days":0}),
            json!({"latitude":42,"longitude":-83,"days":8}),
            json!({"latitude":42,"longitude":-83,"include_observations":"PRIVATE-WEATHER-TEXT"}),
            json!({"latitude":42,"longitude":-83,"query":"PRIVATE-WEATHER-TEXT"}),
        ] {
            config.raw["workflow"]["context_isolation"]["public_weather"] = invalid;
            let error = IsolationConfig::from_config(&config).err().unwrap();
            assert_eq!(error, PolicyError::InvalidConfiguration);
            assert!(!error.to_string().contains("PRIVATE-WEATHER-TEXT"));
        }
    }

    #[test]
    fn private_mcp_registry_requires_an_existing_group_and_its_actual_local_endpoint() {
        let mut config = config();
        policy(&mut config);
        config.raw["function_groups"] = json!({"ops":{
            "_type":"mcp_client","approval_policy":"read_only",
            "server":{"transport":"streamable-http","url":"http://operations.tools.svc.cluster.local:8000/mcp"}
        }});
        let routes = IsolationConfig::from_config(&config).unwrap().unwrap();
        assert!(!routes.allows_local_mcp("ops"));
        config.raw["workflow"]["context_isolation"]["trusted_local_mcp_groups"] = json!({
            "ops":"http://operations.tools.svc.cluster.local:8000/mcp"
        });
        let routes = IsolationConfig::from_config(&config).unwrap().unwrap();
        assert!(routes.allows_local_mcp("ops"));
        assert!(!routes.allows_local_mcp("ops__read"));
        assert!(!routes.allows_local_mcp("unregistered"));
        for endpoint in [
            "https://cloud-mcp.example/mcp",
            "http://different.tools.svc.cluster.local:8000/mcp",
            "http://operations.tools.svc.cluster.local:8000/different",
            "http://user:PRIVATE-MCP-SECRET@operations.tools.svc.cluster.local:8000/mcp",
        ] {
            config.raw["workflow"]["context_isolation"]["trusted_local_mcp_groups"]["ops"] =
                json!(endpoint);
            let error = IsolationConfig::from_config(&config).err().unwrap();
            assert_eq!(error, PolicyError::UntrustedLocalService);
            assert!(!error.to_string().contains("PRIVATE-MCP-SECRET"));
        }
        config.raw["workflow"]["context_isolation"]["trusted_local_mcp_groups"] = json!({
            "unknown":"http://operations.tools.svc.cluster.local:8000/mcp"
        });
        assert!(IsolationConfig::from_config(&config).is_err());
        config.raw["workflow"]["context_isolation"]["trusted_local_mcp_groups"] = json!({
            "ops":"http://operations.tools.svc.cluster.local:8000/mcp"
        });
        config.raw["function_groups"]["ops"]["server"]["url"] =
            json!("https://cloud-mcp.example/mcp");
        assert!(IsolationConfig::from_config(&config).is_err());
    }
}
