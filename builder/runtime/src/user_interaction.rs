//! Authenticated, single-use memory deletion. Confirmation never mints a token.
use crate::{config::truthy, document_search::Failure, memory_tools::trim};
use anyhow::{Result, anyhow, bail};
use http::HeaderMap;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::LazyLock};

static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../resources/user-interaction.json")).unwrap()
});
static INPUTS: LazyLock<Vec<jsonschema::Validator>> = LazyLock::new(|| {
    fn python_patterns(schema: &mut Value) {
        if schema.get("pattern").is_some_and(|v| v == "\\S") {
            schema["pattern"] = json!(r"[^\s\u001c-\u001f]");
        }
        match schema {
            Value::Object(fields) => fields.values_mut().for_each(python_patterns),
            Value::Array(items) => items.iter_mut().for_each(python_patterns),
            _ => (),
        }
    }
    (0..4)
        .map(|mask| {
            let mut schema = CONTRACT["schemas"][mask.to_string()]["parameters"].clone();
            python_patterns(&mut schema);
            jsonschema::options()
                .should_validate_formats(false)
                .build(&schema)
                .unwrap()
        })
        .collect()
});

pub struct Settings {
    pub values: Value,
    mask: usize,
}
impl Settings {
    pub fn new(raw: &Value) -> Result<Self> {
        let properties = CONTRACT["configuration_schema"]["properties"]
            .as_object()
            .unwrap();
        let mut values = CONTRACT["defaults"].clone();
        for (name, input) in raw
            .as_object()
            .ok_or_else(|| anyhow!("Invalid interaction configuration"))?
        {
            if name == "_type" && input == "user_interaction" {
                continue;
            }
            let schema = properties
                .get(name)
                .ok_or_else(|| anyhow!("Unknown interaction configuration field"))?;
            values[name] = crate::document_tools::coerce(input, schema)?;
        }
        let mask = if let Some(operations) = values["enabled_operations"].as_array() {
            let mut mask = 0;
            for operation in operations {
                mask |= match operation.as_str() {
                    Some("confirm_action") => 1,
                    Some("delete_memory_guarded") => 2,
                    _ => bail!("Invalid interaction operation"),
                };
            }
            mask
        } else {
            3
        };
        Ok(Self { values, mask })
    }
    pub fn schema(&self, name: &str) -> Result<Value> {
        if trim(self.values["description"].as_str().unwrap()).is_empty() {
            bail!("Tool requires a nonempty model-facing description");
        }
        let mut schema = CONTRACT["schemas"][self.mask.to_string()].clone();
        schema["name"] = json!(name);
        schema["description"] = self.values["description"].clone();
        Ok(schema)
    }
    fn arguments(&self, raw: &Value) -> Result<Value> {
        let schema = &CONTRACT["schemas"][self.mask.to_string()]["parameters"];
        let mut errors: Vec<_> = INPUTS[self.mask].iter_errors(raw).collect();
        errors.sort_by_key(|error| {
            let mut current = schema;
            error
                .schema_path()
                .to_string()
                .split('/')
                .skip(1)
                .map(|part| {
                    let rank = current
                        .as_object()
                        .and_then(|map| map.keys().position(|key| key == part))
                        .or_else(|| current.as_array().and_then(|_| part.parse::<usize>().ok()))
                        .unwrap_or(0);
                    current = if current.is_array() {
                        &current[part.parse::<usize>().unwrap()]
                    } else {
                        &current[part]
                    };
                    rank
                })
                .collect::<Vec<_>>()
        });
        let validation: Vec<_> = errors.into_iter().take(8).map(|error| {
            let false_schema = matches!(error.kind(), jsonschema::error::ValidationErrorKind::FalseSchema);
            let mut location: Vec<_> = error.instance_path().to_string().split('/').skip(1)
                .map(|part| json!(part.replace("~1", "/").replace("~0", "~"))).collect();
            // Python's FalseSchema branch does not attach the descended property.
            if false_schema { location.pop(); }
            let keyword = if false_schema { "None" } else { error.kind().keyword() };
            json!({"type":"value_error", "loc":location, "msg":format!("Value error, Argument contract: {keyword}"), "ctx":{"error":format!("Argument contract: {keyword}")}})
        }).collect();
        if !validation.is_empty() {
            return Err(Failure {
                class: "ValidationError",
                validation,
            }
            .into());
        }
        let mut value = raw.clone();
        for key in [
            "action",
            "reason",
            "risks",
            "alternatives",
            "approval_token",
        ] {
            if value.get(key).is_none() {
                value[key] = json!("");
            }
        }
        Ok(value)
    }
    fn prepare(
        &self,
        raw: &Value,
        headers: &HeaderMap,
        env: &HashMap<String, String>,
    ) -> Result<Action> {
        let input = self.arguments(raw)?;
        let header = |name: &str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(trim)
                .unwrap_or_default()
        };
        let expected = env
            .get("DAEDALUS_INTERNAL_API_TOKEN")
            .map(|s| trim(s))
            .unwrap_or_default();
        let provided = header("x-daedalus-internal-token");
        let insecure = env
            .get("ALLOW_INSECURE_INTERNAL")
            .is_some_and(|s| ["1", "true", "yes"].contains(&trim(s).to_ascii_lowercase().as_str()));
        let user = header("x-user-id");
        use sha2::{Digest, Sha256};
        use subtle::ConstantTimeEq;
        if user.is_empty()
            || if expected.is_empty() {
                !insecure
            } else {
                !bool::from(
                    Sha256::digest(expected.as_bytes()).ct_eq(&Sha256::digest(provided.as_bytes())),
                )
            }
        {
            return Ok(Action::Reply(
                "Error: authenticated user is required.".into(),
            ));
        }
        if input["operation"] == "confirm_action" {
            return Ok(Action::Reply(confirmation(&input, user)));
        }
        let token = input["approval_token"].as_str().unwrap();
        if trim(token).is_empty() {
            return Ok(Action::Reply(
                "Error: delete_memory denied: approval token required.".into(),
            ));
        }
        Ok(Action::Delete {
            user: user.into(),
            token: token.into(),
        })
    }
}

