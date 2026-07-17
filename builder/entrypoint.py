#!/usr/bin/env python3
"""
NAT 1.7 entrypoint with Daedalus routes, authentication, and diagnostics.
Runs NAT in-process so that pre-import patches survive.

Replaces: nat serve --config_file=/workspace/config.yaml --host 0.0.0.0 --port 8000
"""

import asyncio
import contextlib
import logging
import os
import sys
import tempfile
from importlib.metadata import PackageNotFoundError, version

EXPECTED_NAT_VERSION = "1.7.0"
DRAINING_MARKER_PATH = os.path.join(tempfile.gettempdir(), "daedalus-draining")


def _patch_request_metadata_redaction() -> None:
    """Keep transport credentials out of NAT tools and telemetry exports."""

    from nat.runtime.user_metadata import RequestAttributes

    original_to_dict = RequestAttributes.to_dict
    if getattr(original_to_dict, "_daedalus_secret_redaction", False):
        return

    def redacted_to_dict(self):
        result = original_to_dict(self)
        # NAT injects this serialized object into every tracing span. Header and
        # cookie collections can contain internal, approval, OAuth, API-key,
        # and session credentials; none are needed for Phoenix correlation.
        result.pop("headers", None)
        result.pop("cookies", None)
        return result

    redacted_to_dict._daedalus_secret_redaction = True
    RequestAttributes.to_dict = redacted_to_dict


async def _readiness_response():
    """Report whether the security gate and durable state dependency are ready."""
    import mcp_patches
    from fastapi.responses import JSONResponse

    if os.path.exists(DRAINING_MARKER_PATH):
        return JSONResponse({"status": "draining"}, status_code=503)
    if not getattr(mcp_patches, "_approval_gate_installed", False):
        return JSONResponse({"status": "unready"}, status_code=503)

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
                await client.aclose()

    return JSONResponse({"status": "ready"})


def _assert_runtime_versions() -> None:
    """Fail startup when private compatibility code meets an unknown ABI."""

    for distribution in ("nvidia-nat-core", "nvidia-nat-mcp"):
        try:
            installed = version(distribution)
        except PackageNotFoundError as exc:
            raise RuntimeError(
                f"Required runtime package {distribution} is missing"
            ) from exc
        if installed != EXPECTED_NAT_VERSION:
            raise RuntimeError(
                f"Unsupported {distribution} version {installed}; "
                f"Daedalus patches require {EXPECTED_NAT_VERSION}"
            )

    starlette_version = version("starlette")
    if int(starlette_version.split(".", 1)[0]) >= 1:
        raise RuntimeError(
            f"Unsupported starlette version {starlette_version}; require starlette<1"
        )


def _patch_fastapi_daedalus_routes(logger):
    """Inject Daedalus HTTP routers into NAT's FastAPI app.

    The pinned NAT front end does not attach these application routers, so we
    wrap FastAPI.__init__ to run after NAT has constructed its app and
    attach our router via include_router. The patch runs exactly once
    per FastAPI instance (guarded by a marker attribute) so it's safe
    if NAT, uvicorn, or any other code also constructs FastAPI apps.

    The routers are imported once here at patch-setup time. A failed
    import is fatal (we raise) so the container does not start silently
    without the /v1/images/*, /v1/documents/*, and /v1/profile/* endpoints.
    """
    # Import the routers up front so a broken import fails boot loudly
    # instead of silently leaving the endpoints unregistered (404).
    from document_ingest_api import router as document_ingest_router
    from fastapi import FastAPI
    from image_api import router as image_router
    from nat_helpers.internal_auth import DaedalusInternalAuthMiddleware
    from profile_import_api import router as profile_import_router

    original_init = FastAPI.__init__

    def patched_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        if getattr(self, "_daedalus_routes_attached", False):
            return
        self.add_middleware(DaedalusInternalAuthMiddleware)
        self.add_api_route(
            "/health/ready",
            _readiness_response,
            methods=["GET"],
            include_in_schema=False,
        )
        self.include_router(image_router)
        self.include_router(document_ingest_router)
        self.include_router(profile_import_router)
        self._daedalus_routes_attached = True
        logger.info("Attached Daedalus HTTP routers to FastAPI app")

    FastAPI.__init__ = patched_init


def _configure_phoenix_auth_env(logger):
    """Derive OTLP/Phoenix auth headers from PHOENIX_API_KEY when provided."""
    phoenix_api_key = os.environ.get("PHOENIX_API_KEY", "").strip()
    if not phoenix_api_key:
        return

    header = f"api_key={phoenix_api_key}"
    if not os.environ.get("OTEL_EXPORTER_OTLP_HEADERS", "").strip():
        os.environ["OTEL_EXPORTER_OTLP_HEADERS"] = header
        logger.info("Configured OTLP exporter headers from PHOENIX_API_KEY")
    if not os.environ.get("PHOENIX_CLIENT_HEADERS", "").strip():
        os.environ["PHOENIX_CLIENT_HEADERS"] = header


def main():
    # Configure root logging (NAT will reconfigure its own loggers, but this
    # ensures our daedalus.* diagnostic messages are visible)
    log_level = os.environ.get(
        "LOG_LEVEL", os.environ.get("NAT_LOG_LEVEL", "INFO")
    ).upper()
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s - %(levelname)-8s - %(name)s:%(lineno)d - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    _assert_runtime_versions()
    _patch_request_metadata_redaction()
    _configure_phoenix_auth_env(logging.getLogger("daedalus.phoenix"))

    # Attach Daedalus HTTP routers to NAT's FastAPI app as it's built.
    _patch_fastapi_daedalus_routes(logging.getLogger("daedalus.http_api"))

    # Apply LLM diagnostic patches before NAT imports create clients
    import llm_diagnostics

    llm_diagnostics.patch()

    # Apply MCP StreamableHTTP timeout + resilience patches before NAT imports
    import mcp_patches

    mcp_patches.patch()

    # Build sys.argv to simulate: nat serve --config_file=... --host=... --port=...
    config = os.environ.get("NAT_CONFIG_FILE", "/workspace/config.yaml")
    host = os.environ.get("NAT_HOST", "0.0.0.0")  # nosec B104 — container requires all-interface bind
    port = os.environ.get("NAT_PORT", "8000")

    sys.argv = [
        "nat",
        "serve",
        f"--config_file={config}",
        f"--host={host}",
        f"--port={port}",
    ]

    # Run NAT CLI in-process so our patches remain active
    from nat.cli.main import run_cli

    run_cli()


if __name__ == "__main__":
    main()
