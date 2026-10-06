//! Application-owned model/tool loop. Steering is processed during every wait.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use futures::{StreamExt, stream::FuturesUnordered};
use http::HeaderMap;
use rig_core::completion::{CompletionRequest, FinishReason, ToolDefinition};
use rig_core::message::Message;
use rig_core::providers::openai::{OpenAIConfig, Route};
use rig_core::streaming::{Item, StreamEvent};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::control::{Command, RunHandle};
use crate::events::Events;
use crate::logging::{Phase, label};

#[derive(Deserialize)]
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

#[derive(Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
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

#[derive(Deserialize, Default)]
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
        let preparing = Instant::now();
        tracing::info!(event = "prepare_started");
        let prepare = self
            .http
            .post(format!("{}/runtime/prepare", self.tools_url))
            .headers(self.headers.clone())
            .json(&body)
            .send();
        tokio::pin!(prepare);
        let response = loop {
            tokio::select! {
                biased;
                Some(command) = self.inbox.recv() => self.accept(command).await?,
                response = &mut prepare => break response.context(Phase("prepare_request"))?,
                _ = self.events.sender.closed() => bail!("Client disconnected"),
            }
        };
        let mut prepared: PreparedRun = response
            .error_for_status()
            .context(Phase("prepare_request"))?
            .json()
            .await
            .context(Phase("prepare_decode"))?;
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
        let mut history = vec![Message::system(&prepared.instructions)];
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
        let mut previous_error = String::new();
        let mut repeated_errors = 0;
        let mut iterations = 0;
        let mut retry_attempt = 0;
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
                .cloned()
                .collect();
            let mut params =
                json!({"store":false, "parallel_tool_calls":prepared.parallel_tool_calls});
            if prepared.model.api_type == "responses" {
                params["truncation"] = json!("auto");
            }
            let tool_count = tools.len();
            let mut request = CompletionRequest::new("unused")
                .tools(tools)
                .additional_params(params);
            request.chat_history = history.clone();
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
                crate::provider::CompatibleOpenAi(model.wire),
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
                                partial.push_str(&text);
                                self.events.delta(&text).await?;
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
                if !partial.is_empty() {
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
                    if !received_item
                        && error.is_retryable()
                        && retry_attempt < prepared.model.max_retries =>
                {
                    retry_attempt += 1;
                    iterations -= 1;
                    let delay = Duration::from_millis(250 * (1 << retry_attempt.min(5)));
                    tracing::warn!(
                        event = "model_retry_scheduled",
                        model_call,
                        retry_attempt,
                        delay_ms = delay.as_millis() as u64,
                        error_kind = error.kind().code(),
                        http_status = error
                            .provider_response_status()
                            .map(|status| status.as_u16()),
                        elapsed_ms = model_started.elapsed().as_millis() as u64
                    );
                    tokio::select! {
                        biased;
                        Some(command) = self.inbox.recv() => { self.accept(command).await?; retry_attempt = 0; },
                        _ = tokio::time::sleep(delay) => {},
                        _ = self.events.sender.closed() => bail!("Client disconnected"),
                    }
                    continue;
                }
                Err(error) => return Err(anyhow::Error::new(error).context(Phase("model_stream"))),
            };
            retry_attempt = 0;
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
            if let Some(message) = completed.message() {
                history.push(message);
            }
            self.drain().await?;
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
            let mut queued = VecDeque::from(calls);
            let mut active = FuturesUnordered::new();
            let mut active_groups = HashSet::new();
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
                            || !active_groups
                                .contains(call.function.name.split("__").next().unwrap_or_default())
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
                    active_groups.insert(name.split("__").next().unwrap_or_default().to_owned());
                    self.events
                        .tool(&id, &name, false, call.function.arguments.clone())
                        .await?;
                    let http = self.http.clone();
                    let headers = self.headers.clone();
                    let url = format!("{}/runtime/tools/call", self.tools_url);
                    let events = self.events.clone();
                    active.push(async move {
                        let started = Instant::now();
                        tracing::info!(event = "tool_call_started", tool_call, tool = label(&name));
                        let result = Self::tool_response(
                            http,
                            headers,
                            url,
                            events,
                            &name,
                            &call.function.arguments,
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
                let outcome = outcome?;
                let name = call.function.name.to_string();
                active_groups.remove(name.split("__").next().unwrap_or_default());
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
                    if !prepared.tools.iter().any(|old| old.name == tool.name) {
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
                if outcome.is_error {
                    let signature = format!(
                        "{name}:{}:{}",
                        call.function.arguments,
                        if outcome.error_signature.is_empty() {
                            &outcome.content
                        } else {
                            &outcome.error_signature
                        }
                    );
                    repeated_errors = if signature == previous_error {
                        repeated_errors + 1
                    } else {
                        1
                    };
                    previous_error = signature;
                } else {
                    repeated_errors = 0;
                    previous_error.clear();
                }
                history.push(Message::tool_result(
                    call.id,
                    call.function.name,
                    outcome.content,
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

    async fn tool_response(
        http: reqwest::Client,
        headers: HeaderMap,
        url: String,
        events: Events,
        name: &str,
        arguments: &Value,
    ) -> Result<ToolOutcome> {
        let request = json!({"name":name,"arguments":arguments});
        let response = http
            .post(url)
            .headers(headers)
            .json(&request)
            .send()
            .await?
            .error_for_status()?;
        let mut stream = response.bytes_stream();
        let mut buffer = Vec::new();
        while let Some(chunk) = stream.next().await {
            buffer.extend_from_slice(&chunk?);
            if buffer.len() > 8 * 1024 * 1024 {
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
                        return serde_json::from_value(event["data"].clone())
                            .context("Invalid tool result");
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
