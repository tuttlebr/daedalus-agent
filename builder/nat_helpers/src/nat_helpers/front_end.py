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


def _env_enabled(name: str) -> bool:
    return (os.getenv(name) or "").strip().lower() in {"1", "true", "yes", "on"}


def _rag_readiness_mode() -> str:
    """Return the explicit RAG dependency policy with legacy compatibility."""
    configured = (os.getenv("DAEDALUS_RAG_READINESS_MODE") or "").strip().lower()
    if configured:
        if configured not in {"disabled", "degraded", "required"}:
            raise ValueError(
                "DAEDALUS_RAG_READINESS_MODE must be disabled, degraded, or required"
            )
        return configured
    return "required" if _env_enabled("DAEDALUS_RAG_READINESS_ENABLED") else "disabled"


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
        "degraded" if capabilities["unavailable_optional"] or rag_degraded else "ready"
    )
    return JSONResponse({"status": status, "mcp": capabilities, "rag": rag})


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
