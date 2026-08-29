"""Daedalus-owned composition for NAT's supported FastAPI runner hook."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import os
import re
import tempfile
from collections.abc import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from nat.front_ends.fastapi.fastapi_front_end_plugin_worker import (
    FastApiFrontEndPluginWorker,
)
from nat_helpers.redis_url import close_redis_client, redis_url_from_env

logger = logging.getLogger("daedalus.http_api")

DRAINING_MARKER_PATH = os.path.join(tempfile.gettempdir(), "daedalus-draining")

_MCP_APPROVAL_LITERAL_RE = re.compile(
    r"<!--daedalus-mcp-approval:([A-Za-z0-9_-]+)-->",
)
_MCP_APPROVAL_ESCAPED_RE = re.compile(
    r"&lt;!--daedalus-mcp-approval:([A-Za-z0-9_-]+)--&gt;",
)
_MCP_APPROVAL_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{12,128}$")
_MCP_APPROVAL_ARGUMENTS_SHA_RE = re.compile(r"^[0-9a-f]{64}$")


def _decode_valid_mcp_approval_marker(value: object) -> str | None:
    """Return one canonical marker from a literal or HTML-escaped tool result."""

    if not isinstance(value, str):
        return None
    match = _MCP_APPROVAL_LITERAL_RE.search(value)
    if match is None:
        match = _MCP_APPROVAL_ESCAPED_RE.search(value)
    if match is None:
        return None

    encoded = match.group(1)
    try:
        padded = encoded + "=" * ((4 - len(encoded) % 4) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None

    if not isinstance(payload, dict) or payload.get("version") != 1:
        return None
    required_strings = ("serverName", "toolName", "target", "summary")
    if any(
        not isinstance(payload.get(field), str) or not payload[field].strip()
        for field in required_strings
    ):
        return None
    request_id = payload.get("requestId")
    arguments_sha = payload.get("argumentsSha256")
    if not isinstance(request_id, str) or not _MCP_APPROVAL_REQUEST_ID_RE.fullmatch(
        request_id
    ):
        return None
    if not isinstance(
        arguments_sha, str
    ) or not _MCP_APPROVAL_ARGUMENTS_SHA_RE.fullmatch(arguments_sha):
        return None
    return f"<!--daedalus-mcp-approval:{encoded}-->"


def _approval_marker_from_sse_line(line: bytes) -> str | None:
    """Extract a validated approval marker only from a completed NAT tool step."""

    prefix = b"intermediate_data: "
    if not line.startswith(prefix):
        return None
    try:
        frame = json.loads(line[len(prefix) :])
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(frame, dict) or not str(frame.get("name", "")).startswith(
        "Function Complete:"
    ):
        return None
    return _decode_valid_mcp_approval_marker(frame.get("payload"))


def _has_terminal_mcp_approval(messages: list[object]) -> bool:
    """Return whether the latest tool batch contains a validated approval gate."""

    saw_tool_message = False
    for message in reversed(messages):
        if getattr(message, "type", None) == "tool":
            saw_tool_message = True
            if _decode_valid_mcp_approval_marker(message.content):
                return True
            continue
        if saw_tool_message:
            break
    return False


async def _terminalize_mcp_approval_stream(
    body_iterator: AsyncIterator[bytes | str],
) -> AsyncIterator[bytes]:
    """Replace the first gated tool result with a typed terminal SSE event.

    The agent graph owns deterministic termination before another model cycle.
    This serializer consumes its short natural tail so framework cleanup can
    complete without GeneratorExit or orphaned producer tasks.
    """

    buffered = b""
    terminated = False
    async for chunk in body_iterator:
        if terminated:
            continue
        buffered += chunk.encode("utf-8") if isinstance(chunk, str) else chunk
        while b"\n" in buffered:
            line, buffered = buffered.split(b"\n", 1)
            marker = _approval_marker_from_sse_line(line)
            if marker is not None:
                terminated = True
                buffered = b""
                event = json.dumps({"marker": marker}, separators=(",", ":")).encode(
                    "utf-8"
                )
                logger.info("Terminating chat stream at MCP approval boundary")
                yield b"event: mcp_approval_required\ndata: " + event + b"\n\n"
                break
            yield line + b"\n"
    if buffered and not terminated:
        yield buffered


class McpApprovalTerminalMiddleware:
    """Make a gated mutation a backend-owned terminal stream event."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (
            scope.get("type") != "http"
            or scope.get("method") != "POST"
            or scope.get("path") != "/v1/chat/completions"
        ):
            await self.app(scope, receive, send)
            return

        is_event_stream = False
        buffered = b""
        terminated = False

        async def terminal_send(message):
            nonlocal is_event_stream, buffered, terminated
            if message.get("type") == "http.response.start":
                headers = message.get("headers", [])
                is_event_stream = any(
                    name.lower() == b"content-type"
                    and b"text/event-stream" in value.lower()
                    for name, value in headers
                )
                await send(message)
                return

            if message.get("type") != "http.response.body" or not is_event_stream:
                await send(message)
                return

            if terminated:
                if not message.get("more_body", False):
                    with contextlib.suppress(OSError):
                        await send(
                            {
                                "type": "http.response.body",
                                "body": b"",
                                "more_body": False,
                            }
                        )
                return

            buffered += message.get("body", b"")
            outgoing = bytearray()
            while b"\n" in buffered:
                line, buffered = buffered.split(b"\n", 1)
                marker = _approval_marker_from_sse_line(line)
                if marker is not None:
                    terminated = True
                    buffered = b""
                    event = json.dumps(
                        {"marker": marker}, separators=(",", ":")
                    ).encode("utf-8")
                    outgoing.extend(
                        b"event: mcp_approval_required\ndata: " + event + b"\n\n"
                    )
                    await send(
                        {
                            "type": "http.response.body",
                            "body": bytes(outgoing),
                            "more_body": True,
                        }
                    )
                    return
                outgoing.extend(line + b"\n")

            more_body = bool(message.get("more_body", False))
            if not more_body and buffered:
                outgoing.extend(buffered)
                buffered = b""
            if outgoing or not more_body:
                await send(
                    {
                        "type": "http.response.body",
                        "body": bytes(outgoing),
                        "more_body": more_body,
                    }
                )

        await self.app(scope, receive, terminal_send)
        if terminated:
            logger.info("Terminated backend execution at MCP approval boundary")


