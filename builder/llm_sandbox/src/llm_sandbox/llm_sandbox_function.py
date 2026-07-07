"""HTTP client wrapper for the Daedalus LLM sandbox service."""

import json
import logging
import os
from typing import Literal

import httpx
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "http://llm-sandbox-llm-sandbox.llm-sandbox.svc.cluster.local:8080"


class LlmSandboxConfig(FunctionBaseConfig, name="llm_sandbox"):
    """Configuration for the LLM sandbox function."""

    base_url: str = Field(
        default_factory=lambda: os.environ.get(
            "LLM_SANDBOX_BASE_URL", DEFAULT_BASE_URL
        ),
        description="Base URL for the LLM sandbox HTTP service.",
    )
    api_key: str = Field(
        default_factory=lambda: os.environ.get("LLM_SANDBOX_API_KEY", ""),
        description="Bearer token for the LLM sandbox service.",
    )
    request_timeout: float = Field(
        default=70.0,
        ge=1.0,
        le=600.0,
        description="HTTP request timeout in seconds.",
    )
    default_timeout_seconds: int = Field(
        default=30,
        ge=1,
        le=600,
        description="Sandbox command timeout when timeout_seconds is omitted.",
    )


def _error(message: str) -> str:
    return f"Error: {message}"


def _parse_env_json(env_json: str) -> dict[str, str] | str:
    if not env_json.strip():
        return {}
    try:
        parsed = json.loads(env_json)
    except json.JSONDecodeError as exc:
        return _error(f"env_json must be a JSON object: {exc.msg}.")
    if not isinstance(parsed, dict):
        return _error("env_json must be a JSON object.")
    if not all(
        isinstance(key, str) and isinstance(value, str) for key, value in parsed.items()
    ):
        return _error("env_json keys and values must all be strings.")
    return parsed


def _format_commands(data: dict) -> str:
    commands = data.get("commands") or data.get("allowedCommands") or []
    lines = [
        "## Sandbox Commands",
        f"Shell: {data.get('shell', 'unknown')}",
        f"Path: {data.get('path', 'unknown')}",
        f"Count: {data.get('count', len(commands))}",
        "",
        ", ".join(map(str, commands)) if commands else "No commands reported.",
    ]
    missing = data.get("missingCommands") or []
    if missing:
        lines.extend(["", f"Missing: {', '.join(map(str, missing))}"])
    return "\n".join(lines)


def _format_execute_result(data: dict) -> str:
    lines = [
        "## Sandbox Execution Result",
        f"Request ID: {data.get('requestId', 'unknown')}",
        f"Exit code: {data.get('exitCode', 'unknown')}",
        f"Duration: {data.get('durationMs', 'unknown')} ms",
        f"Timed out: {data.get('timedOut', False)}",
        f"Truncated: {data.get('truncated', False)}",
        "",
        "### stdout",
        "```",
        str(data.get("stdout", "")),
        "```",
        "",
        "### stderr",
        "```",
        str(data.get("stderr", "")),
        "```",
    ]
    return "\n".join(lines)


@register_function(config_type=LlmSandboxConfig)
async def llm_sandbox_function(config: LlmSandboxConfig, builder: Builder):  # noqa: ARG001
    api_key = config.api_key or os.environ.get("LLM_SANDBOX_API_KEY", "")
    base_url = (config.base_url or DEFAULT_BASE_URL).rstrip("/")

    async def _sandbox(
        operation: Literal["list_commands", "execute"] = "execute",
        command: str = "",
        timeout_seconds: int = 0,
        env_json: str = "",
        working_directory: str = ".",
    ) -> str:
        """Run allowlisted shell commands in the isolated LLM sandbox.

        Args:
            operation: list_commands to inspect available commands, or execute.
            command: Command string for execute.
            timeout_seconds: Optional command timeout; 0 uses the configured default.
            env_json: Optional JSON object of string environment variables.
            working_directory: Optional relative sandbox working directory.
        """
        if not api_key:
            return _error("LLM_SANDBOX_API_KEY is not configured.")

        headers = {"Authorization": f"Bearer {api_key}"}
        try:
            async with httpx.AsyncClient(
                base_url=base_url, timeout=config.request_timeout
            ) as client:
                if operation == "list_commands":
                    response = await client.get("/v1/commands", headers=headers)
                    response.raise_for_status()
                    return _format_commands(response.json())

                if operation != "execute":
                    return _error("operation must be list_commands or execute.")

                normalized_command = command.strip()
                if not normalized_command:
                    return _error("command is required for execute.")

                env = _parse_env_json(env_json)
                if isinstance(env, str):
                    return env

                payload = {
                    "command": normalized_command,
                    "timeoutSeconds": timeout_seconds or config.default_timeout_seconds,
                    "env": env,
                    "workingDirectory": working_directory or ".",
                }
                response = await client.post(
                    "/v1/execute", headers=headers, json=payload
                )
                response.raise_for_status()
                return _format_execute_result(response.json())
        except httpx.HTTPStatusError as exc:
            logger.error(
                "LLM sandbox returned %d: %s",
                exc.response.status_code,
                exc.response.text[:500],
            )
            return _error(
                "LLM sandbox returned status "
                f"{exc.response.status_code}: {exc.response.text[:500]}"
            )
        except httpx.RequestError as exc:
            logger.error("LLM sandbox request failed: %s", exc)
            return _error(f"Could not reach LLM sandbox: {exc}")
        except ValueError:
            logger.error("LLM sandbox returned invalid JSON")
            return _error("LLM sandbox returned invalid JSON.")

    try:
        yield FunctionInfo.from_fn(
            _sandbox,
            description=(
                "Run allowlisted Linux commands in the isolated Daedalus LLM sandbox. "
                "Use operation=list_commands to inspect available commands, and "
                "operation=execute with command to run one command in a fresh "
                "workspace."
            ),
        )
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up llm_sandbox function.")
