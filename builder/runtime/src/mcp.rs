//! Per-user MCP sessions and exposure policy. One bounded dispatch per call;
//! reconnecting never replays an operation with an uncertain remote outcome.
use crate::{
    agent::ToolOutcome,
    authorization::{Approvals, Gate, Locks, hash},
    config::{Config, MAX_CONCURRENCY, names, number},
    oauth::{self, Emitter, GoogleOAuth},
};
use anyhow::{Context, Result, anyhow, bail};
use futures::future::join_all;
use http::{HeaderName, HeaderValue};
use rmcp::{
    ServiceError, ServiceExt,
    model::{CallToolRequestParams, CallToolResponse, ClientConfig, PaginatedRequestParams, Tool},
    service::{RoleClient, RunningService, RunningServiceCancellationToken},
    transport::{
        StreamableHttpClientTransport, streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub const UNCONFIRMED: &str = "MCP call did not return a confirmed result. Its remote outcome may be unknown; check the current state before repeating a change.";
/// Run preparation waits at most this long for a session another run holds
/// (an in-flight call or connection) before using its open session's
/// catalogue, or the `__connect` schema when there is none.
const DISCOVERY_WAIT: Duration = Duration::from_secs(2);
#[derive(Debug)]
enum FailureClass {
    Value,
    Validation,
    Schema,
}
impl std::fmt::Display for FailureClass {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Value => "ValueError",
            Self::Validation => "ValidationError",
            Self::Schema => "SchemaError",
        })
    }
}
impl std::error::Error for FailureClass {}
struct Connection {
    session: RunningService<RoleClient, ClientConfig>,
    tools: Vec<Tool>,
    digest: String,
    http: crate::mcp_http::BoundedHttp,
    last_used: Mutex<Instant>,
    _capacity: OwnedSemaphorePermit,
}
struct CancelOnDrop(Option<RunningServiceCancellationToken>);
/// Admission spans concurrent runs in this process, while session locks below
/// protect each individual transport. Weak entries expire with the last caller.
#[derive(Default)]
struct Admission(Mutex<HashMap<String, Weak<Semaphore>>>);
impl Admission {
    fn get(&self, key: &str, bound: usize) -> Arc<Semaphore> {
        let mut gates = self.0.lock().unwrap();
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = gates.get(key).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Arc::new(Semaphore::new(bound));
        gates.insert(key.into(), Arc::downgrade(&gate));
        gate
    }
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(token) = self.0.take() {
            token.cancel();
            tracing::info!(event = "mcp_transport_cancelled");
        }
    }
}
impl Connection {
    fn guard(&self) -> CancelOnDrop {
        CancelOnDrop(Some(self.session.cancellation_token()))
    }
    fn close(&self) {
        self.session.cancellation_token().cancel();
    }
}
pub struct Mcp {
    config: Config,
    groups: Vec<String>,
    connections: Mutex<HashMap<String, Arc<Connection>>>,
    locks: Locks,
    admission: Admission,
    capacity: Arc<Semaphore>,
    /// Sessions beyond a user's first draw on their own pool, so overlapping
    /// reads can never use up the connections first sessions need.
    pub(crate) further_capacity: Arc<Semaphore>,
    pub oauth: GoogleOAuth,
    pub approvals: Approvals,
}
pub fn validate(config: &Config) -> Result<()> {
    Approvals::new(config)?;
    if let Some(groups) = config.raw["function_groups"].as_object() {
        for (name, group) in groups {
            if name.is_empty()
                || name.contains("__")
                || !["mcp_client", "per_user_mcp_client"]
                    .contains(&group["_type"].as_str().unwrap_or(""))
            {
                bail!("Invalid MCP function group");
            }
            let server = &group["server"];
            if server["transport"].as_str().unwrap_or("streamable-http") != "streamable-http" {
                bail!("Only MCP Streamable HTTP is supported");
            }
            let url = reqwest::Url::parse(server["url"].as_str().unwrap_or(""))
                .map_err(|_| anyhow!("Invalid MCP URL"))?;
            if !["http", "https"].contains(&url.scheme())
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
            {
                bail!("Invalid MCP URL");
            }
            let timeout = group
                .get("tool_call_timeout")
                .map(number)
                .transpose()?
                .unwrap_or(120.);
            if timeout <= 0. || timeout > 1800. {
                bail!("Invalid MCP tool timeout");
            }
            if let Some(value) = group.get("max_concurrency")
                && !value
                    .as_u64()
                    .is_some_and(|n| (1..=MAX_CONCURRENCY as u64).contains(&n))
            {
                bail!(
                    "Invalid MCP group max_concurrency: expected an integer from 1 to {MAX_CONCURRENCY}"
                );
            }
            let auth =
                &config.raw["authentication"][server["auth_provider"].as_str().unwrap_or("")];
            if !auth.is_null() && auth.as_object().is_none_or(|a| !a.is_empty()) {
                match auth["_type"].as_str() {
                    Some("mcp_oauth2") => {
                        oauth::service(auth)?;
                        names(auth.get("scopes"))?;
                    }
                    Some("api_key") => {}
                    _ => bail!("Unsupported MCP authentication provider"),
                }
            }
            if let Some(headers) = server.get("custom_headers") {
                for (name, value) in headers
                    .as_object()
                    .ok_or_else(|| anyhow!("Invalid MCP headers"))?
                {
                    HeaderName::from_bytes(name.as_bytes())
                        .map_err(|_| anyhow!("Invalid MCP header name"))?;
                    HeaderValue::from_str(
                        value
                            .as_str()
                            .ok_or_else(|| anyhow!("Invalid MCP header value"))?,
                    )
                    .map_err(|_| anyhow!("Invalid MCP header value"))?;
                }
            }
        }
    }
    let required = config.variable("DAEDALUS_REQUIRED_MCP_GROUPS", "");
    for name in required.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        if config.raw["function_groups"].get(name).is_none() {
            bail!("Unknown required MCP capability");
        }
    }
    Ok(())
}
impl Mcp {
    pub fn new(config: &Config) -> Result<Arc<Self>> {
        validate(config)?;
        Ok(Arc::new(Self {
            config: config.clone(),
            groups: config.raw["function_groups"]
                .as_object()
                .map(|g| g.keys().cloned().collect())
                .unwrap_or_default(),
            connections: Mutex::default(),
            locks: Locks::default(),
            admission: Admission::default(),
            capacity: Arc::new(Semaphore::new(256)),
            further_capacity: Arc::new(Semaphore::new(512)),
            oauth: GoogleOAuth::new(config)?,
            approvals: Approvals::new(config)?,
        }))
    }
    pub fn owns(&self, name: &str) -> bool {
        name.split_once("__")
            .is_some_and(|(group, _)| self.groups.iter().any(|g| g == group))
    }
    fn key(name: &str, user: &str) -> String {
        serde_json::to_string(&(name, user)).unwrap()
    }
    /// Overlapping reads use further sessions of the same user and group. The
    /// first session keeps the plain key that discovery and readiness use.
    fn session_key(name: &str, user: &str, session: usize) -> String {
        if session == 0 {
            Self::key(name, user)
        } else {
            serde_json::to_string(&(name, user, session)).unwrap()
        }
    }
    /// Sessions one user may hold with this group: its configured bound, or
    /// as many as one run admits when unset.
    fn sessions(&self, name: &str) -> usize {
        self.config.raw["function_groups"][name]["max_concurrency"]
            .as_u64()
            .map_or(MAX_CONCURRENCY, |bound| {
                (bound as usize).clamp(1, MAX_CONCURRENCY)
            })
    }
    /// How many calls of this tool may be in flight at once for one user.
    /// Only a tool the deployed policy marks exactly `read_only` may overlap,
    /// up to its group's bound. Connecting and every other operation stay
    /// exclusive, so changes keep their order.
    pub fn concurrency(&self, full_name: &str) -> usize {
        match full_name.split_once("__") {
            Some((name, tool))
                if tool != "connect" && self.approvals.policies.read_only(name, tool) =>
            {
                self.sessions(name)
            }
            _ => 1,
        }
    }
    /// One call at a time owns a session. A call allowed to overlap takes the
    /// first free session of its group, otherwise whichever frees first.
    /// Returns whether it waited behind another call.
    async fn session(
        &self,
        name: &str,
        user: &str,
        sessions: usize,
    ) -> (String, tokio::sync::OwnedMutexGuard<()>, bool) {
        let keys: Vec<String> = (0..sessions.max(1))
            .map(|session| Self::session_key(name, user, session))
            .collect();
        for key in &keys {
            if let Ok(guard) = self.locks.get(key).try_lock_owned() {
                return (key.clone(), guard, false);
            }
        }
        let waits = keys
            .iter()
            .map(|key| Box::pin(self.locks.get(key).lock_owned()));
        let (guard, index, _) = futures::future::select_all(waits).await;
        (keys[index].clone(), guard, true)
    }
    fn auth(&self, name: &str) -> &Value {
        &self.config.raw["authentication"]
            [self.config.raw["function_groups"][name]["server"]["auth_provider"]
                .as_str()
                .unwrap_or("")]
    }
    async fn headers(
        &self,
        name: &str,
        user: &str,
        emit: Option<&Emitter>,
    ) -> Result<Option<HashMap<HeaderName, HeaderValue>>> {
        let group = &self.config.raw["function_groups"][name];
        let mut headers = HashMap::new();
        if let Some(custom) = group["server"]["custom_headers"].as_object() {
            for (key, value) in custom {
                headers.insert(
                    HeaderName::from_bytes(key.as_bytes())?,
                    HeaderValue::from_str(value.as_str().unwrap_or(""))?,
                );
            }
        }
        let auth = self.auth(name);
        match auth["_type"].as_str() {
            Some("mcp_oauth2") => {
                let Some(token) = self.oauth.access_token(user, auth, emit).await? else {
                    return Ok(None);
                };
                headers.insert(
                    http::header::AUTHORIZATION,
                    HeaderValue::from_str(&format!("Bearer {token}"))?,
                );
            }
            Some("api_key") => {
                let raw = auth["raw_key"].as_str().unwrap_or("");
                if raw.is_empty() {
                    bail!("MCP credential is not configured");
                }
                let name = auth["custom_header_name"]
                    .as_str()
                    .unwrap_or("Authorization");
                let prefix = auth["custom_header_prefix"].as_str().unwrap_or("Bearer");
                headers.insert(
                    HeaderName::from_bytes(name.as_bytes())?,
                    HeaderValue::from_str(format!("{prefix} {raw}").trim())?,
                );
            }
            _ => {}
        }
        Ok(Some(headers))
    }
    /// `further` marks a session beyond the user's first with this group.
    async fn connection(
        &self,
        name: &str,
        key: &str,
        further: bool,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<Arc<Connection>> {
        let key = key.to_owned();
        let mut ordered: Vec<_> = headers
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_bytes()))
            .collect();
        ordered.sort_by_key(|(k, _)| *k);
        let digest = hash(&serde_json::to_string(&ordered)?);
        {
            let mut connections = self.connections.lock().unwrap();
            if let Some(cached) = connections.get(&key) {
                if cached.digest == digest && !cached.session.is_closed() {
                    *cached.last_used.lock().unwrap() = Instant::now();
                    return Ok(cached.clone());
                }
                cached.close();
                connections.remove(&key);
            }
        }
        let capacity = if further {
            &self.further_capacity
        } else {
            &self.capacity
        }
        .clone()
        .try_acquire_owned()
        .map_err(|_| anyhow!("MCP connection capacity reached"))?;
        let group = &self.config.raw["function_groups"][name];
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()?;
        let limit = crate::output::Settings::new(&self.config)
            .max_original
            .saturating_mul(6)
            .saturating_add(8 * 1024 * 1024);
        let http = crate::mcp_http::BoundedHttp::new(http, limit);
        let settings = StreamableHttpClientTransportConfig::with_uri(
            group["server"]["url"].as_str().unwrap_or("").to_owned(),
        )
        .custom_headers(headers)
        .max_concurrent_requests(1)
        .control_request_timeout(Duration::from_secs(5))
        .max_sse_event_size(limit)
        .reinit_on_expired_session(false);
        // Keep the baseline protocol and advertised capabilities. Do not enable
        // SDK sampling, roots, elicitation, or automatic multi-round tool calls.
        let client: ClientConfig = serde_json::from_value(
            json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"mcp","version":"0.1.0"}}),
        )?;
        let connection = tokio::time::timeout(Duration::from_secs(15), async {
            let session = client
                .serve(StreamableHttpClientTransport::with_client(
                    http.clone(),
                    settings,
                ))
                .await
                .map_err(|_| anyhow!("MCP connection is unavailable"))?;
            let mut tools: Vec<Tool> = Vec::new();
            let mut cursor = None;
            let mut complete = false;
            for _ in 0..100 {
                let mut params = PaginatedRequestParams::default();
                params.cursor = cursor;
                let page = session
                    .list_tools(Some(params))
                    .await
                    .map_err(|_| anyhow!("MCP discovery is unavailable"))?;
                for tool in page.tools {
                    if tools.iter().any(|t| t.name == tool.name) {
                        bail!("MCP catalogue contains duplicate names");
                    }
                    tools.push(tool);
                }
                cursor = page.next_cursor;
                if cursor.as_ref().is_none_or(String::is_empty) {
                    complete = true;
                    break;
                }
            }
            if !complete {
                bail!("MCP catalogue pagination exceeded limit");
            }
            Ok(Arc::new(Connection {
                session,
                tools,
                digest,
                http,
                last_used: Mutex::new(Instant::now()),
                _capacity: capacity,
            }))
        })
        .await
        .map_err(|_| anyhow!("MCP connection timed out"))??;
        self.connections
            .lock()
            .unwrap()
            .insert(key, connection.clone());
        Ok(connection)
    }
    fn open(&self, key: &str) -> Option<Arc<Connection>> {
        self.connections
            .lock()
            .unwrap()
            .get(key)
            .filter(|connection| !connection.session.is_closed())
            .cloned()
    }
    /// Discovery for run preparation. It never prompts for authorization and
    /// never queues behind another run's tool call: exposure only reads the
    /// catalogue, while each call revalidates under the session lock.
    async fn discover(&self, name: &str, user: &str) -> Result<Vec<Value>> {
        let key = Self::key(name, user);
        let lock = self.locks.get(&key);
        let _lock = match lock.try_lock() {
            Ok(guard) => guard,
            Err(_) => {
                if let Some(connection) = self.open(&key) {
                    return self.schemas(name, &connection);
                }
                match tokio::time::timeout(DISCOVERY_WAIT, lock.lock()).await {
                    Ok(guard) => guard,
                    Err(_) => {
                        let connection = self
                            .open(&key)
                            .ok_or_else(|| anyhow!("MCP session is busy"))?;
                        return self.schemas(name, &connection);
                    }
                }
            }
        };
        let Some(headers) = self.headers(name, user, None).await? else {
            bail!("Authorization required");
        };
        let connection = self.connection(name, &key, false, headers).await?;
        self.schemas(name, &connection)
    }
    /// Validate the complete exposed catalogue without cloning its input schemas.
    /// An undocumented exposed sibling must still prevent dispatch, even when
    /// the requested tool itself has a description.
    fn exposed_tools<'a>(
        &'a self,
        name: &str,
        connection: &'a Connection,
    ) -> Result<Vec<(&'a Tool, &'a str)>> {
        let group = &self.config.raw["function_groups"][name];
        // Match exposure exactly as the approval policy does (trimmed and
        // casefolded), so an excluded operation cannot stay exposed because
        // its remote name differs only in case.
        let normalized = |key| -> HashSet<String> {
            names(group.get(key))
                .unwrap_or_default()
                .iter()
                .map(|name| crate::authorization::fold(name.trim()))
                .collect()
        };
        let (include, exclude) = (normalized("include"), normalized("exclude"));
        connection
            .tools
            .iter()
            .filter(|tool| {
                let name = crate::authorization::fold(tool.name.trim());
                if include.is_empty() {
                    !exclude.contains(&name)
                } else {
                    include.contains(&name)
                }
            })
            .map(|tool| {
                let description = group["tool_overrides"][tool.name.as_ref()]["description"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .or(tool.description.as_deref())
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| {
                        anyhow!("MCP tool requires a description or configured override")
                    })?;
                Ok((tool, description.trim()))
            })
            .collect()
    }
    fn schemas(&self, name: &str, connection: &Connection) -> Result<Vec<Value>> {
        Ok(self
            .exposed_tools(name, connection)?
            .into_iter()
            .map(|(tool, description)| {
                json!({"name":format!("{name}__{}",tool.name),"description":description,"parameters":&*tool.input_schema})
            })
            .collect())
    }
    fn connect_schema(&self, name: &str, deferred: Option<Vec<String>>) -> Value {
        let group = &self.config.raw["function_groups"][name];
        let names = deferred
            .unwrap_or_else(|| names(group.get("include")).unwrap_or_default())
            .join(", ");
        let names = if names.is_empty() {
            "the configured service operations"
        } else {
            &names
        };
        let capability = group["discovery_description"].as_str().unwrap_or("");
        let prefix = if capability.is_empty() {
            String::new()
        } else {
            format!("{capability} ")
        };
        json!({"name":format!("{name}__connect"),"description":format!("{prefix}Connect to {name} and discover its tools before using them. The discovered tools remain available for this request; use their returned names and schemas for subsequent calls. Complete browser authorization if requested. Use tools already exposed directly. Discover the appropriate operation before substituting other tools for unavailable functionality. Operations available after connecting include: {names}."),"parameters":{"type":"object","properties":{},"additionalProperties":false}})
    }
    pub async fn catalogue(
        &self,
        names: &[String],
        user: &str,
        initial: bool,
    ) -> HashMap<String, Vec<Value>> {
        join_all(names.iter().map(|name| async move {
            let group = &self.config.raw["function_groups"][name];
            let deferred = initial && group["defer_discovery"] == true;
            let initial_tools =
                crate::config::names(group.get("initial_tools")).unwrap_or_default();
            if !deferred || !initial_tools.is_empty() {
                let discover = async {
                    let mut schemas = self.discover(name, user).await?;
                    if deferred {
                        let exposed: HashSet<_> = initial_tools
                            .iter()
                            .map(|tool| format!("{name}__{tool}"))
                            .collect();
                        let remaining = schemas
                            .iter()
                            .filter_map(|s| s["name"].as_str())
                            .filter(|s| !exposed.contains(*s))
                            .map(str::to_owned)
                            .collect();
                        schemas.retain(|s| s["name"].as_str().is_some_and(|s| exposed.contains(s)));
                        schemas.push(self.connect_schema(name, Some(remaining)));
                    }
                    Ok::<_, anyhow::Error>(schemas)
                }
                .await;
                if let Ok(schemas) = discover {
                    return (name.clone(), schemas);
                }
                tracing::warn!(
                    event = "mcp_catalogue_unavailable",
                    service = crate::logging::label(name)
                );
            }
            (name.clone(), vec![self.connect_schema(name, None)])
        }))
        .await
        .into_iter()
        .collect()
    }
    /// `background` is true for runs no user is watching (the autonomy
    /// scope); the approval gate then refuses instead of pausing the run.
    pub async fn call(
        &self,
        full_name: &str,
        args: &Value,
        user: &str,
        token: &str,
        emit: &Emitter,
        background: bool,
    ) -> ToolOutcome {
        let mut outcome = match self
            .dispatch(full_name, args, user, token, emit, background)
            .await
        {
            Ok(outcome) => outcome,
            Err(error) => ToolOutcome {
                content: format!(
                    "Tool failed ({}). Check its arguments and service availability.",
                    error
                        .downcast_ref::<FailureClass>()
                        .map(ToString::to_string)
                        .unwrap_or_else(|| "RuntimeError".into())
                ),
                is_error: true,
                ..Default::default()
            },
        };
        if outcome.terminal_reason != "mcp_approval_required" {
            outcome.content = crate::output::redact_approval_markers(&outcome.content);
        }
        if let Ok(payload) = serde_json::from_str::<Value>(&outcome.content)
            && payload.is_object()
        {
            outcome.is_error |= payload["passed"] == false
                || payload["success"] == false
                || payload["isError"] == true
                || ["error", "failed"].contains(&payload["status"].as_str().unwrap_or(""))
                || crate::config::truthy(&payload["error"]);
        }
        if outcome.is_error {
            let escaped: String = serde_json::to_string(&outcome.content)
                .unwrap()
                .chars()
                .map(|c| {
                    if c.is_ascii() {
                        c.to_string()
                    } else {
                        c.encode_utf16(&mut [0; 2])
                            .iter()
                            .map(|u| format!("\\u{u:04x}"))
                            .collect()
                    }
                })
                .collect();
            outcome.error_signature = hash(&escaped);
        }
        outcome
    }
    async fn dispatch(
        &self,
        full_name: &str,
        args: &Value,
        user: &str,
        token: &str,
        emit: &Emitter,
        background: bool,
    ) -> Result<ToolOutcome> {
        let (name, tool_name) = full_name
            .split_once("__")
            .filter(|(name, _)| self.groups.iter().any(|g| g == name))
            .ok_or_else(|| anyhow!(FailureClass::Value))?;
        // Background work reuses/refreshes the existing user's grant but must
        // never create a consent flow that nobody is present to complete.
        // Interactive consent also stays outside the session lock.
        let headers = self
            .headers(name, user, if background { None } else { Some(emit) })
            .await?;
        let Some(mut headers) = headers else {
            return Ok(ToolOutcome {
                content: "The user's saved authorization is unavailable. No call was executed. Record this source as unavailable and ask the user to reconnect it in the daily summary.".into(),
                is_error: true,
                ..Default::default()
            });
        };
        let concurrency = self.concurrency(full_name);
        let bound = self.sessions(name);
        let gate = self.admission.get(&Self::key(name, user), bound);
        // Taking all permits makes every non-read-only operation exclusive
        // across runs, even when a read owns a session other than the first.
        // FIFO acquisition also keeps later reads behind a queued writer.
        let permits = if concurrency > 1 { 1 } else { bound as u32 };
        let (_admission, admission_waited) = match gate.clone().try_acquire_many_owned(permits) {
            Ok(permit) => (permit, false),
            Err(_) => (
                gate.acquire_many_owned(permits)
                    .await
                    .expect("MCP admission gate is never closed"),
                true,
            ),
        };
        let (mut key, mut _session, waited) = self.session(name, user, concurrency).await;
        if admission_waited || waited {
            // Another call held admission or the session; its wait may have outlived
            // this token. Read the current one without prompting again.
            headers = self
                .headers(name, user, None)
                .await?
                .ok_or_else(|| anyhow!("Authorization required"))?;
        }
        let further = key != Self::key(name, user);
        let connection = match self.connection(name, &key, further, headers.clone()).await {
            Ok(connection) => connection,
            Err(_) if further => {
                // A further session could not be opened. Nothing was sent, so
                // the call waits for the user's first session instead: a
                // server that limits sessions costs latency, not the result.
                tracing::info!(event = "mcp_session_unavailable", service = name);
                drop(_session);
                key = Self::key(name, user);
                _session = self.locks.get(&key).lock_owned().await;
                headers = self
                    .headers(name, user, None)
                    .await?
                    .ok_or_else(|| anyhow!("Authorization required"))?;
                self.connection(name, &key, false, headers.clone()).await?
            }
            Err(error) => return Err(error),
        };
        let rejected = headers
            .get(&http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or("")
            .to_owned();
        // A remote error can echo authentication headers. Never return our
        // credentials with its diagnostic, or include arbitrary RPC error data.
        let secrets: Vec<String> = headers
            .values()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| [value, value.strip_prefix("Bearer ").unwrap_or(value)])
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect();
        if tool_name == "connect" {
            let schemas = self.schemas(name, &connection)?;
            if args.as_object().is_none_or(|a| !a.is_empty()) {
                bail!(FailureClass::Value);
            }
            return Ok(ToolOutcome {
                content: "Connected. The discovered tools are now available.".into(),
                tools: schemas
                    .into_iter()
                    .map(serde_json::from_value)
                    .collect::<std::result::Result<_, _>>()?,
                ..Default::default()
            });
        }
        let tool = self
            .exposed_tools(name, &connection)?
            .into_iter()
            .map(|(tool, _)| tool)
            .find(|tool| tool.name == tool_name)
            .ok_or_else(|| anyhow!(FailureClass::Value))?;
        let validator = crate::tool_contracts::validator(&json!(&*tool.input_schema))
            .map_err(|_| anyhow!(FailureClass::Schema))?;
        if !validator.is_valid(args) {
            bail!(FailureClass::Validation);
        }
        let annotations = serde_json::to_value(&tool.annotations)?;
        let gate = if matches!(emit, Emitter::Execution(_)) {
            let (_, digest) = crate::authorization::canonical(args).context(FailureClass::Value)?;
            self.approvals
                .consume(user, token, name, tool_name, &digest)
                .await
        } else {
            self.approvals
                .gate(user, token, name, tool_name, args, &annotations, background)
                .await
        };
        if let Gate::Denied(reason, terminal) = gate {
            // Only a pending approval ends the run at that boundary. A
            // refused call (read-only conflict, background run, spent or
            // mismatched credential) is an ordinary tool error and must not
            // read as "waiting for approval" in logs or telemetry.
            return Ok(ToolOutcome {
                content: reason,
                is_error: true,
                terminal,
                terminal_reason: if terminal {
                    "mcp_approval_required".into()
                } else {
                    String::new()
                },
                ..Default::default()
            });
        }
        let timeout = number(
            self.config.raw["function_groups"][name]
                .get("tool_call_timeout")
                .unwrap_or(&json!(120)),
        )?;
        let arguments = args
            .as_object()
            .ok_or_else(|| anyhow!("MCP arguments must be an object"))?
            .clone();
        // Only an abandoned remote request has an uncertain session state.
        // Local validation and approval refusals keep the user's session.
        let mut guard = connection.guard();
        let result = tokio::time::timeout(
            Duration::from_secs_f64(timeout),
            connection.session.peer().call_tool_once(
                CallToolRequestParams::new(tool_name.to_owned()).with_arguments(arguments),
            ),
        )
        .await;
        let result = match result {
            Ok(Err(ServiceError::McpError(error))) => {
                // An RPC error is a received response, not a lost response.
                // Keep the session and never replay the call. The error alone
                // does not establish that a multi-step operation had no effect.
                guard.0 = None;
                let mut message = error.message.into_owned();
                for secret in secrets {
                    message = message.replace(&secret, "[redacted]");
                }
                let message: String = message
                    .chars()
                    .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
                    .take(2048)
                    .collect();
                tracing::warn!(
                    event = "mcp_rpc_error",
                    service = name,
                    tool = tool_name,
                    code = error.code.0
                );
                return Ok(ToolOutcome {
                    content: crate::output::compact(&json!({
                        "isError": true,
                        "error": {"type": "mcp_rpc_error", "code": error.code, "message": message},
                        "outcome": "error_reported",
                        "guidance": "The server returned an error. A failed operation may have partial effects; verify state before repeating a change."
                    })),
                    is_error: true,
                    ..Default::default()
                });
            }
            Ok(Ok(CallToolResponse::Complete(result))) => {
                let raw = connection
                    .http
                    .take_result()
                    .unwrap_or(serde_json::to_value(&result)?);
                // rmcp accepts absent/null content and a null error flag. The
                // retained Python client rejects these incomplete results; they
                // must never be reported as a confirmed mutation.
                let complete = raw.get("content").is_some_and(Value::is_array)
                    && raw.get("isError").is_none_or(Value::is_boolean);
                let value = crate::mcp_http::result_envelope(raw);
                let valid = complete
                    && (value["isError"] == true
                        || tool.output_schema.as_ref().is_none_or(|schema| {
                            value.get("structuredContent").is_some_and(|content| {
                                crate::tool_contracts::validator(&json!(&**schema))
                                    .is_ok_and(|v| v.is_valid(content))
                            })
                        }));
                valid.then_some(value)
            }
            _ => None,
        };
        let Some(value) = result else {
            self.connections.lock().unwrap().remove(&key);
            connection.close();
            guard.0 = None;
            if self.auth(name)["_type"] == "mcp_oauth2" {
                let _ = self
                    .oauth
                    .invalidate_access(user, self.auth(name), &rejected)
                    .await;
            }
            tracing::warn!(event = "mcp_call_unconfirmed", remote_outcome = "unknown");
            return Ok(ToolOutcome {
                content: UNCONFIRMED.into(),
                is_error: true,
                ..Default::default()
            });
        };
        let failed = value["isError"] == true;
        guard.0 = None;
        let content = crate::output::compact(&value);
        Ok(ToolOutcome {
            is_error: failed,
            content,
            ..Default::default()
        })
    }
    pub async fn reset(&self, service: &str, user: &str) -> Result<Value> {
        oauth::token_key(service, user)?;
        let groups: Vec<_> = self
            .groups
            .iter()
            .filter(|name| {
                self.auth(name)["_type"] == "mcp_oauth2"
                    && oauth::service(self.auth(name)).is_ok_and(|s| s == service)
            })
            .collect();
        let mut guards = Vec::new();
        for name in &groups {
            for session in 0..self.sessions(name) {
                guards.push(
                    self.locks
                        .get(&Self::session_key(name, user, session))
                        .try_lock_owned()
                        .map_err(|_| anyhow!(oauth::IN_USE))?,
                );
            }
        }
        let deleted = self.oauth.reset(service, user).await?;
        let mut removed = 0;
        for name in groups {
            // One cached workflow per group, however many sessions it held.
            let mut closed = false;
            for session in 0..self.sessions(name) {
                if let Some(c) = self
                    .connections
                    .lock()
                    .unwrap()
                    .remove(&Self::session_key(name, user, session))
                {
                    c.close();
                    closed = true;
                }
            }
            removed += usize::from(closed);
        }
        Ok(
            json!({"service":service,"authorizationCleared":true,"savedTokenDeleted":deleted,"cachedWorkflowsInvalidated":removed}),
        )
    }
    pub fn capabilities(&self) -> Value {
        let required: HashSet<_> = self
            .config
            .variable("DAEDALUS_REQUIRED_MCP_GROUPS", "")
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        let connections = self.connections.lock().unwrap();
        let available: HashSet<_> = connections
            .iter()
            .filter(|(_, c)| !c.session.is_closed())
            .filter_map(|(key, _)| {
                // Any open session of a group, first or further, counts.
                serde_json::from_str::<Vec<Value>>(key)
                    .ok()?
                    .first()?
                    .as_str()
                    .map(str::to_owned)
            })
            .collect();
        let mut missing: Vec<_> = required.difference(&available).cloned().collect();
        missing.sort();
        let mut optional: Vec<_> = self
            .groups
            .iter()
            .filter(|g| !required.contains(*g) && !available.contains(*g))
            .cloned()
            .collect();
        optional.sort();
        let mut available: Vec<_> = available.into_iter().collect();
        available.sort();
        json!({"available":available,"missing_required":missing,"unavailable_optional":optional})
    }
    pub async fn maintain(&self) {
        {
            let mut connections = self.connections.lock().unwrap();
            connections.retain(|key, c| {
                let stale = c.session.is_closed()
                    || c.last_used.lock().unwrap().elapsed() > Duration::from_secs(600);
                if stale && self.locks.get(key).try_lock().is_ok() {
                    c.close();
                    false
                } else {
                    true
                }
            });
        }
        let static_groups: Vec<_> = self
            .groups
            .iter()
            .filter(|g| self.auth(g)["_type"] != "mcp_oauth2")
            .cloned()
            .collect();
        self.catalogue(&static_groups, "runtime-readiness", false)
            .await;
    }
    pub fn close(&self) {
        self.oauth.close();
        for (_, c) in self.connections.lock().unwrap().drain() {
            c.close();
        }
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;

    #[test]
    fn idle_admission_entries_are_reclaimed_without_splitting_active_gates() {
        let admission = Admission::default();
        let first = admission.get("first", 3);
        assert!(Arc::ptr_eq(&first, &admission.get("first", 3)));
        let permit = first.try_acquire_owned().unwrap();
        assert_eq!(admission.get("first", 3).available_permits(), 2);
        drop(permit);
        let _next = admission.get("next", 3);
        assert_eq!(admission.0.lock().unwrap().len(), 1);
    }
}
