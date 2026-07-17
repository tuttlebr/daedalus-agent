"""Tests for MCP destructive-action approval helpers."""

import asyncio
import hashlib
import json
import sys
import types

import mcp_patches
import pytest


class _FakeRedis:
    def __init__(self):
        self.store = {}
        self.ttls = {}

    def setex(self, key, ttl, value):
        self.store[key] = value
        self.ttls[key] = ttl

    def getdel(self, key):
        return self.store.pop(key, None)


def test_mcp_success_receipt_is_hashed_exact_short_lived_and_single_use():
    from user_interaction.approval_tokens import (
        consume_mcp_execution_receipt,
        mcp_execution_receipt_key,
        record_mcp_execution_receipt,
    )

    redis = _FakeRedis()
    token = "worker-only-secret-token"
    arguments_hash = hashlib.sha256(b'{"name":"api","replicas":3}').hexdigest()
    record_mcp_execution_receipt(
        redis,
        user_id="alice",
        token=token,
        server_name="k8s_mcp_server",
        tool_name="scale_deployment",
        arguments_sha256=arguments_hash,
    )

    receipt_key = mcp_execution_receipt_key(token)
    assert receipt_key.endswith(hashlib.sha256(token.encode()).hexdigest())
    assert token not in receipt_key
    assert token not in redis.store[receipt_key]
    assert redis.ttls[receipt_key] == 300
    assert consume_mcp_execution_receipt(
        redis,
        user_id="alice",
        token=token,
        server_name="k8s_mcp_server",
        tool_name="scale_deployment",
        arguments_sha256=arguments_hash,
    )
    assert not consume_mcp_execution_receipt(
        redis,
        user_id="alice",
        token=token,
        server_name="k8s_mcp_server",
        tool_name="scale_deployment",
        arguments_sha256=arguments_hash,
    )


def test_mcp_success_receipt_mismatch_is_consumed():
    from user_interaction.approval_tokens import (
        consume_mcp_execution_receipt,
        record_mcp_execution_receipt,
    )

    redis = _FakeRedis()
    token = "worker-only-secret-token"
    arguments_hash = "a" * 64
    record_mcp_execution_receipt(
        redis,
        user_id="alice",
        token=token,
        server_name="k8s_mcp_server",
        tool_name="scale_deployment",
        arguments_sha256=arguments_hash,
    )
    assert not consume_mcp_execution_receipt(
        redis,
        user_id="alice",
        token=token,
        server_name="k8s_mcp_server",
        tool_name="delete_deployment",
        arguments_sha256=arguments_hash,
    )
    assert not consume_mcp_execution_receipt(
        redis,
        user_id="alice",
        token=token,
        server_name="k8s_mcp_server",
        tool_name="scale_deployment",
        arguments_sha256=arguments_hash,
    )


@pytest.mark.parametrize(
    "result,raised,receipt_expected",
    [
        ("scaled", None, True),
        ("MCPToolClient tool call failed: rejected", None, False),
        (None, TimeoutError("tool timed out"), False),
    ],
)
def test_gate_records_receipt_only_for_successful_approved_result(
    monkeypatch, result, raised, receipt_expected
):
    calls = {"tool": 0, "receipts": []}

    class FakeMCPToolClient:
        _tool_name = "scale_deployment"
        input_schema = None

        def __init__(self):
            self._parent_client = types.SimpleNamespace(
                server_name="k8s_mcp_server",
                _reconnect_enabled=True,
            )

        async def acall(self, tool_args):
            calls["tool"] += 1
            if raised is not None:
                raise raised
            return result

    fake_module = types.ModuleType("nat.plugins.mcp.client.tool_client")
    fake_module.MCPToolClient = FakeMCPToolClient
    for module_name in (
        "nat",
        "nat.plugins",
        "nat.plugins.mcp",
        "nat.plugins.mcp.client",
    ):
        module = types.ModuleType(module_name)
        module.__path__ = []
        monkeypatch.setitem(sys.modules, module_name, module)
    monkeypatch.setitem(
        sys.modules,
        "nat.plugins.mcp.client.tool_client",
        fake_module,
    )
    from nat_helpers import identity

    monkeypatch.setattr(identity, "approval_token_from_context", lambda: "secret")

    def approve(*args, **_kwargs):
        args[-1].update(
            {
                "user_id": "alice",
                "action_type": "mcp_mutation",
                "target": "production/api",
                "server_name": "k8s_mcp_server",
                "tool_name": "scale_deployment",
                "arguments_sha256": "a" * 64,
            }
        )
        return True, "approved"

    monkeypatch.setattr(mcp_patches, "_validate_mcp_approval", approve)
    monkeypatch.setattr(
        mcp_patches,
        "_record_approved_mcp_receipt",
        lambda **kwargs: calls["receipts"].append(kwargs) or True,
    )
    monkeypatch.setattr(mcp_patches, "_mcp_client_available", False)
    monkeypatch.setattr(mcp_patches, "_approval_gate_installed", False)
    mcp_patches._patch_tool_client()

    wrapped_result = asyncio.run(
        FakeMCPToolClient().acall({"name": "api", "replicas": 3})
    )

    assert calls["tool"] == 1
    assert bool(calls["receipts"]) is receipt_expected
    if receipt_expected:
        assert calls["receipts"][0]["approval_token"] == "secret"
        assert calls["receipts"][0]["validated_binding"]["tool_name"] == (
            "scale_deployment"
        )
    if raised is not None:
        assert "mcp_tool_failed" in wrapped_result


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
    assert "execution credential" in reason