def _rag_readiness_mode() -> str:
    """Return the explicit RAG dependency policy."""
    configured = (os.getenv("DAEDALUS_RAG_READINESS_MODE") or "").strip().lower()
    if not configured:
        return "disabled"
    if configured not in {"disabled", "degraded", "required"}:
        raise ValueError(
            "DAEDALUS_RAG_READINESS_MODE must be disabled, degraded, or required"
        )
    return configured


def _memory_readiness_mode() -> str:
    """Return the durable-memory dependency policy.

    The request path already treats Hindsight as optional: automatic recall in
    ``per_user_tool_calling`` is wrapped in a broad ``except`` and chat completes
    without it. Defaulting readiness to ``required`` contradicted that, so a
    brief Hindsight outage removed every backend pod from its Service and took
    chat down for a dependency chat does not need. ``degraded`` keeps the
    condition visible in the payload without failing the probe.
    """
    configured = (os.getenv("DAEDALUS_MEMORY_READINESS_MODE") or "").strip().lower()
    if configured:
        if configured not in {"degraded", "required"}:
            raise ValueError(
                "DAEDALUS_MEMORY_READINESS_MODE must be degraded or required"
            )
        return configured
    return "degraded"


def _required_collections() -> set[str]:
    configured = os.getenv("DAEDALUS_REQUIRED_COLLECTIONS") or ""
    return {item for item in configured.replace(",", " ").split() if item}


