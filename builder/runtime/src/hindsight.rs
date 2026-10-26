//! Shared identity-bound Hindsight transport. Mutations are never retried.
use crate::{config::Config, memory::bank_id, storage::Store};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::{fmt, net::IpAddr, time::Duration};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyError {
    StateUnavailable,
    UntrustedEndpoint,
    TextContractRequired,
    UnsupportedOperation,
    UnsupportedModality,
    UnknownRetryModality,
}
impl PolicyError {
    pub fn code(self) -> &'static str {
        match self {
            Self::StateUnavailable => "memory_policy_state_unavailable",
            Self::UntrustedEndpoint => "memory_endpoint_not_trusted",
            Self::TextContractRequired => "memory_local_text_contract_required",
            Self::UnsupportedOperation => "memory_operation_not_permitted",
            Self::UnsupportedModality => "memory_modality_not_permitted",
            Self::UnknownRetryModality => "memory_retry_modality_unknown",
        }
    }
    pub fn transient(self) -> bool {
        matches!(
            self,
            Self::StateUnavailable | Self::UntrustedEndpoint | Self::TextContractRequired
        )
    }
}
impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for PolicyError {}

/// Canonical local service origin, with no credentials, prefix, query or
/// fragment. An operator must separately attest its transitive processing.
pub(crate) fn local_origin(value: &str) -> Option<String> {
    let endpoint = reqwest::Url::parse(value.trim()).ok()?;
    let host = endpoint.host_str()?.trim_matches(['[', ']']);
    let local = match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private(),
        Ok(IpAddr::V6(ip)) => ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00,
        Err(_) => host == "localhost" || host.ends_with(".svc.cluster.local"),
    };
    (local
        && ["http", "https"].contains(&endpoint.scheme())
        && endpoint.username().is_empty()
        && endpoint.password().is_none()
        && endpoint.query().is_none()
        && endpoint.fragment().is_none()
        && endpoint.path() == "/")
        .then(|| endpoint.origin().ascii_serialization())
}

