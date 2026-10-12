//! Application-owned model/tool loop. Steering is processed during every wait.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use futures::{StreamExt, stream::FuturesUnordered};
use http::HeaderMap;
use rig_core::completion::{CompletionRequest, FinishReason, ToolDefinition};
use rig_core::message::Message;
use rig_core::providers::openai::{OpenAIConfig, Route};
use rig_core::streaming::{Item, StreamEvent};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::control::{Command, RunHandle};
use crate::events::Events;
use crate::logging::{Phase, label};

#[derive(Deserialize, Serialize)]
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

pub struct Agent {
    pub http: reqwest::Client,
    pub tools_url: String,
    pub headers: HeaderMap,
    pub events: Events,
    pub inbox: mpsc::Receiver<Command>,
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
    async fn accept(&mut self, command: Command) -> Result<()> {
        match command {
            Command::Steer {
                command_id,
                instruction,
            } => {
                self.revision += 1;
                tracing::info!(event = "steering_received", %command_id, revision = self.revision);
                self.events.event("steering", json!({
                    "command_id":command_id,"status":"received","revision":self.revision,"instruction":instruction
                })).await?;
                self.pending.push((command_id.to_string(), instruction));
            }
            Command::Cancel { command_id } => {
                tracing::info!(event = "cancellation_received", %command_id);
                self.events
                    .event(
                        "steering",
                        json!({"command_id":command_id,"status":"cancelled"}),
                    )
                    .await?;
                bail!("Run cancelled by user");
            }
        }
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
        let mut missing_tool_recoveries = 0;
        let preparing = Instant::now();
        tracing::info!(event = "prepare_started");
        let preparation = self.preparation.clone();
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
        tracing::info!(
            event = "prepare_finished",
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
        let provider = OpenAIConfig::new(prepared.model.api_key.clone())
            .with_base_url(&prepared.model.base_url)
            .with_route(route)
            .client();
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
        let mut executor_states: HashMap<String, Value> = HashMap::new();
        let query = prepared
            .messages
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .map(|m| m.content.clone())
            .unwrap_or_default();
        let initial_menu = crate::tool_contracts::initial_menu(&prepared.tools, &query);
        while iterations < prepared.max_iterations {
            self.drain().await?;
            self.apply(&mut history).await?;
            iterations += 1;
            let final_synthesis = prepared.daily_summary
                && started.elapsed().as_secs_f64() >= prepared.research_budget_seconds;
            let tools: Vec<_> = prepared
                .tools
                .iter()
                .filter(|tool| !final_synthesis || prepared.final_tools.contains(&tool.name))
                .filter(|tool| requirement.allows(&tool.name))
                .filter(|tool| {
                    iterations != 1
                        || self.revision != 0
                        || requirement.pending()
                        || initial_menu
                            .as_ref()
                            .is_none_or(|names| names.contains(&tool.name))
                })
                .cloned()
                .collect();
            if requirement.pending() && tools.is_empty() {
                bail!("Required tool did not complete successfully");
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
                .tool_choice(requirement.choice())
                .additional_params(params);
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
            if final_synthesis {
                request.chat_history.push(Message::user("Finish using the evidence already collected. Render the briefing or return the sourced findings and any explicit gaps."));
            }
            let model_call = self
                .handle
                .metrics
                .model_calls
                .fetch_add(1, Ordering::Relaxed)
                + 1;
            let model_started = Instant::now();
            tracing::info!(
                event = "model_call_started",
                model_call,
                iteration = iterations,
                attempt = retry_attempt + 1,
                model = label(&model_name),
                tool_count,
                timeout_seconds = prepared.model.request_timeout,
                final_synthesis
            );
            let model = provider.completion(&model_name);
            let model = rig_core::driver::Model::new(
                crate::provider::CompatibleOpenAi::for_session(
                    model.wire,
                    &self.handle.user,
                    &self.handle.conversation,
                    &self.events.run_id,
                ),
                model.transport,
            );
            let mut stream = model.stream(request).context(Phase("model_request"))?;
            let deadline = tokio::time::sleep(Duration::from_secs_f64(
                prepared.model.request_timeout.max(1.0),
            ));
            tokio::pin!(deadline);
            let mut partial = String::new();
            let mut interrupted = false;
            let mut stream_error = None;
            let mut received_item = false;
            let mut last_activity = Instant::now();
            loop {
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
                            if !received_item {
                                tracing::info!(event = "model_first_event", model_call,
                                    elapsed_ms = model_started.elapsed().as_millis() as u64);
                            }
                            received_item = true;
                            if let Item::Event(StreamEvent::Text { text, .. }) = item {
                                last_activity = Instant::now();
                                partial.push_str(&text);
                                if !requirement.pending() {
                                    self.events.delta(&text).await?;
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
                    _ = &mut deadline => return Err(anyhow::anyhow!("Model request timed out").context(Phase("model_stream"))),
                    _ = self.events.sender.closed() => bail!("Client disconnected"),
                }
            }
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
                if !partial.is_empty() && !requirement.pending() {
                    history.push(Message::assistant(partial));
                }
                continue;
            }
            let completion = match stream_error {
                Some(error) => Err(error),
                None => stream.finish().await,
            };
            let completed = match completion {
                Ok(completed) => completed,
                Err(error)
                    if (crate::provider::retryable(&error)
                        || (crate::provider::stream_decode_error(&error)
                            && decode_recoveries == 0))
                        && retry_attempt < prepared.model.max_retries =>
                {
                    if crate::provider::stream_decode_error(&error) {
                        decode_recoveries += 1;
                        retrying_decode = true;
                    }
                    retry_attempt += 1;
                    iterations -= 1;
                    // Tools only execute after a complete model response. Keep
                    // prior results and visible text, but discard every tool
                    // proposal from this failed attempt, even a finished item.
                    let output_bytes = partial.len();
                    if !partial.is_empty() && !requirement.pending() {
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
                        error_kind = if crate::provider::is_gateway_transport_error(&error) {
                            "upstream_transport"
                        } else {
                            error.kind().code()
                        },
                        http_status = error
                            .provider_response_status()
                            .map(|status| status.as_u16()),
                        elapsed_ms = model_started.elapsed().as_millis() as u64,
                        received_item,
                        output_bytes,
                        resuming = resume_text
                    );
                    tokio::select! {
                        biased;
                        Some(command) = self.inbox.recv() => { self.accept(command).await?; retry_attempt = 0; },
                        _ = tokio::time::sleep(delay) => {},
                        _ = self.events.sender.closed() => bail!("Client disconnected"),
                    }
                    continue;
                }
                Err(error) => {
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
            resume_text = false;
            if completed.usage.is_reported() {
                self.handle
                    .metrics
                    .reported_usage_calls
                    .fetch_add(1, Ordering::Relaxed);
                self.handle
                    .metrics
                    .input_tokens
                    .fetch_add(completed.usage.input_tokens.unwrap_or(0), Ordering::Relaxed);
                self.handle.metrics.output_tokens.fetch_add(
                    completed.usage.output_tokens.unwrap_or(0),
                    Ordering::Relaxed,
                );
            }
            if !matches!(
                completed.finish_reason(),
                Some(FinishReason::Stop | FinishReason::ToolCalls)
            ) {
                return Err(anyhow::anyhow!("Model response did not complete")
                    .context(Phase("model_finish")));
            }
            let calls: Vec<_> = completed.tool_calls().cloned().collect();
            tracing::info!(
                event = "model_call_finished",
                model_call,
                elapsed_ms = model_started.elapsed().as_millis() as u64,
                output_bytes = partial.len(),
                tool_calls = calls.len(),
                usage_reported = completed.usage.is_reported(),
                input_tokens = completed.usage.input_tokens,
                output_tokens = completed.usage.output_tokens
            );
            self.drain().await?;
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
            }
            if calls.is_empty() {
                if !self.pending.is_empty() {
                    continue;
                }
                if !self.handle.finish_if_idle(&self.inbox).await {
                    continue;
                }
                if partial.is_empty() {
                    bail!("Model completed without an answer");
                }
                self.events.finish("stop").await?;
                return Ok(());
            }
            let batch_revision = self.revision;
            let problems = catalog.check_batch(&calls, &tools)?;
            let recovery_exhausted = validation_recovery.exhausted(&calls, &problems);
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
                for (call, problem) in calls.into_iter().zip(problems) {
                    history.push(Message::tool_result(call.id, call.function.name,
                        json!({"status":"error", "executed":false, "error":"invalid_tool_batch",
                            "detail":if problem.is_empty() {"Another call in this batch was invalid. No calls ran."} else {&problem}}).to_string()));
                }
                if recovery_exhausted {
                    bail!("Tool arguments remained invalid after correction");
                }
                history.push(Message::user("No calls in the rejected batch ran. Correct the arguments using the advertised schemas and use fresh call IDs. Read earlier results before making dependent calls."));
                continue;
            }
            let mut queued = VecDeque::from(calls);
            let mut active = FuturesUnordered::new();
            let mut active_groups = HashMap::<String, usize>::new();
            let concurrency = if prepared.parallel_tool_calls { 8 } else { 1 };
            let mut terminal = None;
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
                    if !prepared.tools.iter().any(|tool| tool.name == name)
                        || (final_synthesis && !prepared.final_tools.contains(&name))
                    {
                        tracing::warn!(event = "tool_call_skipped", reason = "unavailable");
                        history.push(Message::tool_result(
                            call.id,
                            call.function.name,
                            "Tool is unavailable for this phase.",
                        ));
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
                    self.events
                        .tool(&id, &name, false, call.function.arguments.clone())
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
                    let context = json!({"version":1,"query":query,"available_tools":prepared.tools.iter().map(|t| &t.name).collect::<Vec<_>>(),"executor_state":executor_states.get(&group).cloned().unwrap_or_else(||json!({}))});
                    active.push(async move {
                        let started = Instant::now();
                        tracing::info!(event = "tool_call_started", tool_call, tool = label(&name));
                        let result = Self::tool_response(
                            http,
                            headers,
                            url,
                            events,
                            (&name, &call.function.arguments),
                            tool_preparation,
                            context,
                        )
                        .await
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
                        (call, result)
                    });
                }
                if active.is_empty() {
                    continue;
                }
                let (call, outcome) = tokio::select! {
                    biased;
                    Some(command) = self.inbox.recv() => { self.accept(command).await?; continue; }
                    Some(result) = active.next() => result,
                    _ = self.events.sender.closed() => bail!("Client disconnected"),
                };
                let mut outcome = outcome?;
                let name = call.function.name.to_string();
                if !outcome.is_error && !outcome.terminal {
                    requirement.succeeded(&name);
                }
                let group = self.execution_group(&name);
                if preparation.is_some() {
                    // The verifier is read-only and has no run-scoped executor state.
                    // Never replace shared state with a concurrent call's snapshot.
                    if group != "native:source_verifier" {
                        executor_states.insert(group.clone(), outcome.executor_state.clone());
                    }
                    if let Some(preparation) = &preparation {
                        // A leaf reports successful skill loading; only Rust resolves routing policy.
                        let selection = selection.as_mut().unwrap();
                        outcome.model_profile =
                            selection.skill_loaded(&preparation.config, &outcome.loaded_skills);
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
                self.events
                    .tool(&call.id.to_string(), &name, true, Value::String(visible))
                    .await?;
                if outcome.terminal && terminal.is_none() {
                    terminal = Some((outcome.content.clone(), outcome.terminal_reason));
                }
                for tool in outcome.tools {
                    if catalog.add(&tool)? {
                        prepared.tools.push(tool);
                    }
                }
                if let Some(profile) = &outcome.model_profile
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
            if let Some((content, reason)) = terminal {
                self.drain().await?;
                if !self.pending.is_empty() || !self.handle.finish_if_idle(&self.inbox).await {
                    continue;
                }
                if reason == "mcp_approval_required" {
                    tracing::info!(event = "approval_required");
                    self.events
                        .event("mcp_approval_required", json!({"marker":content}))
                        .await?;
                }
                self.events.delta(&content).await?;
                self.events
                    .finish(if reason == "mcp_approval_required" {
                        "mcp_approval_required"
                    } else {
                        "stop"
                    })
                    .await?;
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
        self.preparation
            .as_ref()
            .map_or(1, |preparation| preparation.config.tool_concurrency(name))
    }

    async fn tool_response(
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
            && let Some(mcp) = &preparation.mcp
            && mcp.owns(name)
        {
            let user = crate::preparation::header(&headers, "x-user-id");
            let token = crate::preparation::header(&headers, "x-daedalus-approval-token");
            let emit = crate::oauth::Emitter::Chat(events.clone());
            let call = mcp.call(name, arguments, user, token, &emit);
            tokio::pin!(call);
            let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
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
        let response = http
            .post(url)
            .headers(headers)
            .json(&request)
            .send()
            .await?
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
        while let Some(chunk) = stream.next().await {
            buffer.extend_from_slice(&chunk?);
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
                                    name,
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
