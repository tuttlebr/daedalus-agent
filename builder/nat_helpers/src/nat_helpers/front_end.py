"""Daedalus HTTP routers and dependency readiness."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import tempfile

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from nat_helpers.redis_url import close_redis_client, redis_url_from_env

logger = logging.getLogger("daedalus.http_api")

DRAINING_MARKER_PATH = os.path.join(tempfile.gettempdir(), "daedalus-draining")


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


async def readiness_response(request: Request) -> JSONResponse:
    """Report whether the security gate and durable dependencies are ready."""
    from daedalus_runtime import approval

    if os.path.exists(DRAINING_MARKER_PATH):
        return JSONResponse({"status": "draining"}, status_code=503)
    if not approval._approval_policy_configured:
        return JSONResponse({"status": "unready"}, status_code=503)

    capabilities = request.app.state.mcp.capability_status()
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


def attach_daedalus_routes(app: FastAPI) -> FastAPI:
    """Attach authenticated application APIs to the Python tool service."""
    if getattr(app, "_daedalus_routes_attached", False):
        return app
    from collection_metadata_api import router as collection_metadata_router
    from document_ingest_api import router as document_ingest_router
    from image_api import router as image_router
    from mcp_approval_api import create_mcp_approval_router
    from memory_api import router as memory_router
    from nat_helpers.identity import authenticated_user_id_from_context
    from nat_helpers.internal_auth import DaedalusInternalAuthMiddleware
    from profile_import_api import router as profile_import_router

    async def reset_google_workspace_connection(service_id: str, request: Request):
        return await request.app.state.mcp.reset(
            service_id, authenticated_user_id_from_context()
        )

    app.add_middleware(DaedalusInternalAuthMiddleware)
    app.add_api_route(
        "/health/ready", readiness_response, methods=["GET"], include_in_schema=False
    )
    app.add_api_route(
        "/v1/google-workspace/connections/{service_id}",
        reset_google_workspace_connection,
        methods=["DELETE"],
        include_in_schema=False,
    )
    for router in (
        image_router,
        collection_metadata_router,
        document_ingest_router,
        profile_import_router,
        memory_router,
        create_mcp_approval_router(),
    ):
        app.include_router(router)
    app._daedalus_routes_attached = True
    return app
