//! Application-owned model/tool loop. Steering is processed during every wait.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use futures::{StreamExt, stream::FuturesUnordered};
use http::HeaderMap;
use rig_core::completion::{CompletionRequest, FinishReason, ToolDefinition};
use rig_core::message::Message;
use rig_core::providers::openai::{OpenAIConfig, Route};
use rig_core::streaming::{Item, StreamEvent};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::control::{RunHandle, Steering};
use crate::events::{Events, ResponseText};
use crate::logging::{Phase, label};

#[derive(Clone, Deserialize, Serialize)]
pub struct ModelConfig {
    pub base_url: String,
    pub api_key: String,
    pub model_name: String,
    #[serde(default = "responses")]
    pub api_type: String,
    #[serde(default = "timeout")]
    pub request_timeout: f64,
    #[serde(default = "retries")]
    pub max_retries: usize,
}
fn responses() -> String {
    "responses".into()
}
fn timeout() -> f64 {
    60.0
}
fn retries() -> usize {
    3
}

#[derive(Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize, Serialize)]
pub struct PreparedRun {
    pub model: ModelConfig,
    pub instructions: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDefinition>,
    pub max_iterations: usize,
    #[serde(default)]
    pub model_routes: HashMap<String, String>,
    #[serde(default)]
    pub explicit_model_profile: bool,
    #[serde(default)]
    pub daily_summary: bool,
    #[serde(default)]
    pub final_tools: Vec<String>,
    #[serde(default = "research_budget")]
    pub research_budget_seconds: f64,
    #[serde(default = "error_limit")]
    pub repeated_error_limit: usize,
    #[serde(default)]
    pub parallel_tool_calls: bool,
}
fn research_budget() -> f64 {
    300.0
}
fn error_limit() -> usize {
    4
}

fn public_sources_permitted(body: &Value) -> bool {
    let policy = &body["additional_props"]["sourcePolicy"];
    let disabled = policy["disabledSources"].as_array();
    !policy["requirePlanApproval"].as_bool().unwrap_or(false)
        && !["perplexity_search", "known_url_scrape"]
            .iter()
            .any(|source| disabled.is_some_and(|values| values.iter().any(|value| value == source)))
        && policy["enabledSources"].as_array().is_none_or(|values| {
            values.is_empty()
                || ["perplexity_search", "known_url_scrape"]
                    .iter()
                    .all(|source| values.iter().any(|value| value == source))
        })
}

#[derive(serde::Serialize, Deserialize, Default)]
pub struct ToolOutcome {
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default)]
    pub error_signature: String,
    #[serde(default)]
    pub terminal: bool,
    #[serde(default)]
    pub terminal_reason: String,
    #[serde(default)]
    pub model_profile: Option<String>,
    #[serde(default)]
    pub tools: Vec<ToolDefinition>,
    #[serde(default)]
    pub loaded_skills: Vec<String>,
    #[serde(default)]
    pub executor_state: Value,
}

#[derive(Default)]
struct BriefingClock {
    revision: Option<u64>,
}

impl BriefingClock {
    fn allows(
        &self,
        protected_daily: bool,
        revision: u64,
        requirement: &crate::tool_contracts::Requirement,
        kind: &str,
    ) -> bool {
        !protected_daily
            || kind != "current_datetime"
            || requirement.pending()
            || self.revision != Some(revision)
    }

    fn observe(&mut self, revision: u64, kind: &str, outcome: &ToolOutcome) -> bool {
        // A bundled skill clock does not consume the user's opportunity to
        // request an explicit datetime read, even when tool_choice is Auto.
        if kind != "current_datetime"
            || outcome.is_error
            || outcome.terminal
            || self.revision.is_some_and(|observed| revision < observed)
        {
            return false;
        }
        let fresh = self.revision != Some(revision);
        self.revision = Some(revision);
        fresh
    }
}

/// Only a real native full load can establish the initial automatic briefing
/// phase. Caller tool choices and steering retain their ordinary semantics.
struct BriefingBootstrap {
    initial_daily: bool,
    loaded: bool,
}

impl BriefingBootstrap {
    fn new(protected_daily: bool) -> Self {
        Self {
            initial_daily: protected_daily,
            loaded: false,
        }
    }

    fn pending(&self, revision: u64, requirement: &crate::tool_contracts::Requirement) -> bool {
        self.initial_daily
            && !self.loaded
            && revision == 0
            && matches!(requirement, crate::tool_contracts::Requirement::Auto)
    }

    fn definition(
        preparation: &crate::preparation::Preparation,
        tools: &[ToolDefinition],
    ) -> Result<ToolDefinition> {
        let mut candidates = Vec::new();
        for definition in tools {
            let Some(tool) = preparation.skill_tools.get(&definition.name) else {
                continue;
            };
            if tool.settings.exposes_loading()
                && tool
                    .parser()
                    .map_err(|_| anyhow!("Daily-summary full skill is unavailable"))?
                    .names()
                    .iter()
                    .any(|name| name == "daily-summary")
            {
                candidates.push(definition);
            }
        }
        let [definition] = candidates.as_slice() else {
            bail!("Daily-summary requires one available native full-skill loader");
        };
        let mut definition = (*definition).clone();
        definition.description = "Load the complete daily-summary guide, all four required references, and its trusted backend clock before automatic briefing work. Omit resource; individual references do not establish this phase.".into();
        definition.parameters = json!({"type":"object","additionalProperties":false,
            "required":["operation","skill_name"],"properties":{
                "operation":{"type":"string","enum":["load_skill"]},
                "skill_name":{"type":"string","enum":["daily-summary"]}}});
        Ok(definition)
    }

    fn permits(definition: &ToolDefinition, name: &str, arguments: &Value) -> bool {
        definition.name == name
            && arguments.as_object().is_some_and(|args| args.len() == 2)
            && arguments["operation"] == "load_skill"
            && arguments["skill_name"] == "daily-summary"
    }

    fn observe(&mut self, native: bool, arguments: &Value, outcome: &ToolOutcome) {
        if native
            && arguments["operation"] == "load_skill"
            && arguments["skill_name"] == "daily-summary"
            && arguments
                .get("resource")
                .is_none_or(|value| value.is_null() || value == "")
            && !outcome.is_error
            && !outcome.terminal
            && outcome
                .loaded_skills
                .iter()
                .any(|name| name == "daily-summary")
        {
            self.loaded = true;
        }
    }
}

fn ensure_workflow_time(workers: Option<&crate::public_worker::Workers>) -> Result<()> {
    if workers.is_some_and(|workers| workers.remaining().is_zero()) {
        return Err(crate::context_isolation::IsolationError::DeadlineExceeded.into());
    }
    Ok(())
}

async fn within_workflow_time<T>(
    workers: Option<&crate::public_worker::Workers>,
    action: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    let Some(workers) = workers else {
        return action.await;
    };
    let started = tokio::time::Instant::now();
    ensure_workflow_time(Some(workers))?;
    let deadline = started + workers.remaining();
    // One absolute timer owns the complete operation. Heartbeats and steering
    // cannot renew it, and expiry wins over a simultaneously ready result.
    tokio::select! {
        biased;
        _ = tokio::time::sleep_until(deadline) => Err(crate::context_isolation::IsolationError::DeadlineExceeded.into()),
        result = action => {
            ensure_workflow_time(Some(workers))?;
            result
        }
    }
}

/// Stage each bounded event operation before reserving the client channel.
/// Encoding and backpressure happen before the final expiry check; publication
/// itself has no await. Legacy operations keep their original direct path.
async fn publish_workflow_frames<F, Fut>(
    workers: Option<&crate::public_worker::Workers>,
    events: &Events,
    frame_limit: usize,
    emit: F,
) -> Result<()>
where
    F: FnOnce(Events) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let Some(workers) = workers else {
        return emit(events.clone()).await;
    };
    within_workflow_time(Some(workers), async {
        // Callers emit one frame, or at most two for text and finish. This
        // staging queue never collects a whole response or an unbounded stream.
        let (sender, mut receiver) = mpsc::channel(frame_limit);
        emit(Events {
            run_id: events.run_id.clone(),
            sender,
        })
        .await?;
        while let Some(frame) = receiver.recv().await {
            let permit = events
                .sender
                .reserve()
                .await
                .map_err(|_| anyhow!("Client disconnected"))?;
            ensure_workflow_time(Some(workers))?;
            permit.send(frame);
        }
        Ok(())
    })
    .await
}

async fn workflow_text_delta(
    workers: Option<&crate::public_worker::Workers>,
    response_text: &mut ResponseText,
    events: &Events,
    text: &str,
) -> Result<()> {
    // A new response block can add its separator before the content frame.
    publish_workflow_frames(workers, events, 2, |staged| async move {
        response_text.delta(&staged, text).await
    })
    .await
}

async fn workflow_finish(
    workers: Option<&crate::public_worker::Workers>,
    events: &Events,
    reason: &str,
) -> Result<()> {
    publish_workflow_frames(workers, events, 2, |staged| async move {
        staged.finish(reason).await
    })
    .await
}

async fn workflow_tool_event(
    workers: Option<&crate::public_worker::Workers>,
    events: &Events,
    id: &str,
    name: &str,
    completed: bool,
    payload: Value,
) -> Result<()> {
    publish_workflow_frames(workers, events, 1, |staged| async move {
        staged.tool(id, name, completed, payload).await
    })
    .await
}

async fn workflow_event(
    workers: Option<&crate::public_worker::Workers>,
    events: &Events,
    event: &str,
    payload: Value,
) -> Result<()> {
    publish_workflow_frames(workers, events, 1, |staged| async move {
        staged.event(event, payload).await
    })
    .await
}

pub struct Agent {
    pub http: reqwest::Client,
    pub tools_url: String,
    pub headers: HeaderMap,
    pub events: Events,
    pub inbox: mpsc::Receiver<Steering>,
    pub handle: std::sync::Arc<RunHandle>,
    pub pending: Vec<(String, String)>,
    pub revision: u64,
    pub preparation: Option<std::sync::Arc<crate::preparation::Preparation>>,
}

/// Match the executor's json.dumps(ensure_ascii=False) framing, including its
/// separator spaces and trailing newline, without charging private P1 state.
fn legacy_tool_event_size(value: &Value) -> usize {
    fn spaces(value: &Value) -> usize {
        match value {
            Value::Object(fields) => {
                fields.len()
                    + fields.len().saturating_sub(1)
                    + fields.values().map(spaces).sum::<usize>()
            }
            Value::Array(items) => {
                items.len().saturating_sub(1) + items.iter().map(spaces).sum::<usize>()
            }
            _ => 0,
        }
    }
    value.to_string().len() + spaces(value) + 1
}

impl Agent {
    async fn accept(&mut self, steering: Steering) -> Result<()> {
        let Steering {
            command_id,
            instruction,
        } = steering;
        self.revision += 1;
        tracing::info!(event = "steering_received", %command_id, revision = self.revision);
        self.events.event("steering", json!({
            "command_id":command_id,"status":"received","revision":self.revision,"instruction":instruction
        })).await?;
        self.pending.push((command_id.to_string(), instruction));
        Ok(())
    }

    async fn drain(&mut self) -> Result<()> {
        while let Ok(command) = self.inbox.try_recv() {
            self.accept(command).await?;
        }
        Ok(())
    }

    async fn apply(&mut self, history: &mut Vec<Message>) -> Result<()> {
        for (id, instruction) in self.pending.drain(..) {
            tracing::info!(
                event = "steering_applied",
                command_id = id,
                revision = self.revision
            );
            history.push(Message::user(instruction));
            self.events
                .event(
                    "steering",
                    json!({"command_id":id,"status":"applied","revision":self.revision}),
                )
                .await?;
        }
        Ok(())
    }

