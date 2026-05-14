"""Tests for MCP destructive-action approval helpers."""

import mcp_patches


def test_read_only_mcp_call_does_not_need_token():
    ok, reason = mcp_patches._validate_mcp_approval(
        "get_pod",
        {"namespace": "default", "name": "api"},
    )
    assert ok is True
    assert reason == "read-only"


def test_mutating_mcp_call_requires_token():
    ok, reason = mcp_patches._validate_mcp_approval(
        "delete_pod",
        {"namespace": "default", "name": "api"},
    )
    assert ok is False
    assert "approval_token" in reason


def test_gmail_create_draft_is_not_blocked_by_generic_create_gate():
    for tool_name in ("create_draft", "gmail_mcp_server.create_draft"):
        ok, reason = mcp_patches._validate_mcp_approval(
            tool_name,
            {"to": "user@example.com", "subject": "Hello", "body": "Draft body"},
        )
        assert ok is True
        assert reason == "read-only"


def test_strip_approval_token_removes_nested_values():
    args = ({"arguments": {"approval_token": "secret", "name": "api"}},)
    kwargs = {"approval_token": "secret2"}
    mcp_patches._strip_approval_token(args, kwargs)
    assert "approval_token" not in args[0]["arguments"]
    assert "approval_token" not in kwargs
