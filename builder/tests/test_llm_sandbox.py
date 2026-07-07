"""Tests for the LLM sandbox tool."""

import asyncio
from unittest.mock import MagicMock, patch

import httpx


def run(coro):
    return asyncio.run(coro)


class FakeResponse:
    def __init__(self, status_code=200, data=None, text=""):
        self.status_code = status_code
        self._data = data or {}
        self.text = text

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("error", request=object(), response=self)

    def json(self):
        return self._data


class FakeAsyncClient:
    last_base_url = None
    last_headers = None
    last_json = None
    response = FakeResponse(
        data={
            "shell": "/bin/sh -lc",
            "path": "/usr/bin:/bin",
            "commands": ["cat", "jq"],
            "count": 2,
            "missingCommands": [],
        }
    )

    def __init__(self, base_url=None, timeout=None):
        FakeAsyncClient.last_base_url = base_url
        self.timeout = timeout

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, path, headers):
        FakeAsyncClient.last_headers = headers
        return FakeAsyncClient.response

    async def post(self, path, headers, json):
        FakeAsyncClient.last_headers = headers
        FakeAsyncClient.last_json = json
        return FakeAsyncClient.response


async def _registered_sandbox_fn(config):
    from llm_sandbox.llm_sandbox_function import llm_sandbox_function

    items = []
    async for item in llm_sandbox_function(config, MagicMock()):
        items.append(item)
    return items[0].fn


def test_config_reads_llm_sandbox_api_key(monkeypatch):
    from llm_sandbox.llm_sandbox_function import LlmSandboxConfig

    monkeypatch.setenv("LLM_SANDBOX_API_KEY", "env-key")

    assert LlmSandboxConfig().api_key == "env-key"


def test_missing_api_key_returns_readable_error(monkeypatch):
    from llm_sandbox.llm_sandbox_function import LlmSandboxConfig

    async def _run():
        monkeypatch.delenv("LLM_SANDBOX_API_KEY", raising=False)
        sandbox = await _registered_sandbox_fn(LlmSandboxConfig(api_key=""))
        return await sandbox(operation="list_commands")

    assert "LLM_SANDBOX_API_KEY" in run(_run())


def test_list_commands_uses_bearer_auth():
    import llm_sandbox.llm_sandbox_function as mod
    from llm_sandbox.llm_sandbox_function import LlmSandboxConfig

    async def _run():
        FakeAsyncClient.response = FakeResponse(
            data={
                "shell": "/bin/sh -lc",
                "path": "/usr/bin:/bin",
                "commands": ["cat", "jq"],
                "count": 2,
            }
        )
        with patch.object(mod.httpx, "AsyncClient", FakeAsyncClient):
            sandbox = await _registered_sandbox_fn(
                LlmSandboxConfig(api_key="test-key", base_url="http://sandbox")
            )
            return await sandbox(operation="list_commands")

    output = run(_run())

    assert FakeAsyncClient.last_base_url == "http://sandbox"
    assert FakeAsyncClient.last_headers["Authorization"] == "Bearer test-key"
    assert "cat, jq" in output


def test_execute_posts_command_payload():
    import llm_sandbox.llm_sandbox_function as mod
    from llm_sandbox.llm_sandbox_function import LlmSandboxConfig

    async def _run():
        FakeAsyncClient.response = FakeResponse(
            data={
                "requestId": "req-1",
                "exitCode": 0,
                "stdout": "hello",
                "stderr": "",
                "durationMs": 12,
                "timedOut": False,
                "truncated": False,
            }
        )
        with patch.object(mod.httpx, "AsyncClient", FakeAsyncClient):
            sandbox = await _registered_sandbox_fn(
                LlmSandboxConfig(api_key="test-key", base_url="http://sandbox")
            )
            return await sandbox(
                operation="execute",
                command=" printf hello ",
                timeout_seconds=5,
                env_json='{"EXAMPLE":"value"}',
                working_directory="work",
            )

    output = run(_run())

    assert FakeAsyncClient.last_json == {
        "command": "printf hello",
        "timeoutSeconds": 5,
        "env": {"EXAMPLE": "value"},
        "workingDirectory": "work",
    }
    assert "Exit code: 0" in output
    assert "hello" in output


def test_execute_rejects_invalid_env_json():
    from llm_sandbox.llm_sandbox_function import LlmSandboxConfig

    async def _run():
        sandbox = await _registered_sandbox_fn(LlmSandboxConfig(api_key="test-key"))
        return await sandbox(
            operation="execute",
            command="printf hello",
            env_json='{"EXAMPLE": 1}',
        )

    assert run(_run()) == "Error: env_json keys and values must all be strings."