def test_mutating_approval_is_exact_and_single_use(monkeypatch):
    from nat_helpers import identity
    from user_interaction import approval_tokens
    from user_interaction.approval_tokens import ApprovalRequest, issue_approval_token

    redis = _FakeRedis()
    payload = {
        "namespace": "production",
        "name": "api",
        "replicas": 3,
    }
    arguments_hash = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    token = issue_approval_token(
        redis,
        ApprovalRequest(
            user_id="alice",
            action_type="mcp_mutation",
            target="production/api",
            server_name="k8s_mcp_server",
            tool_name="scale_deployment",
            arguments_sha256=arguments_hash,
            canonical_arguments=json.dumps(
                payload, sort_keys=True, separators=(",", ":")
            ),
        ),
    )
    monkeypatch.setattr(
        identity,
        "authenticated_user_id_from_context_or_fallback",
        lambda _asserted: "alice",
    )
    monkeypatch.setattr(approval_tokens, "make_redis_client", lambda _url: redis)

    ok, reason = mcp_patches._validate_mcp_approval(
        "scale_deployment",
        payload,
        server_name="k8s_mcp_server",
        approval_token=token,
    )
    assert (ok, reason) == (True, "approved")

    replay_ok, replay_reason = mcp_patches._validate_mcp_approval(
        "scale_deployment",
        payload,
        server_name="k8s_mcp_server",
        approval_token=token,
    )
    assert replay_ok is False
    assert "already used" in replay_reason


def test_receipt_keeps_original_approved_hash_when_schema_adds_default(monkeypatch):
    from nat_helpers import identity
    from pydantic import BaseModel
    from user_interaction import approval_tokens
    from user_interaction.approval_tokens import (
        ApprovalRequest,
        consume_mcp_execution_receipt,
        issue_approval_token,
    )

    class ToolInput(BaseModel):
        name: str
        propagation_policy: str = "Foreground"

    redis = _FakeRedis()
    approved_payload = {"name": "api"}
    canonical_arguments = json.dumps(
        approved_payload, sort_keys=True, separators=(",", ":")
    )
    approved_hash = hashlib.sha256(canonical_arguments.encode()).hexdigest()
    normalized_arguments = json.dumps(
        ToolInput.model_validate(approved_payload).model_dump(mode="json"),
        sort_keys=True,
        separators=(",", ":"),
    )
    assert hashlib.sha256(normalized_arguments.encode()).hexdigest() != approved_hash
    token = issue_approval_token(
        redis,
        ApprovalRequest(
            user_id="alice",
            action_type="mcp_mutation",
            target="production/api",
            server_name="k8s_mcp_server",
            tool_name="delete_deployment",
            arguments_sha256=approved_hash,
            canonical_arguments=canonical_arguments,
        ),
    )
    monkeypatch.setattr(
        identity,
        "authenticated_user_id_from_context_or_fallback",
        lambda _asserted: "alice",
    )
    monkeypatch.setattr(approval_tokens, "make_redis_client", lambda _url: redis)
    binding = {}

    ok, reason = mcp_patches._validate_mcp_approval(
        "delete_deployment",
        approved_payload,
        server_name="k8s_mcp_server",
        approval_token=token,
        input_schema=ToolInput,
        validated_binding=binding,
    )

    assert (ok, reason) == (True, "approved")
    assert binding["arguments_sha256"] == approved_hash
    assert mcp_patches._record_approved_mcp_receipt(
        approval_token=token,
        validated_binding=binding,
    )
    assert consume_mcp_execution_receipt(
        redis,
        user_id="alice",
        token=token,
        server_name="k8s_mcp_server",
        tool_name="delete_deployment",
        arguments_sha256=approved_hash,
    )