    pub async fn run(mut self, body: Value) -> Result<()> {
        let mut requirement = crate::tool_contracts::Requirement::parse(&body)?;
        let mut response_policy = crate::response_policy::ResponsePolicy::parse(&body)?;
        self.headers.insert("x-run-id", self.events.run_id.parse()?);
        let mut missing_tool_recoveries = 0;
        let preparing = Instant::now();
        tracing::info!(event = "prepare_started");
        let preparation = self.preparation.clone();
        if preparation.is_none() {
            // The retained executor cannot enforce isolated worker contexts.
            // Check durable enrollment even when preparation mode is changed
            // or the isolation configuration stanza was removed on rollback.
            let path = std::env::var("DAEDALUS_CONFIG_FILE")
                .unwrap_or_else(|_| "/workspace/config.yaml".into());
            let config = crate::config::Config::from_path(std::path::Path::new(&path))?;
            let enabled = crate::routing::IsolationConfig::from_config(&config)?.is_some();
            crate::context_state::enforce(
                &config,
                &self.handle.user,
                &self.handle.conversation,
                body["additional_props"]["context_workflow_id"]
                    .as_str()
                    .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                    .unwrap_or(&self.events.run_id),
                enabled,
            )
            .await?;
            if enabled {
                return Err(crate::routing::PolicyError::UnsupportedGateway.into());
            }
        }
        let prepare_http = self.http.clone();
        let prepare_headers = self.headers.clone();
        let prepare_url = self.tools_url.clone();
        let prepare = async {
            if let Some(preparation) = &preparation {
                preparation
                    .prepare(&prepare_http, &prepare_url, &prepare_headers, &body)
                    .await
            } else {
                prepare_http
                    .post(format!("{prepare_url}/runtime/prepare"))
                    .headers(prepare_headers)
                    .json(&body)
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<PreparedRun>()
                    .await
                    .map_err(Into::into)
            }
        };
        tokio::pin!(prepare);
        let mut prepared = loop {
            tokio::select! {
                biased;
                Some(command) = self.inbox.recv() => self.accept(command).await?,
                response = &mut prepare => break response.context(Phase("prepare_request"))?,
                _ = self.events.sender.closed() => bail!("Client disconnected"),
            }
        };
        let isolation = preparation
            .as_ref()
            .map(|p| crate::routing::IsolationConfig::from_config(&p.config))
            .transpose()?
            .flatten();
        let requested_profile = body["additional_props"]["model_profile"]
            .as_str()
            .unwrap_or("default");
        let workflow_id = match body["additional_props"].get("context_workflow_id") {
            Some(value) => {
                let id = value
                    .as_str()
                    .ok_or_else(|| anyhow!("Invalid context workflow identity"))?;
                uuid::Uuid::parse_str(id)
                    .map_err(|_| anyhow!("Invalid context workflow identity"))?;
                id
            }
            None => &self.events.run_id,
        };
        let coordinator_route = isolation
            .as_ref()
            .map(|policy| policy.resolve_coordinator(requested_profile))
            .transpose()?;
        let session_state = if isolation.is_some() {
            Some(crate::context_state::SessionState::new(
                &preparation.as_ref().unwrap().config,
                &self.handle.user,
                &self.handle.conversation,
                workflow_id,
                &format!(
                    "{}:{}",
                    crate::context_isolation::PUBLIC_POLICY,
                    coordinator_route.as_ref().unwrap().policy_version,
                ),
            )?)
        } else {
            None
        };
        let workers = isolation.map(|routes| {
            crate::public_worker::Workers::new(
                &self.handle.user,
                &self.events.run_id,
                routes,
                prepared.max_iterations,
                prepared.research_budget_seconds,
                preparation.as_ref().map_or(75.0, |p| {
                    p.config
                        .limit("daily_summary_synthesis_retry_timeout_seconds", 75.0)
                }),
                public_sources_permitted(&body),
            )
        });
        if let (Some(workers), Some(state)) = (&workers, &session_state) {
            workers.configure_source_policy(&body["additional_props"]["sourcePolicy"])?;
            workers.configure_capability(body["additional_props"]["model_profile"].as_str())?;
            let research = Duration::from_secs_f64(prepared.research_budget_seconds);
            let synthesis = Duration::from_secs_f64(
                preparation
                    .as_ref()
                    .unwrap()
                    .config
                    .limit("daily_summary_synthesis_retry_timeout_seconds", 75.0),
            );
            workers.attach_budget(
                state
                    .budget(
                        prepared.max_iterations.min(u32::MAX as usize) as u32,
                        (prepared.max_iterations as u64).saturating_mul(8192),
                        research,
                        research + synthesis,
                    )
                    .await?,
            )?;
            workers.attach_state(state.clone(), self.handle.clone())?;
        }
        if workers.is_some() {
            prepared.instructions.push_str("\n\n");
            prepared
                .instructions
                .push_str(crate::public_worker::INSTRUCTIONS);
            prepared.tools.push(crate::public_worker::schema());
            prepared.tools.retain_mut(|tool| {
                if !crate::public_worker::restrict_coordinator_schema(
                    preparation.as_ref().unwrap(),
                    tool,
                ) {
                    return false;
                }
                if preparation
                    .as_ref()
                    .unwrap()
                    .weather_tools
                    .contains_key(&tool.name)
                {
                    tool.parameters =
                        json!({"type":"object","properties":{},"additionalProperties":false});
                    tool.description = "Read weather for the operator-approved public location using the fixed runtime template. Pass no arguments; private or model-proposed coordinates cannot be exported.".into();
                }
                true
            });
        }
        tracing::info!(
            event = "prepare_finished",
            harness_version = 1,
            harness_digest = crate::harness::identity(
                &prepared,
                &preparation
                    .as_ref()
                    .map_or(json!({}), |p| p.config.workflow().clone())
            ),
            elapsed_ms = preparing.elapsed().as_millis() as u64,
            model = label(&prepared.model.model_name),
            api_type = label(&prepared.model.api_type),
            tool_count = prepared.tools.len(),
            message_count = prepared.messages.len(),
            max_iterations = prepared.max_iterations,
            parallel_tool_calls = prepared.parallel_tool_calls
        );
        let mut selection = preparation.as_ref().map(|p| {
            crate::preparation::ModelSelection::new(
                &p.config,
                &body,
                prepared.daily_summary,
                crate::preparation::header(&self.headers, "x-daedalus-execution-scope")
                    .eq_ignore_ascii_case("autonomy"),
            )
        });
        if coordinator_route.is_some()
            && let Some(selection) = &mut selection
        {
            selection.effective = "trusted_local".into();
            selection.source = "context_policy";
        }
        if let Some(preparation) = &preparation
            && let Some(telemetry) = &preparation.telemetry
        {
            let span = telemetry.start(&prepared, selection.as_ref().unwrap());
            tracing::info!(event = "telemetry_started", trace_id = %span.trace_id());
            self.headers
                .insert("traceparent", crate::telemetry::traceparent(&span));
            self.headers.remove("tracestate");
            *self.handle.telemetry.lock().await = Some(span);
        } else if preparation.is_some() {
            self.headers.remove("traceparent");
            self.headers.remove("tracestate");
        }
        let route = if prepared.model.api_type == "responses" {
            Route::Responses
        } else {
            Route::Chat
        };
        let provider_config = OpenAIConfig::new(prepared.model.api_key.clone())
            .with_base_url(&prepared.model.base_url)
            .with_route(route);
        let provider = if workers.is_some() {
            crate::provider::isolated_client(provider_config)?
        } else {
            provider_config.client()
        };
        let mut model_name = prepared.model.model_name.clone();
        let mut catalog = crate::tool_contracts::Catalog::default();
        for tool in &prepared.tools {
            if !catalog.add(tool)? {
                bail!("Tool catalog contains duplicate definitions");
            }
        }
        let instructions = format!(
            "{}\n\n{}",
            prepared.instructions,
            crate::tool_contracts::POLICY["instructions"]
                .as_str()
                .unwrap()
        );
        let mut history = vec![Message::system(instructions)];
        for message in &prepared.messages {
            if message.content.is_empty() {
                continue;
            }
            history.push(match message.role.as_str() {
                "user" => Message::user(&message.content),
                "assistant" => Message::assistant(&message.content),
                _ => bail!("Unsupported inbound message role"),
            });
            if let Some(workers) = &workers {
                workers
                    .record_private(
                        crate::context_isolation::SourceKind::Message,
                        message.content.clone(),
                    )
                    .await;
            }
        }
        let started = Instant::now();
        let mut error_counts = HashMap::<String, usize>::new();
        let mut invalid_batches = 0;
        let mut validation_recovery = crate::tool_contracts::Recovery::default();
        let mut iterations = 0;
        let mut retry_attempt = 0;
        let mut decode_recoveries = 0;
        let mut retrying_decode = false;
        let mut resume_text = false;
        let mut response_text = ResponseText::default();
        let mut briefing_text_fallback = false;
        let mut briefing_fallback_started = false;
        let mut briefing_renderer_attempted = false;
        let mut unvalidated_html_recoveries = 0;
        // Edition clocks are revision-local. Never persist this visibility
        // state or let an old in-flight tool consume a steered request's clock.
        let mut briefing_clock = BriefingClock::default();
        let mut briefing_bootstrap =
            BriefingBootstrap::new(workers.is_some() && prepared.daily_summary);
        let mut executor_states: HashMap<String, Value> = HashMap::new();
        let query = prepared
            .messages
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .map(|m| m.content.clone())
            .unwrap_or_default();
        let initial_menu = crate::tool_contracts::initial_menu(&prepared.tools, &query);
        response_policy.observe_user(&query);
        while iterations < prepared.max_iterations
            || (briefing_text_fallback && !briefing_fallback_started)
        {
            self.drain().await?;
            for (_, instruction) in &self.pending {
                response_policy.observe_user(instruction);
            }
            // A retry continues already visible text, potentially mid-word.
            // Tool rounds and steering instead begin a new response block.
            let steered = !self.pending.is_empty();
            if !resume_text || steered {
                response_text.begin_block();
            }
            self.apply(&mut history).await?;
            if steered {
                // New direction supersedes recovery of an interrupted attempt:
                // its visible text stays in history, but the next response
                // answers the steering rather than continuing that text.
                resume_text = false;
                retrying_decode = false;
            }
            iterations += 1;
            let bootstrap = if briefing_bootstrap.pending(self.revision, &requirement) {
                Some(BriefingBootstrap::definition(
                    preparation.as_ref().unwrap(),
                    &prepared.tools,
                )?)
            } else {
                None
            };
            let final_synthesis = briefing_text_fallback
                || (prepared.daily_summary
                    && (started.elapsed().as_secs_f64() >= prepared.research_budget_seconds
                        || workers
                            .as_ref()
                            .is_some_and(|workers| workers.research_remaining().is_zero())));
            // A named capability deserves one evidence check if the model
            // answers without calling anything. This is still auto selection:
            // mentions, quotations and prohibitions never force execution.
            let review_tool_omission = iterations == 1
                && self.revision == 0
                && matches!(requirement, crate::tool_contracts::Requirement::Auto)
                && initial_menu.is_some();
            let withhold_text = response_policy.final_only()
                || requirement.pending()
                || review_tool_omission
                || (workers.is_some() && prepared.daily_summary);
            let otherwise_available = |tool: &&ToolDefinition| {
                !briefing_text_fallback
                    && (workers.is_none()
                        || preparation.as_ref().is_some_and(|p|
                        // Schema visibility removes unsafe tools; dispatch
                        // repeats authorization against the concrete arguments.
                        workers.as_ref().unwrap().schema_allowed(p, &tool.name)))
                    && (!final_synthesis
                        || prepared.final_tools.contains(&tool.name)
                        // A resumed closed research phase still needs its
                        // fresh native full bundle. Only that validated loader
                        // can cross the final-tool filter while bootstrap is
                        // pending; its ordinary gate rejects every sibling.
                        || bootstrap.as_ref().is_some_and(|loader| loader.name == tool.name))
                    && requirement.allows(&tool.name)
                    && validation_recovery.allows(&tool.name)
            };
            let clock_available = |tool: &&ToolDefinition| {
                briefing_clock.allows(
                    workers.is_some() && prepared.daily_summary,
                    self.revision,
                    &requirement,
                    preparation
                        .as_ref()
                        .and_then(|preparation| {
                            preparation.config.raw["functions"][&tool.name]["_type"].as_str()
                        })
                        .unwrap_or(""),
                )
            };
            let available =
                |tool: &&ToolDefinition| otherwise_available(tool) && clock_available(tool);
            let in_menu = |tool: &&ToolDefinition| {
                if let Some(bootstrap) = &bootstrap {
                    return tool.name == bootstrap.name;
                }
                iterations != 1
                    || self.revision != 0
                    || requirement.pending()
                    || initial_menu
                        .as_ref()
                        .is_none_or(|names| names.contains(&tool.name))
            };
            let tools: Vec<_> = prepared
                .tools
                .iter()
                .filter(available)
                .filter(in_menu)
                .map(|tool| bootstrap.as_ref().unwrap_or(tool).clone())
                .collect();
            // These return with the full catalogue next round. Rejecting a
            // proposal for one must not spend that tool's argument correction.
            let mut menu_hidden: std::collections::HashSet<_> = prepared
                .tools
                .iter()
                .filter(available)
                .filter(|tool| !in_menu(tool))
                .map(|tool| tool.name.clone())
                .collect();
            // A successful clock hides only this edition phase. Proposing it
            // again is not an argument error and must not disable the fresh
            // clock that steering can make available later.
            menu_hidden.extend(
                prepared
                    .tools
                    .iter()
                    .filter(otherwise_available)
                    .filter(|tool| !clock_available(tool))
                    .map(|tool| tool.name.clone()),
            );
            if requirement.pending() && tools.is_empty() {
                bail!("Required tool did not complete successfully");
            }
            if bootstrap.is_some() && tools.is_empty() {
                bail!("Daily-summary full skill could not be loaded in this phase");
            }
            let mut params = json!({
                "store": false,
                "parallel_tool_calls": prepared.parallel_tool_calls,
                "user": crate::provider::cache_affinity_key(
                    &self.handle.user,
                    &self.handle.conversation,
                    &self.events.run_id,
                ),
            });
            if prepared.model.api_type == "responses" {
                params["truncation"] = json!("auto");
            }
            if let Some(route) = &coordinator_route {
                params
                    .as_object_mut()
                    .unwrap()
                    .extend(route.extra_body.as_object().unwrap().clone());
                route.record("coordinator", "coordinator", retry_attempt + 1);
            }
            let tool_count = tools.len();
            if iterations == 1 && tool_count < prepared.tools.len() {
                tracing::info!(
                    event = "initial_tool_menu",
                    available_tools = prepared.tools.len(),
                    advertised_tools = tool_count
                );
            }
            let mut request = CompletionRequest::new("unused")
                .tools(tools.clone())
                .tool_choice(if briefing_text_fallback {
                    rig_core::message::ToolChoice::None
                } else if bootstrap.is_some() {
                    rig_core::message::ToolChoice::Required
                } else if workers.is_some()
                    && prepared.daily_summary
                    && self.revision == 0
                    && !briefing_renderer_attempted
                    && !tools.is_empty()
                    && matches!(requirement, crate::tool_contracts::Requirement::Auto)
                    && preparation.as_ref().is_some_and(|preparation| {
                        prepared.tools.iter().any(|tool| {
                            preparation.config.raw["functions"][&tool.name]["_type"]
                                == "briefing_renderer"
                        })
                    })
                {
                    // Constrain planning to an advertised capability without
                    // changing the caller's explicit tool requirement. Once a
                    // renderer dispatch is attempted, honest text recovery is
                    // again possible through the ordinary Auto choice.
                    rig_core::message::ToolChoice::Required
                } else {
                    requirement.choice()
                })
                .additional_params(params);
            if let Some(workers) = &workers {
                workers.reserve_model_call(8192).await?;
                request.max_tokens = Some(8192);
            }
            request.chat_history = history.clone();
            if resume_text {
                request.chat_history.push(Message::user(
                    "The previous model stream was interrupted. Continue from the assistant text already delivered without repeating it. Use the completed tool results in the conversation; do not repeat completed tool actions. Tool calls from the interrupted response were not executed.",
                ));
            }
            if retrying_decode {
                request.chat_history.push(Message::user(
                    "The previous model response could not be decoded. None of its proposed tool calls ran. Reissue a complete response with valid tool arguments using the completed results already in the conversation; do not repeat completed tool actions.",
                ));
            }
            if briefing_text_fallback {
                request.chat_history.push(Message::user("The briefing renderer arguments remained invalid after the allowed correction. The rejected renderer calls did not run. The HTML edition could not be validated. Return the useful briefing as sourced plain text from the completed evidence already in this conversation, with source links and material gaps beside the affected reporting. Do not claim the unvalidated edition is verified, write HTML, call tools, or restart research."));
            } else if final_synthesis {
                request.chat_history.push(Message::user("Finish using the evidence already collected. Render the briefing or return the sourced findings and any explicit gaps."));
            }
            let model_call = self
                .handle
                .metrics
                .model_calls
                .fetch_add(1, Ordering::Relaxed)
                + 1;
            let model_started = Instant::now();
            // request_timeout bounds inactivity: time to the first stream item
            // and between items. A healthy long response keeps streaming; the
            // whole-run deadline bounds total time.
            let inactivity = Duration::from_secs_f64(prepared.model.request_timeout.max(1.0));
            let mut total_timeout = if briefing_text_fallback {
                briefing_fallback_started = true;
                // Configured and validated alongside the research budget. The
                // single text-only synthesis attempt keeps a total cap.
                Some(preparation.as_ref().map_or(75.0, |p| {
                    p.config
                        .limit("daily_summary_synthesis_retry_timeout_seconds", 75.0)
                }))
            } else {
                None
            };
            if let Some(workers) = &workers {
                let remaining = workers.remaining().as_secs_f64();
                total_timeout =
                    Some(total_timeout.map_or(remaining, |seconds| seconds.min(remaining)));
            }
            tracing::info!(
                event = "model_call_started",
                catalog_digest = crate::harness::digest(&json!(tools)),
                final_only = response_policy.final_only(),
                model_call,
                iteration = iterations,
                attempt = retry_attempt + 1,
                model = label(&model_name),
                tool_count,
                timeout_seconds = prepared.model.request_timeout,
                total_timeout_seconds = total_timeout,
                final_synthesis
            );
            let model = provider.completion(&model_name);
            let wire = if let Some(route) = &coordinator_route {
                crate::provider::CompatibleOpenAi::for_isolated_session(
                    model.wire,
                    &self.handle.user,
                    &self.events.run_id,
                    "coordinator",
                    &route.policy_version,
                    &prepared.model.base_url,
                    &model_name,
                )
            } else {
                crate::provider::CompatibleOpenAi::for_session(
                    model.wire,
                    &self.handle.user,
                    &self.handle.conversation,
                    &self.events.run_id,
                )
            };
            let model = rig_core::driver::Model::new(wire, model.transport);
            ensure_workflow_time(workers.as_deref())?;
            let mut stream = model.stream(request).context(Phase("model_request"))?;
            let idle = tokio::time::sleep(inactivity);
            tokio::pin!(idle);
            let total = async {
                match total_timeout {
                    Some(seconds) => {
                        let seconds = if workers.is_some() {
                            seconds
                        } else {
                            seconds.max(1.0)
                        };
                        tokio::time::sleep(Duration::from_secs_f64(seconds)).await
                    }
                    None => std::future::pending().await,
                }
            };
            tokio::pin!(total);
            let mut partial = String::new();
            let mut interrupted = false;
            let mut inactive = false;
            let mut stream_error = None;
            let mut received_item = false;
            let mut last_activity = Instant::now();
            within_workflow_time(workers.as_deref(), async {
                loop {
                    // Buffered, always-ready items must not starve the absolute
                    // timer. Recheck before polling or publishing another delta.
                    ensure_workflow_time(workers.as_deref())?;
                    tokio::select! {
                        biased;
                        Some(command) = self.inbox.recv() => {
                            self.accept(command).await?;
                            interrupted = true;
                            break;
                        }
                        item = stream.next() => match item {
                            None => break,
                            Some(Err(error)) => { stream_error = Some(error); break; },
                            Some(Ok(item)) => {
                                ensure_workflow_time(workers.as_deref())?;
                                idle.as_mut().reset(tokio::time::Instant::now() + inactivity);
                                if !received_item {
                                    tracing::info!(event = "model_first_event", model_call,
                                        elapsed_ms = model_started.elapsed().as_millis() as u64);
                                }
                                received_item = true;
                                if let Item::Event(StreamEvent::Text { text, .. }) = item {
                                    if withhold_text && partial.len().saturating_add(text.len()) > crate::response_policy::MAX_WITHHELD_BYTES {
                                        return Err(anyhow::anyhow!("Withheld response exceeded output limit").context(Phase("model_stream")));
                                    }
                                    partial.push_str(&text);
                                    if !withhold_text {
                                        workflow_text_delta(workers.as_deref(), &mut response_text, &self.events, &text).await?;
                                        last_activity = Instant::now();
                                    } else if last_activity.elapsed() >= Duration::from_secs(15) {
                                        self.events.raw(": model active\n\n".into()).await?;
                                        last_activity = Instant::now();
                                    }
                                } else if last_activity.elapsed() >= Duration::from_secs(15) {
                                    // Reasoning and argument fragments are private,
                                    // but their arrival proves the stream is active.
                                    // A silent provider emits no activity comments.
                                    self.events.raw(": model active\n\n".into()).await?;
                                    last_activity = Instant::now();
                                }
                            },
                        },
                        _ = &mut idle => { inactive = true; break; }
                        _ = &mut total => return Err(anyhow::anyhow!("Model request timed out").context(Phase("model_stream"))),
                        _ = self.events.sender.closed() => bail!("Client disconnected"),
                    }
                }
                Ok(())
            }).await?;
            if interrupted {
                tracing::info!(
                    event = "model_call_interrupted",
                    model_call,
                    reason = "steering",
                    elapsed_ms = model_started.elapsed().as_millis() as u64,
                    output_bytes = partial.len()
                );
                // The incomplete provider response never contributes tool calls.
                // Keep text already shown to the user in the next request.
                drop(stream);
                retry_attempt = 0;
                if !partial.is_empty() && !withhold_text {
                    history.push(Message::assistant(partial));
                }
                continue;
            }
            // `None` is a silent provider: no stream item within the
            // inactivity timeout. Like a transport failure it is retryable.
            let completion = match stream_error {
                Some(error) => Err(Some(error)),
                None if inactive => {
                    drop(stream);
                    Err(None)
                }
                None => {
                    within_workflow_time(workers.as_deref(), async {
                        Ok(stream.finish().await.map_err(Some))
                    })
                    .await?
                }
            };
            let completed = match completion {
                Ok(completed) => completed,
                Err(error)
                    if !briefing_text_fallback
                        && error.as_ref().is_none_or(|error| {
                            crate::provider::retryable(error)
                                || (crate::provider::stream_decode_error(error)
                                    && decode_recoveries == 0)
                        })
                        && retry_attempt < prepared.model.max_retries =>
                {
                    if error
                        .as_ref()
                        .is_some_and(crate::provider::stream_decode_error)
                    {
                        decode_recoveries += 1;
                        retrying_decode = true;
                    }
                    retry_attempt += 1;
                    iterations -= 1;
                    // Tools only execute after a complete model response. Keep
                    // prior results and visible text, but discard every tool
                    // proposal from this failed attempt, even a finished item.
                    let output_bytes = partial.len();
                    if !partial.is_empty() && !withhold_text {
                        history.push(Message::assistant(partial));
                        resume_text = true;
                    }
                    let delay = Duration::from_millis(250 * (1 << retry_attempt.min(5)));
                    tracing::warn!(
                        event = "model_retry_scheduled",
                        model_call,
                        retry_attempt,
                        decode_recoveries,
                        delay_ms = delay.as_millis() as u64,
                        error_kind = match &error {
                            None => "inactivity_timeout",
                            Some(error) if crate::provider::is_gateway_transport_error(error) => {
                                "upstream_transport"
                            }
                            Some(error) => error.kind().code(),
                        },
                        http_status = error
                            .as_ref()
                            .and_then(|error| error.provider_response_status())
                            .map(|status| status.as_u16()),
                        elapsed_ms = model_started.elapsed().as_millis() as u64,
                        received_item,
                        output_bytes,
                        resuming = resume_text
                    );
                    within_workflow_time(workers.as_deref(), async {
                        tokio::select! {
                            biased;
                            Some(command) = self.inbox.recv() => { self.accept(command).await?; retry_attempt = 0; },
                            _ = tokio::time::sleep(delay) => {},
                            _ = self.events.sender.closed() => bail!("Client disconnected"),
                        }
                        Ok(())
                    }).await?;
                    continue;
                }
                Err(None) => {
                    tracing::warn!(
                        event = "model_call_failed",
                        model_call,
                        error_kind = "inactivity_timeout",
                        retry_attempt,
                        decode_recoveries,
                        elapsed_ms = model_started.elapsed().as_millis() as u64,
                        received_item,
                        output_bytes = partial.len(),
                    );
                    return Err(
                        anyhow::anyhow!("Model request timed out").context(Phase("model_stream"))
                    );
                }
                Err(Some(error)) => {
                    tracing::warn!(
                        event = "model_call_failed",
                        model_call,
                        error_kind = error.kind().code(),
                        retry_attempt,
                        decode_recoveries,
                        elapsed_ms = model_started.elapsed().as_millis() as u64,
                        received_item,
                        output_bytes = partial.len(),
                    );
                    return Err(anyhow::Error::new(error).context(Phase("model_stream")));
                }
            };
            retry_attempt = 0;
            retrying_decode = false;
            // The interrupted attempt's text is already visible; an empty
            // continuation completes that answer rather than replacing it.
            let resumed = std::mem::take(&mut resume_text);
            self.handle.metrics.record_usage(
                completed.usage.input_tokens,
                completed.usage.output_tokens,
                completed.usage.cached_input_tokens,
            );
            if !matches!(
                completed.finish_reason(),
                Some(FinishReason::Stop | FinishReason::ToolCalls)
            ) {
                return Err(anyhow::anyhow!("Model response did not complete")
                    .context(Phase("model_finish")));
            }
            let mut calls: Vec<_> = completed.tool_calls().cloned().collect();
            tracing::info!(
                event = "model_call_finished",
                model_call,
                elapsed_ms = model_started.elapsed().as_millis() as u64,
                output_bytes = partial.len(),
                tool_calls = calls.len(),
                usage_reported = completed.usage.is_reported(),
                input_tokens = completed.usage.input_tokens,
                output_tokens = completed.usage.output_tokens,
                cached_tokens = completed.usage.cached_input_tokens
            );
            self.drain().await?;
            if calls.is_empty() && review_tool_omission && self.pending.is_empty() {
                tracing::info!(event = "tool_omission_review");
                history.push(Message::user("No tool has executed for this request. Your proposed answer was withheld for one evidence check. Re-read the user's request: if it asks you to invoke an available capability, call it and answer from the actual result. Do not invent or simulate evidence, even for a synthetic test. If the request merely discusses or quotes a tool, forbids tool use, or needs clarification, answer directly without invoking it. This check does not authorize extra actions."));
                continue;
            }
            if calls.is_empty() && requirement.pending() {
                missing_tool_recoveries += 1;
                tracing::warn!(
                    event = "required_tool_missing",
                    attempt = missing_tool_recoveries
                );
                if missing_tool_recoveries >= 2 {
                    bail!("Required tool did not complete successfully");
                }
                history.push(Message::user("The required tool has not succeeded. Your proposed answer was withheld. Invoke the required tool and use its actual result. Do not invent evidence."));
                continue;
            }
            if let Some(message) = completed.message() {
                history.push(message);
                if let Some(workers) = &workers {
                    workers
                        .record_private(
                            crate::context_isolation::SourceKind::Derived,
                            partial.clone(),
                        )
                        .await;
                }
            }
            if workers.is_some()
                && prepared.daily_summary
                && calls.is_empty()
                && (partial.to_ascii_lowercase().contains("<html")
                    || partial.to_ascii_lowercase().contains("<!doctype"))
            {
                unvalidated_html_recoveries += 1;
                if unvalidated_html_recoveries > 1 {
                    bail!("Briefing HTML was not validated by the canonical renderer");
                }
                history.push(Message::user("The proposed HTML was withheld because it did not come from the canonical briefing renderer. Submit the canonical edition to briefing_renderer_tool, or return sourced plain text with explicit limitations if rendering is unavailable. Do not write HTML yourself or restart research."));
                continue;
            }
            if calls.is_empty() {
                if bootstrap.is_some() && self.pending.is_empty() {
                    bail!("Daily-summary full skill was not loaded");
                }
                if !self.pending.is_empty() {
                    continue;
                }
                if !self.handle.finish_if_idle(&self.inbox).await {
                    continue;
                }
                if partial.is_empty() && !resumed {
                    bail!("Model completed without an answer");
                }
                within_workflow_time(workers.as_deref(), async {
                    if withhold_text {
                        workflow_text_delta(
                            workers.as_deref(),
                            &mut response_text,
                            &self.events,
                            &partial,
                        )
                        .await?;
                    }
                    workflow_finish(workers.as_deref(), &self.events, "stop").await
                })
                .await?;
                if let Some(state) = &session_state
                    && state.finish().await.is_err()
                {
                    tracing::warn!(event = "context_workflow_cleanup_failed");
                }
                return Ok(());
            }
            if briefing_text_fallback {
                bail!("Briefing text fallback proposed tools despite disabled tool access");
            }
            let batch_revision = self.revision;
            let mut problems = catalog.check_batch(&calls, &tools)?;
            if let Some(bootstrap) = &bootstrap {
                for (call, problem) in calls.iter().zip(&mut problems) {
                    if !BriefingBootstrap::permits(
                        bootstrap,
                        call.function.name.as_str(),
                        &call.function.arguments,
                    ) {
                        *problem = "Load the full daily-summary guide with the advertised native loader and no resource before other automatic tools. This call did not execute.".into();
                    }
                }
            }
            let (counted_calls, counted_problems): (Vec<_>, Vec<_>) = calls
                .iter()
                .zip(&problems)
                .filter(|(call, _)| {
                    !menu_hidden.contains(call.function.name.as_str())
                        // Bootstrap hides every sibling, including tools that
                        // also await personal-source authorization. Those
                        // proposals must not disable their later phase.
                        && bootstrap
                            .as_ref()
                            .is_none_or(|bootstrap| call.function.name.as_str() == bootstrap.name)
                })
                .map(|(call, problem)| (call.clone(), problem.clone()))
                .unzip();
            let recovery_exhausted =
                validation_recovery.exhausted(&counted_calls, &counted_problems);
            // Every tool result must directly answer the assistant's calls.
            // Correction guidance follows the whole batch, never between results.
            let mut batch_notice = None;
            let mut clock_notice = false;
            if problems.iter().any(|problem| !problem.is_empty()) {
                invalid_batches += 1;
                let diagnostics: Vec<_> = calls.iter().zip(&problems)
                    .filter(|(_, problem)| !problem.is_empty())
                    .map(|(call, problem)| json!({
                        "tool": if tools.iter().any(|tool| tool.name == call.function.name.as_str()) {
                            call.function.name.as_str()
                        } else { "<unavailable>" },
                        "constraint": problem
                    })).collect();
                tracing::warn!(
                    event = "tool_batch_rejected",
                    attempt = invalid_batches,
                    calls = calls.len(),
                    recovery_exhausted,
                    problems = %json!(diagnostics)
                );
                let renderer_only_errors = calls
                    .iter()
                    .zip(&problems)
                    .filter(|(_, problem)| !problem.is_empty())
                    .all(|(call, _)| call.function.name.as_str() == "briefing_renderer_tool");
                let mut valid = Vec::new();
                for (call, problem) in calls.into_iter().zip(problems) {
                    if problem.is_empty() {
                        valid.push(call);
                        continue;
                    }
                    history.push(Message::tool_result(
                        call.id,
                        call.function.name,
                        json!({"status":"error", "executed":false, "error":"invalid_tool_batch",
                            "detail":problem})
                        .to_string(),
                    ));
                }
                calls = valid;
                if recovery_exhausted {
                    if prepared.daily_summary && renderer_only_errors && !requirement.pending() {
                        if let Some(workers) = &workers {
                            workers.close_research().await?;
                        }
                        briefing_text_fallback = true;
                        tracing::info!(
                            event = "briefing_text_fallback",
                            reason = "renderer_arguments"
                        );
                    }
                    batch_notice = Some(
                        "Tools with repeated invalid arguments have been disabled for this run. Continue with successful results and other available tools. Report the affected gap without claiming those calls succeeded. Do not repeat disabled calls.",
                    );
                } else {
                    batch_notice = Some(
                        "Invalid calls did not run; valid calls in the same batch will execute. Correct invalid arguments once using the advertised schemas and fresh call IDs. Resolve identifiers from earlier results, supplied context or available memory; do not guess missing values. Read results before dependent calls.",
                    );
                }
            }
            if calls.iter().any(|call| {
                preparation.as_ref().is_some_and(|preparation| {
                    preparation.config.raw["functions"][call.function.name.as_str()]["_type"]
                        == "briefing_renderer"
                })
            }) && let Some(workers) = &workers
            {
                workers.close_research().await?;
            }
            let mut queued = VecDeque::from(calls);
            let mut active = FuturesUnordered::new();
            let mut active_groups = HashMap::<String, usize>::new();
            let concurrency = if prepared.parallel_tool_calls { 8 } else { 1 };
            let mut terminal = None;
            // Where the approval boundary's own result sits in the transcript,
            // so a redirect that pre-empts the approval can neutralise it.
            let mut terminal_result = None;
            let tool_batch = async {
                while !queued.is_empty() || !active.is_empty() {
                    self.drain().await?;
                    while active.len() < concurrency {
                        let redirected = self.revision != batch_revision
                            || !self.pending.is_empty()
                            || terminal.is_some();
                        let position = queued.iter().position(|call| {
                            redirected
                                || active_groups
                                    .get(&self.execution_group(&call.function.name))
                                    .copied()
                                    .unwrap_or(0)
                                    < self.execution_concurrency(&call.function.name)
                        });
                        let Some(position) = position else {
                            break;
                        };
                        let call = queued.remove(position).expect("queued call exists");
                        let name = call.function.name.to_string();
                        let id = call.id.to_string();
                        // Repeat the exact phase predicate at scheduling. The
                        // pending snapshot covers the whole original batch;
                        // a successful sibling cannot authorize dependent work.
                        if bootstrap.as_ref().is_some_and(|bootstrap| {
                            !BriefingBootstrap::permits(bootstrap, &name, &call.function.arguments)
                        }) {
                            bail!("Daily-summary bootstrap dispatch was not authorized");
                        }
                        if self.revision != batch_revision
                            || !self.pending.is_empty()
                            || terminal.is_some()
                        {
                            tracing::info!(
                                event = "tool_call_skipped",
                                reason = "redirected_or_terminal"
                            );
                            history.push(Message::tool_result(call.id, call.function.name, "Not executed: this run was redirected or reached an approval boundary."));
                            continue;
                        }
                        let tool_call = self
                            .handle
                            .metrics
                            .tool_calls
                            .fetch_add(1, Ordering::Relaxed)
                            + 1;
                        let group = self.execution_group(&name);
                        *active_groups.entry(group.clone()).or_default() += 1;
                        workflow_tool_event(
                            workers.as_deref(),
                            &self.events,
                            &id,
                            &name,
                            false,
                            call.function.arguments.clone(),
                        )
                        .await?;
                        let http = self.http.clone();
                        let headers = self.headers.clone();
                        let url = format!(
                            "{}/runtime/{}",
                            self.tools_url,
                            if preparation.is_some() {
                                "v1/tools/call"
                            } else {
                                "tools/call"
                            }
                        );
                        let events = self.events.clone();
                        let tool_preparation = preparation.clone();
                        let tool_workers = workers.clone();
                        let tool_state = session_state.clone();
                        let renderer = tool_preparation.as_ref().is_some_and(|preparation| {
                            preparation.config.raw["functions"][&name]["_type"]
                                == "briefing_renderer"
                        });
                        let context = json!({"version":1,"query":query,"available_tools":prepared.tools.iter().map(|t| &t.name).collect::<Vec<_>>(),"executor_state":executor_states.get(&group).filter(|state| state.is_object()).cloned().unwrap_or_else(||json!({}))});
                        active.push(async move {
                            let mut renderer_executed = false;
                            let started = Instant::now();
                            tracing::info!(
                                event = "tool_call_started",
                                tool_call,
                                tool = label(&name)
                            );
                            let result = if let (Some(workers), Some(preparation)) =
                                (&tool_workers, &tool_preparation)
                            {
                                if let Err(rejection) = workers
                                    .authorize_tool(preparation, &name, &call.function.arguments)
                                    .await
                                {
                                    Ok(rejection.outcome())
                                } else if name == crate::public_worker::NAME {
                                    workers
                                        .call(
                                            &call.function.arguments,
                                            preparation.clone(),
                                            http,
                                            headers,
                                            url.trim_end_matches("/runtime/v1/tools/call")
                                                .to_string(),
                                            events,
                                        )
                                        .await
                                } else {
                                    async {
                                        let arguments = workers.tool_arguments(
                                            preparation,
                                            &name,
                                            &call.function.arguments,
                                        );
                                        if let Some(cached) = tool_state
                                            .as_ref()
                                            .unwrap()
                                            .lookup_read(&name, &arguments)
                                            .await?
                                        {
                                            return Ok(cached);
                                        }
                                        if preparation.weather_tools.contains_key(&name) {
                                            workers.reserve_research_tool_call().await?;
                                        }
                                        renderer_executed = renderer;
                                        Self::tool_response(
                                            http,
                                            headers,
                                            url,
                                            events,
                                            (&name, &arguments),
                                            tool_preparation.clone(),
                                            context,
                                        )
                                        .await
                                    }
                                    .await
                                }
                            } else {
                                renderer_executed = renderer;
                                Self::tool_response(
                                    http,
                                    headers,
                                    url,
                                    events,
                                    (&name, &call.function.arguments),
                                    tool_preparation,
                                    context,
                                )
                                .await
                            }
                            .context(Phase("tool_request"));
                            match &result {
                                Ok(outcome) => tracing::info!(
                                    event = "tool_call_finished",
                                    tool_call,
                                    tool = label(&name),
                                    elapsed_ms = started.elapsed().as_millis() as u64,
                                    is_error = outcome.is_error,
                                    terminal = outcome.terminal,
                                    output_bytes = outcome.content.len(),
                                    approval_required =
                                        outcome.terminal_reason == "mcp_approval_required"
                                ),
                                Err(error) => {
                                    let details = crate::logging::failure(error);
                                    tracing::warn!(
                                        event = "tool_call_failed",
                                        tool_call,
                                        tool = label(&name),
                                        elapsed_ms = started.elapsed().as_millis() as u64,
                                        error_kind = details.kind,
                                        http_status = details.status
                                    );
                                }
                            }
                            (call, result, renderer_executed)
                        });
                    }
                    if active.is_empty() {
                        continue;
                    }
                    let (call, outcome, renderer_executed) = tokio::select! {
                        biased;
                        Some(command) = self.inbox.recv() => { self.accept(command).await?; continue; }
                        Some(result) = active.next() => result,
                        _ = self.events.sender.closed() => bail!("Client disconnected"),
                    };
                    // A completed tool must not publish or enter model history
                    // after the protected workflow's original total deadline.
                    ensure_workflow_time(workers.as_deref())?;
                    briefing_renderer_attempted |= renderer_executed;
                    // One call's transport or decoding failure is that call's result,
                    // not the run's: ending the run here would drop the sibling calls
                    // still in flight (their remote effects unknown) and lose results
                    // that completed but were not yet collected. Only a disconnected
                    // client ends the run.
                    let mut outcome = match outcome {
                        Ok(outcome) => outcome,
                        Err(error) if error.root_cause().to_string() == "Client disconnected" => {
                            return Err(error);
                        }
                        Err(error) => {
                            let details = crate::logging::failure(&error);
                            // Transport failures name only their kind; the runtime's
                            // own fixed messages carry no private values.
                            let reason = if details.kind == "application" {
                                error.root_cause().to_string()
                            } else {
                                details.kind.to_owned()
                            };
                            ToolOutcome {
                                content: format!(
                                    "Tool failed ({reason}). Check its arguments and service availability."
                                ),
                                is_error: true,
                                error_signature: reason,
                                ..Default::default()
                            }
                        }
                    };
                    let name = call.function.name.to_string();
                    briefing_bootstrap.observe(
                        preparation
                            .as_ref()
                            .is_some_and(|preparation| preparation.skill_tools.contains_key(&name)),
                        &call.function.arguments,
                        &outcome,
                    );
                    if workers.is_some()
                        && outcome
                            .loaded_skills
                            .iter()
                            .any(|skill| skill == "daily-summary")
                    {
                        prepared.daily_summary = true;
                    }
                    if let Some(workers) = &workers {
                        workers.observe_tool(&name, &outcome);
                        workers
                            .record_private(
                                match name.as_str() {
                                    "get_memory" => crate::context_isolation::SourceKind::Memory,
                                    _ if name.starts_with("gmail_mcp_server__") => {
                                        crate::context_isolation::SourceKind::Email
                                    }
                                    _ if name.starts_with("calendar_mcp_server__") => {
                                        crate::context_isolation::SourceKind::Calendar
                                    }
                                    _ => crate::context_isolation::SourceKind::Tool,
                                },
                                outcome.content.clone(),
                            )
                            .await;
                    }
                    if let Some(state) = &session_state {
                        let arguments = workers.as_ref().unwrap().tool_arguments(
                            preparation.as_ref().unwrap(),
                            &name,
                            &call.function.arguments,
                        );
                        state.record_read(&name, &arguments, &outcome).await?;
                    }
                    if !outcome.is_error && !outcome.terminal {
                        if workers.is_some()
                            && let Some(preparation) = &preparation
                        {
                            clock_notice |= briefing_clock.observe(
                                batch_revision,
                                preparation.config.raw["functions"][&name]["_type"]
                                    .as_str()
                                    .unwrap_or(""),
                                &outcome,
                            );
                        }
                        requirement.succeeded(&name);
                    }
                    let group = self.execution_group(&name);
                    if preparation.is_some() {
                        // Scraping and verification have no run-scoped executor state.
                        // Never replace shared state with a concurrent call's snapshot.
                        if !matches!(
                            group.as_str(),
                            "native:source_verifier" | "native:webscrape"
                        ) && outcome.executor_state.is_object()
                        {
                            executor_states.insert(group.clone(), outcome.executor_state.clone());
                        }
                        if let Some(preparation) = &preparation {
                            // A leaf reports successful skill loading; only Rust resolves routing policy.
                            let selection = selection.as_mut().unwrap();
                            outcome.model_profile = if workers.is_none() {
                                selection.skill_loaded(&preparation.config, &outcome.loaded_skills)
                            } else {
                                None
                            };
                            if let Some(span) = self.handle.telemetry.lock().await.as_mut() {
                                crate::telemetry::routing(span, selection);
                            }
                        }
                    }
                    *active_groups.get_mut(&group).expect("active group exists") -= 1;
                    // An approval marker terminates the frontend stream. Defer it until
                    // every already-started call has returned its result.
                    let visible =
                        if outcome.terminal && outcome.terminal_reason == "mcp_approval_required" {
                            "Waiting at the approval boundary.".to_owned()
                        } else {
                            outcome.content.clone()
                        };
                    ensure_workflow_time(workers.as_deref())?;
                    workflow_tool_event(
                        workers.as_deref(),
                        &self.events,
                        &call.id.to_string(),
                        &name,
                        true,
                        Value::String(visible),
                    )
                    .await?;
                    let approval_boundary =
                        outcome.terminal && outcome.terminal_reason == "mcp_approval_required";
                    if outcome.terminal && terminal.is_none() {
                        terminal = Some((outcome.content.clone(), outcome.terminal_reason));
                    }
                    for mut tool in outcome.tools {
                        if workers.is_some()
                            && !crate::public_worker::restrict_coordinator_schema(
                                preparation.as_ref().unwrap(),
                                &mut tool,
                            )
                        {
                            continue;
                        }
                        if catalog.add(&tool)? {
                            prepared.tools.push(tool);
                        }
                    }
                    if let Some(profile) = &outcome.model_profile
                        && workers.is_none()
                        && !prepared.explicit_model_profile
                        && let Some(alias) = prepared.model_routes.get(profile)
                    {
                        if model_name != *alias {
                            tracing::info!(
                                event = "model_route_changed",
                                model = label(alias),
                                profile = label(profile)
                            );
                        }
                        model_name = alias.clone();
                    }
                    let repeated_errors = if outcome.is_error {
                        let signature = format!(
                            "{name}:{}:{}",
                            call.function.arguments,
                            if outcome.error_signature.is_empty() {
                                &outcome.content
                            } else {
                                &outcome.error_signature
                            }
                        );
                        let count = error_counts.entry(signature).or_default();
                        *count += 1;
                        *count
                    } else {
                        0
                    };
                    if approval_boundary && terminal_result.is_none() {
                        terminal_result =
                            Some((history.len(), call.id.clone(), call.function.name.clone()));
                    }
                    history.push(Message::tool_result(
                        call.id,
                        call.function.name,
                        if outcome.is_error {
                            json!({"status":"error", "content":outcome.content}).to_string()
                        } else {
                            outcome.content
                        },
                    ));
                    if prepared.repeated_error_limit > 0
                        && repeated_errors >= prepared.repeated_error_limit
                    {
                        bail!("Repeated identical tool failure");
                    }
                }
                Ok(())
            };
            within_workflow_time(workers.as_deref(), tool_batch).await?;
            if let Some(notice) = batch_notice {
                history.push(Message::user(notice));
            }
            if clock_notice && prepared.daily_summary && self.revision == batch_revision {
                // Phase guidance follows every result in the batch, keeping
                // each result directly bound to its assistant tool call.
                history.push(Message::user("The clock is established for this edition. Reuse its returned time and continue source work or finalization. A fresh clock is available after steering or a resumed run."));
            }
            if let Some((content, reason)) = terminal {
                self.drain().await?;
                if !self.pending.is_empty() || !self.handle.finish_if_idle(&self.inbox).await {
                    // The user's direction wins over the approval boundary. The
                    // gated call never ran and its approval is never requested, so
                    // its marker must not stay in the transcript as a result the
                    // model can quote.
                    if let Some((index, id, name)) = terminal_result.take() {
                        history[index] = Message::tool_result(
                            id,
                            name,
                            "Not executed: this call needs the user's approval, and the run was redirected before approval could be requested.",
                        );
                    }
                    continue;
                }
                within_workflow_time(workers.as_deref(), async {
                    if reason == "mcp_approval_required" {
                        tracing::info!(event = "approval_required");
                        workflow_event(
                            workers.as_deref(),
                            &self.events,
                            "mcp_approval_required",
                            json!({"marker":content}),
                        )
                        .await?;
                    }
                    response_text.begin_block();
                    workflow_text_delta(
                        workers.as_deref(),
                        &mut response_text,
                        &self.events,
                        &content,
                    )
                    .await?;
                    workflow_finish(
                        workers.as_deref(),
                        &self.events,
                        if reason == "mcp_approval_required" {
                            "mcp_approval_required"
                        } else {
                            "stop"
                        },
                    )
                    .await
                })
                .await?;
                if reason == "validated_artifact"
                    && let Some(state) = &session_state
                    && state.finish().await.is_err()
                {
                    tracing::warn!(event = "context_workflow_cleanup_failed");
                }
                return Ok(());
            }
        }
        bail!("Agent iteration limit reached")
    }

