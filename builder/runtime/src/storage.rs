//! Bounded Redis access. Commands are never automatically replayed after errors.
use crate::config::Config;
use anyhow::{Result, anyhow};
use redis::aio::MultiplexedConnection;
use std::{sync::Arc, time::Duration};
use tokio::sync::Mutex;

/// Insert a fallback port into the authority, preserving credentials, database
/// paths and TLS query parameters. An explicit URL port always takes precedence.
pub fn redis_url_with_port(url: &str, port: &str) -> Result<String> {
    if port.is_empty() {
        return Ok(url.to_owned());
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| anyhow!("Invalid Redis configuration"))?;
    if parsed.host_str().is_some()
        && parsed.port().is_none()
        && let Some((scheme, authority)) = url.split_once("://")
    {
        let end = authority.find(['/', '?', '#']).unwrap_or(authority.len());
        return Ok(format!(
            "{scheme}://{}:{port}{}",
            &authority[..end],
            &authority[end..]
        ));
    }
    Ok(url.to_owned())
}

#[derive(Clone)]
pub struct Store {
    client: redis::Client,
    connection: Arc<Mutex<Option<MultiplexedConnection>>>,
}
impl Store {
    pub fn new(config: &Config) -> Result<Self> {
        let url = config.variable(
            "REDIS_URL",
            "redis://daedalus-redis.daedalus.svc.cluster.local",
        );
        let port = config.variable("REDIS_PORT", "");
        let url = redis_url_with_port(url.trim(), port.trim())?;
        Self::from_url(&url, &config.variable("REDIS_TLS_CA_FILE", ""))
    }
    /// Named tools pass their configured URL directly to redis.from_url. Keep
    /// that path independent of the HTTP service's REDIS_PORT and CA fallback.
    pub fn from_url(url: &str, fallback_ca: &str) -> Result<Self> {
        let parsed =
            reqwest::Url::parse(url).map_err(|_| anyhow!("Invalid Redis configuration"))?;
        let ca = parsed
            .query_pairs()
            .find(|(key, _)| key == "ssl_ca_certs")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_else(|| fallback_ca.to_owned());
        // The deployed URL uses redis-py's ssl_ca_certs query parameter.
        // redis-rs does not consume it; install that CA explicitly, retaining
        // certificate and hostname verification.
        let client = if parsed.scheme() == "rediss" && !ca.is_empty() {
            redis::Client::build_with_tls(
                url,
                redis::TlsCertificates {
                    client_tls: None,
                    root_cert: Some(
                        std::fs::read(ca).map_err(|_| anyhow!("Redis TLS CA unavailable"))?,
                    ),
                },
            )
        } else {
            redis::Client::open(url)
        }
        .map_err(|_| anyhow!("Invalid Redis configuration"))?;
        Ok(Self {
            client,
            connection: Arc::new(Mutex::new(None)),
        })
    }
    pub async fn command<T: redis::FromRedisValue>(&self, command: &mut redis::Cmd) -> Result<T> {
        self.command_with_timeout(command, Duration::from_secs(2))
            .await
    }
    pub async fn command_with_timeout<T: redis::FromRedisValue>(
        &self,
        command: &mut redis::Cmd,
        timeout: Duration,
    ) -> Result<T> {
        let result = tokio::time::timeout(timeout, async {
            let mut cached = self.connection.lock().await;
            if cached.is_none() {
                *cached = Some(self.client.get_multiplexed_async_connection().await?);
            }
            let mut connection = cached.as_ref().unwrap().clone();
            drop(cached);
            command.query_async(&mut connection).await
        })
        .await;
        match result {
            Ok(Ok(value)) => Ok(value),
            _ => {
                *self.connection.lock().await = None;
                Err(anyhow!("Redis unavailable"))
            }
        }
    }
    pub async fn get(&self, key: &str) -> Result<Option<String>> {
        self.command(redis::cmd("GET").arg(key)).await
    }
    /// Document reads use the retained service's separate connection/read
    /// timeouts and its one retry on timeout. This read-only retry does not
    /// apply to any mutation or other runtime Redis command.
    pub async fn document(
        &self,
        key: &str,
        connect_timeout: Option<Duration>,
        read_timeout: Option<Duration>,
    ) -> Result<Option<Vec<u8>>> {
        for attempt in 0..2 {
            let result = async {
                let mut cached = self.connection.lock().await;
                if cached.is_none() {
                    let connect = self.client.get_multiplexed_async_connection();
                    *cached = Some(if let Some(timeout) = connect_timeout {
                        tokio::time::timeout(timeout, connect).await.map_err(|_| {
                            redis::RedisError::from(std::io::Error::new(
                                std::io::ErrorKind::TimedOut,
                                "Timeout connecting to server",
                            ))
                        })??
                    } else {
                        connect.await?
                    });
                }
                let mut connection = cached.as_ref().unwrap().clone();
                drop(cached);
                let mut command = redis::cmd("JSON.GET");
                command.arg(key);
                if let Some(timeout) = read_timeout {
                    tokio::time::timeout(timeout, command.query_async(&mut connection))
                        .await
                        .map_err(|_| {
                            redis::RedisError::from(std::io::Error::new(
                                std::io::ErrorKind::TimedOut,
                                "Timeout reading from socket",
                            ))
                        })?
                } else {
                    command.query_async(&mut connection).await
                }
            }
            .await;
            match result {
                Ok(value) => return Ok(value),
                Err(error) => {
                    *self.connection.lock().await = None;
                    if attempt != 0 || !error.is_timeout() {
                        return Err(error.into());
                    }
                }
            }
        }
        unreachable!()
    }
    pub async fn set(&self, key: &str, value: &str, ttl: usize) -> Result<()> {
        self.command(redis::cmd("SET").arg(key).arg(value).arg("EX").arg(ttl))
            .await
    }
    pub async fn lock(&self, key: &str, ttl: usize) -> Result<bool> {
        let value: Option<String> = self
            .command(
                redis::cmd("SET")
                    .arg(key)
                    .arg("1")
                    .arg("NX")
                    .arg("EX")
                    .arg(ttl),
            )
            .await?;
        Ok(value.is_some())
    }
    pub async fn delete(&self, key: &str) -> Result<()> {
        let _: usize = self.command(redis::cmd("DEL").arg(key)).await?;
        Ok(())
    }
    pub async fn lease(&self, key: &str, ttl: usize) -> Result<Option<Lease>> {
        let expires = std::time::Instant::now() + Duration::from_secs(ttl as u64);
        Ok(self.lock(key, ttl).await?.then(|| Lease {
            store: self.clone(),
            key: key.into(),
            expires,
        }))
    }
    pub async fn ping(&self) -> Result<()> {
        let _: String = self.command(&mut redis::cmd("PING")).await?;
        Ok(())
    }
    /// Cross-process OAuth refresh lease, compatible with redis-py's key and
    /// owner token. Compare ownership on writes and release, including Drop.
    pub async fn owned_lease(&self, key: &str) -> Result<OwnedLease> {
        let owner = crate::authorization::nonce();
        let until = tokio::time::Instant::now() + Duration::from_secs(35);
        loop {
            let acquired: Option<String> = self
                .command(
                    redis::cmd("SET")
                        .arg(key)
                        .arg(&owner)
                        .arg("NX")
                        .arg("EX")
                        .arg(40),
                )
                .await?;
            if acquired.is_some() {
                return Ok(OwnedLease {
                    store: self.clone(),
                    key: key.into(),
                    owner,
                });
            }
            if tokio::time::Instant::now() >= until {
                return Err(anyhow!("Authorization is in use"));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

pub struct OwnedLease {
    store: Store,
    key: String,
    owner: String,
}
impl OwnedLease {
    pub async fn write(&self, key: &str, value: Option<&str>) -> Result<bool> {
        let script = "if redis.call('GET',KEYS[1]) ~= ARGV[1] then return -1 end; if ARGV[2] == 'delete' then return redis.call('DEL',KEYS[2]) end; redis.call('SET',KEYS[2],ARGV[3]); return 1";
        let result: i64 = self
            .store
            .command(
                redis::cmd("EVAL")
                    .arg(script)
                    .arg(2)
                    .arg(&self.key)
                    .arg(key)
                    .arg(&self.owner)
                    .arg(if value.is_some() { "set" } else { "delete" })
                    .arg(value.unwrap_or("")),
            )
            .await?;
        if result == -1 {
            return Err(anyhow!("Authorization lease expired"));
        }
        Ok(result == 1)
    }
}
impl Drop for OwnedLease {
    fn drop(&mut self) {
        let store = self.store.clone();
        let key = self.key.clone();
        let owner = self.owner.clone();
        tokio::spawn(async move {
            let _: Result<i64> = store.command(redis::cmd("EVAL").arg("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0").arg(1).arg(key).arg(owner)).await;
        });
    }
}

/// Preparation is bounded to 2.5s, well inside the 30/60s compatible lock TTL.
/// Dropping a cancelled future releases its lock. Avoid deleting a successor's
/// lock if a stalled runtime has already exceeded this lease's lifetime.
pub struct Lease {
    store: Store,
    key: String,
    expires: std::time::Instant,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let store = self.store.clone();
        let key = self.key.clone();
        let expires = self.expires;
        tokio::spawn(async move {
            if std::time::Instant::now() + Duration::from_secs(2) < expires {
                let _ = store.delete(&key).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fallback_port_preserves_database_credentials_and_tls_options() {
        for (url, port, expected) in [
            ("redis://cache", "6380", "redis://cache:6380"),
            ("redis://cache/", "6380", "redis://cache:6380/"),
            (
                "redis://user:p%40ss@cache/2",
                "6380",
                "redis://user:p%40ss@cache:6380/2",
            ),
            (
                "rediss://cache/2?ssl_ca_certs=%2Ftmp%2Fca.pem",
                "6380",
                "rediss://cache:6380/2?ssl_ca_certs=%2Ftmp%2Fca.pem",
            ),
            ("redis://[::1]/2", "6380", "redis://[::1]:6380/2"),
            ("redis://cache:6379/2", "6380", "redis://cache:6379/2"),
            ("redis://cache/2", "", "redis://cache/2"),
        ] {
            assert_eq!(redis_url_with_port(url, port).unwrap(), expected);
        }
        assert!(redis_url_with_port("invalid", "6380").is_err());
    }

    #[test]
    fn configured_store_connects_to_the_selected_port_and_database() {
        let config = Config::new(
            json!({"llms":{"main":{"base_url":"http://model.invalid","model_name":"fixture"}},"workflow":{"_type":"daedalus_rust_agent","llm_name":"main"}}),
            [
                ("REDIS_URL".into(), " redis://user:p%40ss@cache/2 ".into()),
                ("REDIS_PORT".into(), " 6380 ".into()),
            ].into(),
        ).unwrap();
        let store = Store::new(&config).unwrap();
        let info = store.client.get_connection_info();
        assert_eq!(
            info.addr(),
            &redis::ConnectionAddr::Tcp("cache".into(), 6380)
        );
        assert_eq!(info.redis_settings().db(), 2);
        assert_eq!(info.redis_settings().username(), Some("user"));
        assert_eq!(info.redis_settings().password(), Some("p@ss"));
    }
}
