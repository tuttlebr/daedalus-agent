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
from daedalus_runtime.cancellation import CancelOnDisconnect
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
    metrics: dict[str, int] = Field(default_factory=dict)


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

    async def call(self, body: ToolCall, run: RunContext, emit):
        from agent_skills.load_events import skill_load_scope

        if body.name not in run.tools:
            raise ValueError("Tool is not available in this run")
        with trace.use_span(
            run.span,
            end_on_exit=False,
            record_exception=False,
            set_status_on_exception=False,
        ), approval_marker_scope(new_request=True), agent_run_scope(
            run=run.artifacts
        ), skill_load_scope(
            lambda event: run.selection.skill_loaded(event, self.routing)
        ):
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
            if not result.get("terminal"):
                optimized = await optimize_tool_content(
                    result["content"],
                    tool_name=body.name,
                    query=run.query,
                    user_id=run.user,
                    store=self.outputs,
                    settings=self.compaction,
                )
                result["content"] = optimized.content
            if run.selection.source == "skill_load":
                result["model_profile"] = run.selection.effective
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
            mcp = MCPManager(config, oauth)
            service = ToolService(config, registry, mcp)
            app.state.tools, app.state.mcp, app.state.oauth = service, mcp, oauth
            from daedalus_runtime.executions import Executions

            app.state.executions = Executions(mcp)
            reaper = asyncio.create_task(mcp.reap())
            try:
                static_groups = [
                    name
                    for name in mcp.groups
                    if mcp._auth(name).get("_type") != "mcp_oauth2"
                ]
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
                if key in body.metrics:
                    run.span.set_attribute(key, body.metrics[key])
            run.span.end()
        log_event(
            "tool_run_released",
            run_id=run_id,
            outcome=body.outcome,
            active_runs=len(service.runs),
        )
        return {"status": "released"}

    @app.post("/runtime/tools/call")
    async def call(body: ToolCall, request: Request):
        service = request.app.state.tools
        run = service.context(request)
        if body.name not in run.tools:
            raise HTTPException(400, "Tool is not available in this run")

        async def stream():
            queue = asyncio.Queue(maxsize=16)

            async def emit(event, data):
                if event == "oauth_required":
                    log_event(
                        "tool_oauth_required",
                        run_id=request.headers.get("x-daedalus-request-id", ""),
                        tool=body.name,
                    )
                await queue.put({"event": event, "data": data})

            async def invoke():
                started = time.monotonic()
                with log_context(
                    run_id=request.headers.get("x-daedalus-request-id", ""),
                    tool=body.name,
                ):
                    log_event("tool_execution_started")
                    try:
                        result = await service.call(body, run, emit)
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
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

        return StreamingResponse(stream(), media_type="application/x-ndjson")

    return app
