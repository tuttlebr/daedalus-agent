//! Application-owned authorization. Remote annotations never grant authority.
use crate::{
    config::{Config, names},
    storage::Store,
};
use anyhow::{Result, anyhow, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, LazyLock, Mutex, Weak},
};

pub const MARKER: &str = "<!--daedalus-mcp-approval:";
pub fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
pub fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
pub fn nonce() -> String {
    // UUID v4 draws from the OS random source. Two UUIDs provide > 240 random bits.
    URL_SAFE_NO_PAD.encode(
        [
            uuid::Uuid::new_v4().as_bytes().as_slice(),
            uuid::Uuid::new_v4().as_bytes().as_slice(),
        ]
        .concat(),
    )
}

#[derive(Default)]
pub struct Locks(Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>);
impl Locks {
    pub fn get(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.0.lock().unwrap();
        locks.retain(|_, value| value.strong_count() > 0);
        if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(key.into(), Arc::downgrade(&lock));
        lock
    }
}

// Pinned to Python 3.12's Unicode 15.0 data. Lowercasing is not casefolding
// (for example, German sharp s and Greek final sigma).
static CASEFOLD: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../resources/casefold-unicode-15.json")).unwrap()
});
pub(crate) fn fold(text: &str) -> String {
    text.chars()
        .map(|c| {
            CASEFOLD
                .get(&c.to_string())
                .cloned()
                .unwrap_or_else(|| c.to_string())
        })
        .collect()
}

#[derive(Clone, Copy, PartialEq)]
enum Policy {
    Required,
    ReadOnly,
    Auto,
}
fn policy(value: &Value) -> Result<Policy> {
    match fold(value.as_str().unwrap_or("").trim()).as_str() {
        "approval_required" => Ok(Policy::Required),
        "read_only" => Ok(Policy::ReadOnly),
        "auto_approve" => Ok(Policy::Auto),
        _ => bail!("Unsupported MCP approval policy"),
    }
}
struct GroupPolicy {
    include: HashSet<String>,
    exclude: HashSet<String>,
    default: Policy,
    overrides: HashMap<String, Policy>,
}
pub struct Policies(HashMap<String, GroupPolicy>);
impl Policies {
    pub fn new(raw: &Value) -> Result<Self> {
        let mut policies = HashMap::new();
        if let Some(groups) = raw.get("function_groups") {
            for (name, group) in groups
                .as_object()
                .ok_or_else(|| anyhow!("Invalid function_groups"))?
            {
                if !["mcp_client", "per_user_mcp_client"]
                    .contains(&group["_type"].as_str().unwrap_or(""))
                {
                    continue;
                }
                let set = |key| -> Result<HashSet<String>> {
                    let values = names(group.get(key))?;
                    if values.iter().any(|v| v.trim().is_empty()) {
                        bail!("Invalid MCP exposure policy");
                    }
                    Ok(values.iter().map(|s| fold(s.trim())).collect())
                };
                let include = set("include")?;
                let exclude = set("exclude")?;
                let default = group
                    .get("approval_policy")
                    .map(policy)
                    .transpose()?
                    .unwrap_or(Policy::Required);
                if default == Policy::ReadOnly {
                    bail!("MCP group cannot default to read-only");
                }
                let mut overrides = HashMap::new();
                if let Some(raw) = group
                    .get("tool_overrides")
                    .filter(|v| crate::config::truthy(v))
                {
                    for (tool, value) in raw
                        .as_object()
                        .ok_or_else(|| anyhow!("Invalid MCP tool overrides"))?
                    {
                        if let Some(p) = value.get("approval_policy").filter(|v| !v.is_null()) {
                            let p = policy(p)?;
                            let normalized = fold(tool.trim());
                            if (!include.is_empty() && !include.contains(&normalized))
                                || (include.is_empty() && exclude.contains(&normalized))
                            {
                                bail!("MCP approval policy references an unexposed tool");
                            }
                            if p == Policy::ReadOnly && mutating(tool, &json!({}), &Value::Null) {
                                bail!("MCP read-only policy conflicts with mutation detection");
                            }
                            overrides.insert(normalized, p);
                        }
                    }
                }
                policies.insert(
                    fold(name),
                    GroupPolicy {
                        include,
                        exclude,
                        default,
                        overrides,
                    },
                );
            }
        }
        Ok(Self(policies))
    }
    fn target(server: &str, tool: &str) -> (String, String) {
        let server = fold(server);
        let mut tool = fold(tool.trim());
        for separator in [".", "::"] {
            if let Some(t) = tool.strip_prefix(&format!("{server}{separator}")) {
                tool = t.into();
                break;
            }
        }
        (server, tool)
    }
    fn for_tool(&self, server: &str, tool: &str) -> Policy {
        let (server, tool) = Self::target(server, tool);
        let Some(group) = self.0.get(&server) else {
            return Policy::Required;
        };
        if (!group.include.is_empty() && !group.include.contains(&tool))
            || (group.include.is_empty() && group.exclude.contains(&tool))
        {
            return Policy::Required;
        }
        *group.overrides.get(&tool).unwrap_or(&group.default)
    }
    pub fn read_only(&self, server: &str, tool: &str) -> bool {
        self.for_tool(server, tool) == Policy::ReadOnly
    }
    pub fn allowed(&self, server: &str, tool: &str, args: &Value, annotations: &Value) -> bool {
        match self.for_tool(server, tool) {
            Policy::Auto => true,
            Policy::ReadOnly => !mutating(tool, args, annotations),
            Policy::Required => false,
        }
    }
}