def test_mutating_approval_rejects_changed_arguments_and_burns_token(monkeypatch):
    from nat_helpers import identity
    from user_interaction import approval_tokens
    from user_interaction.approval_tokens import ApprovalRequest, issue_approval_token

    redis = _FakeRedis()
    approved_payload = {
        "namespace": "production",
        "name": "api",
        "replicas": 3,
    }
    arguments_hash = hashlib.sha256(
        json.dumps(approved_payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    token = issue_approval_token(
        redis,
        ApprovalRequest(
            user_id="alice",
            action_type="mcp_mutation",
            target="production/api",
            server_name="k8s_mcp_server",
            tool_name="scale_deployment",
            arguments_sha256=arguments_hash,
            canonical_arguments=json.dumps(
                approved_payload, sort_keys=True, separators=(",", ":")
            ),
        ),
    )
    monkeypatch.setattr(
        identity,
        "authenticated_user_id_from_context_or_fallback",
        lambda _asserted: "alice",
    )
    monkeypatch.setattr(approval_tokens, "make_redis_client", lambda _url: redis)

    ok, reason = mcp_patches._validate_mcp_approval(
        "scale_deployment",
        {**approved_payload, "replicas": 20},
        server_name="k8s_mcp_server",
        approval_token=token,
    )
    assert ok is False
    assert "arguments mismatch" in reason

    replay_ok, replay_reason = mcp_patches._validate_mcp_approval(
        "scale_deployment",
        approved_payload,
        server_name="k8s_mcp_server",
        approval_token=token,
    )
    assert replay_ok is False
    assert "already used" in replay_reason


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
    assert "execution credential" in reason


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
    assert "execution credential" in reason


def test_destructive_hint_via_dict_annotations():
    # Annotations may arrive as a plain dict rather than a model.
    ok, _ = mcp_patches._validate_mcp_approval(
        "ingest_blob",
        {},
        annotations={"destructiveHint": True},
    )
    assert ok is False


def test_read_only_hint_cannot_override_local_mutating_verb():
    # Remote annotations are advisory and cannot authorize a locally detected
    # mutation, even when the server claims the operation is read-only.
    ok, reason = mcp_patches._validate_mcp_approval(
        "update_dashboard_view",
        {},
        annotations=_Annotations(readOnlyHint=True),
    )
    assert ok is False
    assert "execution credential" in reason


def test_sensitive_group_unknown_tool_defaults_to_approval():
    ok, reason = mcp_patches._validate_mcp_approval(
        "reconcile",
        {},
        annotations=_Annotations(readOnlyHint=True),
        server_name="k8s_mcp_server",
    )
    assert ok is False
    assert "execution credential" in reason


def test_sensitive_group_read_prefixed_tool_still_requires_approval():
    ok, reason = mcp_patches._validate_mcp_approval(
        "get_pod",
        {"namespace": "default", "name": "api"},
        server_name="k8s_mcp_server",
    )
    assert ok is False
    assert "execution credential" in reason


def test_physical_server_is_bound_to_logical_function_group(monkeypatch):
    physical = "streamable-http:https://mcp.example.test/mcp"
    monkeypatch.setattr(mcp_patches, "_mcp_server_group_names", {})
    monkeypatch.setattr(mcp_patches, "_ambiguous_mcp_servers", set())
    monkeypatch.setattr(mcp_patches, "_sensitive_mcp_server_names", set())
    client = type(
        "Client",
        (),
        {
            "server_name": "streamable-http",
            "_transport": "streamable-http",
            "_url": "https://mcp.example.test/mcp",
        },
    )()
    group = type("Group", (), {"mcp_client": client})()
    mcp_patches._register_mcp_group_identity("k8s_mcp_server", group)
    assert mcp_patches._mcp_server_group_names[physical] == "k8s_mcp_server"
    assert physical in mcp_patches._sensitive_mcp_server_names

    parent = client
    assert mcp_patches._canonical_mcp_server_name(parent) == "k8s_mcp_server"

    ok, reason = mcp_patches._validate_mcp_approval(
        "reconcile",
        {},
        annotations=_Annotations(readOnlyHint=True),
        server_name=physical,
    )
    assert ok is False
    assert "execution credential" in reason


def test_streamable_mcp_groups_with_distinct_urls_do_not_collide(monkeypatch):
    monkeypatch.setattr(mcp_patches, "_mcp_server_group_names", {})
    monkeypatch.setattr(mcp_patches, "_ambiguous_mcp_servers", set())
    monkeypatch.setattr(mcp_patches, "_sensitive_mcp_server_names", set())

    def client(url):
        return type(
            "Client",
            (),
            {
                "server_name": "streamable-http",
                "_transport": "streamable-http",
                "_url": url,
            },
        )()

    k8s_client = client("https://k8s.example.test/mcp")
    unifi_client = client("https://unifi.example.test/mcp")
    mcp_patches._register_mcp_group_identity(
        "k8s_mcp_server", type("Group", (), {"mcp_client": k8s_client})()
    )
    mcp_patches._register_mcp_group_identity(
        "unifi_mcp_server", type("Group", (), {"mcp_client": unifi_client})()
    )

    assert not mcp_patches._ambiguous_mcp_servers
    assert mcp_patches._canonical_mcp_server_name(k8s_client) == "k8s_mcp_server"
    assert mcp_patches._canonical_mcp_server_name(unifi_client) == "unifi_mcp_server"


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
