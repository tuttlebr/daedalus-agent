"""Tests for the user_interaction package -- structured user interaction framework."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class FakeRedis:
    def __init__(self):
        self.store = {}

    def setex(self, key, ttl, value):
        self.store[key] = value
        return True

    def set(self, key, value):
        self.store[key] = value
        return True

    def get(self, key):
        return self.store.get(key)

    def getdel(self, key):
        return self.store.pop(key, None)

    def delete(self, *keys):
        deleted = 0
        for key in keys:
            if key in self.store:
                del self.store[key]
                deleted += 1
        return deleted

    def scan_iter(self, pattern):
        import fnmatch

        return (key for key in list(self.store) if fnmatch.fnmatch(key, pattern))

    def execute_command(self, command, key):
        if command != "JSON.GET":
            raise ValueError(command)
        return self.store.get(key)


def run(coro):
    """Run a coroutine synchronously."""
    return asyncio.run(coro)


def test_approval_redis_url_uses_standard_redis_host(monkeypatch):
    from user_interaction.approval_tokens import build_redis_url

    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("REDIS_USERNAME", raising=False)
    monkeypatch.delenv("REDIS_PASSWORD", raising=False)
    monkeypatch.delenv("REDIS_TLS_ENABLED", raising=False)
    monkeypatch.delenv("REDIS_TLS_CA_FILE", raising=False)
    monkeypatch.setenv("REDIS_HOST", "redis.internal")
    monkeypatch.setenv("REDIS_PORT", "6380")

    assert build_redis_url() == "redis://redis.internal:6380"


def test_approval_redis_url_encodes_acl_credentials_and_tls(monkeypatch):
    from user_interaction.approval_tokens import build_redis_url

    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.setenv("REDIS_HOST", "2001:db8::8")
    monkeypatch.setenv("REDIS_PORT", "6380")
    monkeypatch.setenv("REDIS_USERNAME", "approval user")
    monkeypatch.setenv("REDIS_PASSWORD", "p@ss word/#")
    monkeypatch.setenv("REDIS_TLS_ENABLED", "true")
    monkeypatch.setenv("REDIS_TLS_CA_FILE", "/etc/redis tls/ca.crt")

    assert build_redis_url() == (
        "rediss://approval%20user:p%40ss%20word%2F%23@[2001:db8::8]:6380"
        "?ssl_ca_certs=%2Fetc%2Fredis+tls%2Fca.crt"
    )


def test_approval_redis_url_prefers_explicit_url(monkeypatch):
    from user_interaction.approval_tokens import build_redis_url

    monkeypatch.setenv("REDIS_HOST", "ignored")
    monkeypatch.setenv("REDIS_URL", "rediss://daedalus@example.test:6379/0")

    assert build_redis_url() == "rediss://daedalus@example.test:6379/0"


def test_approval_redis_url_adds_port_before_database_path(monkeypatch):
    from user_interaction.approval_tokens import build_redis_url

    monkeypatch.setenv("REDIS_URL", "redis://daedalus@example.test/2?health=1")
    monkeypatch.setenv("REDIS_PORT", "6380")

    assert build_redis_url() == ("redis://daedalus@example.test:6380/2?health=1")


async def _get_tools(config_overrides=None):
    """Instantiate the unified user_interaction tool."""
    from user_interaction.user_interaction_function import (
        UserInteractionConfig,
        user_interaction_function,
    )

    kwargs = config_overrides or {}
    config = UserInteractionConfig(**kwargs)
    builder = MagicMock()
    items = []
    async for item in user_interaction_function(config, builder):
        items.append(item)
    return items


def _operation(items, operation):
    """Bind one dispatcher operation for readable behavior tests."""

    async def invoke(**kwargs):
        return await items[0].fn(operation=operation, **kwargs)

    invoke.__name__ = operation
    return invoke


class TestUserInteractionRegistration:
    def test_yields_exactly_one_function_info(self):
        items = run(_get_tools())
        assert len(items) == 1

    def test_all_have_fn_and_description(self):
        items = run(_get_tools())
        assert items[0].fn is not None
        assert items[0].description
        assert items[0].input_schema is not None

    def test_tool_schema_requires_an_explicit_operation(self):
        items = run(_get_tools())
        schema = items[0].input_schema.model_json_schema()
        assert items[0].fn.__name__ == "user_interaction"
        assert schema["required"] == ["operation"]
        assert schema["properties"]["operation"]["enum"] == [
            "confirm_action",
            "delete_memory_guarded",
        ]


def test_mcp_argument_preview_redacts_nested_and_embedded_credentials():
    from user_interaction.approval_tokens import (
        canonicalize_mcp_arguments,
        redacted_mcp_arguments,
    )

    # Assemble the credential markers at runtime so the redaction regression
    # test does not itself look like a committed live secret to Gitleaks.
    authorization_key = "Authori" + "zation"
    bearer_scheme = "Bear" + "er"
    token_key = "API_" + "TOKEN"
    nested_value = "nested-" + "secret"
    command_value = "command-" + "secret"
    environment_value = "environment-" + "secret"

    canonical, _ = canonicalize_mcp_arguments(
        json.dumps(
            {
                "name": "safe-resource",
                "headers": {authorization_key: f"{bearer_scheme} {nested_value}"},
                "command": (
                    f"curl -H '{authorization_key}: {bearer_scheme} "
                    f"{command_value}' https://x"
                ),
                "env": [f"{token_key}={environment_value}", "MODE=production"],
                "url": "https://user:url-secret@example.test/path",
                "content": "private document text",
                "description": "x" * 300,
            }
        )
    )

    preview = redacted_mcp_arguments(canonical)
    assert "safe-resource" in preview
    assert nested_value not in preview
    assert command_value not in preview
    assert environment_value not in preview
    assert "url-secret" not in preview
    assert "private document text" not in preview
    assert "[REDACTED CONTENT: 21 chars]" in preview
    assert "[REDACTED TEXT: 300 chars]" in preview
    assert preview.count("[REDACTED]") >= 4


def test_pending_mcp_approval_rejects_empty_action_or_reason():
    from user_interaction.approval_tokens import create_pending_mcp_approval

    for action, reason in (("", "Requested in chat"), ("Update doc", "")):
        with pytest.raises(ValueError, match="exact action and reason"):
            create_pending_mcp_approval(
                FakeRedis(),
                user_id="brandon",
                action=action,
                reason=reason,
                target="document/doc-1",
                server_name="docs_mcp_server",
                tool_name="update_doc",
                arguments_json='{"documentId":"doc-1","requests":[]}',
            )


@pytest.mark.parametrize(
    "field",
    ["user_id", "target", "action_type", "server_name", "tool_name", "arguments_json"],
)
def test_memory_tool_rejects_model_supplied_identity_and_mcp_scope(field):
    from pydantic import ValidationError

    async def check():
        tools = await _get_tools()
        with pytest.raises(ValidationError):
            await tools[0].ainvoke(
                {
                    "operation": "confirm_action",
                    "action": "Delete memory",
                    "reason": "User requested deletion",
                    field: "other-user",
                }
            )

    run(check())


def test_confirmation_is_scoped_and_never_mints_credentials(monkeypatch):
    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "synthetic-internal")
    import user_interaction.user_interaction_function as mod
    from nat_helpers.identity import authenticated_request_headers_scope

    async def check():
        tools = await _get_tools()
        with authenticated_request_headers_scope(
            {
                "x-user-id": "synthetic-owner",
                "x-daedalus-internal-token": "synthetic-internal",
            }
        ), patch.object(mod, "make_redis_client") as redis:
            result = await tools[0].ainvoke(
                {
                    "operation": "confirm_action",
                    "action": "Delete memory",
                    "reason": "User request",
                }
            )
            assert "target=`synthetic-owner`" in result
            assert "Delete all of your durable memory" in result
            assert "No executable credential" in result
            redis.assert_not_called()

    run(check())


def test_guarded_delete_requires_identity_owner_and_single_use_token(monkeypatch):
    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "synthetic-internal")
    from contextlib import asynccontextmanager

    import user_interaction.user_interaction_function as mod
    from nat_helpers.identity import authenticated_request_headers_scope
    from user_interaction.approval_tokens import ApprovalRequest, issue_approval_token

    async def check():
        redis = FakeRedis()
        redis.close = MagicMock()
        token = issue_approval_token(
            redis,
            ApprovalRequest(
                user_id="owner", action_type="delete_memory", target="owner"
            ),
        )
        wrong = issue_approval_token(
            redis,
            ApprovalRequest(
                user_id="other", action_type="delete_memory", target="other"
            ),
        )
        with patch.object(mod, "make_redis_client", return_value=redis), patch(
            "nat_helpers.hindsight_client.client_from_env", return_value=object()
        ), patch(
            "nat_helpers.hindsight_client.memory_mode", return_value="hindsight"
        ), patch(
            "nat_helpers.memory_lifecycle.clear_user_memory", new_callable=AsyncMock
        ) as clear:
            async with asynccontextmanager(mod.user_interaction_function)(
                mod.UserInteractionConfig(), MagicMock()
            ) as tool:
                args = {"operation": "delete_memory_guarded", "approval_token": token}
                assert "authenticated user" in await tool.ainvoke(args)
                with authenticated_request_headers_scope(
                    {
                        "x-user-id": "owner",
                        "x-daedalus-internal-token": "synthetic-internal",
                    }
                ):
                    assert "denied" in await tool.ainvoke(
                        {**args, "approval_token": wrong}
                    )
                    clear.assert_not_awaited()
                    assert await tool.ainvoke(args) == "Durable memory cleared."
                    assert "denied" in await tool.ainvoke(args)
                    assert clear.await_count == 1
                    assert clear.await_args.args[1] == "owner"
        redis.close.assert_called_once()

    run(check())
