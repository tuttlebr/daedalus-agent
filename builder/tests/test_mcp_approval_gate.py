"""Tests for MCP destructive-action approval helpers."""

import asyncio
import hashlib
import json
import sys
import types
from pathlib import Path

import mcp_patches
import pytest
import yaml

CONFIG_PATH = Path(__file__).parents[2] / "backend" / "tool-calling-config.yaml"
mcp_patches.configure_mcp_approval_policy(CONFIG_PATH)


class _FakeRedis:
    def __init__(self):
        self.store = {}
        self.ttls = {}

    def setex(self, key, ttl, value):
        self.store[key] = value
        self.ttls[key] = ttl

    def getdel(self, key):
        return self.store.pop(key, None)


def test_mcp_success_receipt_is_hashed_exact_durable_and_single_use():
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
    assert redis.ttls[receipt_key] == 2 * 60 * 60
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

    fake_module = types.ModuleType("nat.plugins.mcp.client.client_base")
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
        "nat.plugins.mcp.client.client_base",
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


def test_unrestricted_mutation_disables_automatic_replay_without_receipt(
    monkeypatch,
):
    reconnect_values = []

    class FakeMCPToolClient:
        _tool_name = "delete_resource"
        input_schema = None

        def __init__(self):
            self._parent_client = types.SimpleNamespace(
                server_name="k8s_mcp_server",
                _reconnect_enabled=True,
            )

        async def acall(self, tool_args):
            del tool_args
            reconnect_values.append(self._parent_client._reconnect_enabled)
            return "deleted"

    fake_module = types.ModuleType("nat.plugins.mcp.client.client_base")
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
        "nat.plugins.mcp.client.client_base",
        fake_module,
    )
    monkeypatch.setattr(
        mcp_patches,
        "_validate_mcp_approval",
        lambda *_args, **_kwargs: (True, "unrestricted-mutation"),
    )
    monkeypatch.setattr(
        mcp_patches,
        "_record_approved_mcp_receipt",
        lambda **_kwargs: pytest.fail("unrestricted calls must not record receipts"),
    )
    monkeypatch.setattr(mcp_patches, "_approval_gate_installed", False)
    mcp_patches._patch_tool_client()

    client = FakeMCPToolClient()
    assert asyncio.run(client.acall({"name": "stale-resource"})) == "deleted"
    assert reconnect_values == [False]
    assert client._parent_client._reconnect_enabled is True


def test_read_only_mcp_call_does_not_need_token():
    ok, reason = mcp_patches._validate_mcp_approval(
        "get_thread",
        {"thread_id": "abc"},
        server_name="gmail_mcp_server",
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
            server_name="restricted_mcp_server",
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
        server_name="restricted_mcp_server",
        approval_token=token,
    )
    assert (ok, reason) == (True, "approved")

    replay_ok, replay_reason = mcp_patches._validate_mcp_approval(
        "scale_deployment",
        payload,
        server_name="restricted_mcp_server",
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
            server_name="restricted_mcp_server",
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
        server_name="restricted_mcp_server",
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
        server_name="restricted_mcp_server",
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
            server_name="restricted_mcp_server",
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
        server_name="restricted_mcp_server",
        approval_token=token,
    )
    assert ok is False
    assert "arguments mismatch" in reason

    replay_ok, replay_reason = mcp_patches._validate_mcp_approval(
        "scale_deployment",
        approved_payload,
        server_name="restricted_mcp_server",
        approval_token=token,
    )
    assert replay_ok is False
    assert "already used" in replay_reason


def test_unregistered_gmail_create_draft_fails_closed():
    for tool_name in ("create_draft", "gmail_mcp_server.create_draft"):
        ok, reason = mcp_patches._validate_mcp_approval(
            tool_name,
            {"to": "user@example.com", "subject": "Hello", "body": "Draft body"},
            server_name="gmail_mcp_server",
        )
        assert ok is False
        assert "execution credential" in reason


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
    "server_name,tool_name,payload,expected_reason",
    [
        ("gmail_mcp_server", "list_labels", {}, "read-only"),
        ("gmail_mcp_server", "get_thread", {}, "read-only"),
        ("calendar_mcp_server", "list_calendars", {}, "unrestricted"),
        ("calendar_mcp_server", "list_events", {}, "unrestricted"),
        ("x_mcp_server", "searchSpaces", {"query": "foo"}, "read-only"),
    ],
)
def test_exact_local_read_only_tools_are_not_over_gated(
    server_name, tool_name, payload, expected_reason
):
    ok, reason = mcp_patches._validate_mcp_approval(
        tool_name, payload, server_name=server_name
    )
    assert ok is True, f"{tool_name} should be read-only"
    assert reason == expected_reason