enum Action {
    Reply(String),
    Delete { user: String, token: String },
}

fn confirmation(input: &Value, user: &str) -> String {
    let text = |name: &str| input[name].as_str().unwrap();
    if trim(text("action")).is_empty() || trim(text("reason")).is_empty() {
        return "Error: memory deletion requires an action and reason.".into();
    }
    let mut parts = vec![
        "**Action requiring confirmation:**\n\nDelete all of your durable memory.".to_owned(),
        format!("\n**Requested action:** {}", text("action")),
        format!("\n**Reason:** {}", text("reason")),
        "\n**Warning:** This action is difficult to reverse.".into(),
    ];
    for (key, label) in [
        ("risks", "Risks"),
        ("alternatives", "Alternatives considered"),
    ] {
        if !text(key).is_empty() {
            parts.push(format!("\n**{label}:** {}", text(key)));
        }
    }
    parts.extend([
        "\nProceed? (yes/no)\nReply with `approve` or `deny`.".into(),
        "\nNo executable credential has been created. The authenticated approval route will mint one only after the user approves.".into(),
        format!("\nApproval scope: action_type=`delete_memory`, target=`{user}`."),
    ]);
    parts.join("\n")
}

fn token_key(user: &str, token: &str) -> String {
    let user = trim(user);
    let user = if user.is_empty() { "anonymous" } else { user };
    format!(
        "approval:{}:{}",
        &crate::authorization::hash(user)[..16],
        trim(token)
    )
}

/// Validate only after GETDEL has atomically consumed the credential. A wrong
/// binding burns it, and no error path may restore it or acknowledge deletion.
fn validate_token(raw: Option<&str>, user: &str) -> Result<std::result::Result<(), &'static str>> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Ok(Err("approval_token is missing, expired, or already used"));
    };
    let Ok(payload) = serde_json::from_str::<Value>(raw) else {
        return Ok(Err("approval_token payload is invalid"));
    };
    let payload = payload
        .as_object()
        .ok_or_else(|| Failure::new("AttributeError"))?;
    let normalized = |key: &str| -> Result<&str> {
        let value = payload.get(key).unwrap_or(&Value::Null);
        if !truthy(value) {
            return Ok("");
        }
        value
            .as_str()
            .map(trim)
            .ok_or_else(|| Failure::new("AttributeError").into())
    };
    let digest = normalized("arguments_sha256")?;
    let actual_user = normalized("user_id")?;
    let action = normalized("action_type")?;
    let target = normalized("target")?;
    let server = normalized("server_name")?;
    let tool = normalized("tool_name")?;
    for (actual, expected, reason) in [
        (actual_user, trim(user), "approval_token user mismatch"),
        (action, "delete_memory", "approval_token action mismatch"),
        (target, trim(user), "approval_token target mismatch"),
        (server, "", "approval_token server mismatch"),
        (tool, "", "approval_token tool mismatch"),
        (digest, "", "approval_token arguments mismatch"),
    ] {
        if actual != expected {
            return Ok(Err(reason));
        }
    }
    Ok(Ok(()))
}