pub fn mutating(tool: &str, args: &Value, annotations: &Value) -> bool {
    if annotations["destructiveHint"] == true {
        return true;
    }
    let mut text = tool.to_lowercase();
    for key in ["operation", "command", "action", "method", "verb"] {
        if let Some(value) = args[key].as_str() {
            text.push(' ');
            text.push_str(&value.to_lowercase());
        }
    }
    if [
        "apply",
        "create",
        "delete",
        "deletecollection",
        "patch",
        "replace",
        "rollback",
        "rollout",
        "scale",
        "autoscale",
        "uninstall",
        "update",
        "upgrade",
        "cordon",
        "drain",
        "evict",
        "taint",
        "terminate",
        "destroy",
        "revoke",
        "restart",
        "annotate",
        "remove",
        "disable",
    ]
    .iter()
    .any(|s| text.contains(s))
    {
        return true;
    }
    text.split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit())
        .any(|word| {
            [
                "exec", "set", "put", "post", "cp", "edit", "kill", "drop", "debug", "expose",
                "attach", "label", "write", "send", "move", "rename",
            ]
            .contains(&word)
        })
}

fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .map(|(k, v)| (k.clone(), sorted(v)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(sorted).collect()),
        _ => value.clone(),
    }
}
pub fn canonical(args: &Value) -> Result<(String, String)> {
    let mut value = args
        .as_object()
        .ok_or_else(|| anyhow!("MCP arguments must be an object"))?
        .clone();
    value.remove("approval_token");
    let text = crate::output::compact(&sorted(&Value::Object(value)));
    Ok((text.clone(), hash(&text)))
}
fn ascii_json(value: &Value) -> String {
    crate::output::compact(&sorted(value))
        .chars()
        .map(|c| {
            if c.is_ascii() {
                c.to_string()
            } else {
                c.encode_utf16(&mut [0; 2])
                    .iter()
                    .map(|c| format!("\\u{c:04x}"))
                    .collect()
            }
        })
        .collect()
}
pub fn safe_user(user: &str) -> String {
    hash(if user.trim().is_empty() {
        "anonymous"
    } else {
        user.trim()
    })[..16]
        .into()
}
pub fn token_key(user: &str, token: &str) -> String {
    format!("approval:{}:{}", safe_user(user), token.trim())
}
pub enum Gate {
    Allowed(Option<Value>),
    Denied(String, bool),
}