    fn execution_group(&self, name: &str) -> String {
        if let Some(preparation) = &self.preparation
            && let Some(kind) = preparation.config.raw["functions"][name]["_type"].as_str()
        {
            return format!("native:{kind}");
        }
        name.split("__").next().unwrap_or_default().to_owned()
    }

    fn execution_concurrency(&self, name: &str) -> usize {
        if name == crate::public_worker::NAME {
            return 4;
        }
        self.preparation
            .as_ref()
            .map_or(1, |preparation| preparation.config.tool_concurrency(name))
    }

    pub(crate) async fn tool_response(
        http: reqwest::Client,
        headers: HeaderMap,
        url: String,
        events: Events,
        invocation: (&str, &Value),
        preparation: Option<std::sync::Arc<crate::preparation::Preparation>>,
        context: Value,
    ) -> Result<ToolOutcome> {
        let (name, arguments) = invocation;
        if let Some(preparation) = &preparation
            && (preparation.document_tools.contains_key(name)
                || preparation.domain_tools.contains_key(name)
                || preparation.search_tools.contains_key(name)
                || preparation.skill_tools.contains_key(name)
                || preparation.sandbox_tools.contains_key(name)
                || preparation.exploration_tools.contains_key(name)
                || preparation.weather_tools.contains_key(name)
                || preparation.docs_tools.contains_key(name))
        {
            let call = async {
                if let Some(tool) = preparation.skill_tools.get(name) {
                    return tool
                        .call(arguments)
                        .await
                        .map(|(text, loaded)| (crate::document_json::Text::from(text), loaded));
                }
                let result = if let Some(tool) = preparation.document_tools.get(name) {
                    tool.call(arguments, &headers).await
                } else if let Some(tool) = preparation.exploration_tools.get(name) {
                    tool.call(arguments, &headers).await
                } else if let Some(tool) = preparation.sandbox_tools.get(name) {
                    tool.call(arguments, &headers).await
                } else if let Some(tool) = preparation.weather_tools.get(name) {
                    tool.call(arguments).await
                } else if let Some(tool) = preparation.search_tools.get(name) {
                    tool.call(arguments)
                        .await
                        .map(crate::document_json::Text::from)
                } else if let Some(tool) = preparation.docs_tools.get(name) {
                    let limit = preparation
                        .outputs
                        .settings
                        .max_original
                        .saturating_mul(6)
                        .saturating_add(8 * 1024 * 1024);
                    tool.call(arguments, limit)
                        .await
                        .map(crate::document_json::Text::from)
                } else {
                    preparation.domain_tools[name]
                        .search(arguments)
                        .await
                        .map(crate::document_json::Text::from)
                };
                result.map(|text| (text, vec![]))
            };
            tokio::pin!(call);
            let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            heartbeat.tick().await;
            let result = loop {
                tokio::select! {
                    result = &mut call => break result,
                    _ = heartbeat.tick() => events.raw(": tool active\n\n".into()).await?,
                }
            };
            let (content, is_error, loaded_skills) = match result {
                Ok((text, loaded)) => {
                    // Receipt completion precedes this encoding boundary. An
                    // unencodable result fails its stream, just as the executor
                    // does, while its accepted write remains completed.
                    let content = text.into_utf8()?;
                    let failed = content.starts_with("Error:")
                        || preparation.docs_tools.contains_key(name)
                            && serde_json::from_str::<Value>(&content)
                                .is_ok_and(|value| crate::config::truthy(&value["error"]));
                    (content, failed, loaded)
                }
                Err(error) => (crate::document_tools::error_content(&error), true, vec![]),
            };
            let content = preparation
                .outputs
                .optimize(
                    crate::preparation::header(&headers, "x-user-id"),
                    name,
                    context["query"].as_str().unwrap_or(""),
                    &crate::output::redact_approval_markers(&content),
                )
                .await;
            let outcome = ToolOutcome {
                content,
                is_error,
                loaded_skills,
                ..Default::default()
            };
            if legacy_tool_event_size(&json!({"event":"result","data":outcome})) > 8 * 1024 * 1024 {
                bail!("Tool event exceeds size limit");
            }
            return Ok(outcome);
        }
        if let Some(preparation) = &preparation
            && preparation.config.raw["functions"][name]["_type"] == "tool_output_retriever"
        {
            // Retain executor validation, marker redaction and output policy.
            if let Some(error) = crate::output_retriever::input_error(arguments) {
                return Ok(ToolOutcome {
                    content: error.into(),
                    is_error: true,
                    ..Default::default()
                });
            }
            let content = crate::output_retriever::retrieve(
                &preparation.output_readers[name],
                &preparation.config.raw["functions"][name],
                crate::preparation::header(&headers, "x-user-id"),
                arguments,
            )
            .await?;
            let is_error = serde_json::from_str::<Value>(&content)
                .is_ok_and(|v| crate::config::truthy(&v["error"]));
            let content = preparation
                .outputs
                .optimize(
                    crate::preparation::header(&headers, "x-user-id"),
                    name,
                    context["query"].as_str().unwrap_or(""),
                    &crate::output::redact_approval_markers(&content),
                )
                .await;
            return Ok(ToolOutcome {
                content,
                is_error,
                ..Default::default()
            });
        }
        if let Some(preparation) = &preparation
            && crate::memory_tools::owns(
                preparation.config.raw["functions"][name]["_type"]
                    .as_str()
                    .unwrap_or(""),
            )
        {
            let call = preparation.memory_tools.call(
                &preparation.config.raw["functions"][name],
                arguments,
                &headers,
            );
            tokio::pin!(call);
            let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            heartbeat.tick().await;
            let content = loop {
                tokio::select! {
                    content = &mut call => break content,
                    _ = heartbeat.tick() => events.raw(": tool active\n\n".into()).await?,
                }
            };
            let is_error = content.starts_with("Error:") || content.starts_with("Tool failed (");
            let content = preparation
                .outputs
                .optimize(
                    crate::preparation::header(&headers, "x-user-id"),
                    name,
                    context["query"].as_str().unwrap_or(""),
                    &crate::output::redact_approval_markers(&content),
                )
                .await;
            let outcome = ToolOutcome {
                content,
                is_error,
                ..Default::default()
            };
            if legacy_tool_event_size(&json!({"event":"result","data":outcome})) > 8 * 1024 * 1024 {
                bail!("Tool event exceeds size limit");
            }
            return Ok(outcome);
        }
        if let Some(preparation) = &preparation
            && let Some(mcp) = &preparation.mcp
            && mcp.owns(name)
        {
            let user = crate::preparation::header(&headers, "x-user-id");
            let token = crate::preparation::header(&headers, "x-daedalus-approval-token");
            let emit = crate::oauth::Emitter::Chat(events.clone());
            let background = crate::preparation::header(&headers, "x-daedalus-execution-scope")
                .eq_ignore_ascii_case("autonomy");
            let call = mcp.call(name, arguments, user, token, &emit, background);
            tokio::pin!(call);
            let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            heartbeat.tick().await;
            let mut outcome = loop {
                tokio::select! {
                    outcome = &mut call => break outcome,
                    _ = heartbeat.tick() => events.raw(": tool active\n\n".into()).await?,
                }
            };
            if !outcome.terminal {
                outcome.content = preparation
                    .outputs
                    .optimize(
                        user,
                        name,
                        context["query"].as_str().unwrap_or(""),
                        &outcome.content,
                    )
                    .await;
            }
            if legacy_tool_event_size(&json!({"event":"result","data":outcome})) > 8 * 1024 * 1024 {
                bail!("Tool event exceeds size limit");
            }
            return Ok(outcome);
        }
        if let Some(preparation) = &preparation
            && preparation.config.raw["functions"][name]["_type"] == "current_datetime"
        {
            if !arguments.is_object() {
                bail!("Tool arguments must be an object");
            }
            if arguments.as_object().is_some_and(|a| !a.is_empty()) {
                // Match Pydantic's safe error envelope and Python json.dumps,
                // including spaces and ASCII escaping of untrusted field names.
                let errors: Vec<_> = arguments.as_object().unwrap().keys().map(|key| {
                    let key: String = serde_json::to_string(key).unwrap().chars().map(|c| {
                        if c.is_ascii() { c.to_string() } else {
                            c.encode_utf16(&mut [0; 2]).iter().map(|u| format!("\\u{u:04x}")).collect()
                        }
                    }).collect();
                    format!("{{\"type\": \"extra_forbidden\", \"loc\": [{key}], \"msg\": \"Extra inputs are not permitted\"}}")
                }).collect();
                return Ok(ToolOutcome {
                    content: format!("[{}]", errors.join(", ")),
                    is_error: true,
                    ..Default::default()
                });
            }
            let configured = preparation.config.raw["functions"][name]["timezone"]
                .as_str()
                .unwrap_or("UTC");
            let trusted = crate::preparation::header(&headers, "x-timezone");
            let timezone = if trusted.is_empty() {
                configured
            } else {
                trusted
            };
            return Ok(match timezone.parse::<chrono_tz::Tz>() {
                Ok(tz) => ToolOutcome { content:chrono::Utc::now().with_timezone(&tz).to_rfc3339_opts(chrono::SecondsFormat::Micros,false), ..Default::default() },
                Err(_) => ToolOutcome { content:"Tool failed (ZoneInfoNotFoundError). Check its arguments and service availability.".into(),is_error:true,..Default::default() }
            });
        }
        let mut request = json!({"name":name,"arguments":arguments});
        if preparation.is_some() {
            request["context"] = context.clone();
        }
        let user = crate::preparation::header(&headers, "x-user-id").to_string();
        // The tool service writes a heartbeat line every 15 s while a call
        // runs, so a longer silence means the peer or its socket died without
        // closing. Without this bound a hung call would hold the run until
        // the whole-run deadline.
        let idle = Duration::from_secs_f64(
            preparation
                .as_ref()
                .and_then(|p| {
                    p.config
                        .variable("DAEDALUS_TOOL_STREAM_IDLE_SECONDS", "60")
                        .trim()
                        .parse::<f64>()
                        .ok()
                })
                .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
                .unwrap_or(60.0),
        );
        let response =
            tokio::time::timeout(idle, http.post(url).headers(headers).json(&request).send())
                .await
                .map_err(|_| anyhow!("Tool service did not accept the call in time"))??
                .error_for_status()?;
        let mut stream = response.bytes_stream();
        let mut buffer = Vec::new();
        // The legacy executor compacted before transport. Version 1 transports
        // raw content to its Rust owner; allow the configured compaction input
        // (up to six JSON-escaped bytes per character) plus the legacy envelope.
        let event_limit = preparation.as_ref().map_or(8 * 1024 * 1024, |p| {
            p.outputs
                .settings
                .max_original
                .saturating_mul(6)
                .saturating_add(8 * 1024 * 1024)
        });
        loop {
            let chunk = match tokio::time::timeout(idle, stream.next()).await {
                Ok(Some(chunk)) => chunk?,
                Ok(None) => break,
                Err(_) => bail!("Tool stream stalled"),
            };
            buffer.extend_from_slice(&chunk);
            if buffer.len() > event_limit {
                bail!("Tool event exceeds size limit");
            }
            while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                let line: Vec<_> = buffer.drain(..=end).collect();
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                let event: Value = serde_json::from_slice(&line)?;
                match event["event"].as_str() {
                    Some("result") => {
                        let mut outcome: ToolOutcome =
                            serde_json::from_value(event["data"].clone())
                                .context("Invalid tool result")?;
                        if let Some(preparation) = &preparation
                            && !outcome.terminal
                        {
                            outcome.content = preparation
                                .outputs
                                .optimize(
                                    &user,
                                    if preparation.config.raw["functions"][name]["_type"]
                                        == "webscrape"
                                    {
                                        "webscrape_tool"
                                    } else {
                                        name
                                    },
                                    context["query"].as_str().unwrap_or(""),
                                    &outcome.content,
                                )
                                .await;
                        }
                        if preparation.is_some() {
                            // Only the internal raw buffer grew. Preserve the
                            // legacy envelope limit after Rust compaction,
                            // excluding the new private executor context.
                            let mut legacy = event;
                            let data = legacy["data"]
                                .as_object_mut()
                                .context("Invalid tool result")?;
                            data.remove("executor_state");
                            data.remove("loaded_skills");
                            data.insert("content".into(), json!(outcome.content));
                            if legacy_tool_event_size(&legacy) > 8 * 1024 * 1024 {
                                bail!("Tool event exceeds size limit");
                            }
                        }
                        return Ok(outcome);
                    }
                    Some("oauth_required") => {
                        tracing::info!(event = "oauth_required");
                        events
                            .event("oauth_required", event["data"].clone())
                            .await?
                    }
                    Some("heartbeat") => events.raw(": tool active\n\n".into()).await?,
                    _ => bail!("Unknown tool-service event"),
                }
            }
        }
        bail!("Tool stream ended without a result")
    }
}