fn redis_url(explicit: Option<&str>, env: &HashMap<String, String>) -> Result<String> {
    let setting = |key: &str| env.get(key).map(|v| trim(v)).unwrap_or_default();
    if let Some(url) = explicit.map(trim).filter(|s| !s.is_empty()) {
        return Ok(url.into());
    }
    let configured = setting("REDIS_URL");
    if !configured.is_empty() {
        return crate::storage::redis_url_with_port(configured, setting("REDIS_PORT"))
            .map_err(|_| Failure::new("ValueError").into());
    }
    let fallback = |key: &str, default: &str| {
        let value = setting(key);
        if value.is_empty() {
            default.to_owned()
        } else {
            value.to_owned()
        }
    };
    let host = fallback("REDIS_HOST", "localhost");
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host
    };
    let port = fallback("REDIS_PORT", "6379");
    let tls = ["1", "true", "yes", "on"]
        .contains(&setting("REDIS_TLS_ENABLED").to_ascii_lowercase().as_str());
    let scheme = if tls { "rediss" } else { "redis" };
    let credentials = env
        .get("REDIS_PASSWORD")
        .filter(|s| !s.is_empty())
        .map(|password| {
            format!(
                "{}:{}@",
                crate::hindsight::quote(&fallback("REDIS_USERNAME", "default")),
                crate::hindsight::quote(password)
            )
        })
        .unwrap_or_default();
    let mut url = format!("{scheme}://{credentials}{host}:{port}");
    let ca = setting("REDIS_TLS_CA_FILE");
    if tls && !ca.is_empty() {
        url.push_str(&format!(
            "?ssl_ca_certs={}",
            crate::hindsight::quote(ca).replace("%20", "+")
        ));
    }
    Ok(url)
}

pub struct Tool {
    pub settings: Settings,
    env: HashMap<String, String>,
    redis: tokio::sync::OnceCell<ApprovalStore>,
}

