#!/usr/bin/env python3
"""
Enhanced NAT entrypoint that applies runtime patches before starting
the workflow server. Runs NAT in-process (not via os.execvp) so that
monkey-patches to the OpenAI SDK and MCP client survive.

Replaces: nat serve --config_file=/workspace/config.yaml --host 0.0.0.0 --port 8000
"""

import logging
import os
import sys


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

    # Apply patches BEFORE nat imports create clients
    import llm_diagnostics

    llm_diagnostics.patch()

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