async def readiness_response() -> JSONResponse:
    """Report whether the security gate and durable dependencies are ready."""
    import mcp_patches

    if os.path.exists(DRAINING_MARKER_PATH):
        return JSONResponse({"status": "draining"}, status_code=503)
    if not getattr(mcp_patches, "_approval_gate_installed", False):
        return JSONResponse({"status": "unready"}, status_code=503)

    capabilities = mcp_patches.mcp_capability_status()
    if capabilities["missing_required"]:
        return JSONResponse(
            {
                "status": "unready",
                "reason": "required_mcp_capability_unavailable",
                "mcp": capabilities,
            },
            status_code=503,
        )

    client = None
    try:
        from redis.asyncio import Redis

        # Resolve exactly like every tool store does. A local default here
        # would let the probe report a Redis the application never uses.
        client = Redis.from_url(
            redis_url_from_env(),
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        await asyncio.wait_for(client.ping(), timeout=1.5)
    except Exception:
        return JSONResponse({"status": "unready"}, status_code=503)
    finally:
        if client is not None:
            with contextlib.suppress(Exception):
                await close_redis_client(client)

    try:
        from nat_helpers.hindsight_client import client_from_env, memory_mode

        configured_memory_mode = memory_mode()
    except ValueError:
        logger.error("Invalid memory configuration")
        return JSONResponse(
            {"status": "unready", "reason": "invalid_memory_mode"},
            status_code=503,
        )

    try:
        memory_readiness_mode = _memory_readiness_mode()
    except ValueError:
        logger.error("Invalid memory readiness configuration")
        return JSONResponse(
            {"status": "unready", "reason": "invalid_memory_readiness_mode"},
            status_code=503,
        )

    memory = {"state": configured_memory_mode}
    memory_degraded = False
    if configured_memory_mode == "hindsight":
        try:
            await asyncio.wait_for(client_from_env().health(), timeout=3.5)
            memory["hindsight"] = "ready"
        except Exception:
            logger.warning("Hindsight readiness check failed")
            memory["hindsight"] = "unavailable"
            if memory_readiness_mode == "required":
                return JSONResponse(
                    {
                        "status": "unready",
                        "reason": "hindsight_unavailable",
                        "memory": memory,
                    },
                    status_code=503,
                )
            memory_degraded = True

    rag = {"state": "disabled"}
    try:
        rag_mode = _rag_readiness_mode()
    except ValueError:
        logger.error("Invalid RAG readiness configuration")
        return JSONResponse(
            {"status": "unready", "reason": "invalid_rag_readiness_mode"},
            status_code=503,
        )
    rag_degraded = False
    if rag_mode != "disabled":
        try:
            # Reuse the same authenticated client path as the collection API
            # and retrieval tools, including token precedence and the bounded
            # MILVUS_METADATA_TIMEOUT_SECONDS deadline.
            from collection_metadata_api import _list_collections

            collections = await _list_collections()
            missing = sorted(_required_collections() - set(collections))
            if missing:
                rag = {
                    "state": "unready",
                    "collectionCount": len(collections),
                    "missingRequiredCollections": missing,
                }
                if rag_mode == "required":
                    return JSONResponse(
                        {
                            "status": "unready",
                            "reason": "required_collections_unavailable",
                            "rag": rag,
                        },
                        status_code=503,
                    )
                rag_degraded = True
            else:
                rag = {"state": "ready", "collectionCount": len(collections)}
        except Exception:
            # Keep the response and logs diagnostic but credential-safe. Some
            # client exception representations include connection arguments.
            logger.warning("Milvus readiness check failed")
            rag = {"state": "unavailable", "reason": "milvus_unavailable"}
            if rag_mode == "required":
                return JSONResponse(
                    {
                        "status": "unready",
                        "reason": "milvus_unavailable",
                        "rag": rag,
                    },
                    status_code=503,
                )
            rag_degraded = True

    status = (
        "degraded"
        if capabilities["unavailable_optional"] or rag_degraded or memory_degraded
        else "ready"
    )
    return JSONResponse(
        {"status": status, "mcp": capabilities, "rag": rag, "memory": memory}
    )


def attach_daedalus_routes(
    app: FastAPI,
    *,
    session_managers: list[object] | None = None,
    execution_store: object | None = None,
    http_flow_handler: object | None = None,
) -> FastAPI:
    """Attach the repository-owned API surface to one NAT application."""
    if getattr(app, "_daedalus_routes_attached", False):
        return app

    # Import eagerly while NAT constructs the application. A broken router is
    # a startup failure, never a silently missing production endpoint.
    from collection_metadata_api import router as collection_metadata_router
    from document_ingest_api import router as document_ingest_router
    from image_api import router as image_router
    from mcp_approval_api import create_mcp_approval_router
    from memory_api import router as memory_router
    from nat_helpers.google_workspace_auth import reset_google_workspace_authorization
    from nat_helpers.internal_auth import DaedalusInternalAuthMiddleware
    from profile_import_api import router as profile_import_router

    active_session_managers = session_managers if session_managers is not None else []

    async def reset_google_workspace_connection(
        service_id: str,
        request: Request,
    ):
        return await reset_google_workspace_authorization(
            service_id,
            request,
            active_session_managers,
        )

    app.add_middleware(DaedalusInternalAuthMiddleware)
    app.add_middleware(McpApprovalTerminalMiddleware)
    app.add_api_route(
        "/health/ready",
        readiness_response,
        methods=["GET"],
        include_in_schema=False,
    )
    app.add_api_route(
        "/v1/google-workspace/connections/{service_id}",
        reset_google_workspace_connection,
        methods=["DELETE"],
        include_in_schema=False,
    )
    app.include_router(image_router)
    app.include_router(collection_metadata_router)
    app.include_router(document_ingest_router)
    app.include_router(profile_import_router)
    app.include_router(memory_router)
    if execution_store is not None and http_flow_handler is not None:
        app.include_router(
            create_mcp_approval_router(
                session_managers=active_session_managers,
                execution_store=execution_store,
                http_flow_handler=http_flow_handler,
            )
        )
    app._daedalus_routes_attached = True
    logger.info("Attached Daedalus HTTP routers to NAT FastAPI app")
    return app


class DaedalusFastApiFrontEndPluginWorker(FastApiFrontEndPluginWorker):
    """NAT FastAPI worker composed through ``runner_class`` configuration."""

    def build_app(self) -> FastAPI:
        return attach_daedalus_routes(
            super().build_app(),
            session_managers=getattr(self, "_session_managers", []),
            execution_store=getattr(self, "_execution_store", None),
            http_flow_handler=getattr(self, "_http_flow_handler", None),
        )
