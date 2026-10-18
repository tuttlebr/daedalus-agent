//! Request-owned Milvus gRPC reads. Authentication, database headers, handshake,
//! legacy statuses and retry decisions match the retained PyMilvus consumer.
use crate::{collections, config::Config, milvus_proto as pb};
use anyhow::{Result, anyhow, bail};
use base64::Engine;
use prost::Message;
use std::time::Duration;
use tokio::time::Instant;
use tonic::{
    Code, Request,
    client::Grpc,
    codec::CompressionEncoding,
    metadata::MetadataValue,
    transport::{Certificate, Channel, ClientTlsConfig, Endpoint},
};

const UNAVAILABLE: &str = "Milvus metadata unavailable";
#[derive(Clone)]
struct Settings {
    endpoint: String,
    socket: Option<String>,
    authorization: Option<String>,
    user: String,
    database: String,
    domain_options: Option<serde_json::Value>,
}
impl Settings {
    fn new(config: &Config) -> Result<Self> {
        Self::from_args(&collections::kwargs(config))
    }
    fn from_args(args: &serde_json::Value) -> Result<Self> {
        let raw = args["uri"].as_str().ok_or_else(|| anyhow!(UNAVAILABLE))?;
        let mut user = args["user"].as_str().unwrap_or("").to_owned();
        let mut password = args["password"].as_str().unwrap_or("").to_owned();
        let (endpoint, socket, path) = if let Some(path) = raw.strip_prefix("unix:") {
            ("http://localhost".to_owned(), Some(path.to_owned()), path)
        } else {
            let uri = reqwest::Url::parse(raw).map_err(|_| anyhow!(UNAVAILABLE))?;
            if !["http", "https", "tcp", "grpc"].contains(&uri.scheme()) {
                bail!(UNAVAILABLE);
            }
            let host = uri.host_str().ok_or_else(|| anyhow!(UNAVAILABLE))?;
            // The retained connection validator rejects IPv6 addresses.
            if host.contains(':') {
                bail!(UNAVAILABLE);
            }
            if !uri.username().is_empty() {
                user = uri.username().into();
            }
            if let Some(value) = uri.password().filter(|s| !s.is_empty()) {
                password = value.into();
            }
            // URL canonicalization removes explicit default ports. Preserve
            // those, because Milvus's default for a bare http URI is 19530.
            let after = raw.split_once("://").ok_or_else(|| anyhow!(UNAVAILABLE))?.1;
            let authority = after.split(['/', '?', '#']).next().unwrap();
            let authority = authority.rsplit('@').next().unwrap();
            let port = authority
                .rsplit_once(':')
                .and_then(|(_, n)| n.parse::<u16>().ok())
                .unwrap_or(if uri.scheme() == "https" { 443 } else { 19530 });
            if port == u16::MAX {
                bail!(UNAVAILABLE);
            }
            let path = after
                .find(['/', '?', '#'])
                .filter(|i| after.as_bytes()[*i] == b'/')
                .map(|i| &after[i..])
                .unwrap_or("")
                .split(['?', '#'])
                .next()
                .unwrap();
            (
                format!(
                    "{}://{host}:{port}",
                    if uri.scheme() == "https" {
                        "https"
                    } else {
                        "http"
                    }
                ),
                None,
                path,
            )
        };
        let token = args["token"].as_str().unwrap_or("");
        let authorization = if !token.is_empty() {
            Some(token.into())
        } else if !user.is_empty() && !password.is_empty() {
            Some(format!("{user}:{password}"))
        } else {
            None
        };
        let database = args["db_name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| path.split('/').find(|s| !s.is_empty()).unwrap_or(""));
        Ok(Self {
            endpoint,
            socket,
            authorization: authorization
                .map(|s: String| base64::engine::general_purpose::STANDARD.encode(s)),
            user,
            database: database.into(),
            domain_options: None,
        })
    }
}
#[derive(Clone)]
pub(super) struct Client {
    grpc: Grpc<Channel>,
    settings: Settings,
    identifier: Option<i64>,
    deadline: Option<Instant>,
    retry_until: Option<Instant>,
    rpc_timeout: Option<Duration>,
    #[cfg(test)]
    retry_sleeps: Option<std::sync::Arc<std::sync::Mutex<Vec<u64>>>>,
}
pub(super) trait Status {
    fn status(&self) -> Option<&pb::Status>;
}

#[derive(Debug)]
pub(super) enum ReadFailure {
    Configuration,
    Transport,
    Application,
    RateLimitExhausted,
    Exhausted,
}
impl std::fmt::Display for ReadFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(UNAVAILABLE)
    }
}
impl std::error::Error for ReadFailure {}
macro_rules! status {
    ($($type:ident),*) => {$(impl Status for pb::$type { fn status(&self) -> Option<&pb::Status> { self.status.as_ref() } })*};
}
status!(
    ConnectResponse,
    ShowCollectionsResponse,
    DescribeCollectionResponse
);

