#!/usr/bin/env python3
"""
NAT entrypoint with Starlette compatibility shim and LLM diagnostics.
Runs NAT in-process so that pre-import patches survive.

Replaces: nat serve --config_file=/workspace/config.yaml --host 0.0.0.0 --port 8000
"""

import logging
import os
import sys


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


def _patch_fastapi_image_routes(logger):
    """Inject the /v1/images/* router into NAT's FastAPI app.

    NAT v1.4.x does not expose a custom-routes extension point, so we
    wrap FastAPI.__init__ to run after NAT has constructed its app and
    attach our router via include_router. The patch runs exactly once
    per FastAPI instance (guarded by a marker attribute) so it's safe
    if NAT, uvicorn, or any other code also constructs FastAPI apps.
    """
    from fastapi import FastAPI

    original_init = FastAPI.__init__

    def patched_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        if getattr(self, "_daedalus_image_routes_attached", False):
            return
        try:
            from image_api import router as image_router

            self.include_router(image_router)
            self._daedalus_image_routes_attached = True
            logger.info("Attached /v1/images/* router to FastAPI app")
        except Exception:
            logger.exception("Failed to attach /v1/images/* router")

    FastAPI.__init__ = patched_init


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

    # Starlette 1.0.0 removed add_event_handler, add_route, add_websocket_route;
    # NAT v1.4.x still calls them.  Patch before any NAT imports.
    _patch_starlette_compat(logging.getLogger("daedalus.starlette_compat"))

    # Attach our /v1/images/* router to NAT's FastAPI app as it's built.
    _patch_fastapi_image_routes(logging.getLogger("daedalus.image_api"))

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