@pytest.mark.parametrize(
    "server_name,tool_name,payload",
    [
        ("k8s_mcp_server", "getClusterSummary", {}),
        ("k8s_mcp_server", "listContexts", {}),
        ("unifi_mcp_server", "listSites", {}),
        ("unifi_mcp_server", "getInfo", {}),
    ],
)
def test_unrestricted_infrastructure_tools_do_not_need_token(
    server_name, tool_name, payload
):
    ok, reason = mcp_patches._validate_mcp_approval(
        tool_name, payload, server_name=server_name
    )
    assert ok is True
    assert reason == "unrestricted"


@pytest.mark.parametrize("server_name", ["k8s_mcp_server", "unifi_mcp_server"])
def test_unrestricted_infrastructure_mutations_do_not_need_token(server_name):
    ok, reason = mcp_patches._validate_mcp_approval(
        "delete_resource",
        {"name": "stale-resource"},
        annotations=_Annotations(destructiveHint=True),
        server_name=server_name,
    )
    assert ok is True
    assert reason == "unrestricted-mutation"


def test_api_key_environment_configuration_log_is_presence_only(monkeypatch, caplog):
    secret = "do-not-log-this-api-key"
    monkeypatch.setenv("KUBERNETES_MCP_TOKEN", secret)
    monkeypatch.delenv("UNIFI_MCP_TOKEN", raising=False)

    with caplog.at_level("INFO", logger="daedalus.mcp_patches"):
        mcp_patches._log_static_mcp_api_key_configuration()

    assert (
        "server=k8s_mcp_server environment=KUBERNETES_MCP_TOKEN configured=True"
        in caplog.text
    )
    assert (
        "server=unifi_mcp_server environment=UNIFI_MCP_TOKEN configured=False"
        in caplog.text
    )
    assert secret not in caplog.text


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