fn missing(status: &pb::Status) -> bool {
    status.error_code == 4
        || status.code == 100
        || (status.error_code == 1 && status.reason.contains("can't find collection"))
}
impl Client {
    fn clock_address(&self) -> String {
        if let Some(path) = &self.settings.socket {
            format!("unix:{path}")
        } else {
            self.settings
                .endpoint
                .split_once("://")
                .unwrap()
                .1
                .to_owned()
        }
    }
    pub fn mutation_timestamp(&self, collection: &str) -> u64 {
        crate::milvus_timestamps::get(&self.clock_address(), &self.settings.database, collection)
            .max(1)
    }
    pub fn record_mutation(&self, collection: &str, timestamp: u64) {
        crate::milvus_timestamps::record(
            &self.clock_address(),
            &self.settings.database,
            collection,
            timestamp,
        );
    }
    async fn new(config: &Config, duration: Duration) -> Result<Self> {
        Self::connect(config, Settings::new(config)?, duration, true).await
    }
    async fn connect(
        config: &Config,
        settings: Settings,
        duration: Duration,
        bounded: bool,
    ) -> Result<Self> {
        let deadline = bounded.then(|| Instant::now() + duration);
        let mut endpoint =
            Endpoint::from_shared(settings.endpoint.clone())?.connect_timeout(duration);
        // The pinned SDK installs these keepalive defaults on every channel;
        // only domain grpc_options can override them. Its handshake, tool reads
        // and writes send no gRPC deadline, so keepalive alone bounds a silent
        // or half-open transport.
        let defaults = serde_json::Value::Null;
        let options = settings
            .domain_options
            .as_ref()
            .map_or(&defaults, |options| &options["grpc_options"]);
        let millis = |key: &str, default| {
            options[key]
                .as_u64()
                .map(Duration::from_millis)
                .unwrap_or(default)
        };
        endpoint = endpoint
            .http2_keep_alive_interval(millis("grpc.keepalive_time_ms", Duration::from_secs(10)))
            .keep_alive_timeout(millis("grpc.keepalive_timeout_ms", Duration::from_secs(5)))
            .keep_alive_while_idle(
                options["grpc.keepalive_permit_without_calls"]
                    .as_bool()
                    .unwrap_or_else(|| {
                        options["grpc.keepalive_permit_without_calls"]
                            .as_i64()
                            .is_none_or(|v| v != 0)
                    }),
            );
        if settings.endpoint.starts_with("https:") {
            let roots = config.variable("GRPC_DEFAULT_SSL_ROOTS_FILE_PATH", "");
            let roots = if settings.domain_options.as_ref().is_some_and(|args| {
                args["server_pem_path"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
                    || ["ca_pem_path", "client_pem_path", "client_key_path"]
                        .iter()
                        .all(|name| args[*name].as_str().is_some_and(|s| !s.is_empty()))
            }) {
                String::new()
            } else {
                roots
            };
            let tls = if roots.is_empty() {
                ClientTlsConfig::new().with_native_roots()
            } else {
                ClientTlsConfig::new().ca_certificate(Certificate::from_pem(std::fs::read(roots)?))
            };
            let tls = if let Some(options) = &settings.domain_options {
                Self::domain_tls(tls, options)?
            } else {
                tls
            };
            endpoint = endpoint.tls_config(tls.timeout(duration))?;
        }
        let channel = if let Some(path) = settings.socket.clone() {
            endpoint
                .connect_with_connector(tower::service_fn(move |_| {
                    let path = path.clone();
                    async move {
                        tokio::net::UnixStream::connect(path)
                            .await
                            .map(hyper_util::rt::TokioIo::new)
                    }
                }))
                .await?
        } else {
            endpoint.connect().await?
        };
        let grpc = Grpc::new(channel)
            .accept_compressed(CompressionEncoding::Gzip)
            .max_decoding_message_size(usize::MAX)
            .max_encoding_message_size(usize::MAX);
        let mut client = Self {
            grpc,
            settings,
            identifier: None,
            deadline,
            retry_until: (!bounded).then(|| Instant::now() + duration),
            rpc_timeout: None,
            #[cfg(test)]
            retry_sleeps: None,
        };
        let request = pb::ConnectRequest {
            client_info: Some(pb::ClientInfo {
                sdk_type: "Rust".into(),
                sdk_version: env!("CARGO_PKG_VERSION").into(),
                local_time: chrono::Local::now()
                    .format("%Y-%m-%d %H:%M:%S%.6f")
                    .to_string(),
                user: client.settings.user.clone(),
                host: config.variable("HOSTNAME", "localhost"),
            }),
        };
        let response: pb::ConnectResponse = client.call("Connect", request, false, false).await?;
        client.identifier = Some(response.identifier);
        client.retry_until = None;
        Ok(client)
    }
    pub(super) async fn for_index(config: &Config, args: &serde_json::Value) -> Result<Self> {
        let mut client = Self::connect(
            config,
            Settings::from_args(args)?,
            Duration::from_secs(10),
            true,
        )
        .await?;
        // The retained SDK's writer does not set per-RPC deadlines. The document
        // waiter owns its timeout, while started work retains collection ownership
        // until it settles. Do not turn caller cancellation into a write replay.
        client.deadline = None;
        Ok(client)
    }
    pub(super) async fn for_tool(config: &Config, args: &serde_json::Value) -> Result<Self> {
        // The SDK's tool connection checks a ten-second retry budget after
        // failed handshakes, but sends Connect without a gRPC deadline. Later
        // reads have no timeout and use the 75-retry limit instead.
        Self::connect(
            config,
            Settings::from_args(args).map_err(|_| ReadFailure::Configuration)?,
            Duration::from_secs(10),
            false,
        )
        .await
    }

    fn domain_tls(
        mut tls: ClientTlsConfig,
        options: &serde_json::Value,
    ) -> Result<ClientTlsConfig> {
        let path = |name: &str| -> Result<&str> {
            options.get(name).map_or(Ok(""), |value| {
                value
                    .as_str()
                    .ok_or_else(|| crate::document_search::Failure::new("TypeError").into())
            })
        };
        let read = |path: &str| -> Result<Vec<u8>> {
            std::fs::read(path).map_err(|error| {
                crate::document_search::Failure::new(match error.kind() {
                    std::io::ErrorKind::NotFound => "FileNotFoundError",
                    std::io::ErrorKind::PermissionDenied => "PermissionError",
                    std::io::ErrorKind::IsADirectory => "IsADirectoryError",
                    _ => "OSError",
                })
                .into()
            })
        };
        let server = path("server_pem_path")?;
        if !server.is_empty() {
            tls = ClientTlsConfig::new().ca_certificate(Certificate::from_pem(read(server)?));
        } else {
            let (ca, cert, key) = (
                path("ca_pem_path")?,
                path("client_pem_path")?,
                path("client_key_path")?,
            );
            if !ca.is_empty() && !cert.is_empty() && !key.is_empty() {
                tls = ClientTlsConfig::new()
                    .ca_certificate(Certificate::from_pem(read(ca)?))
                    .identity(tonic::transport::Identity::from_pem(
                        read(cert)?,
                        read(key)?,
                    ));
            }
        }
        let mut server_name = path("server_name")?;
        if server_name.is_empty() {
            server_name = options["grpc_options"]["grpc.ssl_target_name_override"]
                .as_str()
                .unwrap_or("");
        }
        if !server_name.is_empty() {
            tls = tls.domain_name(server_name);
        }
        Ok(tls)
    }

    fn domain_grpc_options(value: &serde_json::Value) -> Result<serde_json::Value> {
        if value.is_object() {
            return Ok(value.clone());
        }
        let pairs = value
            .as_array()
            .ok_or_else(|| crate::document_search::Failure::new("TypeError"))?;
        let mut options = serde_json::json!({});
        for pair in pairs {
            let pair = pair
                .as_array()
                .ok_or_else(|| crate::document_search::Failure::new("TypeError"))?;
            if pair.len() != 2 {
                return Err(crate::document_search::Failure::new("ValueError").into());
            }
            let key = pair[0]
                .as_str()
                .ok_or_else(|| crate::document_search::Failure::new("TypeError"))?;
            options[key] = pair[1].clone();
        }
        Ok(options)
    }

    pub(super) async fn for_domain(config: &Config, args: &serde_json::Value) -> Result<Self> {
        let mut args = args.clone();
        if let Some(options) = args.get("grpc_options") {
            args["grpc_options"] = Self::domain_grpc_options(options)?;
        }
        // The pinned SDK installs byte-keyed unlimited message sizes before
        // string-keyed user options. gRPC keeps the first duplicate, so JSON
        // max-message options do not replace those defaults. Service captures
        // exercise one-byte limits and retain the SDK's successful requests.
        for key in ["user", "password", "token"] {
            if let Some(value) = args.get(key) {
                args[key] = serde_json::json!(crate::profile_import::identifier(value));
            }
        }
        if let Some(address) = args
            .get("address")
            .filter(|value| crate::config::truthy(value))
        {
            let address = address
                .as_str()
                .ok_or_else(|| crate::document_search::Failure::new("ConnectionConfigException"))?
                .to_owned();
            // MilvusClient resolves the database from its URI before the
            // connection layer chooses an explicit address over that URI.
            let database = Settings::from_args(&args)
                .map_err(|_| ReadFailure::Configuration)?
                .database;
            args["db_name"] = serde_json::json!(database);
            args["uri"] = serde_json::json!(format!("http://{address}"));
        }
        let mut settings = Settings::from_args(&args).map_err(|_| ReadFailure::Configuration)?;
        if !settings.endpoint.starts_with("https:") {
            match args.get("secure") {
                None | Some(serde_json::Value::Bool(false)) => {}
                Some(serde_json::Value::Bool(true)) => {
                    settings.endpoint = settings.endpoint.replacen("http:", "https:", 1)
                }
                _ => return Err(crate::document_search::Failure::new("ParamError").into()),
            }
        }
        settings.domain_options = Some(args.clone());
        let seconds = args["timeout"].as_f64().or_else(|| {
            args["timeout"]
                .as_bool()
                .map(|value| f64::from(u8::from(value)))
        });
        if seconds.is_some_and(|seconds| seconds <= 0.0) {
            return Err(crate::document_search::Failure::new("MilvusException").into());
        }
        let duration = seconds
            .filter(|value| value.is_finite() && *value > 0.0)
            .and_then(|value| Duration::try_from_secs_f64(value).ok())
            .unwrap_or(Duration::from_secs(10));
        Self::connect(config, settings, duration, false).await
    }

    pub(super) fn with_read_timeout(&self, seconds: Option<f64>) -> Self {
        let mut client = self.clone();
        client.rpc_timeout = seconds.and_then(|seconds| Duration::try_from_secs_f64(seconds).ok());
        client.retry_until = client
            .rpc_timeout
            .and_then(|duration| Instant::now().checked_add(duration));
        client
    }
    pub(super) async fn unary<I, O>(
        &mut self,
        method: &'static str,
        body: I,
        context: bool,
        database: Option<&str>,
    ) -> Result<std::result::Result<O, tonic::Status>>
    where
        I: Message + Default + Clone + Send + Sync + 'static,
        O: Message + Default + Send + Sync + 'static,
    {
        let remaining = self
            .deadline
            .map(|deadline| {
                deadline
                    .checked_duration_since(Instant::now())
                    .ok_or_else(|| anyhow!(UNAVAILABLE))
            })
            .transpose()?;
        self.grpc.ready().await.map_err(|_| anyhow!(UNAVAILABLE))?;
        let mut request = Request::new(body);
        if let Some(remaining) = remaining.or(self.rpc_timeout) {
            request.set_timeout(remaining);
        }
        let metadata = request.metadata_mut();
        if let Some(value) = &self.settings.authorization {
            metadata.insert("authorization", MetadataValue::try_from(value.as_str())?);
        }
        if let Some(identifier) = self.identifier {
            metadata.insert(
                "identifier",
                MetadataValue::try_from(identifier.to_string())?,
            );
        }
        if context {
            metadata.insert(
                "dbname",
                MetadataValue::try_from(database.unwrap_or(&self.settings.database))?,
            );
            metadata.insert("client-request-id", MetadataValue::from_static(""));
            metadata.insert(
                "client-request-unixmsec",
                MetadataValue::try_from(chrono::Utc::now().timestamp_millis().to_string())?,
            );
        }
        let path = format!("/milvus.proto.milvus.MilvusService/{method}").parse()?;
        Ok(self
            .grpc
            .unary(request, path, tonic_prost::ProstCodec::<I, O>::default())
            .await
            .map(|response| response.into_inner()))
    }
    pub(super) async fn call<I, O>(
        &mut self,
        method: &'static str,
        body: I,
        context: bool,
        allow_missing: bool,
    ) -> Result<O>
    where
        I: Message + Default + Clone + Send + Sync + 'static,
        O: Message + Default + Status + Send + Sync + 'static,
    {
        let mut backoff = Duration::from_millis(10);
        for attempt in 0.. {
            let result: std::result::Result<O, _> =
                self.unary(method, body.clone(), context, None).await?;
            let modern_rate_limit = match result {
                Ok(response) => {
                    let default = pb::Status::default();
                    let status = response.status().unwrap_or(&default);
                    if (status.code == 0 && status.error_code == 0)
                        || (allow_missing && missing(status))
                    {
                        return Ok(response);
                    }
                    if status.code != 8 && status.error_code != 49 {
                        return Err(ReadFailure::Application.into());
                    }
                    status.code == 8
                }
                Err(status) => {
                    if matches!(
                        status.code(),
                        Code::DeadlineExceeded
                            | Code::PermissionDenied
                            | Code::Unauthenticated
                            | Code::InvalidArgument
                            | Code::AlreadyExists
                            | Code::ResourceExhausted
                            | Code::Unimplemented
                    ) {
                        return Err(ReadFailure::Transport.into());
                    }
                    false
                }
            };
            // Tool clients omit a deadline and use the SDK's 75-retry limit.
            // HTTP metadata instead bounds retries by its total deadline.
            if self
                .retry_until
                .is_some_and(|until| Instant::now() >= until)
                || self.retry_until.is_none() && self.deadline.is_none() && attempt >= 75
            {
                return Err(if modern_rate_limit {
                    ReadFailure::RateLimitExhausted
                } else {
                    ReadFailure::Exhausted
                }
                .into());
            }
            self.retry_sleep(backoff).await;
            backoff = (backoff * 3).min(Duration::from_secs(3));
        }
        unreachable!("retry loop only exits through a result")
    }

    pub(super) async fn retry_sleep(&self, duration: Duration) {
        // Service acceptance exercises every actual RPC while recording the
        // requested backoff. Production always waits for the full duration.
        #[cfg(test)]
        if let Some(sleeps) = &self.retry_sleeps {
            sleeps
                .lock()
                .expect("Milvus retry recorder")
                .push(duration.as_millis() as u64);
            return;
        }
        tokio::time::sleep(duration).await;
    }

    #[cfg(test)]
    pub(super) fn record_retry_sleeps(&mut self) -> std::sync::Arc<std::sync::Mutex<Vec<u64>>> {
        let sleeps = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        self.retry_sleeps = Some(sleeps.clone());
        sleeps
    }

    pub(super) async fn collections(&mut self) -> Result<Vec<String>> {
        let listed: pb::ShowCollectionsResponse = self
            .call(
                "ShowCollections",
                pb::ShowCollectionsRequest {},
                true,
                false,
            )
            .await?;
        Ok(listed.collection_names)
    }
}
pub async fn list_collections(config: &Config) -> Result<Vec<String>> {
    let duration = Duration::from_secs_f64(collections::timeout(config)?);
    tokio::time::timeout(duration, async {
        let mut client = Client::new(config, duration).await?;
        let listed: pb::ShowCollectionsResponse = client
            .call(
                "ShowCollections",
                pb::ShowCollectionsRequest {},
                true,
                false,
            )
            .await?;
        // A list-only public role is not enough: retain the DescribeCollection
        // permission probe, including the empty-database sentinel.
        let name = listed
            .collection_names
            .first()
            .map(String::as_str)
            .unwrap_or("__daedalus_rag_readiness__");
        let _: pb::DescribeCollectionResponse = client
            .call(
                "DescribeCollection",
                pb::DescribeCollectionRequest {
                    collection_name: name.into(),
                },
                true,
                true,
            )
            .await?;
        Ok(listed.collection_names)
    })
    .await
    .map_err(|_| anyhow!(UNAVAILABLE))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    fn subset(actual: &Value, expected: &Value) {
        if let Some(fields) = expected.as_object() {
            assert!(actual.is_object());
            for (key, value) in fields {
                subset(&actual[key], value);
            }
        } else if actual.is_number() && expected.is_string() {
            assert_eq!(actual.to_string(), expected.as_str().unwrap());
        } else {
            assert_eq!(actual, expected);
        }
    }
    fn status(value: Option<pb::Status>) -> Value {
        value.map(|s| json!({"error_code":s.error_code, "reason":s.reason, "code":s.code, "retriable":s.retriable})).unwrap_or(Value::Null)
    }
    #[test]
    fn pinned_milvus_protobuf_contracts() {
        for case in collections::tests::fixture()["wire"].as_array().unwrap() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(case["base64"].as_str().unwrap())
                .unwrap();
            macro_rules! decode {
                ($type:ident) => {{
                    let value = pb::$type::decode(bytes.as_slice()).unwrap();
                    assert_eq!(value.encode_to_vec(), bytes);
                    value
                }};
            }
            let actual = match case["type"].as_str().unwrap() {
                "ConnectRequest" => {
                    let info = decode!(ConnectRequest).client_info.unwrap();
                    json!({"client_info":{"sdk_type":info.sdk_type,"sdk_version":info.sdk_version,"local_time":info.local_time,"user":info.user,"host":info.host}})
                }
                "ConnectResponse" => {
                    let value = decode!(ConnectResponse);
                    json!({"identifier":value.identifier,"status":status(value.status)})
                }
                "ShowCollectionsRequest" => {
                    decode!(ShowCollectionsRequest);
                    json!({})
                }
                "ShowCollectionsResponse" => {
                    let value = decode!(ShowCollectionsResponse);
                    json!({"status":status(value.status),"collection_names":value.collection_names})
                }
                "DescribeCollectionRequest" => {
                    json!({"collection_name":decode!(DescribeCollectionRequest).collection_name})
                }
                "DescribeCollectionResponse" => {
                    json!({"status":status(decode!(DescribeCollectionResponse).status)})
                }
                _ => unreachable!(),
            };
            subset(&actual, &case["input"]);
        }
    }
    #[tokio::test]
    async fn unresponsive_transport_fails_without_a_grpc_deadline() {
        use tokio::io::AsyncReadExt;
        // Accept TCP and discard bytes without answering HTTP/2 frames or
        // pings, as a black-holed or half-open Milvus connection does.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let peer = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut buffer = [0; 4096];
                    while socket.read(&mut buffer).await.is_ok_and(|n| n > 0) {}
                });
            }
        });
        let config = Config {
            raw: json!({}),
            policy_raw: json!({}),
            python_tools: false,
            env: Default::default(),
        };
        // The tool handshake, like the SDK's, sends Connect without a gRPC
        // deadline. The SDK's keepalive is what bounds a silent transport.
        let result = tokio::time::timeout(
            Duration::from_secs(60),
            Client::for_tool(&config, &json!({"uri":format!("http://{address}")})),
        )
        .await;
        peer.abort();
        let error = match result.expect("a silent Milvus transport must fail, not hang") {
            Ok(_) => panic!("a silent Milvus transport cannot complete the handshake"),
            Err(error) => error,
        };
        assert!(matches!(
            error.downcast_ref::<ReadFailure>(),
            Some(ReadFailure::Exhausted)
        ));
    }
    #[test]
    fn retained_connection_settings() {
        for case in collections::tests::fixture()["endpoints"]
            .as_array()
            .unwrap()
        {
            let config = Config {
                raw: json!({}),
                policy_raw: json!({}),
                python_tools: false,
                env: serde_json::from_value(case["env"].clone()).unwrap(),
            };
            let actual = Settings::new(&config);
            if let Some(expected) = case["expected"].get("ok") {
                let value = actual.unwrap_or_else(|e| panic!("{case}: {e}"));
                assert_eq!(
                    json!({"endpoint":value.endpoint,"socket":value.socket,
                    "authorization":value.authorization,"user":value.user,
                    "database":value.database}),
                    *expected,
                    "{case}"
                );
            } else {
                assert!(actual.is_err(), "{case}");
            }
        }
    }
}
