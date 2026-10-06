"""Tests for MCP destructive-action approval helpers."""

import base64
import hashlib
import json
from pathlib import Path

import pytest
import yaml
from daedalus_runtime import approval as mcp_patches

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


@pytest.mark.parametrize(
    "server_name,tool_name,payload",
    [
        ("docs_mcp_server", "update_doc", {"document_id": "doc-1"}),
        ("calendar_mcp_server", "update_event", {"event_id": "event-1"}),
        ("calendar_mcp_server", "delete_event", {"event_id": "event-1"}),
        ("calendar_mcp_server", "respond_to_event", {"event_id": "event-1"}),
    ],
)
def test_docs_updates_and_existing_calendar_event_changes_require_exact_approval(
    server_name, tool_name, payload
):
    for qualified_tool_name in (tool_name, f"{server_name}.{tool_name}"):
        ok, reason = mcp_patches._validate_mcp_approval(
            qualified_tool_name,
            payload,
            server_name=server_name,
        )
        assert ok is False
        assert "execution credential" in reason


@pytest.mark.parametrize(
    "server_name",
    [
        "calendar_mcp_server",
        "streamable-http:https://calendarmcp.googleapis.com/mcp/v1",
    ],
)
@pytest.mark.parametrize(
    "tool_name",
    [
        "create_event",
        "calendar_mcp_server.create_event",
        "calendar_mcp_server::create_event",
    ],
)
def test_calendar_creation_skips_approval_storage(monkeypatch, server_name, tool_name):
    def forbidden(**_kwargs):
        pytest.fail("Calendar creation must not create a per-call approval")

    monkeypatch.setattr(mcp_patches, "_create_mcp_approval_marker", forbidden)
    assert mcp_patches._validate_mcp_approval(
        tool_name,
        {"calendar_id": "primary", "summary": "Test event"},
        annotations=_Annotations(destructiveHint=True),
        server_name=server_name,
    ) == (True, "auto-approved")
    assert not mcp_patches._has_local_read_only_evidence(server_name, tool_name)
    assert "calendar_mcp_server" in mcp_patches._PER_USER_MCP_OAUTH_SERVERS


@pytest.mark.parametrize(
    "server_name,tool_name",
    [
        ("other_mcp_server", "create_event"),
        ("calendar_mcp_server", "create_calendar"),
        ("calendar_mcp_server", "create_event_batch"),
    ],
)
def test_calendar_creation_approval_exception_is_exact(server_name, tool_name):
    ok, reason = mcp_patches._validate_mcp_approval(
        tool_name, {}, server_name=server_name
    )
    assert ok is False
    assert "execution credential" in reason


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


def test_blocked_workspace_write_creates_compact_gate_owned_approval(monkeypatch):
    import nat_helpers.identity as identity

    marker = "<!--daedalus-mcp-approval:opaque-->"
    monkeypatch.setattr(
        identity,
        "authenticated_user_id_from_context_or_fallback",
        lambda _fallback: "alice",
    )
    monkeypatch.setattr(
        mcp_patches,
        "_create_mcp_approval_marker",
        lambda **_kwargs: marker,
    )
    ok, reason = mcp_patches._validate_mcp_approval(
        "update_doc",
        {"documentId": "doc-123", "requests": []},
        server_name="docs_mcp_server",
    )

    assert ok is False
    assert reason == marker
    assert "user_interaction_tool" not in reason
    assert "doc-123" not in reason


def test_gate_persists_exact_document_once_but_marker_contains_only_metadata(
    monkeypatch,
):
    import user_interaction.approval_tokens as approval_tokens

    redis = _FakeRedis()
    monkeypatch.setattr(approval_tokens, "make_redis_client", lambda *_args: redis)
    document_text = "private document text " * 500
    canonical_arguments, arguments_sha256 = mcp_patches._canonical_mcp_call(
        {
            "documentId": "doc-123",
            "requests": [
                {
                    "insertText": {
                        "location": {"index": 1},
                        "text": document_text,
                    }
                }
            ],
        }
    )

    marker = mcp_patches._create_mcp_approval_marker(
        user_id="alice",
        server_name="docs_mcp_server",
        tool_name="update_doc",
        canonical_arguments=canonical_arguments,
        arguments_sha256=arguments_sha256,
    )

    encoded = marker.removeprefix("<!--daedalus-mcp-approval:").removesuffix("-->")
    encoded += "=" * (-len(encoded) % 4)
    marker_payload = json.loads(base64.urlsafe_b64decode(encoded))
    assert marker_payload["summary"].startswith("Update Google document doc-123")
    assert marker_payload["argumentsSha256"] == arguments_sha256
    assert document_text not in marker
    assert len(redis.store) == 1
    pending = json.loads(next(iter(redis.store.values())))
    assert pending["canonical_arguments"] == canonical_arguments
    assert "arguments_preview" not in pending


