//! Shared identity-bound Hindsight transport. Mutations are never retried.
use crate::{config::Config, memory::bank_id};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::time::Duration;

pub struct Client {
    http: tokio::sync::OnceCell<reqwest::Client>,
    certificate_file: Option<String>,
    base: String,
    credential: String,
    timeout: String,
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
        let http = self
            .http
            .get_or_try_init(|| async {
                let mut builder = reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .retry(reqwest::retry::never());
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
