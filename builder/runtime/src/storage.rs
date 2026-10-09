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