fn keys(value: &Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.keys().all(|key| allowed.contains(&key.as_str())))
}
fn text(value: &Value, maximum: usize) -> bool {
    value
        .as_str()
        .is_some_and(|value| !value.is_empty() && value.chars().count() <= maximum)
}
fn optional(value: &Value, key: &str, check: impl FnOnce(&Value) -> bool) -> bool {
    value.get(key).is_none_or(check)
}
fn strings(value: &Value, maximum: usize, length: usize) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.len() <= maximum && items.iter().all(|item| text(item, length)))
}
fn reserved_text(value: &str) -> bool {
    const PREFIX: [char; 8] = ['⟦', 'h', 's', '-', 'a', 't', 't', ':'];
    let mut matched = 0;
    // Match the pinned Hindsight sanitizer before looking for capabilities.
    // TAB/LF/CR survive it. Surrogate code points cannot occur in Rust UTF-8.
    for character in value
        .chars()
        .filter(|character| !matches!(*character as u32,0..=8|11|12|14..=31|127))
    {
        if character == PREFIX[matched] {
            matched += 1;
            if matched == PREFIX.len() {
                return true;
            }
        } else {
            matched = usize::from(character == PREFIX[0]);
        }
    }
    false
}
fn reserved_attachment(value: &Value) -> bool {
    match value {
        // The installed backend rehydrates these same-document references
        // before extraction, even when `content` is a plain string. Reject the
        // reserved lookalike prefix too; never strip it and pretend success.
        Value::String(value) => reserved_text(value),
        Value::Array(values) => values.iter().any(reserved_attachment),
        Value::Object(values) => values
            .iter()
            .any(|(key, value)| reserved_text(key) || reserved_attachment(value)),
        _ => false,
    }
}
fn segment(value: &str) -> bool {
    if value.is_empty() || value.len() > 1024 {
        return false;
    }
    let mut decoded = Vec::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' {
            let Some(high) = bytes.get(index + 1).and_then(|c| (*c as char).to_digit(16)) else {
                return false;
            };
            let Some(low) = bytes.get(index + 2).and_then(|c| (*c as char).to_digit(16)) else {
                return false;
            };
            decoded.push((high * 16 + low) as u8);
            index += 3;
        } else if byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte) {
            decoded.push(byte);
            index += 1;
        } else {
            return false;
        }
    }
    ![b".".as_slice(), b"..".as_slice()].contains(&decoded.as_slice())
        && !decoded
            .iter()
            .any(|byte| matches!(byte, b'/' | b'\\' | b'?' | b'#' | b'%' | 0..=31 | 127))
}
fn resource(suffix: &str, prefix: &str) -> bool {
    suffix.strip_prefix(prefix).is_some_and(segment)
}
fn query_fields(query: &[(&str, &str)], allowed: &[&str]) -> bool {
    let mut seen = std::collections::HashSet::new();
    query.iter().all(|(key, value)| {
        allowed.contains(key)
            && seen.insert(*key)
            && !reserved_text(value)
            && match *key {
                "limit" => value.parse::<u32>().is_ok_and(|n| (1..=100).contains(&n)),
                "offset" => value.parse::<u64>().is_ok(),
                "type" => ["world", "experience", "observation"].contains(value),
                "tags_match" => *value == "all_strict",
                "q" | "tags" => !value.is_empty() && value.chars().count() <= 1_048_576,
                _ => false,
            }
    })
}
fn recall(body: &Value) -> bool {
    keys(
        body,
        &[
            "query",
            "budget",
            "max_tokens",
            "types",
            "prefer_observations",
            "include",
            "trace",
        ],
    ) && text(&body["query"], 1_048_576)
        && matches!(body["budget"].as_str(), Some("low" | "mid"))
        && body["max_tokens"]
            .as_u64()
            .is_some_and(|n| (1..=4096).contains(&n))
        && body["types"].as_array().is_some_and(|types| {
            !types.is_empty()
                && types.len() <= 3
                && types.iter().all(|kind| {
                    matches!(kind.as_str(), Some("world" | "experience" | "observation"))
                })
        })
        && body["prefer_observations"] == true
        && body["trace"] == false
        && keys(&body["include"], &["entities", "chunks", "source_facts"])
        && body["include"]
            .as_object()
            .is_some_and(|include| include.values().all(Value::is_null))
}
fn pure_read(
    method: &reqwest::Method,
    suffix: &str,
    body: Option<&Value>,
    query: &[(&str, &str)],
) -> bool {
    if method == reqwest::Method::POST && suffix == "memories/recall" {
        return query.is_empty() && body.is_some_and(recall);
    }
    if method != reqwest::Method::GET || body.is_some() {
        return false;
    }
    match suffix {
        "config" | "knowledge-base/tree" => query.is_empty(),
        "knowledge-base/search" => {
            query_fields(query, &["q", "limit"]) && query.iter().any(|(key, _)| *key == "q")
        }
        "memories/list" => query_fields(query, &["limit", "offset", "q", "type"]),
        "documents" => query_fields(query, &["limit", "offset", "q", "tags", "tags_match"]),
        _ => {
            query.is_empty()
                && ["knowledge-base/pages/", "documents/", "operations/"]
                    .iter()
                    .any(|prefix| resource(suffix, prefix))
        }
    }
}
fn retain(body: &Value) -> bool {
    keys(body, &["items", "async", "operation_id"])
        && body["async"].is_boolean()
        && optional(body, "operation_id", |value| text(value, 256))
        && body["items"].as_array().is_some_and(|items| {
            !items.is_empty()
                && items.len() <= 1000
                && items.iter().all(|item| {
                    keys(
                        item,
                        &[
                            "content",
                            "document_id",
                            "context",
                            "metadata",
                            "tags",
                            "observation_scopes",
                            "update_mode",
                            "timestamp",
                        ],
                    ) && text(&item["content"], 12000)
                        && text(&item["document_id"], 1024)
                        && optional(item, "context", |value| text(value, 12000))
                        && item["metadata"].as_object().is_some_and(|metadata| {
                            metadata.len() <= 256
                                && metadata.iter().all(|(key, value)| {
                                    !key.is_empty()
                                        && key.len() <= 1024
                                        && value.as_str().is_some_and(|text| text.len() <= 65536)
                                })
                        })
                        && strings(&item["tags"], 256, 1024)
                        && item["observation_scopes"] == "shared"
                        && item["update_mode"] == "replace"
                        && optional(item, "timestamp", |value| text(value, 128))
                })
        })
}
fn text_operation(
    method: &reqwest::Method,
    suffix: &str,
    body: Option<&Value>,
    query: &[(&str, &str)],
) -> bool {
    if !query.is_empty() {
        return false;
    }
    if method == reqwest::Method::DELETE {
        return body.is_none()
            && (suffix == "memories"
                || ["memories/", "documents/", "knowledge-base/nodes/"]
                    .iter()
                    .any(|prefix| resource(suffix, prefix)));
    }
    let Some(body) = body else { return false };
    if method == reqwest::Method::PATCH {
        if suffix == "config" {
            let defaults: Value =
                serde_json::from_str(include_str!("../resources/memory-policy.json")).unwrap();
            return keys(body, &["updates"])
                && body["updates"].as_object().is_some_and(|updates| {
                    updates
                        .iter()
                        .all(|(key, value)| defaults["bank_defaults"].get(key) == Some(value))
                });
        }
        return resource(suffix, "memories/")
            && ((keys(body, &["text"]) && text(&body["text"], 12000))
                || (keys(body, &["state", "reason"])
                    && body["state"] == "invalidated"
                    && text(&body["reason"], 500)));
    }
    if method != reqwest::Method::POST {
        return false;
    }
    match suffix {
        "memories" => retain(body),
        "knowledge-base/pages" => {
            keys(body, &["name", "source_query"])
                && text(&body["name"], 200)
                && text(&body["source_query"], 12000)
        }
        "reflect" => {
            keys(
                body,
                &["query", "budget", "max_tokens", "include", "fact_types"],
            ) && text(&body["query"], 12000)
                && body["budget"] == "low"
                && body["max_tokens"]
                    .as_u64()
                    .is_some_and(|n| (1..=4096).contains(&n))
                && keys(&body["include"], &["facts", "tool_calls"])
                && body["include"]
                    .as_object()
                    .is_some_and(|include| include.values().all(Value::is_null))
                && body["fact_types"].as_array().is_some_and(|types| {
                    !types.is_empty()
                        && types.len() <= 3
                        && types.iter().all(|kind| {
                            matches!(kind.as_str(), Some("world" | "experience" | "observation"))
                        })
                })
        }
        _ => false,
    }
}
fn authorize(
    method: &reqwest::Method,
    suffix: &str,
    body: Option<&Value>,
    query: &[(&str, &str)],
) -> std::result::Result<(), PolicyError> {
    if body.is_some_and(reserved_attachment) || query.iter().any(|(_, value)| reserved_text(value))
    {
        return Err(PolicyError::UnsupportedModality);
    }
    if method == reqwest::Method::POST
        && suffix
            .strip_prefix("operations/")
            .and_then(|value| value.strip_suffix("/retry"))
            .is_some_and(segment)
    {
        return Err(PolicyError::UnknownRetryModality);
    }
    if pure_read(method, suffix, body, query) || text_operation(method, suffix, body, query) {
        Ok(())
    } else if suffix.contains("attachment")
        || suffix.contains("file")
        || body.is_some_and(|body| {
            body["items"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| !item["content"].is_string()))
        })
    {
        Err(PolicyError::UnsupportedModality)
    } else {
        Err(PolicyError::UnsupportedOperation)
    }
}

