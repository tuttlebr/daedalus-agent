//! Durable local-only enrollment and scoped completed-read recovery.
//!
//! Enrollment has no expiry: disabling external workers must never send an
//! already protected conversation back through unrestricted shared history.
//! Completed reads are local evidence, not authorization or provider sessions.

use crate::{
    agent::ToolOutcome,
    config::Config,
    context_isolation::{
        ContextClass, PUBLIC_POLICY, PublicDesk, PublicSource, validate_public_source,
    },
    storage::Store,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fmt,
    time::{Duration, Instant},
};

const ENROLLED: &str = "local-only-v1";
const BUDGET_ERA: &str = "stable-budget-v2";
const READ_VERSION: u32 = 1;
const READ_TTL_SECONDS: usize = 36 * 60 * 60;
const MAX_READ_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateError {
    InvalidScope,
    PolicyStateUnavailable,
    ProtectedConversation,
    IncompatiblePolicyState,
    BudgetExhausted,
    DeadlineExceeded,
    WorkflowCompleted,
    LegacyWorkflowMigrationRequired,
}
impl fmt::Display for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidScope => "context state requires authenticated workflow scope",
            Self::PolicyStateUnavailable => "context policy state is unavailable",
            Self::ProtectedConversation => {
                "protected conversation requires verified local processing"
            }
            Self::IncompatiblePolicyState => "stored context policy state is incompatible",
            Self::BudgetExhausted => "durable workflow budget is exhausted",
            Self::DeadlineExceeded => "durable workflow deadline has expired",
            Self::WorkflowCompleted => "durable workflow is already completed",
            Self::LegacyWorkflowMigrationRequired => {
                "legacy protected owner requires reviewed workflow budget migration"
            }
        })
    }
}
impl std::error::Error for StateError {}
pub type Result<T> = std::result::Result<T, StateError>;

fn hash(parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn scope(user: &str, conversation: &str, run: &str) -> Result<String> {
    if user.trim().is_empty() || (conversation.trim().is_empty() && run.trim().is_empty()) {
        return Err(StateError::InvalidScope);
    }
    Ok(hash(&[
        "daedalus-protected-context-v1",
        user,
        if conversation.is_empty() {
            "run"
        } else {
            "conversation"
        },
        if conversation.is_empty() {
            run
        } else {
            conversation
        },
    ]))
}

fn enrollment_key(user: &str, conversation: &str, run: &str) -> Result<String> {
    Ok(format!(
        "daedalus:context-policy:v1:{}",
        scope(user, conversation, run)?
    ))
}

fn user_enrollment_key(user: &str) -> String {
    format!(
        "daedalus:context-owner-policy:v1:{}",
        hash(&["daedalus-protected-owner-v1", user])
    )
}

fn budget_era_key(user: &str) -> String {
    format!(
        "daedalus:context-budget-era:v1:{}",
        hash(&["daedalus-protected-owner-v1", user])
    )
}

/// Standalone private-service calls must honor owner protection without
/// enrolling an owner or requiring a conversation/run supplied by a client.
pub async fn owner_is_protected(store: &Store, user: &str) -> Result<bool> {
    if user.trim().is_empty() {
        return Err(StateError::InvalidScope);
    }
    let label: Option<String> = store
        .command(redis::cmd("GET").arg(user_enrollment_key(user)))
        .await
        .map_err(|_| StateError::PolicyStateUnavailable)?;
    match label.as_deref() {
        None => Ok(false),
        Some(ENROLLED) => Ok(true),
        Some(_) => Err(StateError::IncompatiblePolicyState),
    }
}

/// Call before loading private memory or invoking any model/tool, including
/// when isolation is disabled or absent from the current configuration. An
/// enrolled owner cannot become unrestricted by changing conversation/run IDs
/// during configuration rollback; unavailable storage cannot prove eligibility.
pub async fn enforce(
    config: &Config,
    user: &str,
    conversation: &str,
    run: &str,
    isolation_enabled: bool,
) -> Result<()> {
    let store = Store::new(config).map_err(|_| StateError::PolicyStateUnavailable)?;
    enforce_store(&store, user, conversation, run, isolation_enabled).await
}

async fn enforce_store(
    store: &Store,
    user: &str,
    conversation: &str,
    run: &str,
    enabled: bool,
) -> Result<()> {
    let key = enrollment_key(user, conversation, run)?;
    let owner_key = user_enrollment_key(user);
    if enabled {
        // Install the stable-budget era only during first enrollment. Legacy
        // protected owners have opaque, policy-dependent budget keys that cannot
        // be safely discovered or reset. They require reviewed migration.
        // Existing recognized privacy and era labels lose any accidental TTL;
        // unknown future versions never get overwritten.
        let outcome: String = store
            .command(
                redis::cmd("EVAL")
                    .arg(ENROLL_OWNER)
                    .arg(3)
                    .arg(key)
                    .arg(owner_key)
                    .arg(budget_era_key(user))
                    .arg(ENROLLED)
                    .arg(BUDGET_ERA),
            )
            .await
            .map_err(|_| StateError::PolicyStateUnavailable)?;
        match outcome.as_str() {
            "enrolled" => {}
            "migration_required" => return Err(StateError::LegacyWorkflowMigrationRequired),
            _ => return Err(StateError::IncompatiblePolicyState),
        }
    } else {
        let state: Vec<Option<String>> = store
            .command(redis::cmd("MGET").arg(&key).arg(&owner_key))
            .await
            .map_err(|_| StateError::PolicyStateUnavailable)?;
        if state.len() != 2 {
            return Err(StateError::IncompatiblePolicyState);
        }
        if state.iter().any(Option::is_some) {
            return Err(StateError::ProtectedConversation);
        }
    }
    Ok(())
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let sorted: std::collections::BTreeMap<_, _> = object
                .iter()
                .map(|(key, value)| (key.clone(), canonical(value)))
                .collect();
            serde_json::to_value(sorted).unwrap()
        }
        Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
        value => value.clone(),
    }
}

fn arguments_hash(value: &Value) -> String {
    hash(&[
        "daedalus-completed-read-args-v1",
        &canonical(value).to_string(),
    ])
}