struct ApprovalStore {
    store: crate::storage::Store,
    config: redis::AsyncConnectionConfig,
    retry_timeout: bool,
}
impl ApprovalStore {
    fn new(url: &str) -> Result<Self> {
        let parsed = reqwest::Url::parse(url).map_err(|_| Failure::new("ValueError"))?;
        let query = |key: &str| {
            parsed
                .query_pairs()
                .find(|(name, value)| name == key && !value.is_empty())
                .map(|(_, value)| value.into_owned())
        };
        let timeout = |value: Option<String>| -> Result<Option<std::time::Duration>> {
            value
                .map(|value| {
                    let value = trim(&value)
                        .parse::<f64>()
                        .map_err(|_| Failure::new("ValueError"))?;
                    if value.is_nan() || value < 0. {
                        return Err(Failure::new("ValueError").into());
                    }
                    if value == 0. {
                        return Err(Failure::new("ConnectionError").into());
                    }
                    std::time::Duration::try_from_secs_f64(value)
                        .map_err(|_| Failure::new("OverflowError").into())
                })
                .transpose()
        };
        let read = timeout(query("socket_timeout"))?;
        let connect = timeout(query("socket_connect_timeout"))?.or(read);
        Ok(Self {
            store: crate::storage::Store::from_url(url, "")
                .map_err(|_| Failure::new("ValueError"))?,
            // redis-rs defaults to 500ms/1s. redis-py has no timeout unless
            // the operator supplies one in this factory's connection URL.
            config: redis::AsyncConnectionConfig::new()
                .set_response_timeout(read)
                .set_connection_timeout(connect),
            retry_timeout: query("retry_on_timeout").is_some_and(|s| {
                !["0", "F", "FALSE", "N", "NO"].contains(&s.to_uppercase().as_str())
            }),
        })
    }
    async fn consume(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let mut retry = self.retry_timeout;
        loop {
            let result = self
                .store
                .command_raw(redis::cmd("GETDEL").arg(key), &self.config)
                .await;
            if retry
                && result
                    .as_ref()
                    .err()
                    .and_then(|e| e.downcast_ref::<redis::RedisError>())
                    .is_some_and(redis::RedisError::is_timeout)
            {
                retry = false;
            } else {
                return result;
            }
        }
    }
}
impl Tool {
    pub fn new(raw: &Value, env: &HashMap<String, String>) -> Result<Self> {
        Ok(Self {
            settings: Settings::new(raw)?,
            env: env.clone(),
            redis: tokio::sync::OnceCell::new(),
        })
    }
    pub async fn call(
        &self,
        input: &Value,
        headers: &HeaderMap,
        memory: &crate::memory::Memory,
        hindsight: &crate::hindsight::Client,
    ) -> Result<String> {
        let (user, token) = match self.settings.prepare(input, headers, &self.env)? {
            Action::Reply(text) => return Ok(text),
            Action::Delete { user, token } => (user, token),
        };
        let store = self
            .redis
            .get_or_try_init(|| async {
                let url = redis_url(self.settings.values["redis_url"].as_str(), &self.env)?;
                ApprovalStore::new(&url)
            })
            .await?;
        let raw: Option<Vec<u8>> =
            store
                .consume(&token_key(&user, &token))
                .await
                .map_err(|error| {
                    if let Some(redis) = error.downcast_ref::<redis::RedisError>() {
                        let class = if redis.kind() == redis::ErrorKind::AuthenticationFailed {
                            "AuthenticationError"
                        } else if redis.code() == Some("NOPERM") {
                            "NoPermissionError"
                        } else if redis.is_timeout() {
                            "TimeoutError"
                        } else if redis.is_io_error() {
                            "ConnectionError"
                        } else {
                            "ResponseError"
                        };
                        anyhow::Error::from(Failure::new(class))
                    } else {
                        error
                    }
                })?;
        let raw = raw
            .map(String::from_utf8)
            .transpose()
            .map_err(|_| Failure::new("UnicodeDecodeError"))?;
        if let Err(reason) = validate_token(raw.as_deref(), &user)? {
            return Ok(format!("Error: delete_memory denied: {reason}."));
        }
        let mode = self
            .env
            .get("DAEDALUS_MEMORY_MODE")
            .filter(|s| !s.is_empty())
            .map(|s| trim(s).to_ascii_lowercase())
            .unwrap_or_else(|| "hindsight".into());
        if mode == "disabled" {
            return Ok(
                "Error: durable memory is disabled by the operator; nothing was deleted.".into(),
            );
        }
        if mode != "hindsight" {
            return Err(Failure::new("ValueError").into());
        }
        match hindsight.clear_user_memory(&user, memory).await {
            Ok(_) => Ok("Durable memory cleared.".into()),
            Err(_) => Ok("Error: Hindsight memory could not be cleared.".into()),
        }
    }
}