@pytest.mark.parametrize(
    "server_name,tool_name,payload,expected_reason",
    [
        ("gmail_mcp_server", "list_labels", {}, "read-only"),
        ("gmail_mcp_server", "get_thread", {}, "read-only"),
        ("calendar_mcp_server", "list_calendars", {}, "read-only"),
        ("calendar_mcp_server", "list_events", {}, "read-only"),
        ("docs_mcp_server", "read_doc", {}, "read-only"),
        ("x_mcp_server", "search_posts_all", {"query": "foo"}, "read-only"),
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
def test_allowlisted_infrastructure_reads_do_not_need_token(
    server_name, tool_name, payload
):
    ok, reason = mcp_patches._validate_mcp_approval(
        tool_name, payload, server_name=server_name
    )
    assert ok is True
    assert reason == "read-only"


@pytest.mark.parametrize("server_name", ["k8s_mcp_server", "unifi_mcp_server"])
def test_infrastructure_mutations_require_exact_approval(server_name):
    ok, reason = mcp_patches._validate_mcp_approval(
        "delete_resource",
        {"name": "stale-resource"},
        annotations=_Annotations(destructiveHint=True),
        server_name=server_name,
    )
    assert ok is False
    assert "execution credential" in reason


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


def test_infrastructure_group_unknown_tool_fails_closed():
    ok, reason = mcp_patches._validate_mcp_approval(
        "reconcile",
        {},
        annotations=_Annotations(readOnlyHint=True),
        server_name="k8s_mcp_server",
    )
    assert ok is False
    assert "execution credential" in reason


def test_unknown_read_like_tool_fails_closed_in_non_sensitive_group():
    ok, reason = mcp_patches._validate_mcp_approval(
        "get_account_export",
        {"operation": "get"},
        annotations=_Annotations(readOnlyHint=True),
        server_name="gmail_mcp_server",
    )
    assert ok is False
    assert "execution credential" in reason


@pytest.mark.parametrize(
    "tool_name,payload",
    [
        ("account_status", {"verify": True}),
        ("get_league", {}),
        ("get_teams", {}),
        ("get_roster", {}),
        ("get_matchups", {"week": 1}),
        ("search_players", {"query": "Josh Allen"}),
        ("get_free_agents", {}),
        ("get_player", {"player_id": 3918298}),
        ("get_draft", {}),
        ("get_transactions", {}),
    ],
)
def test_espn_reads_never_request_an_execution_credential(tool_name, payload):
    for server_name in (
        "espn_mcp_server",
        "streamable-http:http://espn-mcp-server.daedalus.svc.cluster.local:8000/mcp",
    ):
        for _ in range(2):
            assert mcp_patches._validate_mcp_approval(
                tool_name,
                payload,
                annotations=_Annotations(readOnlyHint=True, destructiveHint=False),
                server_name=server_name,
                approval_token=None,
            ) == (True, "read-only")


def test_espn_unlisted_tools_still_require_approval():
    ok, reason = mcp_patches._validate_mcp_approval(
        "set_lineup",
        {},
        annotations=_Annotations(readOnlyHint=True),
        server_name="espn_mcp_server",
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


@pytest.mark.parametrize(
    "tool_name",
    [
        "set_light_state",
        "set_group_state",
        "recall_scene",
        "create_scene",
        "update_scene",
        "delete_scene",
        "update_room",
        "update_zone",
        "new_hue_control",
    ],
)
@pytest.mark.parametrize(
    "server_name",
    [
        "hue_mcp_server",
        "streamable-http:http://hue-mcp-server.daedalus.svc.cluster.local:8000/mcp",
    ],
)
def test_hue_controls_are_operator_authorized_without_approval_storage(
    monkeypatch, tool_name, server_name
):
    def forbidden(**_kwargs):
        pytest.fail("auto-approved Hue calls must not create UI approvals")

    monkeypatch.setattr(mcp_patches, "_create_mcp_approval_marker", forbidden)
    assert mcp_patches._validate_mcp_approval(
        tool_name,
        {},
        annotations=_Annotations(destructiveHint=True),
        server_name=server_name,
        approval_token=None,
    ) == (True, "auto-approved")
    assert not mcp_patches._has_local_read_only_evidence(server_name, tool_name)


@pytest.mark.parametrize(
    "tool_name", ["get_bridge_status", "list_resources", "get_resource"]
)
def test_hue_reads_do_not_require_ui_approval(tool_name):
    assert mcp_patches._validate_mcp_approval(
        tool_name, {}, server_name="hue_mcp_server"
    ) == (True, "read-only")


@pytest.mark.parametrize(
    "server_name,tool_name",
    [
        ("k8s_mcp_server", "delete_all_resources"),
        ("other_mcp_server", "set_light_state"),
    ],
)
def test_operator_approval_does_not_extend_to_other_tools_or_servers(
    server_name, tool_name
):
    ok, _ = mcp_patches._validate_mcp_approval(
        tool_name, {"approval_policy": "auto_approve"}, server_name=server_name
    )
    assert not ok


def test_operator_approval_can_be_revoked_by_inherited_configuration(tmp_path):
    overlay = tmp_path / "revoked.yaml"
    overlay.write_text(
        yaml.safe_dump(
            {
                "base": str(CONFIG_PATH),
                "function_groups": {
                    "hue_mcp_server": {
                        "tool_overrides": {
                            "set_light_state": {"approval_policy": "approval_required"},
                        }
                    }
                },
            }
        )
    )
    try:
        mcp_patches.configure_mcp_approval_policy(overlay)
        assert not mcp_patches._validate_mcp_approval(
            "set_light_state", {}, server_name="hue_mcp_server"
        )[0]
        assert mcp_patches._validate_mcp_approval(
            "recall_scene", {}, server_name="hue_mcp_server"
        ) == (True, "auto-approved")
    finally:
        mcp_patches.configure_mcp_approval_policy(CONFIG_PATH)


def test_only_hue_discovers_all_tools_in_the_deployed_configuration():
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    for group_name, group in config["function_groups"].items():
        if group.get("_type") in {"mcp_client", "per_user_mcp_client"}:
            if group_name == "hue_mcp_server":
                assert "include" not in group
                assert group["approval_policy"] == "auto_approve"
            else:
                assert group.get("include"), group_name


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
    ) == (True, "read-only")


def test_per_user_oauth_registry_is_derived_from_config():
    assert mcp_patches._PER_USER_MCP_OAUTH_SERVERS == frozenset(
        {
            "gmail_mcp_server",
            "calendar_mcp_server",
            "docs_mcp_server",
        }
    )


def test_approval_policy_follows_base_inheritance(tmp_path):
    """An overlay with only `base:` must load the canonical policy, not an
    empty one — otherwise every MCP tool silently becomes approval-gated."""
    overlay_path = tmp_path / "overlay-config.yaml"
    overlay_path.write_text(f"base: {CONFIG_PATH}\n", encoding="utf-8")

    mcp_patches.configure_mcp_approval_policy(CONFIG_PATH)
    canonical_state = (
        dict(mcp_patches._LOCAL_READ_ONLY_MCP_TOOLS),
        dict(mcp_patches._LOCAL_AUTO_APPROVED_MCP_TOOLS),
        dict(mcp_patches._MCP_GROUP_APPROVAL_POLICIES),
        mcp_patches._PER_USER_MCP_OAUTH_SERVERS,
    )
    assert canonical_state[0], "canonical policy is empty"

    mcp_patches.configure_mcp_approval_policy(overlay_path)
    overlay_state = (
        dict(mcp_patches._LOCAL_READ_ONLY_MCP_TOOLS),
        dict(mcp_patches._LOCAL_AUTO_APPROVED_MCP_TOOLS),
        dict(mcp_patches._MCP_GROUP_APPROVAL_POLICIES),
        mcp_patches._PER_USER_MCP_OAUTH_SERVERS,
    )

    assert overlay_state == canonical_state

    mcp_patches.configure_mcp_approval_policy(CONFIG_PATH)


def test_approval_policy_overlay_overrides_merge_over_base(tmp_path):
    base_path = tmp_path / "base.yaml"
    base_path.write_text(
        """
function_groups:
  inventory_mcp_server:
    _type: mcp_client
    include: [get_inventory]
    tool_overrides:
      get_inventory:
        approval_policy: approval_required
    server:
      transport: streamable-http
      url: https://inventory.example.test/mcp
""",
        encoding="utf-8",
    )
    overlay_path = tmp_path / "overlay.yaml"
    overlay_path.write_text(
        """
base: base.yaml
function_groups:
  inventory_mcp_server:
    tool_overrides:
      get_inventory:
        approval_policy: read_only
""",
        encoding="utf-8",
    )

    mcp_patches.configure_mcp_approval_policy(overlay_path)
    assert mcp_patches._LOCAL_READ_ONLY_MCP_TOOLS["inventory_mcp_server"] == frozenset(
        {"get_inventory"}
    )

    mcp_patches.configure_mcp_approval_policy(CONFIG_PATH)


def test_approval_policy_rejects_circular_base_chain(tmp_path):
    config_path = tmp_path / "self-config.yaml"
    config_path.write_text("base: self-config.yaml\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="too deep or circular"):
        mcp_patches.configure_mcp_approval_policy(config_path)

    mcp_patches.configure_mcp_approval_policy(CONFIG_PATH)


@pytest.mark.parametrize("policy", ["read_only", "auto_approve"])
def test_approval_policy_rejects_tool_outside_include(tmp_path, policy):
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
        """.replace("approval_policy: read_only", f"approval_policy: {policy}"),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="outside include"):
        mcp_patches.configure_mcp_approval_policy(config_path)

    mcp_patches.configure_mcp_approval_policy(CONFIG_PATH)


@pytest.mark.parametrize("filter_config", [{}, {"include": []}])
def test_discovery_does_not_grant_approval_by_default(tmp_path, filter_config):
    config_path = tmp_path / "discovery.yaml"
    config_path.write_text(
        yaml.safe_dump(
            {
                "function_groups": {
                    "inventory_mcp_server": {
                        "_type": "mcp_client",
                        **filter_config,
                        "tool_overrides": {
                            "get_inventory": {"approval_policy": "read_only"}
                        },
                    }
                }
            }
        )
    )
    try:
        mcp_patches.configure_mcp_approval_policy(config_path)
        assert mcp_patches._validate_mcp_approval(
            "get_inventory", {}, server_name="inventory_mcp_server"
        ) == (True, "read-only")
        assert not mcp_patches._validate_mcp_approval(
            "new_tool",
            {},
            annotations=_Annotations(readOnlyHint=True),
            server_name="inventory_mcp_server",
        )[0]
    finally:
        mcp_patches.configure_mcp_approval_policy(CONFIG_PATH)


@pytest.mark.parametrize(
    "filters,allowed",
    [
        ({}, True),
        ({"include": []}, True),
        ({"exclude": ["new_tool"]}, False),
        ({"include": [], "exclude": ["new_tool"]}, False),
        ({"include": ["another_tool"]}, False),
        ({"include": ["new_tool"], "exclude": ["new_tool"]}, True),
    ],
)
def test_group_approval_respects_configured_exposure_filters(
    tmp_path, filters, allowed
):
    config_path = tmp_path / "group.yaml"
    config_path.write_text(
        yaml.safe_dump(
            {
                "function_groups": {
                    "inventory_mcp_server": {
                        "_type": "mcp_client",
                        "approval_policy": "auto_approve",
                        **filters,
                    }
                }
            }
        )
    )
    try:
        mcp_patches.configure_mcp_approval_policy(config_path)
        ok, reason = mcp_patches._validate_mcp_approval(
            "new_tool", {}, server_name="inventory_mcp_server"
        )
        assert ok is allowed
        if allowed:
            assert reason == "auto-approved"
    finally:
        mcp_patches.configure_mcp_approval_policy(CONFIG_PATH)


def test_read_only_override_keeps_mutation_checks_with_group_auto_approval():
    assert not mcp_patches._validate_mcp_approval(
        "get_resource",
        {},
        server_name="hue_mcp_server",
        annotations=_Annotations(destructiveHint=True),
    )[0]


@pytest.mark.parametrize("default", ["read_only", "typo", None])
def test_group_approval_rejects_invalid_defaults(default):
    with pytest.raises(RuntimeError, match="Unsupported MCP group approval policy"):
        mcp_patches._parse_mcp_group_approval_policy(
            "inventory", {"approval_policy": default}
        )


@pytest.mark.parametrize("key", ["include", "exclude"])
@pytest.mark.parametrize("value", [None, "get_inventory", [""], [42]])
def test_exposure_filters_reject_invalid_values(key, value):
    with pytest.raises(RuntimeError, match="list of non-empty tool names"):
        mcp_patches._parse_mcp_group_approval_policy("inventory", {key: value})


def test_approval_override_for_excluded_tool_is_rejected():
    with pytest.raises(RuntimeError, match="excluded tool"):
        mcp_patches._parse_mcp_group_approval_policy(
            "inventory",
            {
                "exclude": ["get_inventory"],
                "tool_overrides": {
                    "get_inventory": {"approval_policy": "auto_approve"}
                },
            },
        )


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


def test_infrastructure_read_prefixed_unknown_tool_fails_closed():
    ok, reason = mcp_patches._validate_mcp_approval(
        "get_pod",
        {"namespace": "default", "name": "api"},
        server_name="k8s_mcp_server",
    )
    assert ok is False
    assert "execution credential" in reason


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