pub struct Client {
    http: tokio::sync::OnceCell<reqwest::Client>,
    private_http: tokio::sync::OnceCell<reqwest::Client>,
    certificate_file: Option<String>,
    base: String,
    credential: String,
    timeout: String,
    isolated: bool,
    store: Store,
    text_origin: Option<String>,
    registered_origin: Option<String>,
}
impl Client {
    pub async fn clear_user_memory(
        &self,
        user: &str,
        memory: &crate::memory::Memory,
    ) -> Result<Value> {
        let tree = self
            .request(
                reqwest::Method::GET,
                user,
                "knowledge-base/tree",
                None,
                &[],
                None,
            )
            .await?;
        if tree
            .get("roots")
            .is_some_and(|v| v.is_null() || v.is_boolean() || v.is_number())
        {
            bail!("Invalid memory knowledge tree");
        }
        let result = self
            .request(
                reqwest::Method::DELETE,
                user,
                "memories",
                None,
                &[],
                Some(60.),
            )
            .await?;
        for node in tree["roots"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| v.is_object())
        {
            if let Some(id) = node.get("id").filter(|v| crate::config::truthy(v)) {
                let id = crate::profile_import::identifier(id);
                if !crate::memory_tools::trim(&id).is_empty() {
                    self.request(
                        reqwest::Method::DELETE,
                        user,
                        &format!("knowledge-base/nodes/{}", quote(&id)),
                        None,
                        &[],
                        None,
                    )
                    .await?;
                }
            }
        }
        memory.clear_caches(user).await?;
        Ok(result)
    }
    pub fn new(config: &Config) -> Result<Self> {
        let default = "http://hindsight-api.daedalus.svc.cluster.local:8888";
        let base = config.variable("HINDSIGHT_API_URL", default);
        Ok(Self {
            http: tokio::sync::OnceCell::new(),
            private_http: tokio::sync::OnceCell::new(),
            certificate_file: config
                .env
                .get("SSL_CERT_FILE")
                .filter(|s| !s.is_empty())
                .cloned(),
            base: (if base.is_empty() { default } else { &base })
                .trim()
                .trim_end_matches('/')
                .into(),
            credential: config.variable("HINDSIGHT_API_KEY", "").trim().into(),
            timeout: config.variable("HINDSIGHT_API_TIMEOUT_SECONDS", "60"),
            isolated: config.workflow()["context_isolation"]["enabled"] == true,
            store: Store::new(config)?,
            text_origin: config.hindsight_local_text_origin()?,
            registered_origin:
                config.workflow()["context_isolation"]["trusted_local_services"]["hindsight"]
                    .as_str()
                    .and_then(local_origin),
        })
    }
    pub async fn request(
        &self,
        method: reqwest::Method,
        user: &str,
        suffix: &str,
        body: Option<Value>,
        query: &[(&str, &str)],
        timeout: Option<f64>,
    ) -> Result<Value> {
        if self.credential.is_empty() {
            bail!("Memory credential unavailable");
        }
        let protected = if user.is_empty() {
            if method != reqwest::Method::GET
                || suffix != "health"
                || body.is_some()
                || !query.is_empty()
            {
                return Err(PolicyError::UnsupportedOperation.into());
            }
            self.isolated
        } else {
            let enrolled = crate::context_state::owner_is_protected(&self.store, user)
                .await
                .map_err(|_| PolicyError::StateUnavailable)?;
            self.isolated || enrolled
        };
        if protected {
            let origin = local_origin(&self.base).ok_or(PolicyError::UntrustedEndpoint)?;
            // RFC1918 or cluster DNS syntax is not an operator trust decision.
            // Preserve this exact registration check after feature rollback.
            if self.registered_origin.as_ref() != Some(&origin)
                && self.text_origin.as_ref() != Some(&origin)
            {
                return Err(PolicyError::UntrustedEndpoint.into());
            }
            if !user.is_empty() {
                authorize(&method, suffix, body.as_ref(), query)?;
                if !pure_read(&method, suffix, body.as_ref(), query)
                    && self.text_origin.as_ref() != Some(&origin)
                {
                    return Err(PolicyError::TextContractRequired.into());
                }
            }
        }
        let configured: f64 = if self.timeout.is_empty() {
            60.
        } else {
            self.timeout.trim().parse()?
        };
        let timeout = Duration::try_from_secs_f64(timeout.unwrap_or(configured))?;
        let url = if user.is_empty() {
            format!("{}/{suffix}", self.base)
        } else {
            format!("{}/v1/default/banks/{}/{suffix}", self.base, bank_id(user))
        };
        // HTTPX constructs its TLS context on the first request. Keep CA-file
        // failures inside the operation, and retain the client for later calls.
        let http = (if protected {
            &self.private_http
        } else {
            &self.http
        })
        .get_or_try_init(|| async {
            let mut builder = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never());
            if protected {
                builder = builder.no_proxy();
            }
            if let Some(path) = &self.certificate_file {
                let pem = tokio::fs::read(path).await?;
                builder = builder.tls_certs_only(reqwest::Certificate::from_pem_bundle(&pem)?);
            }
            builder.build().map_err(anyhow::Error::from)
        })
        .await?;
        let mut request = http
            .request(method, url)
            .bearer_auth(&self.credential)
            .header("Accept", "application/json")
            .query(query)
            .timeout(timeout);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await?.error_for_status()?;
        if response.status() == 204 {
            return Ok(json!({}));
        }
        let bytes = response.bytes().await?;
        if bytes.is_empty() {
            return Ok(json!({}));
        }
        let value: Value = serde_json::from_slice(&bytes)?;
        if !value.is_object() {
            bail!("Invalid memory response");
        }
        Ok(without_bank_fields(value))
    }
}
pub fn without_bank_fields(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(k, _)| !["bank_id", "tenant_id"].contains(&k.as_str()))
                .map(|(k, v)| (k, without_bank_fields(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(without_bank_fields).collect()),
        other => other,
    }
}
/// urllib.parse.quote(value, safe="") for opaque service resource identifiers.
pub fn quote(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory_api::tests::peers;

    fn config(base: &str, redis: &str, protected: bool, contract: Option<&str>) -> Config {
        let mut raw = json!({"llms":{"main":{"base_url":"http://127.0.0.1:9000/v1","model_name":"fixture","api_type":"chat"}},
            "workflow":{"_type":"daedalus_rust_agent","llm_name":"main"}});
        if protected {
            let mut redis_origin = reqwest::Url::parse(redis).unwrap();
            redis_origin.set_username("").unwrap();
            redis_origin.set_password(None).unwrap();
            redis_origin.set_query(None);
            redis_origin.set_fragment(None);
            if redis_origin.port().is_none() {
                redis_origin.set_port(Some(6379)).unwrap();
            }
            if matches!(redis_origin.path(), "" | "/") {
                redis_origin.set_path("/0");
            }
            raw["workflow"]["context_isolation"] = json!({"enabled":true,"policy_version":"memory-guard-v1","coordinator":"local",
                "destinations":{"local":{"llm":"main","trust":"trusted_local","transport":"direct"}},
                "worker_profiles":{},"trusted_local_services":{"redis":redis_origin.as_str(),"hindsight":base}});
        }
        let mut env = [
            ("REDIS_URL".into(), redis.into()),
            ("HINDSIGHT_API_URL".into(), base.into()),
            ("HINDSIGHT_API_KEY".into(), "synthetic-key".into()),
        ]
        .into_iter()
        .collect::<std::collections::HashMap<_, _>>();
        if let Some(contract) = contract {
            env.insert(
                "DAEDALUS_HINDSIGHT_LOCAL_TEXT_ORIGIN".into(),
                contract.into(),
            );
        }
        Config::new(raw, env).unwrap()
    }
    fn text_batch() -> Value {
        json!({"items":[{"content":"Synthetic private text","document_id":"synthetic-doc","context":"Synthetic context",
            "metadata":{"source":"synthetic"},"tags":["source:synthetic"],"observation_scopes":"shared","update_mode":"replace"}],"async":true,"operation_id":"synthetic-operation"})
    }
    fn recall_body() -> Value {
        json!({"query":"Synthetic private query","budget":"low","max_tokens":600,"types":["world","experience","observation"],
            "prefer_observations":true,"include":{"entities":null,"chunks":null,"source_facts":null},"trace":false})
    }
    fn policy(error: anyhow::Error) -> PolicyError {
        *error
            .downcast_ref::<PolicyError>()
            .expect("typed policy failure")
    }

    #[test]
    fn text_contract_is_an_exact_local_origin_and_never_an_alias_or_url_prefix() {
        assert_eq!(
            local_origin("HTTP://LOCALHOST:80/"),
            Some("http://localhost".into())
        );
        for value in [
            "daedalus/local",
            "https://cloud.example",
            "http://127.0.0.1/prefix",
            "http://user@127.0.0.1",
            "http://127.0.0.1?query=x",
            "http://127.0.0.1#fragment",
            "file:///tmp/memory",
            "http://127.0.0.1.evil.example",
        ] {
            assert!(local_origin(value).is_none(), "{value}");
        }
        assert!(segment("41892d4f-0616-4518-87fc-12a134030897"));
        for value in ["%2F", "%252F", "name%25suffix", "%2e%2e", "%3Fquery"] {
            assert!(!segment(value), "{value}");
        }
        for control in (0u32..=8).chain([11, 12]).chain(14..=31).chain([127]) {
            let control = char::from_u32(control).unwrap();
            for index in 1..8 {
                let mut token = "⟦hs-att:0123456789ab⟧".chars().collect::<Vec<_>>();
                token.insert(index, control);
                let token = token.into_iter().collect::<String>();
                assert!(reserved_text(&token), "sanitized token survived guard");
                assert!(reserved_attachment(&json!({"metadata":{(token):"value"}})));
            }
        }
        for preserved in ['\t', '\n', '\r'] {
            assert!(!reserved_text(&format!("⟦hs-a{preserved}tt:0123456789ab⟧")));
        }
    }

    #[tokio::test]
    async fn protected_http_reads_and_attested_text_mutations_obey_exact_grammar() {
        let (base, calls, peer) =
            peers::hindsight(|_, _| json!({"success":true,"operation_id":"synthetic-operation"}))
                .await;
        let (redis, policy_store) = crate::context_state::empty_policy_store().await;
        let private = config(&base, &redis, true, None);
        let client = Client::new(&private).unwrap();
        client
            .request(
                reqwest::Method::GET,
                "synthetic-alice",
                "documents",
                None,
                &[("limit", "25"), ("offset", "0")],
                None,
            )
            .await
            .unwrap();
        client
            .request(
                reqwest::Method::POST,
                "synthetic-alice",
                "memories/recall",
                Some(recall_body()),
                &[],
                None,
            )
            .await
            .unwrap();
        assert!(client.private_http.initialized());
        assert!(
            !client.http.initialized(),
            "protected requests must not reuse the proxy-enabled client"
        );
        assert_eq!(
            policy(
                client
                    .request(
                        reqwest::Method::POST,
                        "synthetic-alice",
                        "memories",
                        Some(text_batch()),
                        &[],
                        None
                    )
                    .await
                    .unwrap_err()
            ),
            PolicyError::TextContractRequired
        );
        let mismatched =
            Client::new(&config(&base, &redis, true, Some("http://127.0.0.1:1"))).unwrap();
        assert_eq!(
            policy(
                mismatched
                    .request(
                        reqwest::Method::POST,
                        "synthetic-alice",
                        "memories",
                        Some(text_batch()),
                        &[],
                        None
                    )
                    .await
                    .unwrap_err()
            ),
            PolicyError::TextContractRequired
        );
        assert_eq!(calls.lock().await.len(), 2);
        let attested = Client::new(&config(&base, &redis, true, Some(&base))).unwrap();
        for (method, suffix, body) in [
            (reqwest::Method::POST, "memories", Some(text_batch())),
            (
                reqwest::Method::PATCH,
                "memories/memory-1",
                Some(json!({"text":"Corrected synthetic fact"})),
            ),
            (
                reqwest::Method::PATCH,
                "memories/memory-1",
                Some(json!({"state":"invalidated","reason":"User correction"})),
            ),
            (reqwest::Method::DELETE, "documents/document-1", None),
            (reqwest::Method::GET, "operations/synthetic-operation", None),
        ] {
            attested
                .request(method, "synthetic-alice", suffix, body, &[], None)
                .await
                .unwrap();
        }
        let allowed = calls.lock().await.len();
        assert_eq!(allowed, 7);
        for path in ["content", "context", "metadata", "tags"] {
            let mut body = text_batch();
            let token = json!("reserved ⟦hs-att:0123456789ab⟧ marker");
            match path {
                "metadata" => body["items"][0][path] = json!({"note":token}),
                "tags" => body["items"][0][path] = json!([token]),
                _ => body["items"][0][path] = token,
            }
            assert_eq!(
                policy(
                    attested
                        .request(
                            reqwest::Method::POST,
                            "synthetic-alice",
                            "memories",
                            Some(body),
                            &[],
                            None
                        )
                        .await
                        .unwrap_err()
                ),
                PolicyError::UnsupportedModality
            );
        }
        let mut sanitized = text_batch();
        sanitized["items"][0]["metadata"] = json!({"note":"⟦hs-a\u{0000}tt:0123456789ab⟧"});
        assert_eq!(
            policy(
                attested
                    .request(
                        reqwest::Method::POST,
                        "synthetic-alice",
                        "memories",
                        Some(sanitized),
                        &[],
                        None
                    )
                    .await
                    .unwrap_err()
            ),
            PolicyError::UnsupportedModality
        );
        let mut image = text_batch();
        image["items"][0]["content"] =
            json!([{"type":"image","image_url":"https://example.invalid/synthetic.png"}]);
        assert_eq!(
            policy(
                attested
                    .request(
                        reqwest::Method::POST,
                        "synthetic-alice",
                        "memories",
                        Some(image),
                        &[],
                        None
                    )
                    .await
                    .unwrap_err()
            ),
            PolicyError::UnsupportedModality
        );
        assert_eq!(
            policy(
                attested
                    .request(
                        reqwest::Method::POST,
                        "synthetic-alice",
                        "operations/synthetic-operation/retry",
                        Some(json!({})),
                        &[],
                        None
                    )
                    .await
                    .unwrap_err()
            ),
            PolicyError::UnknownRetryModality
        );
        let mut malformed = recall_body();
        malformed["include"]["attachments"] = true.into();
        assert_eq!(
            policy(
                attested
                    .request(
                        reqwest::Method::POST,
                        "synthetic-alice",
                        "memories/recall",
                        Some(malformed),
                        &[],
                        None
                    )
                    .await
                    .unwrap_err()
            ),
            PolicyError::UnsupportedOperation
        );
        assert_eq!(
            policy(
                attested
                    .request(
                        reqwest::Method::GET,
                        "synthetic-alice",
                        "documents/document-1",
                        None,
                        &[("url", "https://example.invalid")],
                        None
                    )
                    .await
                    .unwrap_err()
            ),
            PolicyError::UnsupportedOperation
        );
        assert_eq!(
            calls.lock().await.len(),
            allowed,
            "blocked proposals reached Hindsight"
        );
        peer.abort();
        policy_store.abort();
    }

    #[tokio::test]
    async fn policy_state_failure_prevents_any_authenticated_http_dispatch() {
        let (base, calls, peer) = peers::hindsight(|_, _| json!({})).await;
        let client = Client::new(&config(&base, "redis://127.0.0.1:1", false, None)).unwrap();
        assert_eq!(
            policy(
                client
                    .request(
                        reqwest::Method::GET,
                        "synthetic-alice",
                        "documents",
                        None,
                        &[],
                        None
                    )
                    .await
                    .unwrap_err()
            ),
            PolicyError::StateUnavailable
        );
        assert!(calls.lock().await.is_empty());
        peer.abort();
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn owner_policy_survives_restart_without_enrolling_readers() {
        let redis = std::env::var("DAEDALUS_TEST_REDIS_URL").unwrap();
        let (base, calls, peer) = peers::hindsight(|_, _| json!({"success":true})).await;
        let legacy = config(&base, &redis, false, None);
        let mut registered = legacy.clone();
        registered.raw["workflow"]["context_isolation"] =
            json!({"enabled":false,"trusted_local_services":{"hindsight":base}});
        let user = uuid::Uuid::new_v4().to_string();
        let store = Store::new(&legacy).unwrap();
        assert!(
            !crate::context_state::owner_is_protected(&store, &user)
                .await
                .unwrap()
        );
        let first = Client::new(&registered).unwrap();
        first
            .request(
                reqwest::Method::POST,
                &user,
                "memories",
                Some(text_batch()),
                &[],
                None,
            )
            .await
            .unwrap();
        assert!(
            !crate::context_state::owner_is_protected(&store, &user)
                .await
                .unwrap(),
            "standalone API must not enroll an owner"
        );
        crate::context_state::enforce(&legacy, &user, "old-conversation", "old-run", true)
            .await
            .unwrap();
        // A client that already performed a legacy call must immediately stop
        // using its earlier transport/eligibility once its owner enrolls.
        first
            .request(reqwest::Method::GET, &user, "documents", None, &[], None)
            .await
            .unwrap();
        assert!(first.private_http.initialized());
        assert!(first.http.initialized());
        let unregistered = Client::new(&legacy).unwrap();
        assert_eq!(
            policy(
                unregistered
                    .request(reqwest::Method::GET, &user, "documents", None, &[], None)
                    .await
                    .unwrap_err()
            ),
            PolicyError::UntrustedEndpoint
        );
        let restarted = Client::new(&registered).unwrap();
        assert_eq!(
            policy(
                restarted
                    .request(
                        reqwest::Method::POST,
                        &user,
                        "memories",
                        Some(text_batch()),
                        &[],
                        None
                    )
                    .await
                    .unwrap_err()
            ),
            PolicyError::TextContractRequired
        );
        restarted
            .request(reqwest::Method::GET, &user, "documents", None, &[], None)
            .await
            .unwrap();
        assert!(restarted.private_http.initialized());
        assert!(!restarted.http.initialized());
        let (other_base, other_calls, other_peer) = peers::hindsight(|_, _| json!({})).await;
        let mut changed = registered.clone();
        changed.env.insert("HINDSIGHT_API_URL".into(), other_base);
        let changed = Client::new(&changed).unwrap();
        assert_eq!(
            policy(
                changed
                    .request(
                        reqwest::Method::POST,
                        &user,
                        "memories/recall",
                        Some(recall_body()),
                        &[],
                        None
                    )
                    .await
                    .unwrap_err()
            ),
            PolicyError::UntrustedEndpoint
        );
        assert!(
            other_calls.lock().await.is_empty(),
            "a different LAN port received protected data"
        );
        other_peer.abort();
        let attested = Client::new(&config(&base, &redis, false, Some(&base))).unwrap();
        attested
            .request(reqwest::Method::GET, &user, "documents", None, &[], None)
            .await
            .unwrap();
        assert!(attested.private_http.initialized());
        let prefixed = Client::new(&config(
            &format!("{base}/changed"),
            &redis,
            false,
            Some(&base),
        ))
        .unwrap();
        assert_eq!(
            policy(
                prefixed
                    .request(reqwest::Method::GET, &user, "documents", None, &[], None)
                    .await
                    .unwrap_err()
            ),
            PolicyError::UntrustedEndpoint
        );
        let unrelated = uuid::Uuid::new_v4().to_string();
        restarted
            .request(
                reqwest::Method::POST,
                &unrelated,
                "operations/old-vision/retry",
                Some(json!({})),
                &[],
                None,
            )
            .await
            .unwrap();
        assert_eq!(calls.lock().await.len(), 5);
        peer.abort();
    }
}