#[tokio::test]
#[ignore = "requires actual TLS Redis and the local Hindsight acceptance provider"]
async fn actual_service() {
    let document: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("DAEDALUS_INTERACTION_INPUT").unwrap()).unwrap(),
    )
    .unwrap();
    let client = reqwest::Client::new();
    let control = document["control"].as_str().unwrap();
    let mut observations = Vec::new();
    for case in document["cases"].as_array().unwrap() {
        client
            .post(format!("{control}/__reset"))
            .json(case)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let mut env: HashMap<String, String> =
            serde_json::from_value(document["environment"].clone()).unwrap();
        if let Some(overrides) = case["env"].as_object() {
            env.extend(
                overrides
                    .iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap().into())),
            );
        }
        let config = crate::config::Config::new(json!({"llms":{"main":{"base_url":"http://model.invalid/v1", "model_name":"fixture"}}, "workflow":{"_type":"daedalus_rust_agent", "llm_name":"main"}}), env.clone()).unwrap();
        let memory = crate::memory::Memory::new(&config, client.clone()).unwrap();
        let hindsight = crate::hindsight::Client::new(&config).unwrap();
        let tool = Tool::new(case.get("config").unwrap_or(&json!({})), &env).unwrap();
        let headers =
            HeaderMap::from_iter(case["headers"].as_object().unwrap().iter().map(|(k, v)| {
                (
                    k.parse::<http::HeaderName>().unwrap(),
                    v.as_str().unwrap().parse().unwrap(),
                )
            }));
        let invoke = || async {
            match tool
                .call(&case["input"], &headers, &memory, &hindsight)
                .await
            {
                Ok(text) => json!({"ok":text}),
                Err(error) => json!({"error":error.downcast_ref::<Failure>().unwrap().class}),
            }
        };
        let count = case["count"].as_u64().unwrap_or(1);
        let mut results = if case["parallel"] == true {
            futures::future::join_all((0..count).map(|_| invoke())).await
        } else {
            let mut results = Vec::new();
            for _ in 0..count {
                results.push(invoke().await);
            }
            results
        };
        if case["parallel"] == true {
            results.sort_by_key(Value::to_string);
        }
        let state: Value = client
            .get(format!("{control}/__state"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        observations.push(json!({"name":case["name"], "results":results, "state":state}));
        println!("Rust memory deletion: {}", case["name"]);
    }
    std::fs::write(
        std::env::var("DAEDALUS_INTERACTION_OUTPUT").unwrap(),
        serde_json::to_vec_pretty(&observations).unwrap(),
    )
    .unwrap();
}

#[test]
fn retained_contracts() {
    let mut fixture: Value =
        serde_json::from_str(include_str!("../tests/fixtures/user-interaction.json")).unwrap();
    crate::document_codecs::tests::expand(&mut fixture);
    for case in fixture["configuration"].as_array().unwrap() {
        let actual = match Settings::new(&case["input"]) {
            Ok(settings) => {
                let mut value = json!({"ok":settings.values});
                match settings.schema("configured_interaction") {
                    Ok(schema) => value["schema"] = schema,
                    Err(_) => value["schema_error"] = json!("ValueError"),
                }
                value
            }
            Err(_) => json!({"error":true}),
        };
        assert_eq!(actual, case["expected"], "configuration {}", case["input"]);
    }
    let env = HashMap::from([(
        "DAEDALUS_INTERNAL_API_TOKEN".into(),
        "synthetic-internal".into(),
    )]);
    for case in fixture["inputs"].as_array().unwrap() {
        let settings = Settings {
            values: CONTRACT["defaults"].clone(),
            mask: case["mask"].as_u64().unwrap() as usize,
        };
        let headers =
            HeaderMap::from_iter(case["headers"].as_object().unwrap().iter().map(|(k, v)| {
                (
                    k.parse::<http::HeaderName>().unwrap(),
                    v.as_str().unwrap().parse().unwrap(),
                )
            }));
        let actual = match settings.prepare(&case["input"], &headers, &env) {
            Ok(Action::Reply(text)) => json!({"ok":text}),
            Ok(Action::Delete { .. }) => panic!("Offline capture must not consume credentials"),
            Err(error) => {
                let error = error.downcast_ref::<Failure>().unwrap();
                json!({"error":error.class, "validation":error.validation})
            }
        };
        assert_eq!(
            actual, case["expected"],
            "mask {} input {}",
            case["mask"], case["input"]
        );
    }
    for case in fixture["tokens"].as_array().unwrap() {
        let user = case["user"].as_str().unwrap();
        assert_eq!(
            json!([token_key(user, case["token"].as_str().unwrap())]),
            case["keys"]
        );
        let actual = match validate_token(case["raw"].as_str(), user) {
            Ok(Ok(())) => json!({"ok":[true,"approved"]}),
            Ok(Err(reason)) => json!({"ok":[false,reason]}),
            Err(error) => json!({"error":error.downcast_ref::<Failure>().unwrap().class}),
        };
        assert_eq!(actual, case["expected"], "token {}", case["raw"]);
    }
    for case in fixture["urls"].as_array().unwrap() {
        let env = serde_json::from_value(case["env"].clone()).unwrap();
        let actual = match redis_url(case["explicit"].as_str(), &env) {
            Ok(url) => json!({"ok":url}),
            Err(error) => json!({"error":error.downcast_ref::<Failure>().unwrap().class}),
        };
        assert_eq!(actual, case["expected"], "URL {}", case["env"]);
    }
}
