//! Request-owned Milvus writer connection. Readiness and TLS use the common
//! transport, while write RPCs never inherit metadata's automatic retry loop.
use crate::{
    config::Config,
    memory_tools::trim,
    milvus,
    milvus_index::{Context, Io},
};
use anyhow::Result;
use prost::Message;
use serde_json::{Value, json};
use std::time::Duration;

#[derive(serde::Deserialize)]
pub struct Connection {
    pub milvus_uri: String,
    pub milvus_username: Option<String>,
    pub milvus_password: Option<String>,
    pub milvus_token: Option<String>,
}
impl Connection {
    pub fn from_config(config: &Config) -> Self {
        Self {
            milvus_uri: config.variable(
                "MILVUS_URI",
                "http://milvus.daedalus.svc.cluster.local:19530",
            ),
            milvus_username: config
                .env
                .get("MILVUS_USERNAME")
                .filter(|s| !s.is_empty())
                .or_else(|| config.env.get("MILVUS_USER"))
                .cloned(),
            milvus_password: config.env.get("MILVUS_PASSWORD").cloned(),
            milvus_token: config.env.get("MILVUS_TOKEN").cloned(),
        }
    }
    /// Ingestion's read probe does not pass MILVUS_DATABASE. Only the URI path
    /// selects a database; the metadata HTTP endpoint has a separate contract.
    pub fn arguments(&self, writer: bool) -> Value {
        fn cleaned(value: Option<&str>) -> Option<&str> {
            value.map(trim).filter(|s| !s.is_empty())
        }
        let mut user = cleaned(self.milvus_username.as_deref());
        let mut password = cleaned(self.milvus_password.as_deref());
        let token = cleaned(self.milvus_token.as_deref());
        let mut args = json!({"uri":self.milvus_uri});
        if writer {
            if (user.is_none() || password.is_none())
                && let Some((token_user, token_password)) = token.and_then(|t| t.split_once(':'))
            {
                user = user.or(Some(token_user));
                password = password.or(Some(token_password));
            }
            // The pinned vdb_upload passes a literal username:password token,
            // including "None" for absent values. Preserve configured behavior.
            args["token"] = json!(format!(
                "{}:{}",
                user.unwrap_or("None"),
                password.unwrap_or("None")
            ));
        } else if let Some(token) = token {
            args["token"] = json!(token);
        } else if user.is_some() || password.is_some() {
            args["token"] = json!(format!("{}:{}", user.unwrap_or(""), password.unwrap_or("")));
        }
        args
    }
    pub async fn connect(&self, config: &Config, writer: bool) -> Result<milvus::Client> {
        milvus::Client::for_index(config, &self.arguments(writer)).await
    }
}