def test_destructive_hint_tightens_exact_local_read_only_registration():
    ok, reason = mcp_patches._validate_mcp_approval(
        "get_thread",
        {"thread_id": "abc"},
        annotations=_Annotations(destructiveHint=True),
        server_name="gmail_mcp_server",
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


def test_unrestricted_group_unknown_tool_is_allowed():
    ok, reason = mcp_patches._validate_mcp_approval(
        "reconcile",
        {},
        annotations=_Annotations(readOnlyHint=True),
        server_name="k8s_mcp_server",
    )
    assert ok is True
    assert reason == "unrestricted"


def test_unknown_read_like_tool_fails_closed_in_non_sensitive_group():
    ok, reason = mcp_patches._validate_mcp_approval(
        "get_account_export",
        {"operation": "get"},
        annotations=_Annotations(readOnlyHint=True),
        server_name="gmail_mcp_server",
    )
    assert ok is False
    assert "execution credential" in reason


def test_local_read_only_registry_matches_configured_includes():
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    groups = config["function_groups"]

    configured_policy = {
        group_name.casefold(): frozenset(
            str(tool_name).casefold()
            for tool_name, override in group.get("tool_overrides", {}).items()
            if override.get("approval_policy") == "read_only"
        )
        for group_name, group in groups.items()
        if group.get("_type") in {"mcp_client", "per_user_mcp_client"}
        and any(
            override.get("approval_policy") == "read_only"
            for override in group.get("tool_overrides", {}).values()
        )
    }
    assert mcp_patches._LOCAL_READ_ONLY_MCP_TOOLS == configured_policy


def test_unrestricted_registry_matches_groups_without_nonempty_include():
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    expected = frozenset(
        group_name.casefold()
        for group_name, group in config["function_groups"].items()
        if group.get("_type") in {"mcp_client", "per_user_mcp_client"}
        and not group.get("include")
    )

    assert mcp_patches._UNRESTRICTED_MCP_GROUPS == expected


def test_per_user_mcp_endpoint_identity_is_loaded_from_config():
    assert (
        mcp_patches._mcp_server_group_names[
            "streamable-http:https://gmailmcp.googleapis.com/mcp/v1"
        ]
        == "gmail_mcp_server"
    )
    assert (
        mcp_patches._mcp_server_group_names[
            "streamable-http:https://calendarmcp.googleapis.com/mcp/v1"
        ]
        == "calendar_mcp_server"
    )
    assert mcp_patches._validate_mcp_approval(
        "search_threads",
        {"query": "is:unread"},
        server_name="streamable-http:https://gmailmcp.googleapis.com/mcp/v1",
    ) == (True, "read-only")
    assert mcp_patches._validate_mcp_approval(
        "list_calendars",
        {},
        server_name="streamable-http:https://calendarmcp.googleapis.com/mcp/v1",
    ) == (True, "unrestricted")


def test_approval_policy_rejects_tool_outside_include(tmp_path):
    config_path = tmp_path / "bad-policy.yaml"
    config_path.write_text(
        """
function_groups:
  gmail_mcp_server:
    _type: per_user_mcp_client
    include: [search_threads]
    tool_overrides:
      create_draft:
        approval_policy: read_only
    server:
      transport: streamable-http
      url: https://gmail.example.test/mcp
""",
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="outside include"):
        mcp_patches.configure_mcp_approval_policy(config_path)

    mcp_patches.configure_mcp_approval_policy(CONFIG_PATH)


def test_approval_policy_rejects_unknown_value(tmp_path):
    config_path = tmp_path / "bad-policy.yaml"
    config_path.write_text(
        """
function_groups:
  inventory_mcp_server:
    _type: mcp_client
    include: [get_inventory]
    tool_overrides:
      get_inventory:
        approval_policy: probably_safe
    server:
      transport: streamable-http
      url: https://inventory.example.test/mcp
""",
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="Unsupported MCP approval policy"):
        mcp_patches.configure_mcp_approval_policy(config_path)

    mcp_patches.configure_mcp_approval_policy(CONFIG_PATH)


def test_read_only_policy_rejects_locally_mutating_tool(tmp_path):
    config_path = tmp_path / "bad-policy.yaml"
    config_path.write_text(
        """
function_groups:
  inventory_mcp_server:
    _type: mcp_client
    include: [update_inventory]
    tool_overrides:
      update_inventory:
        approval_policy: read_only
    server:
      transport: streamable-http
      url: https://inventory.example.test/mcp
""",
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="conflicts with local mutation"):
        mcp_patches.configure_mcp_approval_policy(config_path)

    mcp_patches.configure_mcp_approval_policy(CONFIG_PATH)


def test_unrestricted_group_read_prefixed_tool_is_allowed():
    ok, reason = mcp_patches._validate_mcp_approval(
        "get_pod",
        {"namespace": "default", "name": "api"},
        server_name="k8s_mcp_server",
    )
    assert ok is True
    assert reason == "unrestricted"


def test_physical_server_is_bound_to_logical_function_group(monkeypatch):
    physical = "streamable-http:https://mcp.example.test/mcp"
    monkeypatch.setattr(mcp_patches, "_mcp_server_group_names", {})
    monkeypatch.setattr(mcp_patches, "_ambiguous_mcp_servers", set())
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

    parent = client
    assert mcp_patches._canonical_mcp_server_name(parent) == "k8s_mcp_server"

    ok, reason = mcp_patches._validate_mcp_approval(
        "reconcile",
        {},
        annotations=_Annotations(readOnlyHint=True),
        server_name=physical,
    )
    assert ok is True
    assert reason == "unrestricted"


def test_streamable_mcp_groups_with_distinct_urls_do_not_collide(monkeypatch):
    monkeypatch.setattr(mcp_patches, "_mcp_server_group_names", {})
    monkeypatch.setattr(mcp_patches, "_ambiguous_mcp_servers", set())

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


def test_no_annotations_requires_exact_local_registry_entry():
    ok, _ = mcp_patches._validate_mcp_approval("delete_pod", {}, annotations=None)
    assert ok is False
    ok, reason = mcp_patches._validate_mcp_approval("get_pod", {}, annotations=None)
    assert ok is False
    assert "execution credential" in reason


def test_non_bool_hint_does_not_override_exact_local_registry():
    ok, reason = mcp_patches._validate_mcp_approval(
        "get_thread",
        {},
        annotations=_Annotations(destructiveHint="yes", readOnlyHint=None),
        server_name="gmail_mcp_server",
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
    # F-006 regression: a missing gate always refuses startup.
    monkeypatch.setattr(mcp_patches, "_approval_gate_installed", False)
    with pytest.raises(RuntimeError):
        mcp_patches._verify_approval_gate_installed()


def test_verify_approval_gate_has_no_environment_optout(monkeypatch):
    monkeypatch.setattr(mcp_patches, "_approval_gate_installed", False)
    monkeypatch.setenv("MCP_APPROVAL_GATE_OPTIONAL", "1")
    with pytest.raises(RuntimeError):
        mcp_patches._verify_approval_gate_installed()
