//! Durable exploration through conversation-scoped, short-lived signed grants.
use anyhow::{Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, time::Duration};

pub struct Tool {
    endpoint: String,
    key: String,
    description: String,
    publisher: crate::llm_sandbox::Tool,
    // No cookie store: each request carries only its own short-lived grant,
    // so pooled connections are safe to share across users.
    http: reqwest::Client,
}
impl Tool {
    pub fn new(raw: &Value, env: &HashMap<String, String>) -> Result<Self> {
        if raw.as_object().is_none_or(|o| {
            o.keys()
                .any(|k| !matches!(k.as_str(), "_type" | "description" | "verbose"))
        }) {
            bail!("Exploration settings are supplied by trusted environment variables");
        }
        let contract: Value = serde_json::from_str(include_str!("../resources/exploration.json"))?;
        let description = raw
            .get("description")
            .filter(|v| !v.is_null())
            .unwrap_or(&contract["description"])
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("Exploration requires a nonempty description"))?
            .to_owned();
        if raw.get("verbose").is_some_and(|v| !v.is_boolean()) {
            bail!("Invalid exploration verbose setting");
        }
        let endpoint = env.get("EXPLORATION_BASE_URL").cloned().unwrap_or_default();
        let key = env
            .get("EXPLORATION_GRANT_KEY")
            .cloned()
            .unwrap_or_default();
        let url = reqwest::Url::parse(&endpoint)?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.host_str().is_none()
            || key.len() < 64
        {
            bail!("Invalid exploration endpoint or grant key");
        }
        Ok(Self {
            endpoint: endpoint.trim_end_matches('/').into(),
            key,
            description,
            publisher: crate::llm_sandbox::Tool::new(&json!({}), env)?,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(45))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        })
    }
    pub fn schema(&self, name: &str) -> Value {
        let mut schema: Value =
            serde_json::from_str(include_str!("../resources/exploration.json")).unwrap();
        schema["name"] = json!(name);
        schema["description"] = json!(self.description);
        schema
    }
    fn validate_arguments(raw: &Value) -> Result<()> {
        static INPUT: std::sync::LazyLock<jsonschema::Validator> = std::sync::LazyLock::new(|| {
            let contract: Value =
                serde_json::from_str(include_str!("../resources/exploration.json")).unwrap();
            jsonschema::validator_for(&contract["parameters"]).unwrap()
        });
        if !INPUT.is_valid(raw) {
            bail!("Invalid exploration arguments");
        }
        Ok(())
    }
    fn validate_artifact<'a>(args: &Value, value: &'a Value) -> Result<(&'a str, &'a str)> {
        let path = value["path"].as_str().filter(|s| !s.is_empty());
        let run = value["runId"].as_str().filter(|s| !s.is_empty());
        let content = base64::engine::general_purpose::STANDARD.decode(
            value["contentBase64"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Missing artifact data"))?,
        )?;
        if content.len() > 6_291_456
            || value["size"].as_u64() != Some(content.len() as u64)
            || value["sha256"].as_str() != Some(&format!("{:x}", Sha256::digest(&content)))
            || run.is_none()
            || path.is_none()
            || value["runId"] != args["runId"]
            || value["path"] != args["path"]
        {
            bail!("Artifact integrity or provenance validation failed");
        }
        Ok((path.unwrap(), run.unwrap()))
    }
    fn grant(&self, user: &str, conversation: &str, now: i64) -> Result<String> {
        if user.is_empty() || conversation.is_empty() {
            bail!("Exploration requires a trusted user and conversation context");
        }
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let claims = json!({"iss":"daedalus-agent","aud":"daedalus-exploration",
            "iat":now,"exp":now+120,"profile":"compute-offline-v1",
            "owner":format!("{:x}",Sha256::digest(user.as_bytes())),
            "scope":format!("{:x}",Sha256::digest(format!("{user}\0{conversation}")))});
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims)?);
        let unsigned = format!("{header}.{payload}");
        let mut mac = Hmac::<Sha256>::new_from_slice(self.key.as_bytes())?;
        mac.update(unsigned.as_bytes());
        Ok(format!(
            "{unsigned}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        ))
    }
    pub async fn call(
        &self,
        raw: &Value,
        headers: &http::HeaderMap,
    ) -> Result<crate::document_json::Text> {
        Self::validate_arguments(raw)?;
        let user = crate::preparation::header(headers, "x-user-id");
        let conversation = crate::preparation::header(headers, "x-conversation-id");
        let token = self.grant(user, conversation, chrono::Utc::now().timestamp())?;
        let mut args = raw.clone();
        let publish = args["operation"] == "publish_file";
        if publish {
            args["operation"] = json!("artifact");
        }
        let mut response = self
            .http
            .post(format!("{}/v2/tool", self.endpoint))
            .bearer_auth(token)
            .json(&args)
            .send()
            .await?;
        let status = response.status();
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if body.len() + chunk.len() > 12_000_000 {
                bail!("Exploration response exceeds limit");
            }
            body.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&body)?;
        if !status.is_success() {
            // Keep the service's explanation for the model, but never present
            // a rejected request as a successful result.
            return Ok(format!(
                "Error: Exploration service returned HTTP {}: {}",
                status.as_u16(),
                serde_json::to_string(&value)?
            )
            .into());
        }
        if !publish {
            return Ok(serde_json::to_string(&value)?.into());
        }
        let (path, run) = Self::validate_artifact(&args, &value)?;
        self.publisher
            .publish(&(user.into(), conversation.into()), path, &value, run)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arguments_reject_unknown_authority_and_incomplete_publication() {
        for raw in [
            json!({"operation":"capabilities","owner":"other"}),
            json!({"operation":"unknown"}),
            json!({"operation":"publish_file"}),
            json!({"operation":"publish_file","runId":"run","path":""}),
            json!({"operation":"events","after":false}),
        ] {
            assert!(Tool::validate_arguments(&raw).is_err(), "{raw}");
        }
        assert!(
            Tool::validate_arguments(
                &json!({"operation":"publish_file","runId":"run","path":"report.txt"})
            )
            .is_ok()
        );
    }
    #[test]
    fn artifact_validation_rejects_corruption_and_missing_provenance() {
        let args = json!({"runId":"run","path":"report.txt"});
        let value = json!({"contentBase64":"dGVzdA==", "size":4,
            "sha256":format!("{:x}",Sha256::digest(b"test")),"runId":"run","path":"report.txt"});
        assert_eq!(
            Tool::validate_artifact(&args, &value).unwrap(),
            ("report.txt", "run")
        );
        for (field, bad) in [
            ("sha256", json!("wrong")),
            ("size", json!(3)),
            ("runId", json!("other")),
            ("path", json!(null)),
            ("contentBase64", json!("!")),
        ] {
            let mut changed = value.clone();
            changed[field] = bad;
            assert!(Tool::validate_artifact(&args, &changed).is_err(), "{field}");
        }
        let mut missing = value;
        missing.as_object_mut().unwrap().remove("runId");
        missing.as_object_mut().unwrap().remove("path");
        assert!(Tool::validate_artifact(&json!({}), &missing).is_err());
    }
    #[test]
    fn grants_bind_identity_scope_and_expiry() {
        let tool = Tool::new(
            &json!({"_type":"sandbox_exploration"}),
            &HashMap::from([
                (
                    "EXPLORATION_BASE_URL".into(),
                    "http://localhost:8080".into(),
                ),
                ("EXPLORATION_GRANT_KEY".into(), "a".repeat(64)),
            ]),
        )
        .unwrap();
        assert!(tool.grant("", "conversation", 1000).is_err());
        let token = tool.grant("alice", "first", 1000).unwrap();
        let parts: Vec<_> = token.split('.').collect();
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["exp"], 1120);
        assert_eq!(claims["profile"], "compute-offline-v1");
        assert!(!token.contains("alice"));
        assert_ne!(token, tool.grant("alice", "second", 1000).unwrap());
        assert_ne!(token, tool.grant("bob", "first", 1000).unwrap());
        let mut mac = Hmac::<Sha256>::new_from_slice(tool.key.as_bytes()).unwrap();
        mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
        mac.verify_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap())
            .unwrap();
    }

    fn configured(base: &str) -> Tool {
        Tool::new(
            &json!({"_type":"sandbox_exploration"}),
            &HashMap::from([
                ("EXPLORATION_BASE_URL".into(), base.into()),
                ("EXPLORATION_GRANT_KEY".into(), "a".repeat(64)),
            ]),
        )
        .unwrap()
    }

    fn trusted_headers() -> http::HeaderMap {
        let mut headers = http::HeaderMap::new();
        headers.insert("x-user-id", "alice".parse().unwrap());
        headers.insert("x-conversation-id", "chat".parse().unwrap());
        headers
    }

    #[test]
    fn grant_requires_conversation_and_binds_exact_claims() {
        let tool = configured("http://localhost:8080");
        assert!(tool.grant("alice", "", 1000).is_err());
        let token = tool.grant("alice", "first", 1000).unwrap();
        let claims: Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(token.split('.').nth(1).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(claims["iss"], "daedalus-agent");
        assert_eq!(claims["aud"], "daedalus-exploration");
        assert_eq!(claims["iat"], 1000);
        assert_eq!(claims["owner"], format!("{:x}", Sha256::digest(b"alice")));
        assert_eq!(
            claims["scope"],
            format!("{:x}", Sha256::digest(b"alice\0first"))
        );
    }

    #[tokio::test]
    async fn rejected_requests_are_tool_errors() {
        use axum::{Json, Router, http::StatusCode, routing::post};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().route(
            "/v2/tool",
            post(|| async {
                (
                    StatusCode::CONFLICT,
                    Json(json!({"detail":"idempotencyKey reused with different arguments"})),
                )
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let tool = configured(&base);
        for args in [
            json!({"operation":"submit","sessionId":"s","idempotencyKey":"k","argv":["python","x.py"]}),
            json!({"operation":"publish_file","runId":"run","path":"report.txt"}),
        ] {
            let text = tool
                .call(&args, &trusted_headers())
                .await
                .unwrap()
                .into_utf8()
                .unwrap();
            // The agent loop marks native results failed by this prefix.
            assert!(text.starts_with("Error:"), "reported as success: {text}");
            assert!(text.contains("409") && text.contains("idempotencyKey reused"));
        }
        server.abort();
    }
}
