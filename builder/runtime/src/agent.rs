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
        let mut response_text = ResponseText::default();
        let mut briefing_text_fallback = false;
        let mut briefing_fallback_started = false;
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
            let final_synthesis = briefing_text_fallback
                || (prepared.daily_summary
                    && started.elapsed().as_secs_f64() >= prepared.research_budget_seconds);
            // A named capability deserves one evidence check if the model
            // answers without calling anything. This is still auto selection:
            // mentions, quotations and prohibitions never force execution.
            let review_tool_omission = iterations == 1
                && self.revision == 0
                && matches!(requirement, crate::tool_contracts::Requirement::Auto)
                && initial_menu.is_some();
            let withhold_text =
                response_policy.final_only() || requirement.pending() || review_tool_omission;
            let available = |tool: &&ToolDefinition| {
                !briefing_text_fallback
                    && (!final_synthesis || prepared.final_tools.contains(&tool.name))
                    && requirement.allows(&tool.name)
                    && validation_recovery.allows(&tool.name)
            };
            let in_menu = |tool: &&ToolDefinition| {
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
                .cloned()
                .collect();
            // These return with the full catalogue next round. Rejecting a
            // proposal for one must not spend that tool's argument correction.
            let menu_hidden: std::collections::HashSet<_> = prepared
                .tools
                .iter()
                .filter(available)
                .filter(|tool| !in_menu(tool))
                .map(|tool| tool.name.clone())
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
                .tool_choice(if briefing_text_fallback {
                    rig_core::message::ToolChoice::None
                } else {
                    requirement.choice()
                })
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
            let total_timeout = if briefing_text_fallback {
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
            let idle = tokio::time::sleep(inactivity);
            tokio::pin!(idle);
            let total = async {
                match total_timeout {
                    Some(seconds) => {
                        tokio::time::sleep(Duration::from_secs_f64(seconds.max(1.0))).await
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
                                    response_text.delta(&self.events, &text).await?;
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
                None => stream.finish().await.map_err(Some),
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
                    tokio::select! {
                        biased;
                        Some(command) = self.inbox.recv() => { self.accept(command).await?; retry_attempt = 0; },
                        _ = tokio::time::sleep(delay) => {},
                        _ = self.events.sender.closed() => bail!("Client disconnected"),
                    }
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
            let mut calls: Vec<_> = completed.tool_calls().cloned().collect();
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
            }
            if calls.is_empty() {
                if !self.pending.is_empty() {
                    continue;
                }
                if !self.handle.finish_if_idle(&self.inbox).await {
                    continue;
                }
                if partial.is_empty() && !resumed {
                    bail!("Model completed without an answer");
                }
                if withhold_text {
                    response_text.delta(&self.events, &partial).await?;
                }
                self.events.finish("stop").await?;
                return Ok(());
            }
            if briefing_text_fallback {
                bail!("Briefing text fallback proposed tools despite disabled tool access");
            }
            let batch_revision = self.revision;
            let problems = catalog.check_batch(&calls, &tools)?;
            let (counted_calls, counted_problems): (Vec<_>, Vec<_>) = calls
                .iter()
                .zip(&problems)
                .filter(|(call, _)| !menu_hidden.contains(call.function.name.as_str()))
                .map(|(call, problem)| (call.clone(), problem.clone()))
                .unzip();
            let recovery_exhausted =
                validation_recovery.exhausted(&counted_calls, &counted_problems);
            // Every tool result must directly answer the assistant's calls.
            // Correction guidance follows the whole batch, never between results.
            let mut batch_notice = None;
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
            let mut queued = VecDeque::from(calls);
            let mut active = FuturesUnordered::new();
            let mut active_groups = HashMap::<String, usize>::new();
            let concurrency = if prepared.parallel_tool_calls { 8 } else { 1 };
            let mut terminal = None;
            // Where the approval boundary's own result sits in the transcript,
            // so a redirect that pre-empts the approval can neutralise it.
            let mut terminal_result = None;
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
                if !outcome.is_error && !outcome.terminal {
                    requirement.succeeded(&name);
                }
                let group = self.execution_group(&name);
                if preparation.is_some() {
                    // Scraping and verification have no run-scoped executor state.
                    // Never replace shared state with a concurrent call's snapshot.
                    if !matches!(
                        group.as_str(),
                        "native:source_verifier" | "native:webscrape"
                    ) {
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
                let approval_boundary =
                    outcome.terminal && outcome.terminal_reason == "mcp_approval_required";
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
            if let Some(notice) = batch_notice {
                history.push(Message::user(notice));
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
                if reason == "mcp_approval_required" {
                    tracing::info!(event = "approval_required");
                    self.events
                        .event("mcp_approval_required", json!({"marker":content}))
                        .await?;
                }
                response_text.begin_block();
                response_text.delta(&self.events, &content).await?;
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

    /// A scripted tool service. The call's `query` argument selects the
    /// reply: `fail` answers 500, `stall` writes one heartbeat line and then
    /// never finishes, anything else returns a result naming the query.
    async fn tool_call(
        State(model): State<Arc<Model>>,
        Json(body): Json<Value>,
    ) -> axum::response::Response {
        model.tool_calls.lock().unwrap().push(body.clone());
        let query = body["arguments"]["query"].as_str().unwrap_or("").to_owned();
        if query == "fail" {
            return (
                http::StatusCode::INTERNAL_SERVER_ERROR,
                "tool service failed",
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
    /// model requests.
    async fn run_scripted(
        functions: Value,
        workflow: Value,
        query: &str,
        scripts: Vec<Option<Vec<Value>>>,
        model_settings: Value,
        steer: Option<(usize, &'static str)>,
    ) -> Outcome {
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
        let config = crate::config::Config::new(
            raw,
            [
                ("DAEDALUS_MEMORY_MODE".into(), "disabled".into()),
                ("REDIS_URL".into(), "redis://127.0.0.1:1".into()),
                // Keep a stalled scripted tool stream from waiting a minute.
                ("DAEDALUS_TOOL_STREAM_IDLE_SECONDS".into(), "1".into()),
            ]
            .into(),
        )
        .unwrap();
        let http = reqwest::Client::new();
        let preparation = crate::preparation::Preparation::new(config).unwrap();
        let (commands, inbox) = mpsc::channel(8);
        let (sender, mut receiver) = mpsc::channel::<bytes::Bytes>(128);
        let collector = tokio::spawn(async move {
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
                while model.requests.lock().unwrap().len() < after {
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
                run_id: "synthetic-run".into(),
                sender,
            },
            inbox,
            handle,
            pending: Vec::new(),
            revision: 0,
            preparation: Some(preparation),
        };
        let result = tokio::time::timeout(
            Duration::from_secs(20),
            agent.run(json!({"messages":[{"role":"user","content":query}],"stream":true})),
        )
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
        peer.abort();
        let requests = model.requests.lock().unwrap().clone();
        Outcome {
            requests,
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