#[cfg(test)]
mod tests {
    //! A scripted Responses peer drives the real loop, preparation and native
    //! clock. Assertions inspect what the next model request actually carried.
    use super::*;
    use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
    use std::sync::{Arc, Mutex as StdMutex};

    #[derive(Default)]
    struct Model {
        scripts: StdMutex<VecDeque<Option<Vec<Value>>>>,
        requests: StdMutex<Vec<Value>>,
        tool_calls: StdMutex<Vec<Value>>,
    }
    const DEADLINE_RENDERER_HTML: &str =
        "```html\n<!doctype html><html><body>DEADLINE_RENDERER_MARKER</body></html>\n```";

    /// A scripted tool service. The call's `query` argument selects the
    /// reply: `fail` answers 500, `stall` writes one heartbeat line and then
    /// never finishes, anything else returns a result naming the query.
    async fn tool_call(
        State(model): State<Arc<Model>>,
        Json(body): Json<Value>,
    ) -> axum::response::Response {
        model.tool_calls.lock().unwrap().push(body.clone());
        let query = body["arguments"]["query"].as_str().unwrap_or("").to_owned();
        if query == "fail"
            || body["name"] == "briefing_renderer_tool"
                && body["arguments"]["edition"]["fixture_transport_failure"] == true
        {
            return (
                http::StatusCode::INTERNAL_SERVER_ERROR,
                "tool service failed",
            )
                .into_response();
        }
        if body["name"] == "briefing_renderer_tool"
            && let Some(delay) = body["arguments"]["edition"]["fixture_delay_ms"].as_u64()
        {
            let (sender, receiver) = mpsc::channel::<Result<String, std::convert::Infallible>>(4);
            tokio::spawn(async move {
                let complete_at = tokio::time::Instant::now() + Duration::from_millis(delay);
                while tokio::time::Instant::now() < complete_at {
                    if sender
                        .send(Ok("{\"event\":\"heartbeat\",\"data\":{}}\n".into()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                    tokio::time::sleep(
                        Duration::from_millis(100).min(
                            complete_at.saturating_duration_since(tokio::time::Instant::now()),
                        ),
                    )
                    .await;
                }
                let result = json!({"event":"result","data":{"content":DEADLINE_RENDERER_HTML,
                    "terminal":true,"terminal_reason":"validated_artifact"}});
                let _ = sender.send(Ok(format!("{result}\n"))).await;
            });
            return (
                [(http::header::CONTENT_TYPE, "application/x-ndjson")],
                axum::body::Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(
                    receiver,
                )),
            )
                .into_response();
        }
        if query == "stall" {
            let (sender, receiver) = mpsc::channel::<Result<String, std::convert::Infallible>>(4);
            tokio::spawn(async move {
                if sender
                    .send(Ok("{\"event\":\"heartbeat\",\"data\":{}}\n".into()))
                    .await
                    .is_ok()
                {
                    // Hold the stream open without another byte.
                    std::future::pending::<()>().await;
                }
            });
            return (
                [(http::header::CONTENT_TYPE, "application/x-ndjson")],
                axum::body::Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(
                    receiver,
                )),
            )
                .into_response();
        }
        let result = json!({"event":"result","data":{"content":format!("result for {query}")}});
        (
            [(http::header::CONTENT_TYPE, "application/x-ndjson")],
            format!("{result}\n"),
        )
            .into_response()
    }

