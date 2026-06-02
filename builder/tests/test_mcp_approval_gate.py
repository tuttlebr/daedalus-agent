"""Tests for MCP destructive-action approval helpers."""

import mcp_patches
import pytest


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


@pytest.mark.parametrize(
    "tool_name",
    [
        "kubectl_exec",
        "exec_command",
        "cordon_node",
        "drain_node",
        "evict_pod",
        "rollout_restart",
        "set_image",
        "revoke_token",
        "send_email",
        "remove_user",
        "terminate_instance",
        "destroy_cluster",
    ],
)
def test_additional_destructive_verbs_require_token(tool_name):
    # F-005 regression: destructive verbs beyond the original 9 fragments
    # (notably kubectl exec/cordon/drain/set/rollout) must be gated.
    ok, reason = mcp_patches._validate_mcp_approval(tool_name, {})
    assert ok is False, f"{tool_name} should require approval"
    assert "approval_token" in reason


@pytest.mark.parametrize(
    "tool_name,payload",
    [
        ("get_pod", {"namespace": "default", "name": "api"}),
        ("list_labels", {}),  # gmail read tool: 'labels' must NOT match 'label'
        ("list_events", {}),
        ("get_thread", {}),
        ("search_code", {"query": "foo"}),
        ("list_commits", {}),
        ("get_file_contents", {}),
        ("describe_node", {}),
        ("get_assets", {}),  # 'asset' must NOT match the 'set' token
    ],
)
def test_read_only_tools_are_not_over_gated(tool_name, payload):
    # F-005 regression: whole-token matching for short verbs must not over-gate
    # read-only tool names that merely contain those letters.
    ok, reason = mcp_patches._validate_mcp_approval(tool_name, payload)
    assert ok is True, f"{tool_name} should be read-only"
    assert reason == "read-only"


class _Annotations:
    """Stand-in for an MCP Tool.annotations pydantic model."""

    def __init__(self, **hints):
        for k, v in hints.items():
            setattr(self, k, v)


def test_destructive_hint_gates_tool_with_no_listed_verb():
    # F-009: a mutating tool whose name carries no denylist verb is still gated
    # when the server declares destructiveHint=True.
    ok, reason = mcp_patches._validate_mcp_approval(
        "shuffle_records",  # no listed verb/token
        {},
        annotations=_Annotations(destructiveHint=True),
    )
    assert ok is False
    assert "approval_token" in reason


def test_destructive_hint_via_dict_annotations():
    # Annotations may arrive as a plain dict rather than a model.
    ok, _ = mcp_patches._validate_mcp_approval(
        "ingest_blob",
        {},
        annotations={"destructiveHint": True},
    )
    assert ok is False


def test_read_only_hint_exempts_tool_with_mutating_verb():
    # readOnlyHint=True trusts the server's declaration that the tool cannot
    # mutate state, even though "update" appears in the name.
    ok, reason = mcp_patches._validate_mcp_approval(
        "update_dashboard_view",
        {},
        annotations=_Annotations(readOnlyHint=True),
    )
    assert ok is True
    assert reason == "read-only"


def test_destructive_hint_wins_over_read_only_hint():
    # If both hints are set True (malformed), fail closed: treat as mutating.
    ok, _ = mcp_patches._validate_mcp_approval(
        "noop_tool",
        {},
        annotations=_Annotations(destructiveHint=True, readOnlyHint=True),
    )
    assert ok is False


def test_no_annotations_falls_back_to_verb_heuristic():
    # Absent annotations, the verb denylist still applies (regression guard).
    ok, _ = mcp_patches._validate_mcp_approval("delete_pod", {}, annotations=None)
    assert ok is False
    ok, reason = mcp_patches._validate_mcp_approval("get_pod", {}, annotations=None)
    assert ok is True
    assert reason == "read-only"


def test_non_bool_hint_is_ignored():
    # A non-bool annotation value must not change behavior (falls through to verb).
    ok, reason = mcp_patches._validate_mcp_approval(
        "get_pod",
        {},
        annotations=_Annotations(destructiveHint="yes", readOnlyHint=None),
    )
    assert ok is True
    assert reason == "read-only"


def test_extract_tool_annotations_from_tool_def():
    # The wrapper reads annotations off the underlying MCP Tool definition.
    class _Tool:
        annotations = _Annotations(destructiveHint=True)

    class _Client:
        _tool = _Tool()

    ann = mcp_patches._extract_tool_annotations(_Client())
    assert mcp_patches._annotation_hint(ann, "destructiveHint") is True


def test_extract_tool_annotations_returns_none_when_absent():
    class _Client:
        pass

    assert mcp_patches._extract_tool_annotations(_Client()) is None
    assert mcp_patches._extract_tool_annotations(None) is None


def test_verify_approval_gate_fails_closed(monkeypatch):
    # F-006 regression: MCP client present but gate not installed -> refuse start.
    monkeypatch.setattr(mcp_patches, "_mcp_client_available", True)
    monkeypatch.setattr(mcp_patches, "_approval_gate_installed", False)
    monkeypatch.delenv("MCP_APPROVAL_GATE_OPTIONAL", raising=False)
    with pytest.raises(RuntimeError):
        mcp_patches._verify_approval_gate_installed()


def test_verify_approval_gate_optout_allows_start(monkeypatch):
    monkeypatch.setattr(mcp_patches, "_mcp_client_available", True)
    monkeypatch.setattr(mcp_patches, "_approval_gate_installed", False)
    monkeypatch.setenv("MCP_APPROVAL_GATE_OPTIONAL", "1")
    mcp_patches._verify_approval_gate_installed()  # must not raise


def test_verify_approval_gate_skips_when_mcp_absent(monkeypatch):
    monkeypatch.setattr(mcp_patches, "_mcp_client_available", False)
    monkeypatch.setattr(mcp_patches, "_approval_gate_installed", False)
    monkeypatch.delenv("MCP_APPROVAL_GATE_OPTIONAL", raising=False)
    mcp_patches._verify_approval_gate_installed()  # MCP not in use -> no raise