/// Distinguish an unconfirmed service reply from an explicit application
/// rejection, so per-document orchestration can avoid replaying an uncertain
/// write. Neither the token nor service response details enter its display text.
#[derive(Debug)]
pub struct TransportFailure {
    pub method: &'static str,
    pub code: tonic::Code,
}
impl std::fmt::Display for TransportFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Milvus {} failed with gRPC status {}",
            self.method, self.code as i32
        )
    }
}
impl std::error::Error for TransportFailure {}
impl Io for milvus::Client {
    fn record_mutation(&mut self, collection: &str, timestamp: u64) {
        milvus::Client::record_mutation(self, collection, timestamp);
    }
    async fn exchange<I, O>(
        &mut self,
        method: &'static str,
        input: I,
        context: Context,
    ) -> Result<O>
    where
        I: Message + Default + Clone + Send + Sync + 'static,
        O: Message + Default + Send + Sync + 'static,
    {
        self.unary(
            method,
            input,
            context != Context::Connection,
            if context == Context::Orm {
                Some("default")
            } else {
                None
            },
        )
        .await
        .map_err(|_| TransportFailure {
            method,
            code: tonic::Code::Unavailable,
        })?
        .map_err(|status| {
            TransportFailure {
                method,
                code: status.code(),
            }
            .into()
        })
    }
    async fn sleep(&mut self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub(crate) fn configured(uri: &str) -> Config {
        Config {
            raw: json!({}),
            policy_raw: json!({}),
            python_tools: false,
            env: std::collections::HashMap::from([
                ("MILVUS_URI".into(), uri.into()),
                ("MILVUS_USERNAME".into(), "synthetic-user".into()),
                ("MILVUS_PASSWORD".into(), "synthetic-password".into()),
                ("MILVUS_DATABASE".into(), "ignored-for-ingestion".into()),
                (
                    "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH".into(),
                    std::env::var("GRPC_DEFAULT_SSL_ROOTS_FILE_PATH").unwrap_or_default(),
                ),
            ]),
        }
    }
    pub(crate) fn script(case: &Value) -> Value {
        json!(
            case["calls"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| c["method"] != "Connect")
                .cloned()
                .collect::<Vec<_>>()
        )
    }
    pub(crate) async fn perform(config: Config, case: Value) -> Result<()> {
        let collection = case["collection"].as_str().unwrap_or("private_collection");
        let connection = Connection::from_config(&config);
        let mut probe = connection.connect(&config, false).await?;
        crate::milvus_index::dimension_probe(&mut probe, collection, 2, "vector").await?;
        drop(probe);
        let mut writer = connection.connect(&config, true).await?;
        crate::milvus_index::upload(
            &mut writer,
            &crate::milvus_index::Options {
                collection,
                dimension: 2,
                recreate: case["recreate"].as_bool().unwrap(),
                timestamp: "2026-10-13 12:00:00",
                model: "nvidia/llama-nemotron-embed-1b-v2",
                surrogates: &Default::default(),
            },
            &mut case["records"].clone(),
        )
        .await
    }

    #[test]
    fn retained_ingestion_auth_arguments() {
        let mut data: Value =
            serde_json::from_str(include_str!("../tests/fixtures/milvus-index.json")).unwrap();
        crate::document_codecs::tests::expand(&mut data);
        for case in data["connections"].as_array().unwrap() {
            let config = Config {
                raw: json!({}),
                policy_raw: json!({}),
                python_tools: false,
                env: serde_json::from_value(case["env"].clone()).unwrap(),
            };
            let connection = Connection::from_config(&config);
            assert_eq!(connection.arguments(false), case["probe"], "{case}");
            assert_eq!(connection.arguments(true), case["writer"], "{case}");
        }
    }

    #[tokio::test]
    #[ignore = "requires the disposable retained-SDK gRPC peer; run index_transport_check.py"]
    async fn actual_grpc_indexing_lifecycle() {
        let control = std::env::var("DAEDALUS_INDEX_PEER_CONTROL").unwrap();
        let uri = std::env::var("DAEDALUS_INDEX_PEER_URI").unwrap();
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/milvus-index.json")).unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        let selection = std::env::var("DAEDALUS_INDEX_PEER_CASES").unwrap_or_else(|_| "all".into());
        for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            // The retained exhausted-rate-limit fixture includes over three
            // minutes of backoff. Replay tests compare every RPC and delay;
            // this network check exercises the successful retry variants.
            if case["mode"] == "rate-limit-exhausted" {
                continue;
            }
            if selection != "all" && selection != index.to_string() {
                continue;
            }
            http.post(format!("{control}/reset"))
                .json(&json!({"script":script(case),"uri":uri}))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            let result = perform(configured(&uri), case.clone()).await;
            match result {
                Ok(()) => assert!(case["expected"].get("rows").is_some()),
                Err(error) => {
                    let Some(expected) = case["expected"]["message"].as_str() else {
                        panic!("Unexpected indexing failure: {error}");
                    };
                    assert_eq!(error.to_string(), expected);
                }
            }
            let state: Value = http
                .get(format!("{control}/script"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(
                state,
                json!({"remaining":0,"errors":[]}),
                "{}",
                case["mode"]
            );
        }
        if selection != "all" {
            return;
        }
        let case = &fixture["cases"][0];
        for (code, expected) in [
            ("UNAVAILABLE", tonic::Code::Unavailable),
            ("DEADLINE_EXCEEDED", tonic::Code::DeadlineExceeded),
            ("PERMISSION_DENIED", tonic::Code::PermissionDenied),
        ] {
            http.post(format!("{control}/reset"))
                .json(&json!({
                    "script":script(case),"uri":uri,"faults":{"Insert":{"grpc":code,"count":1}},
                }))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            let error = perform(configured(&uri), case.clone()).await.unwrap_err();
            let failure = error.downcast_ref::<TransportFailure>().unwrap();
            assert_eq!(failure.method, "Insert");
            assert_eq!(failure.code, expected);
            let calls: Vec<Value> = http
                .get(format!("{control}/calls"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(calls.iter().filter(|c| c["method"] == "Insert").count(), 1);
            assert_eq!(calls.last().unwrap()["method"], "Insert");
        }

        // Cancel a real network waiter while its Insert is still in flight.
        // Ownership keeps that channel and collection alive through completion.
        http.post(format!("{control}/reset"))
            .json(&json!({
                "script":script(case),"uri":uri,"delay":{"Insert":{"seconds":30,"count":1}},
            }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let config = configured(&uri);
        let owned_case = case.clone();
        let waiter = tokio::spawn(crate::document_ownership::run(
            lock.clone(),
            Duration::from_secs(60),
            move || perform(config, owned_case),
        ));
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let calls: Vec<Value> = http
                    .get(format!("{control}/calls"))
                    .send()
                    .await
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
                if calls.iter().any(|c| c["method"] == "Insert") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        assert!(lock.try_lock().is_err());
        http.post(format!("{control}/release"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        crate::document_ownership::run(lock, Duration::from_secs(5), || async { Ok(()) })
            .await
            .unwrap();
        let state: Value = http
            .get(format!("{control}/script"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(state, json!({"remaining":0,"errors":[]}));
        let calls: Vec<Value> = http
            .get(format!("{control}/calls"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(calls.iter().filter(|c| c["method"] == "Insert").count(), 2);
        assert!(calls.iter().all(|c| c["cancelled"] == false));
        assert!(
            calls
                .iter()
                .filter(|c| c["method"] != "Connect")
                .all(|c| c["deadline"] == false)
        );
    }
}
