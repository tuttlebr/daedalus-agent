"""Approval-token helpers shared by the MCP approval gate and approval API."""

import hashlib
import json

import pytest


class FakeRedis:
    def __init__(self):
        self.store = {}

    def setex(self, key, ttl, value):
        self.store[key] = value
        return True


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


def test_pending_mcp_approval_stores_exact_canonical_intent_without_preview():
    from user_interaction.approval_tokens import create_pending_mcp_approval

    redis = FakeRedis()
    pending = create_pending_mcp_approval(
        redis,
        user_id="brandon",
        action="Update doc",
        reason="Requested in chat",
        target="document/doc-1",
        server_name="docs_mcp_server",
        tool_name="update_doc",
        arguments_json='{"requests":[],"documentId":"doc-1","approval_token":"x"}',
    )

    # The UI renders and redacts its preview from these exact stored arguments
    # (frontend/server/chat/mcpApproval.ts); a forged credential is stripped.
    assert pending["canonical_arguments"] == '{"documentId":"doc-1","requests":[]}'
    assert (
        pending["arguments_sha256"]
        == hashlib.sha256(pending["canonical_arguments"].encode()).hexdigest()
    )
    stored = json.loads(next(iter(redis.store.values())))
    assert stored == pending
    assert "arguments_preview" not in stored


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