pub struct Approvals {
    pub policies: Policies,
    pub store: Store,
}
impl Approvals {
    pub fn new(config: &Config) -> Result<Self> {
        let mut storage = config.clone();
        let explicit = config.variable("APPROVAL_REDIS_URL", "");
        if !explicit.trim().is_empty() {
            storage
                .env
                .insert("REDIS_URL".into(), explicit.trim().into());
            storage.env.remove("REDIS_PORT");
        } else if config.variable("REDIS_URL", "").trim().is_empty() {
            let tls = ["1", "true", "yes", "on"].contains(
                &config
                    .variable("REDIS_TLS_ENABLED", "")
                    .trim()
                    .to_lowercase()
                    .as_str(),
            );
            let mut url = reqwest::Url::parse(if tls {
                "rediss://localhost:6379"
            } else {
                "redis://localhost:6379"
            })?;
            url.set_host(Some(config.variable("REDIS_HOST", "localhost").trim()))
                .map_err(|_| anyhow!("Invalid Redis host"))?;
            url.set_port(Some(
                config
                    .variable("REDIS_PORT", "6379")
                    .trim()
                    .parse()
                    .map_err(|_| anyhow!("Invalid Redis port"))?,
            ))
            .map_err(|_| anyhow!("Invalid Redis port"))?;
            let password = config.variable("REDIS_PASSWORD", "");
            if !password.is_empty() {
                url.set_username(config.variable("REDIS_USERNAME", "default").trim())
                    .map_err(|_| anyhow!("Invalid Redis user"))?;
                url.set_password(Some(&password))
                    .map_err(|_| anyhow!("Invalid Redis credential"))?;
            }
            storage.env.insert("REDIS_URL".into(), url.into());
        }
        Ok(Self {
            policies: Policies::new(&config.policy_raw)?,
            store: Store::new(&storage)?,
        })
    }
    pub async fn validate(
        &self,
        user: &str,
        token: &str,
        server: &str,
        tool: &str,
        digest: &str,
        consume: bool,
    ) -> Result<Value> {
        if token.trim().is_empty() {
            bail!("approval credential is required");
        }
        let raw: Option<String> = self
            .store
            .command(redis::cmd(if consume { "GETDEL" } else { "GET" }).arg(token_key(user, token)))
            .await?;
        let raw =
            raw.ok_or_else(|| anyhow!("approval credential is missing, expired, or already used"))?;
        let payload: Value = serde_json::from_str(&raw)
            .map_err(|_| anyhow!("approval credential payload is invalid"))?;
        let mut actual = payload["arguments_sha256"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_owned();
        if consume {
            let text = payload["canonical_arguments"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow!("approval credential canonical arguments are missing"))?;
            actual = serde_json::from_str(text)
                .ok()
                .and_then(|args| canonical(&args).ok())
                .map(|(_, hash)| hash)
                .ok_or_else(|| anyhow!("approval credential canonical arguments are invalid"))?;
        }
        for (key, expected, label) in [
            ("user_id", user, "user"),
            ("action_type", "mcp_mutation", "action"),
            ("server_name", server, "server"),
            ("tool_name", tool, "tool"),
        ] {
            if payload[key].as_str().unwrap_or("").trim() != expected.trim() {
                bail!("approval credential {label} mismatch");
            }
        }
        if actual != digest.trim() {
            bail!("approval credential arguments mismatch");
        }
        Ok(payload)
    }
    async fn pending(&self, user: &str, server: &str, tool: &str, args: &Value) -> Result<String> {
        let (canonical, digest) = canonical(args)?;
        let mut identifiers = Vec::new();
        for key in [
            "documentId",
            "document_id",
            "calendarId",
            "calendar_id",
            "eventId",
            "event_id",
            "namespace",
            "name",
            "id",
        ] {
            let rendered = match &args[key] {
                Value::String(s) => s.trim().to_string(),
                Value::Bool(b) => if *b { "True" } else { "False" }.into(),
                Value::Number(n) if !n.to_string().contains(['.', 'e', 'E']) => n.to_string(),
                _ => String::new(),
            };
            if !rendered.is_empty() && !identifiers.contains(&rendered) {
                identifiers.push(rendered);
            }
        }
        let target = if identifiers.is_empty() {
            format!("arguments:{}", &digest[..16])
        } else {
            identifiers
                .into_iter()
                .take(3)
                .collect::<Vec<_>>()
                .join("/")
        };
        if target == "*" {
            bail!("Pending approval requires an exact target");
        }
        let kib = canonical.len().div_ceil(1024).max(1);
        let summary = if server == "docs_mcp_server" && tool == "update_doc" {
            format!("Update Google document {target} ({kib} KiB payload)")
        } else {
            format!("Run {server}.{tool} on {target} ({kib} KiB payload)")
        };
        let request = nonce();
        let payload = json!({"request_id":request,"user_id":user.trim(),"action_type":"mcp_mutation","action":summary,"reason":"This MCP operation changes external data.","target":target,"server_name":server.trim(),"tool_name":tool.trim(),"canonical_arguments":canonical,"arguments_sha256":digest,"created_at":now() as u64});
        self.store
            .set(
                &format!("approval-pending:{}:{request}", safe_user(user)),
                &payload.to_string(),
                604800,
            )
            .await?;
        let marker = json!({"version":1,"requestId":request,"serverName":server,"toolName":tool,"target":target,"summary":summary,"argumentsSha256":digest});
        Ok(format!(
            "{MARKER}{}-->",
            URL_SAFE_NO_PAD.encode(ascii_json(&marker))
        ))
    }
    pub async fn gate(
        &self,
        user: &str,
        token: &str,
        server: &str,
        tool: &str,
        args: &Value,
        annotations: &Value,
    ) -> Gate {
        if self.policies.allowed(server, tool, args, annotations) {
            return Gate::Allowed(None);
        }
        if self.policies.read_only(server, tool) {
            // The direct-execution route deliberately rejects read-only tools.
            // Do not issue an approval that cannot be executed. Return a source
            // error so the agent can continue with its other evidence instead.
            return Gate::Denied(
                "MCP read-only policy conflicts with destructive tool metadata or arguments. The call was not executed; this source is unavailable until its configuration is corrected.".into(),
                false,
            );
        }
        if user.is_empty() {
            return Gate::Denied("authenticated approval context is required before an execution credential can be created".into(),false);
        }
        if token.trim().is_empty() {
            return match self.pending(user, server, tool, args).await {
                Ok(marker) => Gate::Denied(marker, true),
                Err(_) => Gate::Denied("protected approval creation is unavailable".into(), false),
            };
        }
        let digest = match canonical(args) {
            Ok((_, d)) => d,
            Err(_) => return Gate::Denied("approval validation is unavailable".into(), false),
        };
        self.consume(user, token, server, tool, &digest).await
    }
    /// Exact-execution requests always consume their credential, including an
    /// operation that is otherwise auto-approved for an agent call.
    pub async fn consume(
        &self,
        user: &str,
        token: &str,
        server: &str,
        tool: &str,
        digest: &str,
    ) -> Gate {
        match self.validate(user, token, server, tool, digest, true).await {
            Ok(binding) => Gate::Allowed(Some(binding)),
            Err(error) => {
                let message = error.to_string();
                Gate::Denied(
                    if message.starts_with("approval credential ") {
                        message
                    } else {
                        "approval validation is unavailable".into()
                    },
                    false,
                )
            }
        }
    }
    pub async fn receipt(&self, token: &str, binding: &Value) {
        let mut receipt = json!({"action_type":"mcp_mutation","created_at":now() as u64});
        for key in ["user_id", "server_name", "tool_name", "arguments_sha256"] {
            receipt[key] = binding[key].clone();
        }
        if self
            .store
            .set(
                &format!("approval-receipt:{}", hash(token.trim())),
                &ascii_json(&receipt),
                7200,
            )
            .await
            .is_err()
        {
            tracing::error!(
                event = "mcp_receipt_unavailable",
                remote_outcome = "confirmed_success"
            );
        }
    }
}
