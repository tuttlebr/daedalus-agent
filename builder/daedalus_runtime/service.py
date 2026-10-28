"""Authenticated Python leaf tools for the Rust execution controller."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Literal

import httpx
from daedalus_runtime.approval import configure_mcp_approval_policy
from daedalus_runtime.cancellation import CancelOnDisconnect, cancel_and_join
from daedalus_runtime.config import (
    describe_validation_error,
    load_config,
    validate_config,
)
from daedalus_runtime.logging import configure_logging, log_context, log_event
from daedalus_runtime.mcp import MCPManager
from daedalus_runtime.oauth import GoogleOAuth
from daedalus_runtime.tools import ToolRegistry, load_tool_factories
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from nat_helpers.agent_loop_guard import AgentRun, agent_run_scope, tool_outcome
from nat_helpers.approval_context import approval_marker_scope
from nat_helpers.history_budget import _select_history_payloads
from nat_helpers.identity import authenticated_user_id_from_context
from nat_helpers.model_routing import ModelRoutingConfig, ModelSelection
from nat_helpers.redis_url import redis_url_from_env
from nat_helpers.tool_output_compaction import (
    CompactionSettings,
    ToolOutputStore,
    optimize_tool_content,
)
from opentelemetry import trace
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from redis.asyncio import Redis


@dataclass
class RunContext:
    user: str
    query: str
    tools: set[str]
    groups: set[str]
    selection: ModelSelection
    created: float
    artifacts: AgentRun = field(default_factory=AgentRun)
    span: object = None


class ToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=256)
    arguments: dict


class RunReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outcome: Literal["completed", "failed"]
    # Cancelled or partially reported provider attempts have unknown totals.
    metrics: dict[str, int | None] = Field(default_factory=dict)


class CatalogRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    names: list[str] = Field(max_length=256)


class CallContext(BaseModel):
    """Versioned state supplied by the authenticated Rust owner, never the model."""

    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    query: str = Field(max_length=8_000_000)
    available_tools: list[str] = Field(max_length=4096)
    executor_state: dict = Field(default_factory=dict)


class ExplicitToolCall(ToolCall):
    context: CallContext


class ToolService:
    def __init__(self, config: dict, registry: ToolRegistry, mcp: MCPManager):
        self.config, self.registry, self.mcp = config, registry, mcp
        self.workflow = config["workflow"]
        self.routing = ModelRoutingConfig.model_validate(
            {
                key: self.workflow[key]
                for key in (
                    "model_routes",
                    "request_model_profiles",
                    "skill_model_profiles",
                )
                if key in self.workflow
            }
        )
        self.runs: dict[str, RunContext] = {}
        self.released: dict[tuple[str, str], float] = {}
        self.compaction = CompactionSettings(
            **{
                field: self.workflow[key]
                for field, key in {
                    "enabled": "tool_output_compaction_enabled",
                    "min_chars": "tool_output_compaction_min_chars",
                    "max_items": "tool_output_compaction_max_items",
                    "min_savings_chars": "tool_output_compaction_min_savings_chars",
                    "max_compacted_ratio": "tool_output_compaction_max_ratio",
                    "max_original_chars": "tool_output_compaction_max_original_chars",
                    "cache_ttl_seconds": "tool_output_cache_ttl_seconds",
                }.items()
                if key in self.workflow
            }
        )
        self.outputs = ToolOutputStore(ttl_seconds=self.compaction.cache_ttl_seconds)

    async def prepare(self, body: dict, request: Request) -> dict:
        from nat_helpers.autonomous_llm import (
            autonomous_llm_config,
            is_authenticated_autonomy_request,
        )
        from nat_helpers.daily_summary_runtime import request_profile

        user = authenticated_user_id_from_context()
        run_id = request.headers.get("x-daedalus-request-id", "")
        if not run_id:
            raise HTTPException(400, "Run identity is required")
        self.released = {
            key: until
            for key, until in self.released.items()
            if until > time.monotonic()
        }
        if (run_id, user) in self.released:
            raise HTTPException(409, "Run was cancelled during preparation")
        raw_messages = body.get("messages")
        if not isinstance(raw_messages, list) or not raw_messages:
            raise HTTPException(400, "messages must be a nonempty array")
        for message in raw_messages:
            if (
                not isinstance(message, dict)
                or message.get("role") not in {"user", "assistant"}
                or not isinstance(message.get("content"), str)
            ):
                raise HTTPException(
                    400, "Messages require a user or assistant role and text content"
                )
        messages = _select_history_payloads(
            raw_messages,
            max_messages=int(self.workflow.get("max_history", 50)),
            max_tokens=int(self.workflow.get("max_history_tokens", 32000)),
        )
        query = next(
            (
                message["content"]
                for message in reversed(messages)
                if message["role"] == "user"
            ),
            "",
        )
        autonomy = is_authenticated_autonomy_request()
        profile = request_profile(query, autonomous=autonomy)
        selection = ModelSelection.resolve(
            self.routing, body.get("additional_props"), profile
        )
        model = dict(self.config["llms"][self.workflow["llm_name"]])
        model.pop("_type", None)
        if autonomy:
            autonomous = autonomous_llm_config(
                SimpleNamespace(
                    max_retries=int(model.get("max_retries", 3)),
                    request_timeout=float(model.get("request_timeout", 60)),
                )
            )
            if autonomous:
                model = autonomous.model_dump()
                model["api_key"] = autonomous.api_key.get_secret_value()
                selection = ModelSelection(requested="default")
        model["model_name"] = selection.alias(self.routing, model["model_name"])
        model["request_timeout"] = float(model.get("request_timeout", 60))
        model["max_retries"] = int(model.get("max_retries", 3))
        tool_names = self.workflow.get("tools", [])
        if profile == "daily_summary":
            tool_names = self.workflow.get("daily_summary_tools", tool_names)
        group_names = [name for name in tool_names if name in self.mcp.groups]
        local_names = [name for name in tool_names if name not in self.mcp.groups]

        async def local_schema(name):
            return (await self.registry.get_function(name)).schema(name)

        local, remote = await asyncio.gather(
            asyncio.gather(*(local_schema(name) for name in local_names)),
            self.mcp.catalogue(group_names, user, initial=True),
        )
        choice = body.get("tool_choice")
        if isinstance(choice, dict) and choice.get("type") == "function":
            function = choice.get("function")
            name = (
                function.get("name") if isinstance(function, dict) else None
            ) or choice.get("name")
            group = next(
                (
                    group
                    for group in group_names
                    if isinstance(name, str)
                    and name.startswith(group + "__")
                    and name != group + "__connect"
                ),
                None,
            )
            if group:
                remote = [
                    tool for tool in remote if not tool["name"].startswith(group + "__")
                ]
                remote.extend(await self.mcp.catalogue([group], user, initial=False))
        tools = [*local, *remote]
        if not autonomy:
            try:
                from nat_helpers.hindsight_client import client_from_env, memory_mode
                from nat_helpers.hindsight_memory_context import (
                    build_automatic_memory_context,
                )

                if memory_mode() == "hindsight":
                    budget = max(
                        0.1,
                        float(
                            os.getenv("DAEDALUS_MEMORY_CONTEXT_TIMEOUT_SECONDS", "2.5")
                        ),
                    )
                    context = await asyncio.wait_for(
                        build_automatic_memory_context(
                            client_from_env(),
                            user_id=user,
                            conversation_id=request.headers.get("x-conversation-id"),
                            query=query,
                        ),
                        timeout=budget,
                    )
                    if context:
                        index = max(
                            i
                            for i, message in enumerate(messages)
                            if message["role"] == "user"
                        )
                        messages.insert(index, {"role": "user", "content": context})
            except Exception as exc:
                log_event(
                    "memory_context_unavailable",
                    level=logging.WARNING,
                    error_class=type(exc).__name__,
                )
        now = time.monotonic()
        self.runs = {
            key: run for key, run in self.runs.items() if now - run.created < 7200
        }
        if len(self.runs) >= 128:
            raise HTTPException(429, "Tool runtime capacity reached")
        if run_id in self.runs:
            raise HTTPException(409, "Run identity is already active")
        if (run_id, user) in self.released:
            raise HTTPException(409, "Run was cancelled during preparation")
        self.runs[run_id] = RunContext(
            user,
            query,
            {tool["name"] for tool in tools},
            set(group_names),
            selection,
            now,
        )
        self.runs[run_id].span = trace.get_tracer("daedalus.agent").start_span(
            "daedalus.agent",
            attributes={
                "openinference.span.kind": "AGENT",
                "request_profile": profile,
                "requested_route_alias": model["model_name"],
                **{
                    key: value
                    for key, value in selection.metadata().items()
                    if value is not None
                },
            },
        )
        return {
            "model": model,
            "instructions": self.workflow.get("instructions", ""),
            "messages": messages,
            "tools": tools,
            "max_iterations": int(self.workflow.get("max_iterations", 128)),
            "model_routes": self.routing.model_routes,
            "explicit_model_profile": selection.explicit,
            "daily_summary": profile == "daily_summary",
            "final_tools": self.workflow.get("daily_summary_final_tools", []),
            "research_budget_seconds": float(
                self.workflow.get("daily_summary_research_budget_seconds", 300)
            ),
            "repeated_error_limit": int(
                self.workflow.get("loop_guard", {}).get("repeated_error_limit", 4)
            )
            if self.workflow.get("loop_guard", {}).get("enabled", True)
            else 0,
            "parallel_tool_calls": bool(self.workflow.get("parallel_tool_calls", True)),
        }

    def context(self, request: Request) -> RunContext:
        run = self.runs.get(request.headers.get("x-daedalus-request-id", ""))
        if run is None or run.user != authenticated_user_id_from_context():
            raise HTTPException(404, "Run is unavailable")
        return run

    async def call(self, body: ToolCall, run: RunContext, emit, *, explicit=False):
        from agent_skills.load_events import skill_load_scope

        if body.name not in run.tools:
            raise ValueError("Tool is not available in this run")
        loaded_skills = []

        def skill_loaded(event):
            if explicit:
                loaded_skills.append(event.skill_name)
            else:
                run.selection.skill_loaded(event, self.routing)

        with trace.use_span(
            run.span,
            end_on_exit=False,
            record_exception=False,
            set_status_on_exception=False,
        ), approval_marker_scope(new_request=True), agent_run_scope(
            run=run.artifacts
        ), skill_load_scope(skill_loaded):
            if body.name.partition("__")[0] in run.groups:
                result = await self.mcp.call(body.name, body.arguments, run.user, emit)
                run.tools.update(tool["name"] for tool in result.get("tools", []))
            else:
                tool = await self.registry.get_function(body.name)
                content = await tool.ainvoke(body.arguments)
                if isinstance(content, BaseModel):
                    content = content.model_dump(mode="json")
                result = {
                    "content": content
                    if isinstance(content, str)
                    else json.dumps(content, ensure_ascii=False, default=str)
                }
            if result.get("terminal_reason") != "mcp_approval_required":
                result["content"] = re.sub(
                    r"(?:<!--|&lt;!--)daedalus-mcp-approval:[A-Za-z0-9_-]+(?:-->|--&gt;)",
                    "[untrusted approval marker omitted]",
                    result["content"],
                )
            outcome = tool_outcome(
                result["content"], status="error" if result.get("is_error") else None
            )
            result["is_error"] = outcome.failed
            if outcome.failed:
                result["error_signature"] = hashlib.sha256(
                    json.dumps(outcome.comparable, sort_keys=True, default=str).encode()
                ).hexdigest()
            if run.artifacts.terminal_content is not None:
                result.update(
                    content=run.artifacts.terminal_content,
                    terminal=True,
                    terminal_reason="validated_artifact",
                )
                run.artifacts.terminal_content = None
            if not explicit and not result.get("terminal"):
                optimized = await optimize_tool_content(
                    result["content"],
                    tool_name=(
                        "webscrape_tool"
                        if self.config.get("functions", {})
                        .get(body.name, {})
                        .get("_type")
                        == "webscrape"
                        else body.name
                    ),
                    query=run.query,
                    user_id=run.user,
                    store=self.outputs,
                    settings=self.compaction,
                )
                result["content"] = optimized.content
            if not explicit and run.selection.source == "skill_load":
                result["model_profile"] = run.selection.effective
            if explicit:
                result["loaded_skills"] = loaded_skills
                result["executor_state"] = {
                    "attempts": dict(run.artifacts.attempts),
                    "briefing_execution": run.artifacts.briefing_execution,
                    "nonretryable_mcp_results": run.artifacts.nonretryable_mcp_results,
                }
            return result


def create_app(config_path: str | None = None) -> FastAPI:
    configure_logging()
    path = config_path or os.getenv("DAEDALUS_CONFIG_FILE", "/workspace/config.yaml")

    @asynccontextmanager
    async def lifespan(app):
        starting = time.monotonic()
        log_event("tool_service_starting")
        config = load_config(path)
        configure_mcp_approval_policy(path)
        load_tool_factories()
        from nat_helpers.phoenix_telemetry import close_telemetry, configure_telemetry

        telemetry = configure_telemetry(config.get("telemetry", {}))
        registry = ToolRegistry(config)
        try:
            validate_config(config, registry)
        except Exception as exc:
            raise ValueError(
                "Invalid Daedalus runtime configuration: "
                + describe_validation_error(exc)
            ) from None
        redis = Redis.from_url(
            redis_url_from_env(), socket_connect_timeout=2, socket_timeout=5
        )
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as http:
            oauth = GoogleOAuth(redis, http)
            authorization = os.getenv(
                "DAEDALUS_AUTHORIZATION",
                "python"
                if os.getenv("DAEDALUS_PREPARATION", "rust") == "python"
                else "rust",
            )
            if authorization not in {"rust", "python"}:
                raise ValueError("DAEDALUS_AUTHORIZATION must be rust or python")
            mcp = MCPManager(config, oauth, enabled=authorization == "python")
            service = ToolService(config, registry, mcp)
            app.state.tools, app.state.mcp, app.state.oauth = service, mcp, oauth
            from daedalus_runtime.executions import Executions

            app.state.executions = Executions(mcp)
            reaper = asyncio.create_task(mcp.reap()) if mcp.enabled else None
            try:
                static_groups = [
                    name
                    for name in mcp.groups
                    if mcp._auth(name).get("_type") != "mcp_oauth2"
                ]
                if mcp.enabled:
                    await mcp.catalogue(static_groups, "runtime-readiness")
                log_event(
                    "tool_service_ready",
                    elapsed_ms=round((time.monotonic() - starting) * 1000, 1),
                    native_tools=len(config.get("functions", {})),
                    group_count=len(mcp.groups),
                )
                yield
            finally:
                log_event("tool_service_stopping", active_runs=len(service.runs))
                if reaper is not None:
                    reaper.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await reaper
                await app.state.executions.close()
                await oauth.close()
                await mcp.close()
                for run in service.runs.values():
                    if run.span is not None:
                        run.span.set_attribute("outcome", "shutdown")
                        run.span.end()
                await registry.close()
                await service.outputs.close()
                await redis.aclose()
                await close_telemetry(telemetry)

    app = FastAPI(title="Daedalus tools", lifespan=lifespan)
    from nat_helpers.front_end import attach_daedalus_routes

    attach_daedalus_routes(app)
    app.add_middleware(CancelOnDisconnect)

    @app.get("/health")
    async def health():
        return {"status": "healthy", "runtime": "python-tools"}

    @app.get("/auth/redirect")
    async def oauth_redirect(
        request: Request, state: str, code: str | None = None, error: str | None = None
    ):
        request.app.state.oauth.callback(state, code, error)
        return {"status": "authorization_received"}

    @app.post("/runtime/prepare")
    async def prepare(body: dict, request: Request):
        started = time.monotonic()
        with log_context(run_id=request.headers.get("x-daedalus-request-id", "")):
            log_event("tool_prepare_started")
            try:
                result = await request.app.state.tools.prepare(body, request)
            except asyncio.CancelledError:
                log_event(
                    "tool_prepare_cancelled",
                    elapsed_ms=round((time.monotonic() - started) * 1000, 1),
                )
                raise
            except Exception as exc:
                status = (
                    exc.status_code
                    if isinstance(exc, HTTPException)
                    else 400
                    if isinstance(exc, (ValueError, KeyError))
                    else 500
                )
                log_event(
                    "tool_prepare_failed",
                    level=logging.WARNING,
                    error_class=type(exc).__name__,
                    http_status=status,
                    elapsed_ms=round((time.monotonic() - started) * 1000, 1),
                )
                if isinstance(exc, HTTPException):
                    raise
                raise HTTPException(
                    status,
                    "Invalid run or runtime configuration"
                    if status == 400
                    else "Run preparation failed",
                ) from None
            log_event(
                "tool_prepare_finished",
                elapsed_ms=round((time.monotonic() - started) * 1000, 1),
                tool_count=len(result["tools"]),
                message_count=len(result["messages"]),
            )
            return result

    @app.post("/runtime/v1/catalog")
    async def catalog(body: CatalogRequest, request: Request):
        service = request.app.state.tools
        user = authenticated_user_id_from_context()
        configured = set().union(
            *(
                service.workflow.get(key, [])
                for key in ("tools", "daily_summary_tools", "daily_summary_final_tools")
            )
        )
        if set(body.names) - configured:
            raise HTTPException(400, "Tool is not configured")

        async def entry(name):
            if name in service.mcp.groups:
                schemas = await service.mcp.catalogue([name], user, initial=True)
            else:
                schemas = [(await service.registry.get_function(name)).schema(name)]
            return name, schemas

        return dict(await asyncio.gather(*(entry(name) for name in body.names)))

    @app.delete("/runtime/run")
    async def release(body: RunReport, request: Request):
        service = request.app.state.tools
        run_id = request.headers.get("x-daedalus-request-id", "")
        user = authenticated_user_id_from_context()
        run = service.runs.get(run_id)
        if run is not None and run.user != user:
            raise HTTPException(404, "Run is unavailable")
        if run is None:
            # Cleanup may arrive while the prepare request is still waiting on
            # discovery. A short tombstone prevents that request resurrecting
            # a context after the Rust owner has already gone away.
            if len(service.released) >= 256:
                service.released.pop(next(iter(service.released)))
            service.released[(run_id, user)] = time.monotonic() + 180
        else:
            service.runs.pop(run_id, None)
        if run is not None and run.span is not None:
            run.span.set_attribute("outcome", body.outcome)
            for key in (
                "model_calls",
                "tool_calls",
                "input_tokens",
                "output_tokens",
                "reported_usage_calls",
            ):
                if (value := body.metrics.get(key)) is not None:
                    run.span.set_attribute(key, value)
            run.span.end()
        log_event(
            "tool_run_released",
            run_id=run_id,
            outcome=body.outcome,
            active_runs=len(service.runs),
        )
        return {"status": "released"}

    async def stream_call(body: ToolCall, request: Request, run, *, explicit=False):
        service = request.app.state.tools
        if body.name not in run.tools:
            raise HTTPException(400, "Tool is not available in this run")

        async def stream():
            queue = asyncio.Queue(maxsize=16)

            emitted_result = False

            async def emit(event, data):
                nonlocal emitted_result
                if event == "oauth_required":
                    log_event(
                        "tool_oauth_required",
                        run_id=request.headers.get("x-daedalus-request-id", ""),
                        tool=body.name,
                    )
                if event == "result":
                    emitted_result = True
                await queue.put({"event": event, "data": data})

            async def invoke():
                try:
                    await invoke_once()
                finally:
                    # The consumer below ends only on a result. A failure after
                    # the handler's own error handling (or a non-Exception
                    # escape) must still terminate the stream instead of
                    # leaving heartbeats running until the runtime's deadline.
                    if not emitted_result:
                        with contextlib.suppress(asyncio.QueueFull):
                            queue.put_nowait(
                                {
                                    "event": "result",
                                    "data": {
                                        "content": "Tool failed (RuntimeError). Check its arguments and service availability.",
                                        "is_error": True,
                                    },
                                }
                            )

            async def invoke_once():
                started = time.monotonic()
                with log_context(
                    run_id=request.headers.get("x-daedalus-request-id", ""),
                    tool=body.name,
                ):
                    log_event("tool_execution_started")
                    try:
                        result = await service.call(body, run, emit, explicit=explicit)
                    except asyncio.CancelledError:
                        log_event(
                            "tool_execution_cancelled",
                            elapsed_ms=round((time.monotonic() - started) * 1000, 1),
                        )
                        raise
                    except ValidationError as exc:
                        log_event(
                            "tool_validation_failed",
                            level=logging.WARNING,
                            error_class=type(exc).__name__,
                        )
                        result = {
                            "content": json.dumps(
                                exc.errors(include_input=False, include_url=False),
                                default=str,
                            ),
                            "is_error": True,
                        }
                    except Exception as exc:
                        log_event(
                            "tool_execution_failed",
                            level=logging.WARNING,
                            error_class=type(exc).__name__,
                        )
                        result = {
                            "content": f"Tool failed ({type(exc).__name__}). Check its arguments and service availability.",
                            "is_error": True,
                        }
                    log_event(
                        "tool_execution_finished",
                        elapsed_ms=round((time.monotonic() - started) * 1000, 1),
                        is_error=bool(result.get("is_error")),
                        terminal=bool(result.get("terminal")),
                        approval_required=result.get("terminal_reason")
                        == "mcp_approval_required",
                    )
                    if explicit:
                        result.setdefault("loaded_skills", [])
                        result["executor_state"] = {
                            "attempts": dict(run.artifacts.attempts),
                            "briefing_execution": run.artifacts.briefing_execution,
                            "nonretryable_mcp_results": run.artifacts.nonretryable_mcp_results,
                        }
                    await emit("result", result)

            task = asyncio.create_task(invoke())
            try:
                while True:
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=15)
                    except TimeoutError:
                        event = {"event": "heartbeat", "data": {}}
                    yield json.dumps(event, ensure_ascii=False) + "\n"
                    if event["event"] == "result":
                        break
            finally:
                await cancel_and_join(task)

        return StreamingResponse(stream(), media_type="application/x-ndjson")

    @app.post("/runtime/tools/call")
    async def call(body: ToolCall, request: Request):
        return await stream_call(
            body, request, request.app.state.tools.context(request)
        )

    @app.post("/runtime/v1/tools/call")
    async def explicit_call(body: ExplicitToolCall, request: Request):
        from collections import Counter

        from opentelemetry.propagate import extract

        service = request.app.state.tools
        user = authenticated_user_id_from_context()
        group = body.name.partition("__")[0]
        configured = set().union(
            *(
                service.workflow.get(key, [])
                for key in ("tools", "daily_summary_tools", "daily_summary_final_tools")
            )
        )
        if body.name not in body.context.available_tools or (
            body.name not in configured and group not in configured
        ):
            raise HTTPException(400, "Tool is not available in this run")
        # This object lives for exactly one bounded call. Rust retains all run
        # state and returns only the state needed for the next invocation.
        artifacts = AgentRun()
        state = body.context.executor_state
        artifacts.attempts = Counter(state.get("attempts", {}))
        artifacts.briefing_execution = dict(state.get("briefing_execution", {}))
        artifacts.nonretryable_mcp_results = dict(
            state.get("nonretryable_mcp_results", {})
        )
        run = RunContext(
            user,
            body.context.query,
            set(body.context.available_tools),
            set(service.mcp.groups),
            ModelSelection(),
            time.monotonic(),
            artifacts=artifacts,
            span=trace.get_current_span(extract(dict(request.headers))),
        )
        return await stream_call(body, request, run, explicit=True)

    return app
