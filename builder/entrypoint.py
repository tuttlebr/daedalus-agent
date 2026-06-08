#!/usr/bin/env python3
"""
NAT entrypoint with Starlette compatibility shim and LLM diagnostics.
Runs NAT in-process so that pre-import patches survive.

Replaces: nat serve --config_file=/workspace/config.yaml --host 0.0.0.0 --port 8000
"""

import logging
import os
import sys

# Optional string env vars to seed with "" when unset, so NAT ${...}
# interpolation does not emit None for tools that reference them.
# Currently empty: no tool needs a seeded default right now. Add var
# names here as optional tool config fields are introduced; the
# _configure_optional_tool_env mechanism below is intentionally kept
# wired up for that future use.
OPTIONAL_STRING_ENV_DEFAULTS: tuple[str, ...] = ()


def _configure_optional_tool_env(logger):
    """Seed optional string env vars so NAT interpolation does not emit None."""
    seeded = []
    for name in OPTIONAL_STRING_ENV_DEFAULTS:
        if name not in os.environ:
            os.environ[name] = ""
            seeded.append(name)

    if seeded:
        logger.info(
            "Configured empty defaults for optional tool env vars: %s",
            ", ".join(seeded),
        )


def _patch_starlette_compat(logger):
    """Re-add methods removed in Starlette 1.0.0 that NAT v1.4.x still uses.

    Starlette 1.0.0 (March 2026) removed add_event_handler, add_route,
    add_websocket_route, and several decorators.  NAT's
    FastApiFrontEndPluginWorker relies on at least add_event_handler and
    add_websocket_route.  We delegate to the router where possible;
    for event handlers we store them as a no-op (container is killed on
    shutdown anyway).

    The Dockerfile also pins starlette<1.0.0, but this patch acts as a
    safety net if the pin is ever loosened.
    """
    from fastapi import FastAPI

    patched = []

    if not hasattr(FastAPI, "add_event_handler"):

        def _add_event_handler(self, event_type: str, func):
            handlers = getattr(self, "_compat_event_handlers", None)
            if handlers is None:
                handlers = {}
                self._compat_event_handlers = handlers
            handlers.setdefault(event_type, []).append(func)

        FastAPI.add_event_handler = _add_event_handler
        patched.append("add_event_handler")

    if not hasattr(FastAPI, "add_route"):

        def _add_route(self, path, route, **kwargs):
            self.router.add_route(path, route, **kwargs)

        FastAPI.add_route = _add_route
        patched.append("add_route")

    if not hasattr(FastAPI, "add_websocket_route"):

        def _add_websocket_route(self, path, route, **kwargs):
            self.router.add_websocket_route(path, route, **kwargs)

        FastAPI.add_websocket_route = _add_websocket_route
        patched.append("add_websocket_route")

    if patched:
        logger.info(
            "Patched FastAPI for Starlette 1.0 compatibility: %s",
            ", ".join(patched),
        )
    else:
        logger.debug("Starlette compat patch not needed")


def _patch_fastapi_daedalus_routes(logger):
    """Inject Daedalus HTTP routers into NAT's FastAPI app.

    NAT v1.4.x does not expose a custom-routes extension point, so we
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
    from profile_import_api import router as profile_import_router

    original_init = FastAPI.__init__

    def patched_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        if getattr(self, "_daedalus_routes_attached", False):
            return
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

    _configure_phoenix_auth_env(logging.getLogger("daedalus.phoenix"))
    _configure_optional_tool_env(logging.getLogger("daedalus.optional_env"))

    # Starlette 1.0.0 removed add_event_handler, add_route, add_websocket_route;
    # NAT v1.4.x still calls them.  Patch before any NAT imports.
    _patch_starlette_compat(logging.getLogger("daedalus.starlette_compat"))

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