/// Existing read-only personal sources and validated public worker findings can
/// use this local recovery cache. Writes, OAuth/connect, skill loading, arbitrary
/// tools, and provider sessions never enter it. Existing authorization remains
/// a caller prerequisite; cached findings cannot authorize another export.
pub fn cacheable_read(name: &str) -> bool {
    matches!(
        name,
        "get_memory"
            | "nws_weather_tool"
            | "public_briefing_worker"
            | "gmail_mcp_server__search_threads"
            | "gmail_mcp_server__get_thread"
            | "gmail_mcp_server__batch_get_threads"
            | "gmail_mcp_server__get_message"
            | "gmail_mcp_server__list_labels"
            | "gmail_mcp_server__list_drafts"
            | "calendar_mcp_server__list_events"
            | "calendar_mcp_server__get_event"
            | "calendar_mcp_server__list_calendars"
            | "calendar_mcp_server__suggest_time"
            | "calendar_mcp_server__search_events"
    )
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompletedRead {
    schema_version: u32,
    context_class: ContextClass,
    scope: String,
    tool: String,
    arguments_hash: String,
    content: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CollectedEvidence {
    schema_version: u32,
    context_class: ContextClass,
    scope: String,
    source_identity: String,
    policy_version: String,
    desk: PublicDesk,
    sources: Vec<PublicSource>,
}

#[derive(Clone)]
pub struct SessionState {
    store: Store,
    scope: String,
    budget_scope: String,
    owner_key: String,
    era_key: String,
}
impl SessionState {
    /// `workflow_id` is a stable authenticated job identity chosen by runtime
    /// transport. Retries and OAuth resumes reuse it, including across dates;
    /// a new explicit request receives a new identity. Never reconstruct this
    /// value from model output, user prose, or the current clock. The caller
    /// validates externally supplied IDs before invoking this internal API.
    /// `context_policy` scopes evidence only; changing it never allocates a new
    /// resource budget or removes a workflow completion tombstone.
    pub fn new(
        config: &Config,
        user: &str,
        conversation: &str,
        workflow_id: &str,
        context_policy: &str,
    ) -> Result<Self> {
        if workflow_id.trim().is_empty() || context_policy.trim().is_empty() {
            return Err(StateError::InvalidScope);
        }
        // Preserve the evidence namespace for an unchanged policy. The
        // original v1 caller combined these fields before constructing scope.
        let evidence_identity = format!("{workflow_id}:{context_policy}");
        Ok(Self {
            store: Store::new(config).map_err(|_| StateError::PolicyStateUnavailable)?,
            scope: hash(&[
                "daedalus-completed-reads-v1",
                &scope(user, conversation, &evidence_identity)?,
                &evidence_identity,
            ]),
            // Resource authority is the authenticated workflow, independent of
            // policy changes that correctly invalidate cached export evidence.
            budget_scope: hash(&[
                "daedalus-workflow-budget-v2",
                &scope(user, conversation, workflow_id)?,
                workflow_id,
            ]),
            owner_key: user_enrollment_key(user),
            era_key: budget_era_key(user),
        })
    }

    fn key(&self, name: &str, arguments: &Value) -> String {
        format!(
            "daedalus:completed-read:v1:{}:{}",
            self.scope,
            hash(&[name, &arguments_hash(arguments)])
        )
    }

    fn index_key(&self) -> String {
        format!("daedalus:completed-read-index:v1:{}", self.scope)
    }

    fn collection_key(&self, desk: PublicDesk, policy: &str) -> String {
        format!(
            "daedalus:completed-read:v1:{}:collection:{}",
            self.scope,
            hash(&[&serde_json::to_string(&desk).unwrap(), policy])
        )
    }

    pub async fn lookup_collection(
        &self,
        desk: &str,
        policy: &str,
    ) -> Result<Option<Vec<PublicSource>>> {
        let Ok(desk) = serde_json::from_value::<PublicDesk>(Value::String(desk.into())) else {
            return Ok(None);
        };
        if policy != PUBLIC_POLICY {
            return Ok(None);
        }
        let Some(raw) = self
            .store
            .get(&self.collection_key(desk, policy))
            .await
            .map_err(|_| StateError::PolicyStateUnavailable)?
        else {
            return Ok(None);
        };
        if raw.len() > MAX_READ_BYTES {
            return Ok(None);
        }
        let Ok(record) = serde_json::from_str::<CollectedEvidence>(&raw) else {
            return Ok(None);
        };
        if record.schema_version != READ_VERSION
            || record.context_class != ContextClass::ExternalAllowed
            || record.scope != self.scope
            || record.source_identity != "fixed-public-collector-v1"
            || record.policy_version != policy
            || record.desk != desk
            || record.sources.len() > 24
            || record
                .sources
                .iter()
                .any(|source| validate_public_source(source).is_err())
        {
            return Ok(None);
        }
        // Raw collector evidence must still be re-ingested with a fresh
        // ContextStore collection token before constructing any worker task.
        Ok(Some(record.sources))
    }

    pub async fn record_collection(
        &self,
        desk: &str,
        policy: &str,
        sources: &[PublicSource],
    ) -> Result<()> {
        let desk = serde_json::from_value::<PublicDesk>(Value::String(desk.into()))
            .map_err(|_| StateError::IncompatiblePolicyState)?;
        if policy != PUBLIC_POLICY
            || sources.len() > 24
            || sources
                .iter()
                .any(|source| validate_public_source(source).is_err())
        {
            return Err(StateError::IncompatiblePolicyState);
        }
        let record = CollectedEvidence {
            schema_version: READ_VERSION,
            context_class: ContextClass::ExternalAllowed,
            scope: self.scope.clone(),
            source_identity: "fixed-public-collector-v1".into(),
            policy_version: policy.into(),
            desk,
            sources: sources.to_vec(),
        };
        let encoded =
            serde_json::to_string(&record).map_err(|_| StateError::PolicyStateUnavailable)?;
        if encoded.len() > MAX_READ_BYTES {
            return Err(StateError::IncompatiblePolicyState);
        }
        self.store_record(&self.collection_key(desk, policy), &encoded)
            .await
    }

    fn budget_key(&self) -> String {
        format!("daedalus:workflow-budget:v2:{}", self.budget_scope)
    }

    /// Initialize once per workflow. Redis's clock and persisted counters are
    /// authoritative across restarts and OAuth resumes. A changed budget
    /// configuration is incompatible with an in-progress workflow.
    pub async fn budget(
        &self,
        max_calls: u32,
        total_tokens: u64,
        research: Duration,
        total: Duration,
    ) -> Result<DurableBudget> {
        if max_calls == 0
            || total_tokens == 0
            || total_tokens > (1u64 << 53)
            || research.is_zero()
            || total < research
            || total.as_millis() > i64::MAX as u128
        {
            return Err(StateError::IncompatiblePolicyState);
        }
        let started = Instant::now();
        let key = self.budget_key();
        let response: Vec<i64> = self
            .store
            .command(
                redis::cmd("EVAL")
                    .arg(BUDGET_INITIALIZE)
                    .arg(3)
                    .arg(&key)
                    .arg(&self.owner_key)
                    .arg(&self.era_key)
                    .arg(max_calls)
                    .arg(total_tokens)
                    .arg(research.as_millis() as u64)
                    .arg(total.as_millis() as u64)
                    .arg(ENROLLED)
                    .arg(BUDGET_ERA),
            )
            .await
            .map_err(|_| StateError::PolicyStateUnavailable)?;
        if response.len() == 3 && response[0] == -5 {
            return Err(StateError::LegacyWorkflowMigrationRequired);
        }
        if response.len() == 3 && response[0] == -4 {
            return Err(StateError::WorkflowCompleted);
        }
        if response.len() != 3 || response[0] != 1 {
            return Err(StateError::IncompatiblePolicyState);
        }
        let elapsed = started.elapsed();
        let research_left =
            Duration::from_millis(response[1].max(0) as u64).saturating_sub(elapsed);
        let total_left = Duration::from_millis(response[2].max(0) as u64).saturating_sub(elapsed);
        if total_left.is_zero() {
            return Err(StateError::DeadlineExceeded);
        }
        Ok(DurableBudget {
            store: self.store.clone(),
            key,
            research_deadline: Instant::now() + research_left,
            total_deadline: Instant::now() + total_left,
        })
    }

    pub async fn lookup_read(&self, name: &str, arguments: &Value) -> Result<Option<ToolOutcome>> {
        if !cacheable_read(name) {
            return Ok(None);
        }
        let Some(raw) = self
            .store
            .get(&self.key(name, arguments))
            .await
            .map_err(|_| StateError::PolicyStateUnavailable)?
        else {
            return Ok(None);
        };
        if raw.len() > MAX_READ_BYTES + 4096 {
            return Ok(None);
        }
        let Ok(record) = serde_json::from_str::<CompletedRead>(&raw) else {
            return Ok(None);
        };
        if record.schema_version != READ_VERSION
            || record.context_class != ContextClass::LocalOnly
            || record.scope != self.scope
            || record.tool != name
            || record.arguments_hash != arguments_hash(arguments)
            || record.content.len() > MAX_READ_BYTES
        {
            return Ok(None);
        }
        Ok(Some(ToolOutcome {
            content: record.content,
            ..Default::default()
        }))
    }

    pub async fn record_read(
        &self,
        name: &str,
        arguments: &Value,
        outcome: &ToolOutcome,
    ) -> Result<()> {
        if !cacheable_read(name)
            || outcome.is_error
            || outcome.terminal
            || outcome.content.is_empty()
            || outcome.content.len() > MAX_READ_BYTES
            || !outcome.tools.is_empty()
            || !outcome.loaded_skills.is_empty()
            || outcome.model_profile.is_some()
            || outcome.content.trim_start().starts_with("Error:")
        {
            return Ok(());
        }
        let record = CompletedRead {
            schema_version: READ_VERSION,
            context_class: ContextClass::LocalOnly,
            scope: self.scope.clone(),
            tool: name.into(),
            arguments_hash: arguments_hash(arguments),
            content: outcome.content.clone(),
        };
        let encoded =
            serde_json::to_string(&record).map_err(|_| StateError::PolicyStateUnavailable)?;
        self.store_record(&self.key(name, arguments), &encoded)
            .await
    }

    async fn store_record(&self, key: &str, encoded: &str) -> Result<()> {
        // The index and result share one transaction, so completion can delete
        // only this scope's completed reads without a scan or partial orphan.
        let outcome: String = self.store.command(redis::cmd("EVAL")
            .arg("if redis.call('HGET', KEYS[3], 'status') == 'completed' then return 'completed' end; if redis.call('SCARD', KEYS[2]) >= 2048 and redis.call('SISMEMBER', KEYS[2], KEYS[1]) == 0 then return 'full' end; redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]); redis.call('SADD', KEYS[2], KEYS[1]); redis.call('EXPIRE', KEYS[2], ARGV[2]); return 'stored'")
            .arg(3).arg(key).arg(self.index_key()).arg(self.budget_key()).arg(encoded).arg(READ_TTL_SECONDS))
            .await.map_err(|_| StateError::PolicyStateUnavailable)?;
        if outcome == "completed" {
            return Err(StateError::WorkflowCompleted);
        }
        if outcome != "stored" {
            return Err(StateError::PolicyStateUnavailable);
        }
        Ok(())
    }

    /// Close this workflow permanently and clear its recovery evidence after
    /// successful delivery. OAuth pauses, cancellation, and provider failures
    /// must not call this method. Preserve counters and deadlines so another
    /// replica or a duplicate retry cannot renew a completed workflow's budget.
    /// The permanent privacy enrollment remains in place.
    pub async fn finish(&self) -> Result<()> {
        let prefix = format!("daedalus:completed-read:v1:{}:", self.scope);
        let outcome: String = self.store.command(redis::cmd("EVAL")
            .arg("local keys = redis.call('SMEMBERS', KEYS[1]); if #keys > 2048 then return 'incompatible' end; for _, key in ipairs(keys) do if string.sub(key, 1, string.len(ARGV[1])) ~= ARGV[1] then return 'incompatible' end end; if redis.call('EXISTS', KEYS[2]) == 0 then redis.call('HSET', KEYS[2], 'schema_version', '1', 'context_class', 'LOCAL_ONLY') end; redis.call('HSET', KEYS[2], 'status', 'completed'); redis.call('PERSIST', KEYS[2]); for _, key in ipairs(keys) do redis.call('DEL', key) end; redis.call('DEL', KEYS[1]); return 'finished'")
            .arg(2).arg(self.index_key()).arg(self.budget_key()).arg(prefix))
            .await.map_err(|_| StateError::PolicyStateUnavailable)?;
        if outcome != "finished" {
            return Err(StateError::IncompatiblePolicyState);
        }
        Ok(())
    }
}

/// A legacy, unenrolled Redis fixture for preparation/agent tests. It never
/// acknowledges policy enrollment or budget writes: tests requiring those
/// operations must use a real disposable Redis and inspect persisted state.
#[cfg(test)]
pub async fn empty_policy_store() -> (String, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("redis://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let (read, mut write) = socket.into_split();
                let mut read = tokio::io::BufReader::new(read);
                loop {
                    let mut line = String::new();
                    if !read.read_line(&mut line).await.is_ok_and(|count| count > 0) {
                        return;
                    }
                    let Some(count) = line
                        .trim_end()
                        .strip_prefix('*')
                        .and_then(|count| count.parse::<usize>().ok())
                        .filter(|count| *count <= 32)
                    else {
                        return;
                    };
                    let mut arguments = Vec::new();
                    for _ in 0..count {
                        line.clear();
                        if read.read_line(&mut line).await.is_err() {
                            return;
                        }
                        let Some(size) = line
                            .trim_end()
                            .strip_prefix('$')
                            .and_then(|size| size.parse::<usize>().ok())
                            .filter(|size| *size <= 16384)
                        else {
                            return;
                        };
                        let mut value = vec![0; size + 2];
                        if read.read_exact(&mut value).await.is_err() || value[size..] != *b"\r\n" {
                            return;
                        }
                        arguments.push(value[..size].to_vec());
                    }
                    let response = match arguments.as_slice() {
                        [command, ..]
                            if command.eq_ignore_ascii_case(b"CLIENT")
                                && arguments
                                    .get(1)
                                    .is_some_and(|part| part.eq_ignore_ascii_case(b"SETINFO")) =>
                        {
                            b"+OK\r\n".to_vec()
                        }
                        [command, _key] if command.eq_ignore_ascii_case(b"GET") => {
                            b"$-1\r\n".to_vec()
                        }
                        [command, keys @ ..] if command.eq_ignore_ascii_case(b"MGET") => {
                            format!("*{}\r\n{}", keys.len(), "$-1\r\n".repeat(keys.len()))
                                .into_bytes()
                        }
                        _ => b"-ERR unsupported command in empty policy fixture\r\n".to_vec(),
                    };
                    if write.write_all(&response).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    (url, server)
}

const ENROLL_OWNER: &str = r#"
local legacy = false
for i = 1, 2 do
  local value = redis.call('GET', KEYS[i])
  if value and value ~= ARGV[1] then return 'incompatible' end
  legacy = legacy or value ~= false
end
local era = redis.call('GET', KEYS[3])
if era and era ~= ARGV[2] then return 'incompatible' end
if not era and legacy then return 'migration_required' end
for i = 1, 2 do redis.call('SET', KEYS[i], ARGV[1]) end
redis.call('SET', KEYS[3], ARGV[2])
return 'enrolled'
"#;

const BUDGET_INITIALIZE: &str = r#"
if redis.call('GET', KEYS[2]) ~= ARGV[5] then return {-1, 0, 0} end
local era = redis.call('GET', KEYS[3])
if not era then return {-5, 0, 0} end
if era ~= ARGV[6] then return {-1, 0, 0} end
redis.call('PERSIST', KEYS[3])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('HSET', KEYS[1], 'schema_version', '1', 'context_class', 'LOCAL_ONLY',
    'status', 'active', 'research_closed', '0',
    'max_calls', ARGV[1], 'max_tokens', ARGV[2], 'research_ms', ARGV[3], 'total_ms', ARGV[4],
    'calls_used', '0', 'tokens_used', '0', 'research_deadline', now + tonumber(ARGV[3]),
    'total_deadline', now + tonumber(ARGV[4]))
end
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'completed' then return {-4, 0, 0} end
if status ~= 'active' then return {-1, 0, 0} end
local state = redis.call('HMGET', KEYS[1], 'schema_version', 'context_class', 'max_calls',
  'max_tokens', 'research_ms', 'total_ms', 'research_deadline', 'total_deadline', 'calls_used', 'tokens_used')
if state[1] ~= '1' or state[2] ~= 'LOCAL_ONLY' or state[3] ~= ARGV[1]
  or state[4] ~= ARGV[2] or state[5] ~= ARGV[3] or state[6] ~= ARGV[4]
  or not tonumber(state[7]) or not tonumber(state[8]) or not tonumber(state[9])
  or not tonumber(state[10]) then return {-1, 0, 0} end
if tonumber(state[9]) < 0 or tonumber(state[10]) < 0
  or tonumber(state[9]) > tonumber(state[3]) or tonumber(state[10]) > tonumber(state[4])
  or tonumber(state[9]) ~= math.floor(tonumber(state[9]))
  or tonumber(state[10]) ~= math.floor(tonumber(state[10]))
  or tonumber(state[7]) > tonumber(state[8]) then return {-1, 0, 0} end
redis.call('PERSIST', KEYS[1])
local closed = redis.call('HGET', KEYS[1], 'research_closed')
if not closed then closed = '1'; redis.call('HSET', KEYS[1], 'research_closed', '1') end
if closed ~= '0' and closed ~= '1' then return {-1, 0, 0} end
return {1, closed == '1' and 0 or math.max(0, tonumber(state[7]) - now), math.max(0, tonumber(state[8]) - now)}
"#;

const BUDGET_RESERVE: &str = r#"
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'completed' then return -4 end
if status ~= 'active' then return -1 end
local state = redis.call('HMGET', KEYS[1], 'schema_version', 'context_class', 'max_calls',
  'max_tokens', 'calls_used', 'tokens_used', 'total_deadline')
if state[1] ~= '1' or state[2] ~= 'LOCAL_ONLY' then return -1 end
for i = 3, 7 do if not tonumber(state[i]) then return -1 end end
if tonumber(state[3]) <= 0 or tonumber(state[4]) <= 0
  or tonumber(state[5]) < 0 or tonumber(state[6]) < 0
  or tonumber(state[5]) > tonumber(state[3]) or tonumber(state[6]) > tonumber(state[4])
  or tonumber(state[5]) ~= math.floor(tonumber(state[5]))
  or tonumber(state[6]) ~= math.floor(tonumber(state[6])) then return -1 end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if tonumber(state[7]) <= now then return -2 end
if ARGV[2] == 'public' then
  local deadline = tonumber(redis.call('HGET', KEYS[1], 'research_deadline'))
  if redis.call('HGET', KEYS[1], 'research_closed') ~= '0' or not deadline or deadline <= now then return -2 end
end
if tonumber(ARGV[1]) <= 0 or tonumber(state[5]) >= tonumber(state[3])
  or tonumber(state[6]) + tonumber(ARGV[1]) > tonumber(state[4]) then return -3 end
redis.call('HINCRBY', KEYS[1], 'calls_used', 1)
redis.call('HINCRBY', KEYS[1], 'tokens_used', ARGV[1])
return 1
"#;

const RESEARCH_TOOL_RESERVE: &str = r#"
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'completed' then return -4 end
if status ~= 'active' then return -1 end
if redis.call('HGET', KEYS[1], 'research_closed') ~= '0' then return -2 end
local state = redis.call('HMGET', KEYS[1], 'schema_version', 'context_class', 'research_deadline',
  'max_research_calls', 'research_calls_used')
if state[1] ~= '1' or state[2] ~= 'LOCAL_ONLY' or not tonumber(state[3]) then return -1 end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if tonumber(state[3]) <= now then return -2 end
if not state[4] and not state[5] then
  redis.call('HSET', KEYS[1], 'max_research_calls', ARGV[1], 'research_calls_used', 0)
  state[4] = ARGV[1]; state[5] = '0'
end
if state[4] ~= ARGV[1] or not tonumber(state[5]) or tonumber(state[5]) < 0
  or tonumber(state[5]) ~= math.floor(tonumber(state[5]))
  or tonumber(state[5]) > tonumber(state[4]) then return -1 end
if tonumber(state[5]) >= tonumber(state[4]) then return -3 end
redis.call('HINCRBY', KEYS[1], 'research_calls_used', 1)
return 1
"#;

/// All coordinator, worker, synthesis, and retry attempts share this durable
/// counter. Unknown usage remains reserved at the configured output cap.
#[derive(Clone)]
pub struct DurableBudget {
    store: Store,
    key: String,
    research_deadline: Instant,
    total_deadline: Instant,
}
impl DurableBudget {
    pub async fn reserve_model_call(&self, cap: u64) -> Result<()> {
        self.reserve_call(cap, false).await
    }
    pub async fn reserve_public_model_call(&self, cap: u64) -> Result<()> {
        self.reserve_call(cap, true).await
    }
    async fn reserve_call(&self, cap: u64, public: bool) -> Result<()> {
        if cap == 0 || cap > (1u64 << 53) {
            return Err(StateError::BudgetExhausted);
        }
        let outcome: i64 = self
            .store
            .command(
                redis::cmd("EVAL")
                    .arg(BUDGET_RESERVE)
                    .arg(1)
                    .arg(&self.key)
                    .arg(cap)
                    .arg(if public { "public" } else { "local" }),
            )
            .await
            .map_err(|_| StateError::PolicyStateUnavailable)?;
        match outcome {
            1 => Ok(()),
            -2 => Err(StateError::DeadlineExceeded),
            -3 => Err(StateError::BudgetExhausted),
            -4 => Err(StateError::WorkflowCompleted),
            _ => Err(StateError::IncompatiblePolicyState),
        }
    }
    pub async fn close_research(&self) -> Result<()> {
        let outcome: i64 = self.store.command(redis::cmd("EVAL")
            .arg("local s=redis.call('HMGET',KEYS[1],'status','schema_version','context_class'); if s[1]=='completed' then return -4 end; if s[1]~='active' or s[2]~='1' or s[3]~='LOCAL_ONLY' then return -1 end; redis.call('HSET',KEYS[1],'research_closed','1'); return 1")
            .arg(1).arg(&self.key)).await.map_err(|_| StateError::PolicyStateUnavailable)?;
        match outcome {
            1 => Ok(()),
            -4 => Err(StateError::WorkflowCompleted),
            _ => Err(StateError::IncompatiblePolicyState),
        }
    }
    pub fn remaining_total(&self) -> Duration {
        self.total_deadline
            .saturating_duration_since(Instant::now())
    }
    pub fn remaining_research(&self) -> Duration {
        self.research_deadline
            .saturating_duration_since(Instant::now())
    }

    /// Count actual collector transport attempts, including nested searches and
    /// scrapes, against one user-scoped research limit across restarts. Reusing
    /// completed evidence requires no new transport reservation.
    pub async fn reserve_research_tool_call(&self, maximum: u64) -> Result<()> {
        if maximum == 0 {
            return Err(StateError::BudgetExhausted);
        }
        if maximum > (1u64 << 53) {
            return Err(StateError::IncompatiblePolicyState);
        }
        let outcome: i64 = self
            .store
            .command(
                redis::cmd("EVAL")
                    .arg(RESEARCH_TOOL_RESERVE)
                    .arg(1)
                    .arg(&self.key)
                    .arg(maximum),
            )
            .await
            .map_err(|_| StateError::PolicyStateUnavailable)?;
        match outcome {
            1 => Ok(()),
            -2 => Err(StateError::DeadlineExceeded),
            -3 => Err(StateError::BudgetExhausted),
            -4 => Err(StateError::WorkflowCompleted),
            _ => Err(StateError::IncompatiblePolicyState),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn legacy_config(redis: &str) -> Config {
        Config::new(
            json!({
                "llms":{"main":{"base_url":"http://model.invalid","model_name":"fixture"}},
                "workflow":{"_type":"daedalus_rust_agent","llm_name":"main","tools":[]}
            }),
            [("REDIS_URL".into(), redis.into())].into(),
        )
        .unwrap()
    }

    #[test]
    fn opaque_scope_separates_users_conversations_and_unassociated_runs() {
        let first = enrollment_key("PRIVATE_USER", "PRIVATE_CONVERSATION", "run").unwrap();
        assert!(!first.contains("PRIVATE"));
        assert_ne!(
            first,
            enrollment_key("other", "PRIVATE_CONVERSATION", "run").unwrap()
        );
        assert_ne!(
            first,
            enrollment_key("PRIVATE_USER", "other", "run").unwrap()
        );
        assert_eq!(
            first,
            enrollment_key("PRIVATE_USER", "PRIVATE_CONVERSATION", "new-run").unwrap()
        );
        assert_ne!(
            enrollment_key("u", "", "one").unwrap(),
            enrollment_key("u", "", "two").unwrap()
        );
        assert!(enrollment_key("", "c", "r").is_err());
        assert!(enrollment_key("u", "", "").is_err());
    }

    #[test]
    fn recovery_never_caches_writes_or_authorization() {
        for name in [
            "gmail_mcp_server__connect",
            "calendar_mcp_server__create_event",
            "calendar_mcp_server__delete_event",
            "calendar_mcp_server__update_event",
            "agent_skills_tool",
        ] {
            assert!(!cacheable_read(name));
        }
        assert!(cacheable_read("gmail_mcp_server__get_thread"));
        assert!(cacheable_read("calendar_mcp_server__list_events"));
        assert!(cacheable_read("public_briefing_worker"));
        assert_eq!(
            arguments_hash(&json!({"b":2,"a":{"d":4,"c":3}})),
            arguments_hash(&json!({"a":{"c":3,"d":4},"b":2}))
        );
    }

    #[tokio::test]
    async fn missing_state_storage_cannot_enable_or_rollback_protected_context() {
        let store = Store::from_url("redis://127.0.0.1:1", "").unwrap();
        assert_eq!(
            owner_is_protected(&store, "user").await,
            Err(StateError::PolicyStateUnavailable)
        );
        assert_eq!(
            enforce_store(&store, "user", "conversation", "run", true).await,
            Err(StateError::PolicyStateUnavailable)
        );
        assert_eq!(
            enforce_store(&store, "user", "conversation", "run", false).await,
            Err(StateError::PolicyStateUnavailable)
        );
        let config = legacy_config("redis://127.0.0.1:1");
        assert_eq!(
            enforce(&config, "user", "conversation", "run", false).await,
            Err(StateError::PolicyStateUnavailable),
            "removing the feature stanza cannot bypass enrollment checks"
        );
    }

    #[test]
    fn workflow_budget_identity_is_independent_of_evidence_policy() {
        let config = legacy_config("redis://127.0.0.1:1");
        let workflow = uuid::Uuid::new_v4().to_string();
        for conversation in ["conversation", ""] {
            let first = SessionState::new(
                &config,
                "user",
                conversation,
                &workflow,
                "public-desk-v1:policy-a",
            )
            .unwrap();
            let resumed = SessionState::new(
                &config,
                "user",
                conversation,
                &workflow,
                "public-desk-v1:policy-b",
            )
            .unwrap();
            assert_ne!(
                first.scope, resumed.scope,
                "changed policy invalidates cached evidence"
            );
            assert_eq!(
                first.budget_key(),
                resumed.budget_key(),
                "changed policy cannot renew resource authority"
            );
            let fresh = SessionState::new(
                &config,
                "user",
                conversation,
                &uuid::Uuid::new_v4().to_string(),
                "public-desk-v1:policy-b",
            )
            .unwrap();
            assert_ne!(first.budget_key(), fresh.budget_key());
            let other = SessionState::new(
                &config,
                "other",
                conversation,
                &workflow,
                "public-desk-v1:policy-a",
            )
            .unwrap();
            assert_ne!(first.budget_key(), other.budget_key());
            let old_identity = format!("{workflow}:public-desk-v1:policy-a");
            assert_eq!(
                first.scope,
                hash(&[
                    "daedalus-completed-reads-v1",
                    &scope("user", conversation, &old_identity).unwrap(),
                    &old_identity
                ]),
                "unchanged policy preserves existing evidence namespace"
            );
        }
    }

    fn redis_store() -> Store {
        Store::from_url(
            &std::env::var("DAEDALUS_TEST_REDIS_URL").expect("provide disposable Redis URL"),
            "",
        )
        .unwrap()
    }

    async fn session_fixture() -> SessionState {
        let config = legacy_config(&std::env::var("DAEDALUS_TEST_REDIS_URL").unwrap());
        let user = uuid::Uuid::new_v4().to_string();
        let job = uuid::Uuid::new_v4().to_string();
        enforce(&config, &user, "conversation", &job, true)
            .await
            .unwrap();
        SessionState::new(&config, &user, "conversation", &job, "fixture-policy").unwrap()
    }

    #[tokio::test]
    #[ignore = "requires a disposable Redis in DAEDALUS_TEST_REDIS_URL"]
    async fn redis_enrollment_survives_restart_rejects_rollback_and_has_no_expiry() {
        let store = redis_store();
        let user = uuid::Uuid::new_v4().to_string();
        let key = enrollment_key(&user, "conversation", "run").unwrap();
        enforce_store(&store, &user, "conversation", "run", false)
            .await
            .unwrap();
        assert!(!owner_is_protected(&store, &user).await.unwrap());
        enforce_store(&store, &user, "conversation", "run", true)
            .await
            .unwrap();
        assert!(owner_is_protected(&store, &user).await.unwrap());
        let ttl: i64 = store.command(redis::cmd("TTL").arg(&key)).await.unwrap();
        assert_eq!(ttl, -1, "privacy enrollment must never expire");
        let restarted = redis_store();
        assert_eq!(
            enforce_store(&restarted, &user, "conversation", "another-run", false).await,
            Err(StateError::ProtectedConversation)
        );
        assert_eq!(
            enforce_store(&restarted, &user, "new-conversation", "new-run", false).await,
            Err(StateError::ProtectedConversation),
            "new identifiers cannot widen an enrolled owner's privacy policy"
        );
        assert_eq!(
            enforce_store(&restarted, &user, "", "another-unassociated-run", false).await,
            Err(StateError::ProtectedConversation)
        );
        let owner_ttl: i64 = store
            .command(redis::cmd("TTL").arg(user_enrollment_key(&user)))
            .await
            .unwrap();
        assert_eq!(
            owner_ttl, -1,
            "owner protection must survive new conversations and restarts"
        );
        assert!(
            enforce_store(&restarted, "unrelated-user", "conversation", "run", false)
                .await
                .is_ok()
        );
        // Re-enrollment repairs an accidental TTL without weakening the label.
        let _: i64 = store
            .command(redis::cmd("EXPIRE").arg(&key).arg(300))
            .await
            .unwrap();
        enforce_store(&restarted, &user, "conversation", "run", true)
            .await
            .unwrap();
        let ttl: i64 = store.command(redis::cmd("TTL").arg(&key)).await.unwrap();
        assert_eq!(ttl, -1);
        let _: () = store
            .command(redis::cmd("SET").arg(&key).arg("future-unknown-policy"))
            .await
            .unwrap();
        assert_eq!(
            enforce_store(&restarted, &user, "conversation", "run", true).await,
            Err(StateError::IncompatiblePolicyState)
        );
        assert_eq!(
            store.get(&key).await.unwrap().as_deref(),
            Some("future-unknown-policy")
        );
        let config = legacy_config(&std::env::var("DAEDALUS_TEST_REDIS_URL").unwrap());
        assert_eq!(
            enforce(&config, &user, "conversation", "run", false).await,
            Err(StateError::ProtectedConversation),
            "legacy configuration without an isolation stanza cannot remove protection"
        );
        store.delete(&key).await.unwrap();
        store.delete(&user_enrollment_key(&user)).await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires a disposable Redis in DAEDALUS_TEST_REDIS_URL"]
    async fn redis_budget_era_is_atomic_permanent_and_never_inferred_for_legacy_owners() {
        let store = redis_store();
        let user = uuid::Uuid::new_v4().to_string();
        let enrollments = (0..16).map(|index| {
            let store = store.clone();
            let user = user.clone();
            async move {
                enforce_store(&store, &user, &format!("conversation-{index}"), "job", true).await
            }
        });
        assert!(
            futures::future::join_all(enrollments)
                .await
                .into_iter()
                .all(|result| result.is_ok())
        );
        let era_key = budget_era_key(&user);
        assert_eq!(
            store.get(&era_key).await.unwrap().as_deref(),
            Some(BUDGET_ERA)
        );
        let _: bool = store
            .command(redis::cmd("EXPIRE").arg(&era_key).arg(300))
            .await
            .unwrap();
        enforce_store(&store, &user, "conversation-0", "job", true)
            .await
            .unwrap();
        let ttl: i64 = store
            .command(redis::cmd("TTL").arg(&era_key))
            .await
            .unwrap();
        assert_eq!(
            ttl, -1,
            "recognized enrollment repairs an accidental era TTL"
        );
        store
            .set(&era_key, "unknown-future-era", 300)
            .await
            .unwrap();
        assert_eq!(
            enforce_store(&store, &user, "new-conversation", "job", true).await,
            Err(StateError::IncompatiblePolicyState)
        );
        assert_eq!(
            store.get(&era_key).await.unwrap().as_deref(),
            Some("unknown-future-era")
        );
        assert!(
            owner_is_protected(&store, &user).await.unwrap(),
            "standalone privacy enrollment retains v1 semantics"
        );
        assert_eq!(
            enforce_store(&store, &user, "new-conversation", "job", false).await,
            Err(StateError::ProtectedConversation)
        );

        let config = legacy_config(&std::env::var("DAEDALUS_TEST_REDIS_URL").unwrap());
        for conversation_only in [false, true] {
            let user = uuid::Uuid::new_v4().to_string();
            let conversation = "legacy-conversation";
            let job = uuid::Uuid::new_v4().to_string();
            let old_key = if conversation_only {
                enrollment_key(&user, conversation, &job).unwrap()
            } else {
                user_enrollment_key(&user)
            };
            let _: () = store
                .command(redis::cmd("SET").arg(&old_key).arg(ENROLLED))
                .await
                .unwrap();
            let old_identity = format!("{job}:{PUBLIC_POLICY}:old-policy");
            let old_scope = hash(&[
                "daedalus-completed-reads-v1",
                &scope(&user, conversation, &old_identity).unwrap(),
                &old_identity,
            ]);
            let legacy_budget = format!("daedalus:workflow-budget:v1:{old_scope}");
            let _: usize = store
                .command(
                    redis::cmd("HSET")
                        .arg(&legacy_budget)
                        .arg("status")
                        .arg("completed")
                        .arg("calls_used")
                        .arg(17),
                )
                .await
                .unwrap();
            assert_eq!(
                enforce_store(&store, &user, conversation, &job, true).await,
                Err(StateError::LegacyWorkflowMigrationRequired)
            );
            assert!(store.get(&budget_era_key(&user)).await.unwrap().is_none());
            let session =
                SessionState::new(&config, &user, conversation, &job, "new-policy").unwrap();
            let result = session
                .budget(3, 600, Duration::from_secs(30), Duration::from_secs(60))
                .await;
            assert!(matches!(
                result,
                Err(StateError::LegacyWorkflowMigrationRequired
                    | StateError::IncompatiblePolicyState)
            ));
            let budget_exists: bool = store
                .command(redis::cmd("EXISTS").arg(session.budget_key()))
                .await
                .unwrap();
            assert!(
                !budget_exists,
                "legacy owner never gets a fresh v2 budget without reviewed migration"
            );
            let stored: Vec<String> = store
                .command(
                    redis::cmd("HMGET")
                        .arg(&legacy_budget)
                        .arg("status")
                        .arg("calls_used"),
                )
                .await
                .unwrap();
            assert_eq!(
                stored,
                ["completed", "17"],
                "legacy counters and completion remain untouched"
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires a disposable Redis in DAEDALUS_TEST_REDIS_URL"]
    async fn redis_policy_change_invalidates_evidence_but_preserves_budget_and_completion() {
        let config = legacy_config(&std::env::var("DAEDALUS_TEST_REDIS_URL").unwrap());
        let store = redis_store();
        for conversation in ["conversation", ""] {
            let user = uuid::Uuid::new_v4().to_string();
            let job = uuid::Uuid::new_v4().to_string();
            enforce(&config, &user, conversation, &job, true)
                .await
                .unwrap();
            let first = SessionState::new(
                &config,
                &user,
                conversation,
                &job,
                "public-desk-v1:policy-a",
            )
            .unwrap();
            let before = first
                .budget(2, 200, Duration::from_secs(30), Duration::from_secs(60))
                .await
                .unwrap();
            before.reserve_model_call(100).await.unwrap();
            before.reserve_research_tool_call(1).await.unwrap();
            let arguments = json!({"threadId":"private-thread"});
            first
                .record_read(
                    "gmail_mcp_server__get_thread",
                    &arguments,
                    &ToolOutcome {
                        content: "private completed evidence".into(),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            let original: Vec<String> = store
                .command(
                    redis::cmd("HMGET")
                        .arg(first.budget_key())
                        .arg("calls_used")
                        .arg("tokens_used")
                        .arg("research_calls_used")
                        .arg("research_deadline")
                        .arg("total_deadline"),
                )
                .await
                .unwrap();
            let changed = SessionState::new(
                &config,
                &user,
                conversation,
                &job,
                "public-desk-v1:policy-b",
            )
            .unwrap();
            assert!(
                changed
                    .lookup_read("gmail_mcp_server__get_thread", &arguments)
                    .await
                    .unwrap()
                    .is_none()
            );
            let resumed = changed
                .budget(2, 200, Duration::from_secs(30), Duration::from_secs(60))
                .await
                .unwrap();
            let restored: Vec<String> = store
                .command(
                    redis::cmd("HMGET")
                        .arg(changed.budget_key())
                        .arg("calls_used")
                        .arg("tokens_used")
                        .arg("research_calls_used")
                        .arg("research_deadline")
                        .arg("total_deadline"),
                )
                .await
                .unwrap();
            assert_eq!(
                restored, original,
                "policy changes cannot renew any shared resource"
            );
            assert_eq!(
                resumed.reserve_research_tool_call(1).await,
                Err(StateError::BudgetExhausted)
            );
            resumed.reserve_model_call(100).await.unwrap();
            assert_eq!(
                before.reserve_model_call(1).await,
                Err(StateError::BudgetExhausted)
            );
            changed.finish().await.unwrap();
            let third = SessionState::new(
                &config,
                &user,
                conversation,
                &job,
                "public-desk-v1:policy-c",
            )
            .unwrap();
            assert!(matches!(
                third
                    .budget(2, 200, Duration::from_secs(30), Duration::from_secs(60))
                    .await,
                Err(StateError::WorkflowCompleted)
            ));
            assert_eq!(
                before.reserve_model_call(1).await,
                Err(StateError::WorkflowCompleted)
            );
            assert_eq!(
                first
                    .record_read(
                        "gmail_mcp_server__get_thread",
                        &arguments,
                        &ToolOutcome {
                            content: "late result".into(),
                            ..Default::default()
                        }
                    )
                    .await,
                Err(StateError::WorkflowCompleted)
            );
            let fresh = SessionState::new(
                &config,
                &user,
                conversation,
                &uuid::Uuid::new_v4().to_string(),
                "public-desk-v1:policy-c",
            )
            .unwrap();
            fresh
                .budget(2, 200, Duration::from_secs(30), Duration::from_secs(60))
                .await
                .unwrap()
                .reserve_model_call(100)
                .await
                .unwrap();
            let _: bool = store
                .command(redis::cmd("EXPIRE").arg(budget_era_key(&user)).arg(300))
                .await
                .unwrap();
            fresh
                .budget(2, 200, Duration::from_secs(30), Duration::from_secs(60))
                .await
                .unwrap();
            let ttl: i64 = store
                .command(redis::cmd("TTL").arg(budget_era_key(&user)))
                .await
                .unwrap();
            assert_eq!(ttl, -1, "budget restoration also preserves the era marker");
            fresh.finish().await.unwrap();
        }
    }

    #[tokio::test]
    #[ignore = "requires a disposable Redis in DAEDALUS_TEST_REDIS_URL"]
    async fn redis_completed_reads_restore_only_trusted_local_content_in_the_same_scope() {
        let session = session_fixture().await;
        let store = session.store.clone();
        let name = "gmail_mcp_server__get_thread";
        let args = json!({"threadId":"PRIVATE_THREAD_ID"});
        let key = session.key(name, &args);
        let original = ToolOutcome {
            content: "PRIVATE_EMAIL_MARKER".into(),
            executor_state: json!({"private_auth_state":"must not replay"}),
            ..Default::default()
        };
        session.record_read(name, &args, &original).await.unwrap();
        let restarted = SessionState {
            store: redis_store(),
            ..session.clone()
        };
        let restored = restarted.lookup_read(name, &args).await.unwrap().unwrap();
        assert_eq!(restored.content, original.content);
        assert!(restored.executor_state.is_null());
        assert!(restored.tools.is_empty());
        assert!(restored.model_profile.is_none());
        let other_user = session_fixture().await;
        assert!(other_user.lookup_read(name, &args).await.unwrap().is_none());
        assert!(
            restarted
                .lookup_read(name, &json!({"threadId":"other"}))
                .await
                .unwrap()
                .is_none()
        );
        let raw = store.get(&key).await.unwrap().unwrap();
        let mut record: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(record["context_class"], "LOCAL_ONLY");
        assert!(!key.contains("PRIVATE_THREAD"));
        record.as_object_mut().unwrap().remove("context_class");
        store
            .set(&key, &record.to_string(), READ_TTL_SECONDS)
            .await
            .unwrap();
        assert!(
            restarted.lookup_read(name, &args).await.unwrap().is_none(),
            "unclassified cache state must not be restored"
        );
        record["context_class"] = serde_json::json!("EXTERNAL_ALLOWED");
        store
            .set(&key, &record.to_string(), READ_TTL_SECONDS)
            .await
            .unwrap();
        assert!(
            restarted.lookup_read(name, &args).await.unwrap().is_none(),
            "public label cannot authorize a private recovery record"
        );
        store
            .set(&key, "not-json PRIVATE_MARKER", READ_TTL_SECONDS)
            .await
            .unwrap();
        assert!(restarted.lookup_read(name, &args).await.unwrap().is_none());
        store.delete(&key).await.unwrap();

        let failed = ToolOutcome {
            content: "Error: authorization needed".into(),
            is_error: true,
            ..Default::default()
        };
        restarted.record_read(name, &args, &failed).await.unwrap();
        assert!(restarted.lookup_read(name, &args).await.unwrap().is_none());
        let terminal = ToolOutcome {
            content: "OAuth authorization required".into(),
            terminal: true,
            ..Default::default()
        };
        restarted.record_read(name, &args, &terminal).await.unwrap();
        assert!(restarted.lookup_read(name, &args).await.unwrap().is_none());
        restarted.record_read(name, &args, &original).await.unwrap();
        restarted.finish().await.unwrap();
        assert!(restarted.lookup_read(name, &args).await.unwrap().is_none());
        assert!(
            store
                .get(&restarted.index_key())
                .await
                .is_ok_and(|value| value.is_none())
        );
        assert_eq!(
            restarted.record_read(name, &args, &original).await,
            Err(StateError::WorkflowCompleted),
            "a late replica cannot restore evidence after completion"
        );
        assert!(
            matches!(
                restarted
                    .budget(1, 100, Duration::from_secs(30), Duration::from_secs(60))
                    .await,
                Err(StateError::WorkflowCompleted)
            ),
            "finish without an initialized budget must still close this identity"
        );
    }

    #[tokio::test]
    #[ignore = "requires a disposable Redis in DAEDALUS_TEST_REDIS_URL"]
    async fn redis_budget_survives_resume_and_completion_never_renews_it() {
        let session = session_fixture().await;
        let first = session
            .budget(3, 600, Duration::from_secs(30), Duration::from_secs(60))
            .await
            .unwrap();
        first.reserve_model_call(200).await.unwrap();
        first.clone().reserve_model_call(200).await.unwrap();
        let original_deadlines: Vec<i64> = session
            .store
            .command(
                redis::cmd("HMGET")
                    .arg(session.budget_key())
                    .arg("research_deadline")
                    .arg("total_deadline"),
            )
            .await
            .unwrap();
        let restarted = SessionState {
            store: redis_store(),
            ..session.clone()
        };
        let resumed = restarted
            .budget(3, 600, Duration::from_secs(30), Duration::from_secs(60))
            .await
            .unwrap();
        let restored_deadlines: Vec<i64> = session
            .store
            .command(
                redis::cmd("HMGET")
                    .arg(session.budget_key())
                    .arg("research_deadline")
                    .arg("total_deadline"),
            )
            .await
            .unwrap();
        assert_eq!(
            restored_deadlines, original_deadlines,
            "resume cannot restart either deadline"
        );
        assert!(resumed.remaining_total() <= Duration::from_secs(60));
        assert!(resumed.remaining_research() <= Duration::from_secs(30));
        resumed.reserve_model_call(200).await.unwrap();
        assert_eq!(
            first.reserve_model_call(1).await,
            Err(StateError::BudgetExhausted)
        );
        assert_eq!(
            resumed.reserve_model_call(1).await,
            Err(StateError::BudgetExhausted)
        );
        assert!(matches!(
            restarted
                .budget(4, 800, Duration::from_secs(30), Duration::from_secs(60))
                .await,
            Err(StateError::IncompatiblePolicyState)
        ));
        let ttl: i64 = session
            .store
            .command(redis::cmd("TTL").arg(session.budget_key()))
            .await
            .unwrap();
        assert_eq!(
            ttl, -1,
            "unfinished workflow budget must not reset through expiry"
        );
        restarted.finish().await.unwrap();
        assert_eq!(
            first.reserve_model_call(1).await,
            Err(StateError::WorkflowCompleted)
        );
        assert_eq!(
            resumed.reserve_research_tool_call(2).await,
            Err(StateError::WorkflowCompleted)
        );
        assert!(
            matches!(
                restarted
                    .budget(3, 600, Duration::from_secs(30), Duration::from_secs(60))
                    .await,
                Err(StateError::WorkflowCompleted)
            ),
            "completed workflow cannot allocate another budget"
        );
        let preserved: Vec<i64> = session
            .store
            .command(
                redis::cmd("HMGET")
                    .arg(session.budget_key())
                    .arg("calls_used")
                    .arg("tokens_used")
                    .arg("research_deadline")
                    .arg("total_deadline"),
            )
            .await
            .unwrap();
        assert_eq!(
            preserved,
            [3, 600, original_deadlines[0], original_deadlines[1]]
        );
        let ttl: i64 = session
            .store
            .command(redis::cmd("TTL").arg(session.budget_key()))
            .await
            .unwrap();
        assert_eq!(
            ttl, -1,
            "completion tombstone must not expire and permit renewal"
        );
        let fresh_session = session_fixture().await;
        let fresh = fresh_session
            .budget(2, 200, Duration::from_secs(30), Duration::from_secs(60))
            .await
            .unwrap();
        let attempts = (0..8).map(|_| {
            let budget = fresh.clone();
            async move { budget.reserve_model_call(100).await }
        });
        let results = futures::future::join_all(attempts).await;
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 2);
        assert_eq!(
            results
                .iter()
                .filter(|result| **result == Err(StateError::BudgetExhausted))
                .count(),
            6
        );
        let _: usize = fresh_session
            .store
            .command(
                redis::cmd("HSET")
                    .arg(fresh_session.budget_key())
                    .arg("total_deadline")
                    .arg(0)
                    .arg("research_deadline")
                    .arg(0),
            )
            .await
            .unwrap();
        assert_eq!(
            fresh.reserve_model_call(1).await,
            Err(StateError::DeadlineExceeded)
        );
        assert!(matches!(
            fresh_session
                .budget(2, 200, Duration::from_secs(30), Duration::from_secs(60))
                .await,
            Err(StateError::DeadlineExceeded)
        ));
        let _: usize = fresh_session
            .store
            .command(
                redis::cmd("HSET")
                    .arg(fresh_session.budget_key())
                    .arg("context_class")
                    .arg("EXTERNAL_ALLOWED"),
            )
            .await
            .unwrap();
        assert_eq!(
            fresh.reserve_model_call(1).await,
            Err(StateError::IncompatiblePolicyState)
        );
        let _: usize = fresh_session
            .store
            .command(
                redis::cmd("HSET")
                    .arg(fresh_session.budget_key())
                    .arg("context_class")
                    .arg("LOCAL_ONLY")
                    .arg("calls_used")
                    .arg(-1),
            )
            .await
            .unwrap();
        assert_eq!(
            fresh.reserve_model_call(1).await,
            Err(StateError::IncompatiblePolicyState)
        );
        let _: usize = fresh_session
            .store
            .command(
                redis::cmd("HDEL")
                    .arg(fresh_session.budget_key())
                    .arg("status"),
            )
            .await
            .unwrap();
        assert_eq!(
            fresh.reserve_model_call(1).await,
            Err(StateError::IncompatiblePolicyState),
            "unclassified lifecycle state cannot default to active"
        );
        fresh_session.finish().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires a disposable Redis in DAEDALUS_TEST_REDIS_URL"]
    async fn redis_public_collection_requires_runtime_provenance_and_authorized_scope_on_resume() {
        let session = session_fixture().await;
        let sources = vec![PublicSource {
            url: "https://news.example.com/public-article".into(),
            title: "Public article".into(),
            text: "Public collector evidence".into(),
            published_at: Some("2026-10-26".into()),
        }];
        session
            .record_collection("technology", PUBLIC_POLICY, &sources)
            .await
            .unwrap();
        let resumed = SessionState {
            store: redis_store(),
            ..session.clone()
        };
        let restored = resumed
            .lookup_collection("technology", PUBLIC_POLICY)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored[0].text, sources[0].text);
        let other_user = session_fixture().await;
        assert!(
            other_user
                .lookup_collection("technology", PUBLIC_POLICY)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            resumed
                .lookup_collection("technology", "unknown-policy")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            resumed
                .lookup_collection("a private condition", PUBLIC_POLICY)
                .await
                .unwrap()
                .is_none()
        );
        let key = session.collection_key(PublicDesk::Technology, PUBLIC_POLICY);
        let original: Value =
            serde_json::from_str(&session.store.get(&key).await.unwrap().unwrap()).unwrap();
        for (field, value) in [
            ("scope", json!("other-user-scope")),
            ("context_class", json!("LOCAL_ONLY")),
            ("source_identity", json!("model-generated-summary")),
            ("policy_version", json!("forged-policy")),
            ("schema_version", json!(2)),
            ("desk", json!("health")),
        ] {
            let mut corrupt = original.clone();
            corrupt[field] = value;
            session
                .store
                .set(&key, &corrupt.to_string(), READ_TTL_SECONDS)
                .await
                .unwrap();
            assert!(
                resumed
                    .lookup_collection("technology", PUBLIC_POLICY)
                    .await
                    .unwrap()
                    .is_none(),
                "{field}"
            );
        }
        let mut missing = original.clone();
        missing.as_object_mut().unwrap().remove("context_class");
        session
            .store
            .set(&key, &missing.to_string(), READ_TTL_SECONDS)
            .await
            .unwrap();
        assert!(
            resumed
                .lookup_collection("technology", PUBLIC_POLICY)
                .await
                .unwrap()
                .is_none()
        );
        let mut unsafe_source = original.clone();
        unsafe_source["sources"][0]["url"] = json!("http://192.168.1.10/private");
        session
            .store
            .set(&key, &unsafe_source.to_string(), READ_TTL_SECONDS)
            .await
            .unwrap();
        assert!(
            resumed
                .lookup_collection("technology", PUBLIC_POLICY)
                .await
                .unwrap()
                .is_none()
        );
        let mut untrusted_field = original.clone();
        untrusted_field["sources"][0]["context_class"] = json!("EXTERNAL_ALLOWED");
        session
            .store
            .set(&key, &untrusted_field.to_string(), READ_TTL_SECONDS)
            .await
            .unwrap();
        assert!(
            resumed
                .lookup_collection("technology", PUBLIC_POLICY)
                .await
                .unwrap()
                .is_none()
        );
        session
            .store
            .set(&key, "not-json", READ_TTL_SECONDS)
            .await
            .unwrap();
        assert!(
            resumed
                .lookup_collection("technology", PUBLIC_POLICY)
                .await
                .unwrap()
                .is_none()
        );
        session
            .record_collection("technology", PUBLIC_POLICY, &sources)
            .await
            .unwrap();
        resumed.finish().await.unwrap();
        assert!(
            resumed
                .lookup_collection("technology", PUBLIC_POLICY)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    #[ignore = "requires a disposable Redis in DAEDALUS_TEST_REDIS_URL"]
    async fn redis_research_tool_limit_is_shared_atomic_and_survives_resume() {
        let session = session_fixture().await;
        let budget = session
            .budget(5, 1000, Duration::from_secs(30), Duration::from_secs(60))
            .await
            .unwrap();
        assert_eq!(
            budget.reserve_research_tool_call(0).await,
            Err(StateError::BudgetExhausted)
        );
        let attempts = (0..5).map(|_| {
            let budget = budget.clone();
            async move { budget.reserve_research_tool_call(2).await }
        });
        let results = futures::future::join_all(attempts).await;
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 2);
        assert_eq!(
            results
                .iter()
                .filter(|result| **result == Err(StateError::BudgetExhausted))
                .count(),
            3
        );
        let resumed = session
            .budget(5, 1000, Duration::from_secs(30), Duration::from_secs(60))
            .await
            .unwrap();
        assert_eq!(
            resumed.reserve_research_tool_call(2).await,
            Err(StateError::BudgetExhausted)
        );
        assert_eq!(
            resumed.reserve_research_tool_call(3).await,
            Err(StateError::IncompatiblePolicyState)
        );
        let counters: Vec<i64> = session
            .store
            .command(
                redis::cmd("HMGET")
                    .arg(session.budget_key())
                    .arg("calls_used")
                    .arg("tokens_used")
                    .arg("research_calls_used"),
            )
            .await
            .unwrap();
        assert_eq!(counters, [0, 0, 2]);
        let _: usize = session
            .store
            .command(
                redis::cmd("HSET")
                    .arg(session.budget_key())
                    .arg("research_deadline")
                    .arg(0),
            )
            .await
            .unwrap();
        assert_eq!(
            resumed.reserve_research_tool_call(2).await,
            Err(StateError::DeadlineExceeded)
        );
        session.finish().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires a disposable Redis in DAEDALUS_TEST_REDIS_URL"]
    async fn redis_workflow_without_conversation_reuses_budget_across_new_run_ids() {
        let config = legacy_config(&std::env::var("DAEDALUS_TEST_REDIS_URL").unwrap());
        let user = uuid::Uuid::new_v4().to_string();
        let job = uuid::Uuid::new_v4().to_string();
        enforce(&config, &user, "", &job, true).await.unwrap();
        let first = SessionState::new(&config, &user, "", &job, "policy-a").unwrap();
        let budget = first
            .budget(1, 100, Duration::from_secs(30), Duration::from_secs(60))
            .await
            .unwrap();
        budget.reserve_model_call(100).await.unwrap();
        let resumed = SessionState::new(&config, &user, "", &job, "policy-b").unwrap();
        let resumed_budget = resumed
            .budget(1, 100, Duration::from_secs(30), Duration::from_secs(60))
            .await
            .unwrap();
        assert_eq!(
            resumed_budget.reserve_model_call(1).await,
            Err(StateError::BudgetExhausted)
        );
        let distinct = SessionState::new(
            &config,
            &user,
            "",
            &uuid::Uuid::new_v4().to_string(),
            "policy-b",
        )
        .unwrap();
        distinct
            .budget(1, 100, Duration::from_secs(30), Duration::from_secs(60))
            .await
            .unwrap()
            .reserve_model_call(100)
            .await
            .unwrap();
        resumed.finish().await.unwrap();
        distinct.finish().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires a disposable Redis in DAEDALUS_TEST_REDIS_URL"]
    async fn redis_final_composition_closes_public_research_across_restarts() {
        let session = session_fixture().await;
        let budget = session
            .budget(10, 1000, Duration::from_secs(30), Duration::from_secs(60))
            .await
            .unwrap();
        let before: Vec<String> = session
            .store
            .command(
                redis::cmd("HMGET")
                    .arg(session.budget_key())
                    .arg("research_deadline")
                    .arg("total_deadline"),
            )
            .await
            .unwrap();
        budget.reserve_public_model_call(100).await.unwrap();
        budget.close_research().await.unwrap();
        assert_eq!(
            budget.reserve_public_model_call(100).await,
            Err(StateError::DeadlineExceeded)
        );
        assert_eq!(
            budget.reserve_research_tool_call(10).await,
            Err(StateError::DeadlineExceeded)
        );
        budget.reserve_model_call(100).await.unwrap();
        let resumed = session
            .budget(10, 1000, Duration::from_secs(30), Duration::from_secs(60))
            .await
            .unwrap();
        assert!(resumed.remaining_research().is_zero());
        assert!(!resumed.remaining_total().is_zero());
        let after: Vec<String> = session
            .store
            .command(
                redis::cmd("HMGET")
                    .arg(session.budget_key())
                    .arg("research_deadline")
                    .arg("total_deadline"),
            )
            .await
            .unwrap();
        assert_eq!(
            before, after,
            "phase closure cannot renew the shared deadline"
        );
        session.finish().await.unwrap();
    }
}