    async fn respond(
        State(model): State<Arc<Model>>,
        Json(body): Json<Value>,
    ) -> axum::response::Response {
        model.requests.lock().unwrap().push(body);
        let script = model.scripts.lock().unwrap().pop_front();
        // `None` holds the response open until the client gives up.
        let Some(Some(events)) = script else {
            return std::future::pending().await;
        };
        // `__pause_ms` delays the next event; `__stall` keeps the body open.
        if events
            .iter()
            .any(|event| event.get("__pause_ms").is_some() || event.get("__stall").is_some())
        {
            let (sender, receiver) = mpsc::channel::<Result<String, std::convert::Infallible>>(64);
            tokio::spawn(async move {
                for event in events {
                    if let Some(pause) = event["__pause_ms"].as_u64() {
                        tokio::time::sleep(Duration::from_millis(pause)).await;
                    } else if event["__stall"] == true {
                        std::future::pending::<()>().await;
                    } else if sender.send(Ok(format!("data: {event}\n\n"))).await.is_err() {
                        return;
                    }
                }
            });
            return (
                [(http::header::CONTENT_TYPE, "text/event-stream")],
                axum::body::Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(
                    receiver,
                )),
            )
                .into_response();
        }
        let body: String = events
            .iter()
            .map(|event| format!("data: {event}\n\n"))
            .collect();
        ([(http::header::CONTENT_TYPE, "text/event-stream")], body).into_response()
    }

    async fn catalogue() -> Json<Value> {
        Json(json!({
            "briefing_renderer_tool":[{"name":"briefing_renderer_tool",
                "description":"Render the briefing edition.",
                "parameters":{"type":"object","required":["edition"],"additionalProperties":false,
                    "properties":{"edition":{"type":"object"}}}}],
            "edition_renderer":[{"name":"edition_renderer",
                "description":"Render the briefing edition.",
                "parameters":{"type":"object","required":["edition"],"additionalProperties":false,
                    "properties":{"edition":{"type":"object"}}}}],
            "lookup_tool":[{"name":"lookup_tool",
                "description":"Look up a query.",
                "parameters":{"type":"object","required":["query"],"additionalProperties":false,
                    "properties":{"query":{"type":"string"}}}}]
        }))
    }

    fn call(id: &str, name: &str, arguments: &str) -> Value {
        json!({"type":"function_call","id":format!("fc_{id}"),"call_id":id,"name":name,
            "arguments":arguments,"status":"completed"})
    }

    fn text(content: &str) -> Value {
        json!({"type":"message","id":"msg_fixture","status":"completed","role":"assistant",
            "content":[{"type":"output_text","text":content,"annotations":[]}]})
    }

    /// One complete Responses stream: every item is announced, streamed and
    /// finished before the response completes.
    fn completed(items: Vec<Value>) -> Option<Vec<Value>> {
        let mut events = vec![
            json!({"type":"response.created","response":{"id":"resp_fixture",
            "object":"response","created_at":1,"status":"in_progress","model":"fixture","output":[]}}),
        ];
        for (index, item) in items.iter().enumerate() {
            let mut added = item.clone();
            added["status"] = json!("in_progress");
            let delta = if item["type"] == "message" {
                added["content"] = json!([]);
                json!({"type":"response.output_text.delta","output_index":index,"content_index":0,
                    "item_id":item["id"],"delta":item["content"][0]["text"]})
            } else {
                added["arguments"] = json!("");
                json!({"type":"response.function_call_arguments.delta","output_index":index,
                    "item_id":item["id"],"delta":item["arguments"]})
            };
            events.push(
                json!({"type":"response.output_item.added","output_index":index,"item":added}),
            );
            events.push(delta);
            events
                .push(json!({"type":"response.output_item.done","output_index":index,"item":item}));
        }
        events.push(
            json!({"type":"response.completed","response":{"id":"resp_fixture",
            "object":"response","created_at":1,"status":"completed","error":null,
            "incomplete_details":null,"instructions":null,"max_output_tokens":null,
            "model":"fixture","output":items,"tools":[],"usage":{"input_tokens":1,
            "output_tokens":1,"total_tokens":2,"input_tokens_details":{"cached_tokens":0},
            "output_tokens_details":{"reasoning_tokens":0}}}}),
        );
        Some(events)
    }

    /// A healthy answer streamed as timed fragments; optionally the stream
    /// then goes silent before its terminal events.
    fn paced(parts: &[&str], pause_ms: u64, stall: bool) -> Option<Vec<Value>> {
        let events = completed(vec![text(&parts.concat())]).unwrap();
        let mut paced = events[..2].to_vec();
        for part in parts {
            paced.push(json!({ "__pause_ms": pause_ms }));
            paced.push(json!({"type":"response.output_text.delta","output_index":0,
                "content_index":0,"item_id":"msg_fixture","delta":part}));
        }
        if stall {
            paced.push(json!({"__stall":true}));
        }
        paced.extend_from_slice(&events[3..]);
        Some(paced)
    }

    struct Outcome {
        requests: Vec<Value>,
        tool_calls: Vec<Value>,
        stream: String,
        result: Result<()>,
    }

    async fn run(
        functions: Value,
        workflow: Value,
        query: &str,
        scripts: Vec<Option<Vec<Value>>>,
    ) -> Outcome {
        run_with_retries(functions, workflow, query, scripts, 0).await
    }

    async fn run_with_retries(
        functions: Value,
        workflow: Value,
        query: &str,
        scripts: Vec<Option<Vec<Value>>>,
        max_retries: usize,
    ) -> Outcome {
        run_scripted(
            functions,
            workflow,
            query,
            scripts,
            json!({ "max_retries": max_retries }),
            None,
        )
        .await
    }

    /// `steer` submits one instruction once the peer has received that many
    /// model requests. Zero waits for the first dispatched tool instead.
    async fn run_scripted(
        functions: Value,
        workflow: Value,
        query: &str,
        scripts: Vec<Option<Vec<Value>>>,
        model_settings: Value,
        steer: Option<(usize, &'static str)>,
    ) -> Outcome {
        run_scripted_with_body(
            functions,
            workflow,
            query,
            scripts,
            model_settings,
            steer,
            json!({}),
        )
        .await
    }

    async fn run_scripted_with_body(
        mut functions: Value,
        mut workflow: Value,
        query: &str,
        mut scripts: Vec<Option<Vec<Value>>>,
        model_settings: Value,
        mut steer: Option<(usize, &'static str)>,
        request_fields: Value,
    ) -> Outcome {
        // Existing renderer/clock scenarios begin after a genuine native
        // bootstrap. Keep that prerequisite separate from the phase request
        // indices those scenarios assert. Bootstrap-specific tests use the
        // raw helper below and inspect every encoded request.
        let needs_guide = workflow["context_isolation"]["enabled"] == true
            && crate::preparation::profile(query, false) == "daily_summary"
            && request_fields["tool_choice"] != "none"
            && !functions
                .as_object()
                .unwrap()
                .values()
                .any(|settings| settings["_type"] == "agent_skills");
        let skill = needs_guide.then(|| DailySkill::new(true));
        let mut bootstrap_index = None;
        if let Some(skill) = &skill {
            functions["fixture_daily_guide"] = skill.functions()["agent_skills_tool"].clone();
            for key in ["tools", "daily_summary_tools"] {
                if let Some(tools) = workflow[key].as_array_mut() {
                    tools.push(json!("fixture_daily_guide"));
                }
            }
            if let Some(limit) = workflow["max_iterations"].as_u64() {
                workflow["max_iterations"] = json!(limit + 1);
            }
            let index = usize::from(
                crate::tool_contracts::Requirement::parse(&request_fields)
                    .unwrap()
                    .pending(),
            );
            scripts.insert(
                index,
                completed(vec![call(
                    "fixture_full_guide",
                    "fixture_daily_guide",
                    r#"{"operation":"load_skill","skill_name":"daily-summary"}"#,
                )]),
            );
            if let Some((after, _)) = &mut steer
                && *after > index
            {
                *after += 1;
            }
            bootstrap_index = Some(index);
        }
        let mut outcome = run_raw_scripted_with_body(
            functions,
            workflow,
            query,
            scripts,
            model_settings,
            steer,
            request_fields,
        )
        .await;
        if let Some(index) = bootstrap_index {
            let request = outcome.requests.remove(index);
            assert_eq!(tool_names(&request), ["fixture_daily_guide"]);
            assert_eq!(request["tool_choice"], "required");
            if let Some(next) = outcome.requests.get(index) {
                let input = next["input"].to_string();
                assert!(input.contains("daily_summary_runtime_clock"));
                for reference in [
                    "edition-policy.json",
                    "research-and-sourcing.md",
                    "edition-format.md",
                    "editorial-spec.md",
                ] {
                    assert!(input.contains(reference));
                }
            }
        }
        outcome
    }

    async fn run_raw_scripted_with_body(
        functions: Value,
        workflow: Value,
        query: &str,
        scripts: Vec<Option<Vec<Value>>>,
        model_settings: Value,
        steer: Option<(usize, &'static str)>,
        request_fields: Value,
    ) -> Outcome {
        run_raw_scripted_with_output(
            functions,
            workflow,
            query,
            scripts,
            model_settings,
            steer,
            request_fields,
            None,
        )
        .await
    }

    /// A delayed collector models a connected client applying backpressure;
    /// the real Agent still owns the protected deadline and provider stream.
    #[allow(clippy::too_many_arguments)]
    async fn run_raw_scripted_with_output(
        functions: Value,
        workflow: Value,
        query: &str,
        scripts: Vec<Option<Vec<Value>>>,
        model_settings: Value,
        steer: Option<(usize, &'static str)>,
        request_fields: Value,
        output: Option<(usize, Duration, bool)>,
    ) -> Outcome {
        let protected = workflow["context_isolation"]["enabled"] == true;
        let model = Arc::new(Model::default());
        model.scripts.lock().unwrap().extend(scripts);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/v1/responses", post(respond))
            .route("/runtime/v1/catalog", post(catalogue))
            .route("/runtime/v1/tools/call", post(tool_call))
            .with_state(model.clone());
        let peer = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut raw = json!({
            "llms":{"main":{"base_url":format!("{base}/v1"),"api_key":"synthetic",
                "model_name":"fixture","api_type":"responses","max_retries":0}},
            "functions":functions,
            "workflow":{"_type":"daedalus_rust_agent","llm_name":"main"}
        });
        crate::config::merge(&mut raw["workflow"], workflow);
        crate::config::merge(&mut raw["llms"]["main"], model_settings);
        let (policy_redis_url, policy_redis) = if protected {
            (
                std::env::var("DAEDALUS_TEST_REDIS_URL")
                    .expect("protected Agent tests require a real disposable Redis"),
                None,
            )
        } else {
            let (url, server) = crate::context_state::empty_policy_store().await;
            (url, Some(server))
        };
        if protected {
            let mut redis = reqwest::Url::parse(&policy_redis_url).unwrap();
            redis.set_username("").unwrap();
            redis.set_password(None).unwrap();
            redis.set_query(None);
            redis.set_fragment(None);
            if redis.port().is_none() {
                redis.set_port(Some(6379)).unwrap();
            }
            if redis.path().is_empty() || redis.path() == "/" {
                redis.set_path("/0");
            }
            raw["workflow"]["context_isolation"] = json!({
                "enabled":true,"policy_version":"clock-menu-tests-v1","coordinator":"local",
                "destinations":{"local":{"llm":"main","trust":"trusted_local","transport":"direct"}},
                "worker_profiles":{},"trusted_local_services":{"redis":redis.as_str()}
            });
            if raw["functions"]["llm_sandbox_tool"]["_type"] == "llm_sandbox" {
                // Renderer tests use the loopback executor fixture, but still
                // declare its configured private sandbox trust accurately.
                let sandbox = crate::llm_sandbox::Settings::new(
                    &raw["functions"]["llm_sandbox_tool"],
                    &HashMap::new(),
                )
                .unwrap();
                raw["workflow"]["context_isolation"]["trusted_local_services"]["sandbox"] =
                    sandbox.values["base_url"].clone();
            }
        }
        let config = crate::config::Config::new(
            raw,
            [
                ("DAEDALUS_MEMORY_MODE".into(), "disabled".into()),
                ("REDIS_URL".into(), policy_redis_url),
                // Keep a stalled scripted tool stream from waiting a minute.
                ("DAEDALUS_TOOL_STREAM_IDLE_SECONDS".into(), "1".into()),
            ]
            .into(),
        )
        .unwrap();
        let http = reqwest::Client::new();
        let preparation = crate::preparation::Preparation::new(config).unwrap();
        let (commands, inbox) = mpsc::channel(8);
        let (capacity, collector_delay, prefill) = output.unwrap_or((128, Duration::ZERO, false));
        let (sender, mut receiver) = mpsc::channel::<bytes::Bytes>(capacity);
        if prefill {
            sender
                .try_send(bytes::Bytes::from_static(b": fixture backpressure\n\n"))
                .unwrap();
        }
        let collector = tokio::spawn(async move {
            tokio::time::sleep(collector_delay).await;
            let mut stream = String::new();
            while let Some(bytes) = receiver.recv().await {
                stream.push_str(&String::from_utf8_lossy(&bytes));
            }
            stream
        });
        let mut headers = HeaderMap::new();
        headers.insert("x-user-id", "synthetic-user".parse().unwrap());
        let handle = Arc::new(RunHandle {
            telemetry: tokio::sync::Mutex::new(None),
            user: "synthetic-user".into(),
            conversation: "synthetic-conversation".into(),
            autonomy: false,
            sender: commands,
            commands: tokio::sync::Mutex::new(HashMap::new()),
            finished: std::sync::atomic::AtomicBool::new(false),
            cancellation: tokio::sync::watch::channel(false).0,
            metrics: crate::control::Metrics::default(),
        });
        let steering = steer.map(|(after, instruction)| {
            let handle = handle.clone();
            let model = model.clone();
            tokio::spawn(async move {
                while if after == 0 {
                    model.tool_calls.lock().unwrap().is_empty()
                } else {
                    model.requests.lock().unwrap().len() < after
                } {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                let steering = crate::control::Command::Steer {
                    command_id: uuid::Uuid::new_v4(),
                    instruction: instruction.into(),
                };
                assert_eq!(handle.submit("synthetic-user", steering).await, Ok(true));
            })
        });
        let agent = Agent {
            http,
            tools_url: base,
            headers,
            events: Events {
                run_id: if protected {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    "synthetic-run".into()
                },
                sender,
            },
            inbox,
            handle,
            pending: Vec::new(),
            revision: 0,
            preparation: Some(preparation),
        };
        let mut body = json!({"messages":[{"role":"user","content":query}],"stream":true});
        crate::config::merge(&mut body, request_fields);
        let result = tokio::time::timeout(Duration::from_secs(20), agent.run(body))
            .await
            .expect("agent run must finish within the test deadline");
        if let Some(mut steering) = steering {
            let result = tokio::time::timeout(Duration::from_secs(1), &mut steering).await;
            steering.abort();
            result
                .expect("the scripted steering request must be reached")
                .expect("the steering task's assertions must pass");
        }
        let stream = collector.await.unwrap();
        if let Some(policy_redis) = policy_redis {
            policy_redis.abort();
        }
        peer.abort();
        let requests = model.requests.lock().unwrap().clone();
        let tool_calls = model.tool_calls.lock().unwrap().clone();
        Outcome {
            requests,
            tool_calls,
            stream,
            result,
        }
    }

    fn clocks() -> Value {
        json!({"clock":{"_type":"current_datetime"},"calendar_clock":{"_type":"current_datetime"}})
    }

    fn tool_names(request: &Value) -> Vec<&str> {
        request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect()
    }

    fn protected_clock_workflow(tools: &[&str]) -> Value {
        json!({"tools":tools,"daily_summary_tools":tools,"max_iterations":8,
            "context_isolation":{"enabled":true}})
    }

    fn rendering_functions() -> Value {
        let mut functions = clocks();
        functions["briefing_renderer_tool"] = json!({"_type":"briefing_renderer"});
        functions["llm_sandbox_tool"] = json!({"_type":"llm_sandbox"});
        functions
    }

    fn protected_rendering_workflow() -> Value {
        let mut workflow = protected_clock_workflow(&["clock", "briefing_renderer_tool"]);
        workflow["daily_summary_final_tools"] = json!(["briefing_renderer_tool"]);
        workflow
    }

    fn publication_workers(lifetime: Duration) -> Arc<crate::public_worker::Workers> {
        let config = crate::config::Config::new(json!({
            "llms":{"main":{"base_url":"http://127.0.0.1:1/v1", "model_name":"fixture"}},
            "workflow":{"_type":"daedalus_rust_agent","llm_name":"main",
                "context_isolation":{"enabled":true,"policy_version":"publication-tests-v1",
                    "coordinator":"local", "worker_profiles":{},
                    "trusted_local_services":{"redis":"redis://127.0.0.1:1/0"},
                    "destinations":{"local":{"llm":"main","trust":"trusted_local","transport":"direct"}}}}
        }), [("REDIS_URL".into(),"redis://127.0.0.1:1/0".into())].into()).unwrap();
        let routes = crate::routing::IsolationConfig::from_config(&config)
            .unwrap()
            .unwrap();
        crate::public_worker::Workers::new(
            "synthetic",
            "publication",
            routes,
            8,
            lifetime.as_secs_f64(),
            0.,
            false,
        )
    }

    #[tokio::test]
    async fn protected_staged_publication_rechecks_expiry_after_encoding_every_frame_kind() {
        for kind in [
            "final_text",
            "terminal_html",
            "tool_complete",
            "finish",
            "approval",
        ] {
            let workers = publication_workers(Duration::from_millis(20));
            let (sender, mut receiver) = mpsc::channel(4);
            let events = Events {
                run_id: "publication".into(),
                sender,
            };
            let result = publish_workflow_frames(Some(&workers), &events, 2, |staged| async move {
                match kind {
                    "final_text" => {
                        ResponseText::default()
                            .delta(&staged, "FINAL_TEXT_MARKER")
                            .await?
                    }
                    "terminal_html" => {
                        ResponseText::default()
                            .delta(&staged, DEADLINE_RENDERER_HTML)
                            .await?
                    }
                    "tool_complete" => {
                        staged
                            .tool(
                                "render",
                                "briefing_renderer_tool",
                                true,
                                Value::String(DEADLINE_RENDERER_HTML.into()),
                            )
                            .await?
                    }
                    "finish" => staged.finish("stop").await?,
                    "approval" => {
                        staged
                            .event("mcp_approval_required", json!({"marker":"synthetic"}))
                            .await?
                    }
                    _ => unreachable!(),
                }
                // Model synchronous encoding that crosses expiry in one poll.
                // A timer outside this future cannot preempt that operation.
                std::thread::sleep(Duration::from_millis(35));
                Ok(())
            })
            .await;
            assert_eq!(
                result.unwrap_err().root_cause().to_string(),
                "shared workflow deadline has expired",
                "{kind}"
            );
            assert!(receiver.try_recv().is_err(), "late {kind} was published");
        }
    }

    #[tokio::test]
    async fn protected_staged_publication_preserves_text_blocks_tools_and_finish_bytes() {
        let mut legacy_frames = None;
        for protected in [false, true] {
            let workers = protected.then(|| publication_workers(Duration::from_secs(5)));
            let (sender, mut receiver) = mpsc::channel(8);
            let events = Events {
                run_id: "publication".into(),
                sender,
            };
            let mut text = ResponseText::default();
            workflow_text_delta(workers.as_deref(), &mut text, &events, "First.")
                .await
                .unwrap();
            text.begin_block();
            workflow_text_delta(workers.as_deref(), &mut text, &events, "Second.")
                .await
                .unwrap();
            workflow_tool_event(
                workers.as_deref(),
                &events,
                "render",
                "briefing_renderer_tool",
                true,
                Value::String("result".into()),
            )
            .await
            .unwrap();
            workflow_finish(workers.as_deref(), &events, "stop")
                .await
                .unwrap();
            drop(events);
            let mut frames = Vec::new();
            while let Some(frame) = receiver.recv().await {
                frames.push(frame);
            }
            assert_eq!(frames.len(), 6);
            if protected {
                assert_eq!(legacy_frames.as_ref().unwrap(), &frames);
            } else {
                legacy_frames = Some(frames.clone());
            }
            let frames: Vec<_> = frames
                .iter()
                .map(|frame| String::from_utf8_lossy(frame))
                .collect();
            assert!(frames[0].contains("First."));
            assert!(frames[1].contains(r#""content":"\n\n""#));
            assert!(frames[2].contains("Second."));
            assert!(frames[3].contains("Function Complete: briefing_renderer_tool"));
            assert!(frames[4].contains(r#""finish_reason":"stop","daedalus_terminal":true"#));
            assert_eq!(frames[5], "data: [DONE]\n\n");
        }
    }

    #[tokio::test]
    async fn legacy_daily_renderer_keeps_automatic_tool_choice() {
        let outcome = run(
            rendering_functions(),
            json!({"tools":["clock","briefing_renderer_tool"]}),
            "Produce my daily summary.",
            vec![
                completed(vec![call(
                    "render",
                    "briefing_renderer_tool",
                    r#"{"edition":{}}"#,
                )]),
                completed(vec![text("The renderer result is available.")]),
            ],
        )
        .await;
        outcome.result.unwrap();
        assert_eq!(outcome.requests[0]["tool_choice"], "auto");
        assert_eq!(outcome.requests[1]["tool_choice"], "auto");
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_decoding_requires_tools_until_an_executed_renderer() {
        let outcome = run(
            rendering_functions(),
            protected_rendering_workflow(),
            "Produce my daily summary.",
            vec![
                completed(vec![call("time", "clock", "{}")]),
                completed(vec![call(
                    "render",
                    "briefing_renderer_tool",
                    r#"{"edition":{}}"#,
                )]),
                completed(vec![text("Supported findings remain available as text.")]),
            ],
        )
        .await;
        outcome.result.unwrap();
        assert_eq!(outcome.requests[0]["tool_choice"], "required");
        assert_eq!(outcome.requests[1]["tool_choice"], "required");
        assert_eq!(outcome.requests[2]["tool_choice"], "auto");
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_decoding_renderer_transport_failure_allows_text_recovery() {
        let outcome = run(
            rendering_functions(),
            protected_rendering_workflow(),
            "Produce my daily summary.",
            vec![
                completed(vec![call(
                    "render",
                    "briefing_renderer_tool",
                    r#"{"edition":{"fixture_transport_failure":true}}"#,
                )]),
                completed(vec![text(
                    "Rendering was unavailable; these are the supported findings.",
                )]),
            ],
        )
        .await;
        outcome.result.unwrap();
        assert_eq!(outcome.requests[0]["tool_choice"], "required");
        assert_eq!(outcome.requests[1]["tool_choice"], "auto");
        assert!(
            outcome.requests[1]["input"]
                .to_string()
                .contains("Tool failed (http_status)")
        );
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_decoding_rejected_private_photo_does_not_count_as_rendering() {
        let outcome = run(rendering_functions(), protected_rendering_workflow(),
            "Produce my daily summary.", vec![
                completed(vec![call("private_photo", "briefing_renderer_tool", r#"{"edition":{"lead":{"figure":{"url":"https://private-marker.example.invalid/photo.jpg","caption":"Private"}}}}"#)]),
                completed(vec![call("safe_render", "briefing_renderer_tool", r#"{"edition":{}}"#)]),
                completed(vec![text("Supported findings remain available as text.")]),
            ]).await;
        outcome.result.unwrap();
        assert_eq!(outcome.requests[0]["tool_choice"], "required");
        let input = outcome.requests[1]["input"].as_array().unwrap();
        let proposed = input
            .iter()
            .position(|item| item["type"] == "function_call" && item["call_id"] == "private_photo")
            .unwrap();
        assert_eq!(input[proposed]["name"], "briefing_renderer_tool");
        let answer = &input[proposed + 1];
        assert_eq!(answer["type"], "function_call_output");
        assert_eq!(answer["call_id"], "private_photo");
        let wrapper: Value = serde_json::from_str(answer["output"].as_str().unwrap()).unwrap();
        let denial: Value = serde_json::from_str(wrapper["content"].as_str().unwrap()).unwrap();
        assert_eq!(denial["error"], "context_policy_rejected");
        assert_eq!(denial["executed"], false);
        assert_eq!(denial["hint"], crate::public_worker::PHOTO_REJECTION_HINT);
        assert!(
            !answer["output"]
                .as_str()
                .unwrap()
                .contains("private-marker")
        );
        assert!(!answer["output"].as_str().unwrap().contains("Private"));
        assert_eq!(
            outcome.tool_calls.len(),
            1,
            "the bad photo must never reach the executor"
        );
        assert_eq!(outcome.tool_calls[0]["name"], "briefing_renderer_tool");
        assert_eq!(outcome.tool_calls[0]["arguments"], json!({"edition":{}}));
        assert_eq!(outcome.requests[1]["tool_choice"], "required");
        assert_eq!(outcome.requests[2]["tool_choice"], "auto");
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_decoding_invalid_renderer_corrections_keep_text_fallback_none() {
        let outcome = run(
            rendering_functions(),
            protected_rendering_workflow(),
            "Produce my daily summary.",
            vec![
                completed(vec![call(
                    "invalid_render_1",
                    "briefing_renderer_tool",
                    "{}",
                )]),
                completed(vec![call(
                    "invalid_render_2",
                    "briefing_renderer_tool",
                    "{}",
                )]),
                completed(vec![text(
                    "The edition could not be validated; supported findings remain available.",
                )]),
            ],
        )
        .await;
        outcome.result.unwrap();
        assert_eq!(outcome.requests[0]["tool_choice"], "required");
        assert_eq!(outcome.requests[1]["tool_choice"], "required");
        assert_eq!(outcome.requests[2]["tool_choice"], "none");
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_lifecycle_invalid_renderer_fallback_stays_closed_after_interrupted_resume() {
        let workflow_id = uuid::Uuid::new_v4().to_string();
        let request = json!({"additional_props":{"context_workflow_id":workflow_id}});
        let first = run_scripted_with_body(
            rendering_functions(),
            protected_rendering_workflow(),
            "Produce my daily summary.",
            vec![
                completed(vec![call("invalid_1", "briefing_renderer_tool", "{}")]),
                completed(vec![call("invalid_2", "briefing_renderer_tool", "{}")]),
                paced(
                    &["A supported finding that was not yet delivered."],
                    0,
                    true,
                ),
            ],
            json!({"request_timeout":1}),
            None,
            request.clone(),
        )
        .await;
        assert_eq!(
            first.result.unwrap_err().root_cause().to_string(),
            "Model request timed out"
        );
        assert_eq!(first.requests.len(), 3);
        assert_eq!(first.requests[2]["tool_choice"], "none");
        assert!(!first.stream.contains("A supported finding"));
        assert!(!first.stream.contains("\"finish_reason\":\"stop\""));

        // A new Agent instance restores the same unfinished workflow from
        // actual Redis. It may synthesize, but must never reopen research.
        let resumed = run_scripted_with_body(
            rendering_functions(),
            protected_rendering_workflow(),
            "Produce my daily summary.",
            vec![
                completed(vec![call(
                    "render",
                    "briefing_renderer_tool",
                    r#"{"edition":{"fixture_transport_failure":true}}"#,
                )]),
                completed(vec![text(
                    "Rendering is unavailable; the supported finding remains source limited.",
                )]),
            ],
            json!({}),
            None,
            request,
        )
        .await;
        resumed.result.unwrap();
        assert_eq!(tool_names(&resumed.requests[0]), ["briefing_renderer_tool"]);
        assert!(!tool_names(&resumed.requests[0]).contains(&"clock"));
        assert!(!tool_names(&resumed.requests[0]).contains(&"public_briefing_worker"));
        assert_eq!(resumed.tool_calls.len(), 1);
        assert!(
            resumed
                .stream
                .contains("supported finding remains source limited")
        );
        assert!(resumed.stream.contains("\"finish_reason\":\"stop\""));
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_lifecycle_model_retry_keeps_subsecond_deadline_and_withholds_late_chat() {
        let mut workflow = protected_clock_workflow(&["clock"]);
        workflow["daily_summary_research_budget_seconds"] = json!(1);
        workflow["daily_summary_synthesis_retry_timeout_seconds"] = json!(1);
        let mut interrupted = paced(&["On-time partial answer."], 1100, false).unwrap();
        interrupted.truncate(4); // EOF immediately after the visible delta.
        let started = Instant::now();
        let outcome = run_scripted(
            clocks(),
            workflow,
            "Summarize the plan.",
            vec![Some(interrupted), paced(&["LATE_CHAT_MARKER"], 700, false)],
            json!({"request_timeout":3,"max_retries":1}),
            None,
        )
        .await;
        assert_eq!(
            outcome.result.unwrap_err().root_cause().to_string(),
            "shared workflow deadline has expired"
        );
        assert_eq!(outcome.requests.len(), 2);
        assert!(outcome.stream.contains("On-time partial answer."));
        assert!(!outcome.stream.contains("LATE_CHAT_MARKER"));
        assert!(!outcome.stream.contains("\"finish_reason\":\"stop\""));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_lifecycle_model_deadline_cancels_backpressured_chat_without_late_delta() {
        let mut workflow = protected_clock_workflow(&["clock"]);
        workflow["daily_summary_research_budget_seconds"] = json!(1);
        workflow["daily_summary_synthesis_retry_timeout_seconds"] = json!(1);
        let outcome = run_raw_scripted_with_output(
            clocks(),
            workflow,
            "Summarize the plan.",
            vec![paced(
                &["Accepted before deadline.", "BACKPRESSURED_LATE_MARKER"],
                0,
                false,
            )],
            json!({"request_timeout":5}),
            None,
            json!({}),
            Some((1, Duration::from_secs(3), false)),
        )
        .await;
        assert_eq!(
            outcome.result.unwrap_err().root_cause().to_string(),
            "shared workflow deadline has expired"
        );
        assert_eq!(outcome.requests.len(), 1);
        assert!(outcome.stream.contains("Accepted before deadline."));
        assert!(!outcome.stream.contains("BACKPRESSURED_LATE_MARKER"));
        assert!(!outcome.stream.contains("\"finish_reason\":\"stop\""));
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_final_only_text_and_finish_obey_output_backpressure_deadline() {
        for prefill in [false, true] {
            let mut workflow = protected_clock_workflow(&["clock"]);
            workflow["daily_summary_research_budget_seconds"] = json!(1);
            workflow["daily_summary_synthesis_retry_timeout_seconds"] = json!(1);
            let outcome = run_raw_scripted_with_output(
                clocks(),
                workflow,
                "Summarize the plan.",
                vec![completed(vec![text("FINAL_ONLY_TEXT_MARKER")])],
                json!({}),
                None,
                json!({"response_mode":"final_only"}),
                Some((1, Duration::from_secs(3), prefill)),
            )
            .await;
            assert_eq!(
                outcome.result.unwrap_err().root_cause().to_string(),
                "shared workflow deadline has expired"
            );
            assert_eq!(outcome.requests.len(), 1);
            assert_eq!(outcome.stream.contains("FINAL_ONLY_TEXT_MARKER"), !prefill);
            assert!(!outcome.stream.contains("\"finish_reason\":\"stop\""));
            assert!(!outcome.stream.contains("[DONE]"));
        }
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_terminal_html_and_tool_completion_obey_output_backpressure_deadline() {
        // One slot blocks the tool stream after Start. Three accept Start,
        // its heartbeat and Function Complete, but block final HTML content.
        for capacity in [1, 3] {
            let mut workflow = protected_rendering_workflow();
            workflow["daily_summary_research_budget_seconds"] = json!(1);
            workflow["daily_summary_synthesis_retry_timeout_seconds"] = json!(1);
            let outcome = run_raw_scripted_with_output(
                rendering_functions(),
                workflow,
                "Render the supplied edition.",
                vec![completed(vec![call(
                    "render",
                    "briefing_renderer_tool",
                    r#"{"edition":{"fixture_delay_ms":50}}"#,
                )])],
                json!({}),
                None,
                json!({}),
                Some((capacity, Duration::from_secs(3), false)),
            )
            .await;
            assert_eq!(
                outcome.result.unwrap_err().root_cause().to_string(),
                "shared workflow deadline has expired"
            );
            assert_eq!(outcome.requests.len(), 1);
            assert_eq!(outcome.tool_calls.len(), 1);
            assert!(
                outcome
                    .stream
                    .contains("Function Start: briefing_renderer_tool")
            );
            assert_eq!(
                outcome
                    .stream
                    .contains("Function Complete: briefing_renderer_tool"),
                capacity == 3
            );
            assert!(!outcome.stream.contains("chat.completion.chunk"));
            assert!(!outcome.stream.contains("[DONE]"));
        }
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_decoding_preserves_explicit_choices_and_generic_requests() {
        for choice in [
            json!("required"),
            json!({"type":"function","function":{"name":"clock"}}),
        ] {
            let outcome = run_scripted_with_body(
                rendering_functions(),
                protected_rendering_workflow(),
                "Produce my daily summary.",
                vec![
                    completed(vec![call("time", "clock", "{}")]),
                    completed(vec![call(
                        "render",
                        "briefing_renderer_tool",
                        r#"{"edition":{}}"#,
                    )]),
                    completed(vec![text("Done.")]),
                ],
                json!({}),
                None,
                json!({"tool_choice":choice.clone()}),
            )
            .await;
            outcome.result.unwrap();
            if choice.is_string() {
                assert_eq!(outcome.requests[0]["tool_choice"], "required");
            } else {
                assert_eq!(outcome.requests[0]["tool_choice"]["name"], "clock");
            }
        }
        let outcome = run_scripted_with_body(
            rendering_functions(),
            protected_rendering_workflow(),
            "Produce my daily summary.",
            vec![completed(vec![text("A source-limited text response.")])],
            json!({}),
            None,
            json!({"tool_choice":"none"}),
        )
        .await;
        outcome.result.unwrap();
        assert_eq!(outcome.requests[0]["tool_choice"], "none");
        let outcome = run(
            rendering_functions(),
            protected_rendering_workflow(),
            "What is the current time?",
            vec![
                completed(vec![call("time", "clock", "{}")]),
                completed(vec![text("The time is available.")]),
            ],
        )
        .await;
        outcome.result.unwrap();
        assert_eq!(outcome.requests[0]["tool_choice"], "auto");
        assert_eq!(outcome.requests[1]["tool_choice"], "auto");
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_decoding_steering_before_renderer_restores_automatic_choice() {
        let instruction = "Stop the briefing. Return plain text without calling tools.";
        let outcome = run_scripted(
            rendering_functions(),
            protected_rendering_workflow(),
            "Produce my daily summary.",
            vec![
                None,
                completed(vec![text(
                    "This plain text response follows the new instruction.",
                )]),
            ],
            json!({}),
            Some((1, instruction)),
        )
        .await;
        outcome.result.unwrap();
        assert_eq!(outcome.requests.len(), 2);
        assert_eq!(outcome.requests[0]["tool_choice"], "required");
        assert_eq!(outcome.requests[1]["tool_choice"], "auto");
        assert!(
            outcome.requests[1]["input"]
                .to_string()
                .contains(instruction)
        );
        assert!(
            outcome
                .stream
                .contains("This plain text response follows the new instruction.")
        );
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_deadline_cancels_heartbeat_renderer_without_late_html_or_retry() {
        let mut workflow = protected_rendering_workflow();
        workflow["daily_summary_research_budget_seconds"] = json!(1);
        workflow["daily_summary_synthesis_retry_timeout_seconds"] = json!(1);
        let started = Instant::now();
        let outcome = run_scripted(
            rendering_functions(),
            workflow,
            "Produce my daily summary.",
            vec![completed(vec![call(
                "slow_renderer",
                "briefing_renderer_tool",
                r#"{"edition":{"fixture_delay_ms":5000}}"#,
            )])],
            json!({}),
            Some((0, "Keep waiting for the renderer outcome.")),
        )
        .await;
        let error = outcome.result.unwrap_err();
        assert_eq!(
            error.root_cause().to_string(),
            "shared workflow deadline has expired"
        );
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "heartbeats or steering extended the two-second total budget"
        );
        assert_eq!(
            outcome.requests.len(),
            1,
            "deadline expiry must not request a model retry"
        );
        assert!(outcome.stream.contains("tool active"));
        assert!(outcome.stream.contains("steering"));
        assert!(!outcome.stream.contains("DEADLINE_RENDERER_MARKER"));
        assert!(!outcome.stream.contains("\"finish_reason\":\"stop\""));
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_deadline_allows_renderer_within_remaining_total_budget() {
        let mut workflow = protected_rendering_workflow();
        workflow["daily_summary_research_budget_seconds"] = json!(1);
        workflow["daily_summary_synthesis_retry_timeout_seconds"] = json!(1);
        let outcome = run(
            rendering_functions(),
            workflow,
            "Produce my daily summary.",
            vec![completed(vec![call(
                "timely_renderer",
                "briefing_renderer_tool",
                r#"{"edition":{"fixture_delay_ms":1200}}"#,
            )])],
        )
        .await;
        outcome.result.unwrap();
        assert_eq!(outcome.requests.len(), 1);
        assert!(outcome.stream.contains("DEADLINE_RENDERER_MARKER"));
        assert!(outcome.stream.contains("\"finish_reason\":\"stop\""));
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_renderer_alias_permanently_closes_research() {
        let mut functions = rendering_functions();
        let renderer = functions
            .as_object_mut()
            .unwrap()
            .shift_remove("briefing_renderer_tool")
            .unwrap();
        functions["edition_renderer"] = renderer;
        let mut workflow = protected_clock_workflow(&["clock", "edition_renderer"]);
        workflow["daily_summary_final_tools"] = json!(["edition_renderer"]);
        let outcome = run(
            functions,
            workflow,
            "Produce my daily summary.",
            vec![
                completed(vec![call(
                    "aliased_renderer",
                    "edition_renderer",
                    r#"{"edition":{}}"#,
                )]),
                completed(vec![text("Supported text after the renderer attempt.")]),
            ],
        )
        .await;
        outcome.result.unwrap();
        assert_eq!(outcome.requests[0]["tool_choice"], "required");
        assert_eq!(outcome.requests[1]["tool_choice"], "auto");
        assert_eq!(
            tool_names(&outcome.requests[1]),
            ["edition_renderer"],
            "renderer aliases must close research like the canonical name"
        );
    }

    struct DailySkill(std::path::PathBuf);
    impl DailySkill {
        fn new(valid_clock: bool) -> Self {
            let root =
                std::env::temp_dir().join(format!("daedalus-clock-skill-{}", uuid::Uuid::new_v4()));
            let skill = root.join("daily-summary");
            std::fs::create_dir_all(skill.join("references")).unwrap();
            std::fs::write(skill.join("SKILL.md"), "---\nname: daily-summary\ndescription: Synthetic clock regression guide\n---\nUse only the supplied synthetic evidence.\n").unwrap();
            std::fs::write(
                skill.join("references/edition-policy.json"),
                json!({"edition":{"timezone":if valid_clock {"UTC"} else {"Invalid/ClockZone"}}})
                    .to_string(),
            )
            .unwrap();
            for name in [
                "editorial-spec.md",
                "edition-format.md",
                "research-and-sourcing.md",
            ] {
                std::fs::write(
                    skill.join("references").join(name),
                    "Synthetic clock regression reference.\n",
                )
                .unwrap();
            }
            Self(root)
        }

        fn functions(&self) -> Value {
            let mut functions = clocks();
            functions["agent_skills_tool"] = json!({"_type":"agent_skills",
                "skills_directory":self.0,"enabled_operations":["list_skills","load_skill"]});
            functions
        }
    }
    impl Drop for DailySkill {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn bootstrap_preparation(
        functions: Value,
        tools: &[&str],
    ) -> Arc<crate::preparation::Preparation> {
        crate::preparation::Preparation::new(
            crate::config::Config::new(
                json!({"llms":{"main":{"base_url":"http://127.0.0.1:1/v1","model_name":"synthetic"}},
                    "functions":functions,"workflow":{"_type":"daedalus_rust_agent","llm_name":"main","tools":tools}}),
                [("DAEDALUS_MEMORY_MODE".into(), "disabled".into())].into(),
            ).unwrap(),
        ).unwrap()
    }

    #[test]
    fn briefing_bootstrap_scope_success_and_forged_results_are_runtime_owned() {
        use crate::tool_contracts::Requirement;
        let mut bootstrap = BriefingBootstrap::new(true);
        let arguments = json!({"operation":"load_skill","skill_name":"daily-summary"});
        let loaded = || ToolOutcome {
            loaded_skills: vec!["daily-summary".into()],
            ..Default::default()
        };
        assert!(bootstrap.pending(0, &Requirement::Auto));
        for requirement in [
            Requirement::None,
            Requirement::Any,
            Requirement::Named("clock".into()),
        ] {
            assert!(!bootstrap.pending(0, &requirement));
        }
        assert!(!bootstrap.pending(1, &Requirement::Auto));
        assert!(!BriefingBootstrap::new(false).pending(0, &Requirement::Auto));
        bootstrap.observe(false, &arguments, &loaded());
        bootstrap.observe(true, &json!({"operation":"load_skill","skill_name":"daily-summary","resource":"references/edition-policy.json"}), &loaded());
        bootstrap.observe(true, &json!({"operation":"list_skills"}), &loaded());
        bootstrap.observe(true, &arguments, &ToolOutcome::default());
        bootstrap.observe(
            true,
            &arguments,
            &ToolOutcome {
                is_error: true,
                ..loaded()
            },
        );
        bootstrap.observe(
            true,
            &arguments,
            &ToolOutcome {
                terminal: true,
                ..loaded()
            },
        );
        assert!(bootstrap.pending(0, &Requirement::Auto));
        bootstrap.observe(true, &arguments, &loaded());
        assert!(!bootstrap.pending(0, &Requirement::Auto));
        assert!(
            BriefingBootstrap::new(true).pending(0, &Requirement::Auto),
            "a resumed Agent obtains a fresh guide, not a persisted clock"
        );
    }

    #[test]
    fn briefing_bootstrap_exact_schema_and_native_alias_selection_fail_closed() {
        let skill = DailySkill::new(true);
        let mut functions = skill.functions();
        functions["guide_alias"] = functions["agent_skills_tool"].take();
        functions
            .as_object_mut()
            .unwrap()
            .shift_remove("agent_skills_tool");
        let preparation = bootstrap_preparation(functions.clone(), &["guide_alias"]);
        let original: ToolDefinition = serde_json::from_value(
            preparation.skill_tools["guide_alias"]
                .schema("guide_alias")
                .unwrap(),
        )
        .unwrap();
        let exact =
            BriefingBootstrap::definition(&preparation, std::slice::from_ref(&original)).unwrap();
        assert_eq!(exact.name, "guide_alias");
        let validator = crate::tool_contracts::validator(&exact.parameters).unwrap();
        let good = json!({"operation":"load_skill","skill_name":"daily-summary"});
        assert!(validator.is_valid(&good));
        assert!(BriefingBootstrap::permits(&exact, "guide_alias", &good));
        for invalid in [
            json!({"operation":"list_skills","skill_name":"daily-summary"}),
            json!({"operation":"load_skill","skill_name":"other"}),
            json!({"operation":"load_skill","skill_name":"daily-summary","resource":null}),
            json!({"operation":"load_skill","skill_name":"daily-summary","resource":""}),
            json!({"operation":"load_skill","skill_name":"daily-summary","resource":"references/edition-policy.json"}),
        ] {
            assert!(!validator.is_valid(&invalid));
            assert!(!BriefingBootstrap::permits(&exact, "guide_alias", &invalid));
        }
        assert!(!BriefingBootstrap::permits(&exact, "other", &good));
        assert!(BriefingBootstrap::definition(&preparation, &[]).is_err());
        functions["guide_alias"]["enabled_operations"] = json!(["list_skills"]);
        let disabled = bootstrap_preparation(functions.clone(), &["guide_alias"]);
        assert!(BriefingBootstrap::definition(&disabled, std::slice::from_ref(&original)).is_err());
        functions["guide_alias"]["enabled_operations"] = json!(["load_skill"]);
        functions["another_guide"] = functions["guide_alias"].clone();
        let ambiguous = bootstrap_preparation(functions, &["guide_alias", "another_guide"]);
        let mut another = original.clone();
        another.name = "another_guide".into();
        assert!(BriefingBootstrap::definition(&ambiguous, &[original, another]).is_err());
    }

    fn output_for<'a>(request: &'a Value, id: &str) -> &'a str {
        request["input"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["type"] == "function_call_output" && item["call_id"] == id)
            .unwrap()["output"]
            .as_str()
            .unwrap()
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_bootstrap_rejects_partial_paths_and_same_batch_siblings() {
        let skill = DailySkill::new(true);
        // Exceed the ordinary compaction threshold with unique guide text. A
        // full native bundle must reach the actual next model request intact.
        let guide = (0..250)
            .map(|i| format!("Synthetic guide rule {i}: preserve its exact distinct evidence.\n"))
            .collect::<String>();
        std::fs::write(
            skill.0.join("daily-summary/SKILL.md"),
            format!("---\nname: daily-summary\ndescription: Synthetic full guide\n---\n{guide}"),
        )
        .unwrap();
        let mut functions = rendering_functions();
        functions["guide_alias"] = skill.functions()["agent_skills_tool"].clone();
        let siblings = |prefix: &str| {
            vec![
                call(&format!("{prefix}_time"), "clock", "{}"),
                call(
                    &format!("{prefix}_private"),
                    "gmail_mcp_server__search_threads",
                    r#"{"query":"private"}"#,
                ),
                call(
                    &format!("{prefix}_public"),
                    crate::public_worker::NAME,
                    r#"{"desk":"technology","phase":"public_retrieval"}"#,
                ),
                call(
                    &format!("{prefix}_render"),
                    "briefing_renderer_tool",
                    r#"{"edition":{}}"#,
                ),
            ]
        };
        let mut partial = vec![
            call(
                "partial",
                "guide_alias",
                r#"{"operation":"load_skill","skill_name":"daily-summary","resource":"references/edition-format.md"}"#,
            ),
            call(
                "invented",
                "guide_alias",
                r#"{"operation":"load_skill","skill_name":"daily-summary","resource":"invented/missing.md"}"#,
            ),
        ];
        partial.extend(siblings("early"));
        let mut full = vec![call(
            "full",
            "guide_alias",
            r#"{"operation":"load_skill","skill_name":"daily-summary"}"#,
        )];
        full.extend(siblings("same_batch"));
        let outcome = run_raw_scripted_with_body(
            functions,
            protected_clock_workflow(&["guide_alias", "clock", "briefing_renderer_tool"]),
            "Produce my daily summary. Use clock and briefing_renderer_tool.",
            vec![
                completed(partial),
                completed(full),
                completed(vec![call("real_time", "clock", "{}")]),
                completed(vec![call(
                    "real_render",
                    "briefing_renderer_tool",
                    r#"{"edition":{}}"#,
                )]),
                completed(vec![text("Supported final text.")]),
            ],
            json!({}),
            None,
            json!({}),
        )
        .await;
        outcome.result.unwrap();
        assert_eq!(tool_names(&outcome.requests[0]), ["guide_alias"]);
        assert_eq!(tool_names(&outcome.requests[1]), ["guide_alias"]);
        assert_eq!(
            outcome.requests[0]["tools"][0]["parameters"]["required"],
            json!(["operation", "skill_name"])
        );
        assert!(
            outcome.requests[0]["tools"][0]["parameters"]["properties"]
                .get("resource")
                .is_none()
        );
        for id in [
            "partial",
            "invented",
            "early_time",
            "early_private",
            "early_public",
            "early_render",
        ] {
            let rejected: Value =
                serde_json::from_str(output_for(&outcome.requests[1], id)).unwrap();
            assert_eq!(rejected["executed"], false);
        }
        for id in [
            "same_batch_time",
            "same_batch_private",
            "same_batch_public",
            "same_batch_render",
        ] {
            let rejected: Value =
                serde_json::from_str(output_for(&outcome.requests[2], id)).unwrap();
            assert_eq!(rejected["executed"], false);
        }
        let loaded = output_for(&outcome.requests[2], "full");
        assert!(loaded.starts_with(guide.trim()));
        assert!(loaded.contains("daily_summary_runtime_clock"));
        for reference in [
            "edition-policy.json",
            "research-and-sourcing.md",
            "edition-format.md",
            "editorial-spec.md",
        ] {
            assert!(loaded.contains(&format!("## Bundled resource: `references/{reference}`")));
        }
        assert!(tool_names(&outcome.requests[2]).contains(&"clock"));
        assert!(tool_names(&outcome.requests[2]).contains(&crate::public_worker::NAME));
        assert!(tool_names(&outcome.requests[2]).contains(&"briefing_renderer_tool"));
        chrono::DateTime::parse_from_rfc3339(output_for(&outcome.requests[3], "real_time"))
            .unwrap();
        assert!(!tool_names(&outcome.requests[3]).contains(&"clock"));
        assert_eq!(
            outcome.tool_calls.len(),
            1,
            "only the later actual renderer reaches the executor"
        );
        assert!(
            !outcome.requests[2]["input"]
                .to_string()
                .contains("Tools with repeated invalid arguments have been disabled")
        );
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_bootstrap_unavailable_loaders_stop_before_model() {
        let skill = DailySkill::new(true);
        let mut disabled = skill.functions();
        disabled["agent_skills_tool"]["enabled_operations"] = json!(["list_skills"]);
        let mut ambiguous = skill.functions();
        ambiguous["other_guide"] = ambiguous["agent_skills_tool"].clone();
        for (functions, tools) in [
            (clocks(), vec!["clock"]),
            (disabled, vec!["agent_skills_tool", "clock"]),
            (ambiguous, vec!["agent_skills_tool", "other_guide", "clock"]),
        ] {
            let outcome = run_raw_scripted_with_body(
                functions,
                protected_clock_workflow(&tools),
                "Produce my daily summary.",
                vec![],
                json!({}),
                None,
                json!({}),
            )
            .await;
            assert!(
                outcome
                    .result
                    .unwrap_err()
                    .to_string()
                    .contains("requires one available native full-skill loader")
            );
            assert!(outcome.requests.is_empty());
            assert!(outcome.tool_calls.is_empty());
        }
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_bootstrap_failed_or_incomplete_native_bundle_never_opens_sources() {
        for missing_reference in [false, true] {
            let skill = DailySkill::new(missing_reference);
            if missing_reference {
                std::fs::remove_file(
                    skill
                        .0
                        .join("daily-summary/references/research-and-sourcing.md"),
                )
                .unwrap();
            }
            let outcome = run_raw_scripted_with_body(
                skill.functions(),
                protected_clock_workflow(&["agent_skills_tool", "clock"]),
                "Produce my daily summary.",
                vec![
                    completed(vec![call(
                        "failed_guide",
                        "agent_skills_tool",
                        r#"{"operation":"load_skill","skill_name":"daily-summary"}"#,
                    )]),
                    completed(vec![call("hidden_clock", "clock", "{}")]),
                    completed(vec![text(
                        "Pretending the guide succeeded cannot open the next phase.",
                    )]),
                ],
                json!({}),
                None,
                json!({}),
            )
            .await;
            assert!(
                outcome
                    .result
                    .unwrap_err()
                    .to_string()
                    .contains("full skill was not loaded")
            );
            assert_eq!(outcome.requests.len(), 3);
            assert!(
                !output_for(&outcome.requests[1], "failed_guide")
                    .contains("daily_summary_runtime_clock"),
                "a failed or incomplete native bundle must not supply the trusted clock"
            );
            assert_eq!(
                serde_json::from_str::<Value>(output_for(&outcome.requests[2], "hidden_clock"))
                    .unwrap()["executed"],
                false
            );
            for request in &outcome.requests {
                assert_eq!(tool_names(request), ["agent_skills_tool"]);
                assert_eq!(request["tool_choice"], "required");
            }
            assert!(outcome.tool_calls.is_empty());
        }
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_bootstrap_preserves_explicit_choices_and_late_generic_load() {
        for choice in [
            json!("required"),
            json!({"type":"function","function":{"name":"clock"}}),
        ] {
            let skill = DailySkill::new(true);
            let outcome = run_raw_scripted_with_body(
                skill.functions(),
                protected_clock_workflow(&["agent_skills_tool", "clock"]),
                "Produce my daily summary.",
                vec![
                    completed(vec![call("explicit_time", "clock", "{}")]),
                    completed(vec![call(
                        "guide",
                        "agent_skills_tool",
                        r#"{"operation":"load_skill","skill_name":"daily-summary"}"#,
                    )]),
                    completed(vec![text("Done with the actual evidence.")]),
                ],
                json!({}),
                None,
                json!({"tool_choice":choice.clone()}),
            )
            .await;
            outcome.result.unwrap();
            if choice.is_string() {
                assert_eq!(outcome.requests[0]["tool_choice"], "required");
            } else {
                assert_eq!(outcome.requests[0]["tool_choice"]["name"], "clock");
            }
            assert!(tool_names(&outcome.requests[0]).contains(&"clock"));
            assert_eq!(tool_names(&outcome.requests[1]), ["agent_skills_tool"]);
            assert_eq!(outcome.requests[1]["tool_choice"], "required");
            assert!(!tool_names(&outcome.requests[2]).contains(&"clock"));
        }
        let none = run_raw_scripted_with_body(
            clocks(),
            protected_clock_workflow(&["clock"]),
            "Produce my daily summary.",
            vec![completed(vec![text("The requested tool-free response.")])],
            json!({}),
            None,
            json!({"tool_choice":"none"}),
        )
        .await;
        none.result.unwrap();
        assert_eq!(none.requests[0]["tool_choice"], "none");
        let skill = DailySkill::new(true);
        let late = run_raw_scripted_with_body(
            skill.functions(),
            protected_clock_workflow(&["agent_skills_tool", "clock"]),
            "Read the supplied guide and check the time.",
            vec![
                completed(vec![call(
                    "late_guide",
                    "agent_skills_tool",
                    r#"{"operation":"load_skill","skill_name":"daily-summary"}"#,
                )]),
                completed(vec![text("The guide is now available.")]),
            ],
            json!({}),
            None,
            json!({}),
        )
        .await;
        late.result.unwrap();
        assert_eq!(late.requests[0]["tool_choice"], "auto");
        assert!(tool_names(&late.requests[1]).contains(&"clock"));
        assert_eq!(late.requests[1]["tool_choice"], "auto");
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_bootstrap_steering_releases_auto_without_loading_a_guide() {
        let skill = DailySkill::new(true);
        let instruction = "Stop the briefing. Return plain text without calling tools.";
        let outcome = run_raw_scripted_with_body(
            skill.functions(),
            protected_clock_workflow(&["agent_skills_tool", "clock"]),
            "Produce my daily summary.",
            vec![None, completed(vec![text("The briefing has stopped.")])],
            json!({}),
            Some((1, instruction)),
            json!({}),
        )
        .await;
        outcome.result.unwrap();
        assert_eq!(tool_names(&outcome.requests[0]), ["agent_skills_tool"]);
        assert_eq!(outcome.requests[0]["tool_choice"], "required");
        assert_eq!(outcome.requests[1]["tool_choice"], "auto");
        assert!(tool_names(&outcome.requests[1]).contains(&"clock"));
        assert!(
            outcome.requests[1]["input"]
                .to_string()
                .contains(instruction)
        );
        assert!(
            !outcome.requests[1]["input"]
                .to_string()
                .contains("daily_summary_runtime_clock")
        );
    }

    #[test]
    fn briefing_clock_visibility_preserves_scope_and_pending_requirements() {
        use crate::tool_contracts::Requirement;
        let mut clock = BriefingClock::default();
        assert!(clock.allows(true, 0, &Requirement::Auto, "current_datetime"));
        assert!(clock.observe(0, "current_datetime", &ToolOutcome::default()));
        assert!(!clock.allows(true, 0, &Requirement::Auto, "current_datetime"));
        assert!(clock.allows(false, 0, &Requirement::Auto, "current_datetime"));
        assert!(clock.allows(true, 0, &Requirement::Auto, "agent_skills"));
        assert!(clock.allows(
            true,
            0,
            &Requirement::Named("clock".into()),
            "current_datetime"
        ));
        assert!(clock.allows(true, 0, &Requirement::Any, "current_datetime"));
        assert!(
            !clock.observe(0, "current_datetime", &ToolOutcome::default()),
            "one notice per revision"
        );
    }

    #[test]
    fn briefing_clock_requires_successful_explicit_datetime_not_a_skill_clock() {
        use crate::tool_contracts::Requirement;
        let mut clock = BriefingClock::default();
        for outcome in [
            ToolOutcome {
                is_error: true,
                ..Default::default()
            },
            ToolOutcome {
                terminal: true,
                ..Default::default()
            },
        ] {
            assert!(!clock.observe(0, "current_datetime", &outcome));
            assert!(clock.allows(true, 0, &Requirement::Auto, "current_datetime"));
        }
        let skill = ToolOutcome {
            loaded_skills: vec!["daily-summary".into()],
            ..Default::default()
        };
        assert!(!clock.observe(0, "agent_skills", &skill));
        assert!(clock.allows(true, 0, &Requirement::Auto, "current_datetime"));
    }

    #[test]
    fn briefing_clock_steering_and_new_run_allow_fresh_time_without_late_result_reversal() {
        use crate::tool_contracts::Requirement;
        let mut clock = BriefingClock::default();
        assert!(clock.observe(0, "current_datetime", &ToolOutcome::default()));
        assert!(clock.allows(true, 1, &Requirement::Auto, "current_datetime"));
        assert!(!clock.observe(0, "current_datetime", &ToolOutcome::default()));
        assert!(clock.allows(true, 1, &Requirement::Auto, "current_datetime"));
        assert!(clock.observe(1, "current_datetime", &ToolOutcome::default()));
        assert!(!clock.observe(0, "current_datetime", &ToolOutcome::default()));
        assert!(!clock.allows(true, 1, &Requirement::Auto, "current_datetime"));
        assert!(BriefingClock::default().allows(true, 0, &Requirement::Auto, "current_datetime"));
    }

    #[tokio::test]
    async fn legacy_daily_clock_menu_is_unchanged() {
        let outcome = run(
            clocks(),
            json!({"tools":["clock","calendar_clock"]}),
            "Produce my daily summary.",
            vec![
                completed(vec![call("time", "clock", "{}")]),
                completed(vec![text("Done.")]),
            ],
        )
        .await;
        outcome.result.unwrap();
        assert!(tool_names(&outcome.requests[1]).contains(&"clock"));
        assert!(tool_names(&outcome.requests[1]).contains(&"calendar_clock"));
        assert!(
            !outcome.requests[1]["input"]
                .to_string()
                .contains("The clock is established for this edition")
        );
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_clock_hides_aliases_and_notices_after_the_complete_batch() {
        let outcome = run(
            clocks(),
            protected_clock_workflow(&["clock", "calendar_clock"]),
            "Produce my daily summary.",
            vec![
                completed(vec![
                    call("first_time", "clock", "{}"),
                    call("second_time", "calendar_clock", "{}"),
                ]),
                completed(vec![text("Done with the collected evidence.")]),
            ],
        )
        .await;
        outcome.result.unwrap();
        assert_eq!(
            outcome.requests[0]["tool_choice"], "auto",
            "no configured renderer means no forced planning choice"
        );
        assert!(tool_names(&outcome.requests[0]).contains(&"clock"));
        assert!(!tool_names(&outcome.requests[1]).contains(&"clock"));
        assert!(!tool_names(&outcome.requests[1]).contains(&"calendar_clock"));
        let input = outcome.requests[1]["input"].as_array().unwrap();
        let positions: Vec<_> = input
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                item["type"] == "function_call_output" && item["call_id"] != "fixture_full_guide"
            })
            .map(|(index, _)| index)
            .collect();
        assert_eq!(positions.len(), 2);
        for index in &positions {
            chrono::DateTime::parse_from_rfc3339(input[*index]["output"].as_str().unwrap())
                .unwrap();
        }
        let notices: Vec<_> = input
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                item.to_string()
                    .contains("The clock is established for this edition")
            })
            .map(|(index, _)| index)
            .collect();
        assert_eq!(notices.len(), 1);
        assert!(positions.into_iter().all(|position| position < notices[0]));
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_clock_main_skill_preserves_explicit_auto_intent() {
        let skill = DailySkill::new(true);
        let outcome = run(
            skill.functions(),
            protected_clock_workflow(&["agent_skills_tool", "clock", "calendar_clock"]),
            "Produce my daily summary. Load agent_skills_tool and use clock.",
            vec![
                completed(vec![call(
                    "guide",
                    "agent_skills_tool",
                    r#"{"operation":"load_skill","skill_name":"daily-summary"}"#,
                )]),
                completed(vec![call("time", "clock", "{}")]),
                completed(vec![text("Done with the collected evidence.")]),
            ],
        )
        .await;
        outcome.result.unwrap();
        assert!(
            outcome.requests[1]["input"]
                .to_string()
                .contains("daily_summary_runtime_clock")
        );
        assert!(tool_names(&outcome.requests[1]).contains(&"clock"));
        assert!(!tool_names(&outcome.requests[2]).contains(&"clock"));
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_clock_failed_datetime_leaves_time_available() {
        let mut functions = clocks();
        functions["clock"]["timezone"] = json!("Invalid/ClockZone");
        let outcome = run(
            functions,
            protected_clock_workflow(&["clock", "calendar_clock"]),
            "Produce my daily summary.",
            vec![
                completed(vec![call("bad_time", "clock", "{}")]),
                completed(vec![call("good_time", "calendar_clock", "{}")]),
                completed(vec![text("Done with the available time.")]),
            ],
        )
        .await;
        outcome.result.unwrap();
        assert!(tool_names(&outcome.requests[0]).contains(&"clock"));
        assert!(tool_names(&outcome.requests[1]).contains(&"calendar_clock"));
        assert!(
            !outcome.requests[1]["input"]
                .to_string()
                .contains("The clock is established for this edition")
        );
        assert!(!tool_names(&outcome.requests[2]).contains(&"clock"));
        assert!(!tool_names(&outcome.requests[2]).contains(&"calendar_clock"));
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_clock_named_requirement_is_executed_before_hiding() {
        let outcome = run_scripted_with_body(
            clocks(),
            protected_clock_workflow(&["clock", "calendar_clock"]),
            "Produce my daily summary.",
            vec![
                completed(vec![call("required_time", "clock", "{}")]),
                completed(vec![text("Done.")]),
            ],
            json!({}),
            None,
            json!({"tool_choice":{"type":"function","function":{"name":"clock"}}}),
        )
        .await;
        outcome.result.unwrap();
        assert_eq!(tool_names(&outcome.requests[0]), ["clock"]);
        assert_eq!(outcome.requests[0]["tool_choice"]["name"], "clock");
        assert!(!tool_names(&outcome.requests[1]).contains(&"clock"));
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_clock_generic_requests_keep_their_clock_menu() {
        let outcome = run(
            clocks(),
            protected_clock_workflow(&["clock", "calendar_clock"]),
            "Check the time.",
            vec![
                completed(vec![call("time", "clock", "{}")]),
                completed(vec![text("Done.")]),
            ],
        )
        .await;
        outcome.result.unwrap();
        assert!(tool_names(&outcome.requests[1]).contains(&"clock"));
        assert!(
            !outcome.requests[1]["input"]
                .to_string()
                .contains("The clock is established for this edition")
        );
    }

    #[tokio::test]
    #[ignore = "requires disposable Redis at DAEDALUS_TEST_REDIS_URL"]
    async fn protected_briefing_clock_steering_opens_one_fresh_read() {
        let outcome = run_scripted(
            clocks(),
            protected_clock_workflow(&["clock", "calendar_clock"]),
            "Produce my daily summary.",
            vec![
                completed(vec![call("old_time", "clock", "{}")]),
                completed(vec![call("hidden_time_1", "clock", "{}")]),
                completed(vec![call("hidden_time_2", "clock", "{}")]),
                None,
                completed(vec![call("new_time", "clock", "{}")]),
                completed(vec![text("Done with refreshed time.")]),
            ],
            json!({}),
            Some((4, "Refresh the time for this edition.")),
        )
        .await;
        outcome.result.unwrap();
        assert!(!tool_names(&outcome.requests[1]).contains(&"clock"));
        assert!(!tool_names(&outcome.requests[2]).contains(&"clock"));
        assert!(!tool_names(&outcome.requests[3]).contains(&"clock"));
        assert!(tool_names(&outcome.requests[4]).contains(&"clock"));
        assert!(
            !outcome.requests[4]["input"]
                .to_string()
                .contains("Tools with repeated invalid arguments have been disabled")
        );
        assert!(!tool_names(&outcome.requests[5]).contains(&"clock"));
    }

    #[tokio::test]
    async fn mixed_batch_results_directly_follow_their_calls() {
        let outcome = run(
            clocks(),
            json!({"tools":["clock"]}),
            "What time is it?",
            vec![
                completed(vec![
                    call("call_valid", "clock", "{}"),
                    call("call_invalid", "clock", r#"{"extra":1}"#),
                ]),
                completed(vec![text("It is now.")]),
            ],
        )
        .await;
        outcome.result.unwrap();
        assert!(outcome.stream.contains("It is now."));
        assert_eq!(outcome.requests.len(), 2);
        let input = outcome.requests[1]["input"].as_array().unwrap();
        let outputs: Vec<_> = input
            .iter()
            .enumerate()
            .filter(|(_, item)| item["type"] == "function_call_output")
            .collect();
        assert_eq!(outputs.len(), 2);
        let output = |id: &str| {
            outputs
                .iter()
                .find(|(_, item)| item["call_id"] == id)
                .unwrap()
                .1
                .to_string()
        };
        assert!(output("call_invalid").contains("invalid_tool_batch"));
        assert!(!output("call_valid").contains("invalid_tool_batch"));
        let notice = input
            .iter()
            .position(|item| item.to_string().contains("Invalid calls did not run"))
            .expect("correction notice");
        // Chat Completions requires every tool result to answer the preceding
        // assistant calls before any other message.
        assert!(
            outputs.iter().all(|(index, _)| *index < notice),
            "correction notice interleaved with tool results: {input:?}"
        );
    }

    #[tokio::test]
    async fn menu_hidden_proposal_keeps_its_argument_correction() {
        let outcome = run(
            clocks(),
            json!({"tools":["clock","calendar_clock"]}),
            "Use clock now",
            vec![
                // Only `clock` is advertised first; this proposal cannot run.
                completed(vec![call("hidden", "calendar_clock", "{}")]),
                // The full catalogue returns. One argument mistake is correctable.
                completed(vec![call("invalid", "calendar_clock", r#"{"extra":1}"#)]),
                completed(vec![call("corrected", "calendar_clock", "{}")]),
                completed(vec![text("Corrected.")]),
            ],
        )
        .await;
        outcome.result.unwrap();
        assert_eq!(tool_names(&outcome.requests[0]), ["clock"]);
        assert_eq!(
            tool_names(&outcome.requests[1]),
            ["clock", "calendar_clock"]
        );
        assert_eq!(
            tool_names(&outcome.requests[2]),
            ["clock", "calendar_clock"],
            "a menu-hidden proposal must not consume the argument correction"
        );
        let input = outcome.requests[3]["input"].as_array().unwrap();
        let corrected = input
            .iter()
            .find(|item| item["call_id"] == "corrected" && item["type"] == "function_call_output")
            .unwrap();
        assert!(!corrected.to_string().contains("invalid_tool_batch"));
    }

    #[tokio::test]
    async fn one_failed_leaf_call_does_not_abort_its_batch_siblings() {
        let outcome = run(
            json!({"lookup_tool":{"_type":"webscrape"}}),
            json!({"tools":["lookup_tool"],"parallel_tool_calls":true}),
            "Look things up",
            vec![
                completed(vec![
                    call("ok", "lookup_tool", "{\"query\":\"alpha\"}"),
                    call("bad", "lookup_tool", "{\"query\":\"fail\"}"),
                ]),
                completed(vec![text("Done.")]),
            ],
        )
        .await;
        outcome.result.unwrap();
        // The failed call is its own error result; its sibling's result is
        // bound to its call in the next model request.
        let input = outcome.requests[1]["input"].to_string();
        assert!(input.contains("result for alpha"), "{input}");
        assert!(input.contains("Tool failed (http_status)"), "{input}");
        assert!(outcome.stream.contains("\"finish_reason\":\"stop\""));
        assert!(!outcome.stream.contains("event: error"));
    }

    #[tokio::test]
    async fn a_silent_tool_service_stream_fails_the_call_not_the_run() {
        let started = Instant::now();
        let outcome = run(
            json!({"lookup_tool":{"_type":"webscrape"}}),
            json!({"tools":["lookup_tool"]}),
            "Look it up",
            vec![
                completed(vec![call("hang", "lookup_tool", "{\"query\":\"stall\"}")]),
                completed(vec![text("Done without it.")]),
            ],
        )
        .await;
        outcome.result.unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the idle bound did not end the stalled call: {:?}",
            started.elapsed()
        );
        let input = outcome.requests[1]["input"].to_string();
        assert!(input.contains("Tool stream stalled"), "{input}");
    }

    #[tokio::test]
    async fn briefing_fallback_uses_the_configured_synthesis_deadline() {
        let started = Instant::now();
        let outcome = run(
            json!({"briefing_renderer_tool":{"_type":"briefing_renderer"}}),
            json!({"tools":["briefing_renderer_tool"],
                "daily_summary_synthesis_retry_timeout_seconds":1}),
            "Prepare my daily briefing",
            vec![
                completed(vec![call("first", "briefing_renderer_tool", "{}")]),
                completed(vec![call("second", "briefing_renderer_tool", "{}")]),
                // The text-only synthesis attempt never answers.
                None,
            ],
        )
        .await;
        let error = outcome.result.unwrap_err();
        assert_eq!(error.root_cause().to_string(), "Model request timed out");
        assert_eq!(outcome.requests.len(), 3);
        assert_eq!(outcome.requests[2]["tool_choice"], "none");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "fallback ignored its configured deadline: {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn empty_continuation_after_interrupted_answer_completes_the_run() {
        // The first stream delivers the whole answer, then ends before its
        // terminal event. The resumed attempt has nothing left to add.
        let mut interrupted = completed(vec![text("Complete answer.")]).unwrap();
        interrupted.truncate(3);
        let outcome = run_with_retries(
            clocks(),
            json!({"tools":["clock"]}),
            "Summarize the plan.",
            vec![Some(interrupted), completed(vec![])],
            1,
        )
        .await;
        assert_eq!(outcome.requests.len(), 2);
        assert!(
            outcome.requests[1]["input"]
                .to_string()
                .contains("previous model stream was interrupted")
        );
        outcome.result.unwrap();
        assert_eq!(outcome.stream.matches("Complete answer.").count(), 1);
        assert!(outcome.stream.contains("\"finish_reason\":\"stop\""));
        assert!(!outcome.stream.contains("event: error"));
    }

    #[tokio::test]
    async fn model_timeout_resets_while_the_response_keeps_streaming() {
        let parts = [
            "One ", "two ", "three ", "four ", "five ", "six ", "seven ", "eight.",
        ];
        let started = Instant::now();
        let outcome = run_scripted(
            clocks(),
            json!({"tools":["clock"]}),
            "Summarize the plan.",
            vec![paced(&parts, 300, false)],
            json!({"request_timeout":1}),
            None,
        )
        .await;
        outcome.result.unwrap();
        // The healthy response streamed for longer than request_timeout.
        assert!(started.elapsed() >= Duration::from_secs(2));
        assert_eq!(outcome.requests.len(), 1);
        assert!(outcome.stream.contains("eight."));
        assert!(!outcome.stream.contains("event: error"));
    }

    #[tokio::test]
    async fn stalled_model_stream_times_out_and_is_retried() {
        let started = Instant::now();
        let outcome = run_scripted(
            clocks(),
            json!({"tools":["clock"]}),
            "Summarize the plan.",
            vec![
                // Text arrives, then the stream goes silent.
                paced(&["Partial "], 0, true),
                // No response headers or events at all.
                None,
                completed(vec![text("rest.")]),
            ],
            json!({"request_timeout":1, "max_retries":2}),
            None,
        )
        .await;
        let elapsed = started.elapsed();
        outcome.result.unwrap();
        assert_eq!(outcome.requests.len(), 3);
        assert!(
            outcome.requests[1]["input"]
                .to_string()
                .contains("previous model stream was interrupted")
        );
        assert_eq!(outcome.stream.matches("Partial ").count(), 1);
        assert!(outcome.stream.contains("rest."));
        assert!(
            elapsed >= Duration::from_secs(2) && elapsed < Duration::from_secs(10),
            "each silent attempt ends after its inactivity timeout: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn steering_during_a_retry_starts_a_fresh_response() {
        let mut interrupted = completed(vec![text("Partial answer.")]).unwrap();
        interrupted.truncate(3);
        let outcome = run_scripted(
            clocks(),
            json!({"tools":["clock"]}),
            "Summarize the plan.",
            // The retry stalls until steering interrupts it; the steered
            // response is empty.
            vec![Some(interrupted), None, completed(vec![])],
            json!({"max_retries":1}),
            Some((2, "Use the other plan.")),
        )
        .await;
        assert_eq!(outcome.requests.len(), 3);
        assert!(
            outcome.requests[1]["input"]
                .to_string()
                .contains("previous model stream was interrupted")
        );
        let steered = outcome.requests[2]["input"].to_string();
        assert!(steered.contains("Use the other plan."));
        assert!(
            !steered.contains("previous model stream was interrupted"),
            "new direction must not ask to continue the interrupted answer"
        );
        let error = outcome.result.unwrap_err();
        assert_eq!(
            error.root_cause().to_string(),
            "Model completed without an answer"
        );
    }
}
