"""Daedalus-owned composition for NAT's supported FastAPI runner hook."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import tempfile

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from nat.front_ends.fastapi.fastapi_front_end_plugin_worker import (
    FastApiFrontEndPluginWorker,
)
from nat_helpers.redis_url import close_redis_client

logger = logging.getLogger("daedalus.http_api")

DRAINING_MARKER_PATH = os.path.join(tempfile.gettempdir(), "daedalus-draining")


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

        client = Redis.from_url(
            os.environ.get("REDIS_URL", "redis://redis:6379"),
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

    status = "degraded" if capabilities["unavailable_optional"] else "ready"
    return JSONResponse({"status": status, "mcp": capabilities})


def attach_daedalus_routes(app: FastAPI) -> FastAPI:
    """Attach the repository-owned API surface to one NAT application."""
    if getattr(app, "_daedalus_routes_attached", False):
        return app

    # Import eagerly while NAT constructs the application. A broken router is
    # a startup failure, never a silently missing production endpoint.
    from collection_metadata_api import router as collection_metadata_router
    from document_ingest_api import router as document_ingest_router
    from image_api import router as image_router
    from nat_helpers.internal_auth import DaedalusInternalAuthMiddleware
    from profile_import_api import router as profile_import_router

    app.add_middleware(DaedalusInternalAuthMiddleware)
    app.add_api_route(
        "/health/ready",
        readiness_response,
        methods=["GET"],
        include_in_schema=False,
    )
    app.include_router(image_router)
    app.include_router(collection_metadata_router)
    app.include_router(document_ingest_router)
    app.include_router(profile_import_router)
    app._daedalus_routes_attached = True
    logger.info("Attached Daedalus HTTP routers to NAT FastAPI app")
    return app


class DaedalusFastApiFrontEndPluginWorker(FastApiFrontEndPluginWorker):
    """NAT FastAPI worker composed through ``runner_class`` configuration."""

    def build_app(self) -> FastAPI:
        return attach_daedalus_routes(super().build_app())
