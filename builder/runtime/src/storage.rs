//! Bounded Redis access. Commands are never automatically replayed after errors.
use crate::config::Config;
use anyhow::{Result, anyhow};
use redis::aio::MultiplexedConnection;
use std::{sync::Arc, time::Duration};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct Store {
    client: redis::Client,
    connection: Arc<Mutex<Option<MultiplexedConnection>>>,
}
impl Store {
    pub fn new(config: &Config) -> Result<Self> {
        let mut url = config
            .variable(
                "REDIS_URL",
                "redis://daedalus-redis.daedalus.svc.cluster.local",
            )
            .trim()
            .to_owned();
        let port = config.variable("REDIS_PORT", "");
        if !port.trim().is_empty()
            && reqwest::Url::parse(&url)
                .ok()
                .is_some_and(|u| u.port().is_none())
        {
            url = format!("{}:{}", url.trim_end_matches('/'), port.trim());
        }
        let parsed =
            reqwest::Url::parse(&url).map_err(|_| anyhow!("Invalid Redis configuration"))?;
        let ca = parsed
            .query_pairs()
            .find(|(key, _)| key == "ssl_ca_certs")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_else(|| config.variable("REDIS_TLS_CA_FILE", ""));
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
        let result = tokio::time::timeout(Duration::from_secs(2), async {
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
