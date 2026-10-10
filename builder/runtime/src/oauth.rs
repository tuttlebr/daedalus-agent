//! Durable Google grants at the existing NAT object-store keys. No SDK-owned
//! credentials, identities, callbacks, or automatic retry of token exchanges.
use crate::{
    authorization::{Locks, hash, nonce, now},
    config::{Config, names},
    events::Events,
    storage::{OwnedLease, Store},
};
use anyhow::{Result, anyhow, bail};
use base64::{
    Engine,
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
};
use futures::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, watch};

pub const IN_USE: &str = "Authorization is in use; wait for the current operation to finish";
pub const STATE_ERROR: &str = "OAuth state is missing, expired, or already used";
#[derive(Clone)]
pub enum Emitter {
    Chat(Events),
    Execution(watch::Sender<Value>),
}
impl Emitter {
    pub async fn emit(&self, value: Value) -> Result<()> {
        tracing::info!(event = "oauth_required");
        match self {
            Self::Chat(events) => events.event("oauth_required", value).await,
            Self::Execution(sender) => {
                sender.send_replace(json!({"status":"oauth_required","auth_url":value["auth_url"],"oauth_state":value["oauth_state"]}));
                Ok(())
            }
        }
    }
}
pub fn service(config: &Value) -> Result<&'static str> {
    let url = config["server_url"].as_str().unwrap_or("");
    for service in ["gmail", "calendar", "docs"] {
        if url == format!("https://{service}mcp.googleapis.com/mcp")
            || url == format!("https://{service}mcp.googleapis.com/mcp/v1")
        {
            return Ok(service);
        }
    }
    bail!("Unsupported OAuth resource")
}
pub fn token_key(service: &str, user: &str) -> Result<String> {
    let bucket = match service {
        "gmail" => "gmail-mcp-oauth-ro",
        "calendar" => "calendar-mcp-oauth-rw",
        "docs" => "docs-mcp-oauth-drive",
        _ => bail!("Unknown Google service"),
    };
    let namespace = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_DNS, b"nemo-agent-toolkit");
    let legacy = uuid::Uuid::new_v5(
        &namespace,
        format!("daedalus-user-{}", &hash(user)[..32]).as_bytes(),
    );
    Ok(format!(
        "nat/object_store/{bucket}/tokens/{}",
        hash(&legacy.to_string())
    ))
}
pub fn decode_grant(raw: &str) -> Result<Value> {
    decode_grant_in_timezone(raw, chrono::Local)
}
pub fn decode_grant_in_timezone<T: chrono::TimeZone>(raw: &str, zone: T) -> Result<Value> {
    let grant: Value = serde_json::from_str(raw).map_err(|_| anyhow!("Invalid saved grant"))?;
    if grant["version"] == 2 {
        return Ok(grant);
    }
    let data = grant["data"]
        .as_str()
        .ok_or_else(|| anyhow!("Invalid saved grant"))?;
    let decoded = URL_SAFE_NO_PAD
        .decode(data.trim_end_matches('='))
        .or_else(|_| URL_SAFE.decode(data))
        .map_err(|_| anyhow!("Invalid saved grant"))?;
    let legacy: Value =
        serde_json::from_slice(&decoded).map_err(|_| anyhow!("Invalid saved grant"))?;
    let access = legacy["credentials"]
        .as_array()
        .and_then(|a| a.iter().find_map(|v| v.get("token")))
        .cloned()
        .unwrap_or(json!(""));
    let expires = if let Some(time) = legacy["token_expires_at"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        // Python datetime.timestamp uses the process timezone for legacy naive
        // records. Keep its default fold=0 (earlier instant for an overlap,
        // offset before the transition for a nonexistent local time).
        if let Ok(time) = chrono::DateTime::parse_from_rfc3339(time) {
            time.timestamp_micros() as f64 / 1e6
        } else {
            use chrono::{Duration, Offset};
            let naive = chrono::NaiveDateTime::parse_from_str(time, "%Y-%m-%dT%H:%M:%S%.f")
                .map_err(|_| anyhow!("Invalid saved grant expiry"))?;
            let local = zone.from_local_datetime(&naive).earliest();
            let offset = local
                .map(|local| local.offset().fix().local_minus_utc())
                .or_else(|| {
                    (1..=48).find_map(|hours| {
                        naive
                            .checked_sub_signed(Duration::hours(hours))
                            .and_then(|before| zone.from_local_datetime(&before).earliest())
                            .map(|before| before.offset().fix().local_minus_utc())
                    })
                })
                .ok_or_else(|| anyhow!("Invalid saved grant expiry"))?;
            naive.and_utc().timestamp_micros() as f64 / 1e6 - f64::from(offset)
        }
    } else {
        0.
    };
    let expires = if legacy["token_expires_at"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
    {
        json!(expires)
    } else {
        json!(0)
    };
    Ok(
        json!({"version":2,"access_token":access,"refresh_token":legacy["raw"].get("refresh_token").unwrap_or(&json!("")),"scope":legacy["raw"].get("scope").unwrap_or(&json!("")),"expires_at":expires}),
    )
}

struct Pending {
    sender: oneshot::Sender<Result<String>>,
    created: Instant,
}
type PendingMap = Arc<Mutex<HashMap<String, Pending>>>;
struct PendingGuard {
    key: String,
    pending: PendingMap,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.key);
    }
}
pub struct GoogleOAuth {
    pub store: Store,
    http: reqwest::Client,
    authorize_url: reqwest::Url,
    token_url: reqwest::Url,
    pending: PendingMap,
    locks: Locks,
}
fn endpoint(config: &Config, name: &str, default: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(&config.variable(name, default))
        .map_err(|_| anyhow!("Invalid OAuth endpoint"))?;
    let loopback = url.host_str().is_some_and(|h| {
        h == "localhost"
            || h.trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if !(url.scheme() == "https" || url.scheme() == "http" && loopback)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        bail!("Invalid OAuth endpoint");
    }
    Ok(url)
}
impl GoogleOAuth {
    pub fn new(config: &Config) -> Result<Self> {
        Ok(Self {
            store: Store::new(config)?,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(25))
                .build()?,
            authorize_url: endpoint(
                config,
                "DAEDALUS_GOOGLE_OAUTH_AUTHORIZE_URL",
                "https://accounts.google.com/o/oauth2/v2/auth",
            )?,
            token_url: endpoint(
                config,
                "DAEDALUS_GOOGLE_OAUTH_TOKEN_URL",
                "https://oauth2.googleapis.com/token",
            )?,
            pending: Arc::default(),
            locks: Locks::default(),
        })
    }
    async fn exchange(&self, fields: Vec<(&str, String)>) -> Result<(u16, Value)> {
        let response = self
            .http
            .post(self.token_url.clone())
            .form(&fields)
            .send()
            .await
            .map_err(|_| anyhow!("OAuth token endpoint unavailable"))?;
        let status = response.status().as_u16();
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| anyhow!("OAuth token endpoint unavailable"))?;
            if bytes.len() + chunk.len() > 1024 * 1024 {
                bail!("OAuth response exceeds size limit");
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((
            status,
            serde_json::from_slice(&bytes).map_err(|_| anyhow!("Invalid OAuth response"))?,
        ))
    }
    async fn save(
        &self,
        lease: &OwnedLease,
        key: &str,
        token: &Value,
        previous: &Value,
    ) -> Result<String> {
        let access = token["access_token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow!("OAuth response has no access token"))?;
        let expiry = token
            .get("expires_in")
            .map(crate::config::number)
            .transpose()?
            .unwrap_or(3600.);
        let grant = json!({"version":2,"access_token":access,"refresh_token":token.get("refresh_token").filter(|v|crate::config::truthy(v)).or_else(||previous.get("refresh_token")).unwrap_or(&json!("")),"scope":token.get("scope").filter(|v|crate::config::truthy(v)).or_else(||previous.get("scope")).unwrap_or(&json!("")),"expires_at":now()+expiry});
        lease.write(key, Some(&grant.to_string())).await?;
        Ok(access.into())
    }
    pub async fn access_token(
        &self,
        user: &str,
        config: &Value,
        emit: Option<&Emitter>,
    ) -> Result<Option<String>> {
        let key = token_key(service(config)?, user)?;
        let lock = self.locks.get(&key);
        let _lock = lock.lock().await;
        {
            let lease = self
                .store
                .owned_lease(&format!("{key}/refresh-lock"))
                .await?;
            let saved = self
                .store
                .get(&key)
                .await?
                .map(|raw| decode_grant(&raw))
                .transpose()?
                .unwrap_or(Value::Null);
            if let Some(access) = saved["access_token"].as_str().filter(|s| !s.is_empty())
                && saved["expires_at"].as_f64().unwrap_or(0.) > now() + 60.
            {
                return Ok(Some(access.into()));
            }
            if let Some(refresh) = saved["refresh_token"].as_str().filter(|s| !s.is_empty()) {
                let (status, token) = self
                    .exchange(vec![
                        ("grant_type", "refresh_token".into()),
                        ("refresh_token", refresh.into()),
                        ("client_id", field(config, "client_id")),
                        ("client_secret", field(config, "client_secret")),
                        ("resource", field(config, "server_url")),
                    ])
                    .await?;
                if (200..300).contains(&status) {
                    return Ok(Some(self.save(&lease, &key, &token, &saved).await?));
                }
                if status == 400 && token["error"] == "invalid_grant" {
                    lease.write(&key, None).await?;
                } else {
                    bail!("Google token refresh is temporarily unavailable");
                }
            }
        }
        let Some(emit) = emit else {
            return Ok(None);
        };
        if ["client_id", "client_secret", "redirect_uri"]
            .iter()
            .any(|key| field(config, key).is_empty())
        {
            bail!("Google OAuth is not configured");
        }
        let state = nonce();
        let verifier = nonce();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.len() >= 128 {
                bail!("OAuth capacity reached");
            }
            pending.insert(
                state.clone(),
                Pending {
                    sender,
                    created: Instant::now(),
                },
            );
        }
        let _guard = PendingGuard {
            key: state.clone(),
            pending: self.pending.clone(),
        };
        let mut url = self.authorize_url.clone();
        url.query_pairs_mut().extend_pairs([
            ("response_type", "code".into()),
            ("client_id", field(config, "client_id")),
            ("resource", field(config, "server_url")),
            ("redirect_uri", field(config, "redirect_uri")),
            ("scope", names(config.get("scopes"))?.join(" ")),
            ("state", state.clone()),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256".into()),
            ("access_type", "offline".into()),
            ("include_granted_scopes", "true".into()),
            ("prompt", "consent".into()),
        ]);
        emit.emit(json!({"auth_url":url.as_str(),"oauth_state":state}))
            .await?;
        let code = tokio::time::timeout(Duration::from_secs(600), receiver)
            .await
            .map_err(|_| anyhow!("Google authorization timed out"))?
            .map_err(|_| anyhow!("Google authorization cancelled"))??;
        let (status, token) = self
            .exchange(vec![
                ("grant_type", "authorization_code".into()),
                ("code", code),
                ("code_verifier", verifier),
                ("client_id", field(config, "client_id")),
                ("client_secret", field(config, "client_secret")),
                ("resource", field(config, "server_url")),
                ("redirect_uri", field(config, "redirect_uri")),
            ])
            .await?;
        if !(200..300).contains(&status) {
            bail!("Google authorization could not be completed");
        }
        let lease = self
            .store
            .owned_lease(&format!("{key}/refresh-lock"))
            .await?;
        Ok(Some(self.save(&lease, &key, &token, &Value::Null).await?))
    }
    pub fn callback(&self, state: &str, code: Option<&str>, error: Option<&str>) -> Result<()> {
        let pending = self
            .pending
            .lock()
            .unwrap()
            .remove(state)
            .ok_or_else(|| anyhow!(STATE_ERROR))?;
        if pending.created.elapsed() > Duration::from_secs(600) || pending.sender.is_closed() {
            bail!(STATE_ERROR);
        }
        let result = if error.is_some_and(|s| !s.is_empty()) || code.is_none_or(str::is_empty) {
            Err(anyhow!("Google authorization was declined"))
        } else {
            Ok(code.unwrap().into())
        };
        pending
            .sender
            .send(result)
            .map_err(|_| anyhow!(STATE_ERROR))
    }
    pub async fn invalidate_access(
        &self,
        user: &str,
        config: &Value,
        rejected: &str,
    ) -> Result<()> {
        let key = token_key(service(config)?, user)?;
        let lease = self
            .store
            .owned_lease(&format!("{key}/refresh-lock"))
            .await?;
        if let Some(raw) = self.store.get(&key).await? {
            let mut grant = decode_grant(&raw)?;
            if grant["access_token"] == rejected {
                grant["expires_at"] = json!(0);
                lease.write(&key, Some(&grant.to_string())).await?;
            }
        }
        Ok(())
    }
    pub async fn reset(&self, service: &str, user: &str) -> Result<bool> {
        let key = token_key(service, user)?;
        let lock = self.locks.get(&key);
        let _lock = lock.try_lock().map_err(|_| anyhow!(IN_USE))?;
        let lease = self
            .store
            .owned_lease(&format!("{key}/refresh-lock"))
            .await?;
        lease.write(&key, None).await
    }
    pub fn close(&self) {
        self.pending.lock().unwrap().clear();
    }
}
fn field(config: &Value, key: &str) -> String {
    config[key].as_str().unwrap_or("").into()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config::new(json!({"llms":{"main":{"model_name":"fixture","base_url":"http://127.0.0.1/v1"}},"workflow":{"_type":"daedalus_rust_agent","llm_name":"main"}}),HashMap::new()).unwrap()
    }
    #[tokio::test]
    async fn callback_state_is_single_use_expires_and_cancels() {
        let oauth = GoogleOAuth::new(&config()).unwrap();
        assert!(
            oauth
                .callback("missing", Some("secret-code"), None)
                .is_err()
        );
        for (state, age, error, valid) in [
            ("ok", 0, None, true),
            ("expired", 601, None, false),
            ("denied", 0, Some("access_denied"), true),
        ] {
            let (sender, receiver) = oneshot::channel();
            oauth.pending.lock().unwrap().insert(
                state.into(),
                Pending {
                    sender,
                    created: Instant::now() - Duration::from_secs(age),
                },
            );
            assert_eq!(
                oauth.callback(state, Some("synthetic-code"), error).is_ok(),
                valid
            );
            assert!(oauth.callback(state, Some("synthetic-code"), None).is_err());
            let result = receiver.await;
            if state == "ok" {
                assert_eq!(result.unwrap().unwrap(), "synthetic-code");
            } else {
                assert!(result.is_err() || result.unwrap().is_err());
            }
        }
        let (sender, receiver) = oneshot::channel();
        oauth.pending.lock().unwrap().insert(
            "cancelled".into(),
            Pending {
                sender,
                created: Instant::now(),
            },
        );
        {
            let _guard = PendingGuard {
                key: "cancelled".into(),
                pending: oauth.pending.clone(),
            };
        }
        assert!(receiver.await.is_err());
        assert!(
            oauth
                .callback("cancelled", Some("synthetic-code"), None)
                .is_err()
        );
    }
    #[test]
    fn oauth_endpoint_and_malformed_grant_validation_is_redacted() {
        for url in [
            "http://example.org/token",
            "file:///secret",
            "https://secret@example.org/token",
            "https://example.org/token?secret=value",
            "https://example.org/token#secret",
        ] {
            let mut config = config();
            config
                .env
                .insert("DAEDALUS_GOOGLE_OAUTH_TOKEN_URL".into(), url.into());
            let error = GoogleOAuth::new(&config).err().unwrap().to_string();
            assert_eq!(error, "Invalid OAuth endpoint");
        }
        for raw in [
            "not JSON",
            r#"{"data":"!"}"#,
            r#"{"data":"c2VjcmV0"}"#,
            r#"{"unrecognized":"private-token"}"#,
        ] {
            let error = decode_grant(raw).unwrap_err().to_string();
            assert!(!error.contains(raw));
        }
        assert!(token_key("other", "alice").is_err());
        assert!(
            service(&json!({"server_url":"https://gmailmcp.googleapis.com.evil/mcp"})).is_err()
        );
    }
}
