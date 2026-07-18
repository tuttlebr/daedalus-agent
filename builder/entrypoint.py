#!/usr/bin/env python3
"""
NAT 1.7 entrypoint with Daedalus routes, authentication, and diagnostics.
Runs NAT in-process so that pre-import patches survive.

Replaces: nat serve --config_file=/workspace/config.yaml --host 0.0.0.0 --port 8000
"""

import logging
import os
import sys
from importlib.metadata import PackageNotFoundError, version

from packaging.version import Version

EXPECTED_NAT_VERSION = "1.7.0"


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

    starlette_version = Version(version("starlette"))
    if not Version("1.3.1") <= starlette_version < Version("2"):
        raise RuntimeError(
            f"Unsupported starlette version {starlette_version}; "
            "require starlette>=1.3.1,<2"
        )


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

    # Apply LLM diagnostic patches before NAT imports create clients
    import llm_diagnostics

    llm_diagnostics.patch()

    # Apply MCP StreamableHTTP timeout + resilience patches before NAT imports
    import mcp_patches

    config = os.environ.get("NAT_CONFIG_FILE", "/workspace/config.yaml")
    mcp_patches.patch(config_path=config)

    # Build sys.argv to simulate: nat serve --config_file=... --host=... --port=...
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
