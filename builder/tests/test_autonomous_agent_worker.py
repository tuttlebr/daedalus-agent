import json

from autonomous_agent.backend_client import (
    OAuthRequiredError,
    extract_oauth_required_payload,
)
from autonomous_agent.dedupe import dedupe_feed_items
from autonomous_agent.models import now_ms
from autonomous_agent.prompt import (
    build_messages,
    extract_approval_metadata,
    feed_items_from_output,
    load_workspace,
    output_requests_approval,
    parse_structured_output,
    request_approval_key,
)
from autonomous_agent.worker import (
    _approval_reason,
    apply_workspace_updates,
    make_backend,
    run_once,
)


class FakeStore:
    def __init__(self):
        self.text = {}
        self.config = {
            "enabled": True,
            "userId": "test-user",
            "actionPolicy": "broad_autonomy",
            "intervalSeconds": 14400,
            "maxRunsStored": 100,
            "maxFeedItems": 200,
        }
        self.goals = []
        self.runs = []
        self.events = []
        self.feed = []
        self.approvals = []
        self.applied_approvals = set()
        self.pending_approvals = {}
        self.approval_executions = {}
        self.revoked_approval_tokens = []
        self.mcp_receipt_valid = False
        self.receipt_consumptions = []

    def get_config(self, user_id):
        return self.config

    def list_goals(self, user_id):
        return self.goals

    def list_runs(self, user_id):
        return self.runs

    def upsert_run(self, user_id, run):
        self.runs = [r for r in self.runs if r["id"] != run["id"]]
        self.runs.insert(0, dict(run))

    def log_event(self, user_id, run_id, event_type, message, **kwargs):
        self.events.append(
            {
                "runId": run_id,
                "type": event_type,
                "message": message,
                **kwargs,
            }
        )

    def list_feed(self, user_id, limit=None):
        return self.feed[:limit] if limit is not None else self.feed

    def append_feed_items(self, user_id, items):
        # Mirror the real store: de-duplicate against the existing feed and
        # return only the items that were actually stored.
        kept, _dropped = dedupe_feed_items(items, self.feed, now=now_ms())
        self.feed = kept + self.feed
        return kept

    def append_approval(self, user_id, approval):
        self.approvals.append(approval)

    def get_pending_approval(self, user_id, request_id):
        return self.pending_approvals.get(request_id)

    def get_approval_execution(self, user_id, request_id):
        return self.approval_executions.pop(request_id, None)

    def issue_approval_token(self, user_id, execution, **kwargs):
        return "secret-mcp-token"

    def revoke_approval_token(self, user_id, token):
        self.revoked_approval_tokens.append(token)

    def consume_mcp_execution_receipt(self, user_id, token, execution):
        self.receipt_consumptions.append((user_id, token, dict(execution)))
        return self.mcp_receipt_valid

    def cancel_requested(self, user_id, run_id):
        return False

    def is_approval_applied(self, user_id, approval_key):
        return approval_key in self.applied_approvals

    def mark_approval_applied(self, user_id, approval_key, **kwargs):
        self.applied_approvals.add(approval_key)

    def get_text(self, key):
        return self.text.get(key)

    def set_text(self, key, value):
        self.text[key] = value


class FakeBackend:
    def __init__(self, response):
        self.response = response
        self.messages = None
        self.approval_token = ""

    def call(self, messages, *, approval_token=""):
        self.messages = messages
        self.approval_token = approval_token
        return self.response


def test_parse_structured_output_from_json_fence():
    output = parse_structured_output(
        """```json
        {"summary": "done", "feed_items": [{"title": "T", "bluf": "B"}]}
        ```"""
    )

    assert output["summary"] == "done"
    assert output["feed_items"][0]["title"] == "T"


def test_parse_structured_output_falls_back_to_feed_item():
    output = parse_structured_output("plain response")

    assert output["summary"] == "plain response"
    assert output["feed_items"][0]["confidence"] == "low"


def test_feed_items_from_output_limits_and_normalizes():
    output = {
        "feed_items": [
            {
                "lane": "Known",
                "title": "Primary source moved",
                "bluf": "The topology changed.",
                "body": "Worth tracking.",
                "source_url": "https://example.com",
                "thread_key": "example-thread",
                "confidence": "High",
                "confidence_reason": "Primary source.",
            }
        ]
    }

    items = feed_items_from_output("run-1", output)

    assert len(items) == 1
    assert items[0]["lane"] == "known"
    assert items[0]["sourceUrl"] == "https://example.com"
    assert items[0]["threadKey"] == "example-thread"


def test_apply_workspace_updates_only_allows_known_mutable_sections():
    store = FakeStore()
    changed = apply_workspace_updates(
        store,
        "test-user",
        {
            "workspace_updates": {
                "heartbeat": "new heartbeat",
                "identity": "should not write",
                "inner_state": "private",
            }
        },
    )

    assert changed == ["heartbeat", "inner_state"]
    assert store.text["autonomous:test-user:workspace:heartbeat"] == "new heartbeat"
    assert "autonomous:test-user:workspace:identity" not in store.text


def test_load_workspace_uses_builtin_defaults_without_config_mount():
    store = FakeStore()

    workspace = load_workspace(store, "test-user")

    assert "persistent background worker" in workspace["identity"]
    assert "No curated memory index" in workspace["memory"]
    assert (
        store.text["autonomous:test-user:workspace:identity"] == workspace["identity"]
    )


def test_run_once_stores_structured_feed_and_completed_run():
    response = json.dumps(
        {
            "summary": "Found a durable signal.",
            "feed_items": [
                {
                    "lane": "known",
                    "title": "Signal",
                    "bluf": "A useful thing changed.",
                    "body": "The change affects the tracked system.",
                    "confidence": "high",
                }
            ],
            "workspace_updates": {"inner_state": "Track this next."},
        }
    )
    store = FakeStore()
    backend = FakeBackend(response)

    run = run_once(
        store=store,
        backend=backend,
        user_id="test-user",
        request={"trigger": "manual", "prompt": "go"},
    )

    assert run["status"] == "completed"
    assert store.feed[0]["title"] == "Signal"
    assert store.runs[0]["summary"] == "Found a durable signal."
    assert backend.messages[0]["content"].startswith("[IDENTITY]")


def test_build_messages_includes_already_surfaced_digest():
    messages = build_messages(
        user_id="test-user",
        config={"actionPolicy": "broad_autonomy", "feedDedupeWindowDays": 14},
        workspace={},
        goals=[],
        recent_runs=[],
        recent_feed=[
            {
                "title": "NVIDIA announces new GPU",
                "bluf": "Shipped today.",
                "sourceUrl": "https://nvidia.com/gpu",
                "createdAt": now_ms(),
            }
        ],
        request={"trigger": "scheduled"},
    )

    prompt = messages[-1]["content"]
    assert "already_surfaced" in prompt
    assert "NVIDIA announces new GPU" in prompt
    assert "Shipped today." in prompt
    assert "threadKey" in prompt
    assert "Avoid redundancy" in prompt


def test_build_messages_never_delegates_identity_to_tool_arguments():
    messages = build_messages(
        user_id="test-user",
        config={"actionPolicy": "broad_autonomy"},
        workspace={},
        goals=[],
        recent_runs=[],
        request={"trigger": "scheduled"},
    )

    prompt = messages[-1]["content"]
    assert "derive identity only from the trusted authenticated" in prompt
    assert "Never pass user_id, username" in prompt
    assert 'Use user_id="test-user"' not in prompt


def test_build_messages_bounds_persisted_workspace_and_history_context():
    recent = now_ms()
    messages = build_messages(
        user_id="test-user",
        config={"actionPolicy": "broad_autonomy", "feedDedupeWindowDays": 14},
        workspace={
            name: "§" * 10_000
            for name in (
                "identity",
                "soul",
                "schema",
                "interests",
                "user",
                "heartbeat",
                "memory",
                "inner_state",
            )
        },
        goals=[],
        recent_runs=[
            {
                "id": "i" * 1_000,
                "trigger": "t" * 1_000,
                "status": "s" * 1_000,
                "summary": "¶" * 10_000,
                "completedAt": "c" * 1_000,
            }
            for _ in range(8)
        ],
        recent_feed=[
            {
                "title": "T" * 500,
                "bluf": "B" * 500,
                "sourceUrl": f"https://{'d' * 200}.example/item/{index}",
                "threadKey": "K" * 500,
                "createdAt": recent - index,
            }
            for index in range(30)
        ],
        request={"trigger": "scheduled"},
    )

    prompt = messages[-1]["content"]
    runtime = json.loads(prompt.split("Runtime input:\n", 1)[1])

    assert prompt.count("§") < 8 * 2_500
    assert "…[truncated]…" in prompt
    assert len(runtime["recent_runs"]) == 5
    assert all(len(run["summary"]) <= 600 for run in runtime["recent_runs"])
    assert all(len(run["id"]) <= 128 for run in runtime["recent_runs"])
    assert all(len(run["completedAt"]) <= 128 for run in runtime["recent_runs"])
    assert len(runtime["already_surfaced"]) == 20
    assert all(
        len(item["title"]) <= 96
        and len(item["bluf"]) <= 140
        and len(item["source"]) <= 80
        and len(item["threadKey"]) <= 96
        for item in runtime["already_surfaced"]
    )


def test_build_messages_scopes_goal_run_to_selected_goal():
    messages = build_messages(
        user_id="test-user",
        config={"actionPolicy": "broad_autonomy"},
        workspace={},
        goals=[
            {
                "id": "goal_nvidia",
                "title": "Track NVIDIA",
                "status": "active",
                "priority": 1,
            },
            {
                "id": "goal_amd",
                "title": "Track AMD",
                "status": "active",
                "priority": 2,
            },
        ],
        recent_runs=[],
        request={"trigger": "goal", "goalId": "goal_amd", "prompt": "note"},
    )

    prompt = messages[-1]["content"]
    assert '"selected_goal": {' in prompt
    assert '"id": "goal_amd"' in prompt
    assert "treat selected_goal as the sole objective" in prompt
    assert "Do not switch to a different active_goals item" in prompt


def test_run_once_goal_request_passes_selected_goal_to_backend():
    response = json.dumps({"summary": "No new findings.", "feed_items": []})
    store = FakeStore()
    store.goals = [
        {
            "id": "goal_ops",
            "title": "Ops signals",
            "status": "active",
            "priority": 1,
        },
        {
            "id": "goal_research",
            "title": "Research signals",
            "status": "active",
            "priority": 2,
        },
    ]
    backend = FakeBackend(response)

    run = run_once(
        store=store,
        backend=backend,
        user_id="test-user",
        request={"trigger": "goal", "goalId": "goal_research"},
    )

    prompt = backend.messages[-1]["content"]
    assert run["status"] == "completed"
    assert '"goal_id": "goal_research"' in prompt
    assert '"selected_goal": {' in prompt
    assert '"title": "Research signals"' in prompt


def test_run_once_dedupes_feed_items_already_surfaced():
    item = {
        "lane": "known",
        "title": "NVIDIA announces new GPU",
        "bluf": "A new data center GPU shipped today.",
        "body": "Targets AI training workloads.",
        "source_url": "https://nvidia.com/gpu",
        "confidence": "high",
    }
    response = json.dumps({"summary": "Found a signal.", "feed_items": [item]})
    store = FakeStore()
    backend = FakeBackend(response)

    first = run_once(
        store=store,
        backend=backend,
        user_id="test-user",
        request={"trigger": "scheduled"},
    )
    assert first["metrics"]["feedItemsStored"] == 1
    assert first["metrics"]["feedItemsDeduped"] == 0
    assert len(store.feed) == 1

    # A later scheduled cycle rediscovers the same announcement.
    second = run_once(
        store=store,
        backend=backend,
        user_id="test-user",
        request={"trigger": "scheduled"},
    )
    assert second["metrics"]["feedItemsStored"] == 0
    assert second["metrics"]["feedItemsDeduped"] == 1
    assert second["feedItemIds"] == []
    # The feed did not grow — no redundant item was appended.
    assert len(store.feed) == 1


def test_run_once_pauses_when_backend_requests_approval():
    arguments_hash = "a" * 64
    store = FakeStore()
    store.pending_approvals["pending-1"] = {
        "user_id": "test-user",
        "action": "Delete thing",
        "target": "prod-item",
        "server_name": "inventory",
        "tool_name": "delete_item",
        "arguments_preview": '{"id":"prod-item"}',
        "arguments_sha256": arguments_hash,
    }
    backend = FakeBackend(
        "**Action requiring confirmation:**\n\nDelete thing\n\nProceed? (yes/no)\n"
        "No executable credential has been created.\n"
        "Approval scope: action_type=`mcp_mutation`, target=`prod-item`, "
        "server_name=`inventory`, tool_name=`delete_item`, "
        "approval_request_id=`pending-1`, "
        f"arguments_sha256=`{arguments_hash}`."
    )

    run = run_once(
        store=store,
        backend=backend,
        user_id="test-user",
        request={"trigger": "manual"},
    )

    assert run["status"] == "waiting_approval"
    assert store.approvals[0]["actionType"] == "mcp_mutation"
    assert store.approvals[0]["target"] == "prod-item"
    assert store.approvals[0]["serverName"] == "inventory"
    assert store.approvals[0]["toolName"] == "delete_item"
    assert store.approvals[0]["approvalRequestId"] == "pending-1"
    assert store.approvals[0]["argumentsPreview"] == '{"id":"prod-item"}'
    assert store.approvals[0]["argumentsSha256"] == arguments_hash
    assert "approvalToken" not in store.approvals[0]
    assert output_requests_approval(backend.response)


def test_run_once_preserves_deep_research_plan_approval_metadata():
    store = FakeStore()
    backend = FakeBackend(
        "**Deep research plan approval:** AIQ follow-up report\n\n"
        "**Planned report sections:**\n"
        "1. Source Registry\n"
        "2. Plan Approval\n\n"
        "Reply yes to approve this plan, or describe changes.\n"
        "No executable credential has been created.\n"
        "Approval scope: action_type=`deep_research_plan`, "
        "target=`aiq-report`."
    )

    run = run_once(
        store=store,
        backend=backend,
        user_id="test-user",
        request={"trigger": "manual"},
    )

    assert run["status"] == "waiting_approval"
    approval = store.approvals[0]
    assert "approvalToken" not in approval
    assert approval["actionType"] == "deep_research_plan"
    assert approval["target"] == "aiq-report"
    assert approval["risk"] == "low"
    assert "AIQ follow-up report" in approval["action"]
    assert output_requests_approval(backend.response)


def test_build_messages_includes_sanitized_source_policy_message():
    messages = build_messages(
        user_id="test-user",
        config={
            "actionPolicy": "broad_autonomy",
            "sourcePolicy": {
                "enabledSources": ["curated_domains", "missing"],
                "disabledSources": ["google_search"],
                "maxResearchToolCalls": 50,
                "requirePlanApproval": True,
            },
        },
        workspace={},
        goals=[],
        recent_runs=[],
        request={"trigger": "manual"},
    )

    assert messages[0]["content"].startswith("[IDENTITY]")
    assert messages[1]["content"].startswith("[SOURCE_POLICY]")
    assert 'enabled_source_ids=["curated_domains"]' in messages[1]["content"]
    assert 'disabled_source_ids=["google_search"]' in messages[1]["content"]
    assert "max_research_tool_calls=20" in messages[1]["content"]
    assert "require_deep_research_plan_approval=true" in messages[1]["content"]


def test_extract_approval_metadata_defaults_to_mcp_mutation():
    metadata = extract_approval_metadata(
        "**Action requiring confirmation:**\n\nDelete thing\n\nProceed? (yes/no)"
    )

    assert metadata["action_type"] == "mcp_mutation"
    assert metadata["server_name"] == ""
    assert metadata["tool_name"] == ""
    assert metadata["arguments_sha256"] == ""


def test_run_once_pauses_when_backend_requires_oauth():
    class OAuthBackend:
        def call(self, messages):
            raise OAuthRequiredError(
                "OAuth authorization is required.",
                auth_url="https://accounts.google.com/o/oauth2/v2/auth?state=abc",
                oauth_state="abc",
            )

    store = FakeStore()

    run = run_once(
        store=store,
        backend=OAuthBackend(),
        user_id="test-user",
        request={"trigger": "manual"},
    )

    assert run["status"] == "waiting_approval"
    assert store.approvals[0]["actionType"] == "oauth_authorization"
    assert store.approvals[0]["authUrl"].startswith("https://accounts.google.com")
    assert store.approvals[0]["oauthState"] == "abc"


def test_extract_oauth_required_payload_from_sse_event():
    payload = extract_oauth_required_payload(
        "oauth_required",
        {
            "auth_url": "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
            "oauth_state": "abc",
        },
    )

    assert payload == {
        "auth_url": "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
        "oauth_state": "abc",
    }


def test_backend_client_streams_through_loaded_workflow_by_default(monkeypatch):
    calls = []

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def raise_for_status(self):
            return None

        def iter_lines(self, *, decode_unicode):
            assert decode_unicode is True
            return iter(
                [
                    'data: {"choices":[{"delta":{"content":"done"}}]}',
                    "data: [DONE]",
                ]
            )

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return FakeResponse()

    monkeypatch.delenv("BACKEND_API_PATH", raising=False)
    monkeypatch.setattr("autonomous_agent.backend_client.requests.post", fake_post)

    backend = make_backend("test-user")
    assert (
        backend.call(
            [{"role": "user", "content": "go"}],
            approval_token="approved-secret",
        )
        == "done"
    )

    url, kwargs = calls[0]
    assert url.endswith("/v1/chat/completions")
    assert kwargs["stream"] is True
    assert kwargs["json"] == {
        "messages": [{"role": "user", "content": "go"}],
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    assert kwargs["headers"]["x-user-id"] == "test-user"
    assert kwargs["headers"]["x-daedalus-execution-scope"] == "autonomy"
    assert kwargs["headers"]["x-daedalus-approval-token"] == "approved-secret"
    assert "approved-secret" not in json.dumps(kwargs["json"])


def test_make_backend_uses_canonical_base_url_env(monkeypatch):
    monkeypatch.setenv("BACKEND_BASE_URL", "http://backend:8000")
    monkeypatch.setenv("BACKEND_API_PATH", "/v1/chat/completions")

    backend = make_backend("test-user")

    assert backend.base_url == "http://backend:8000"
    assert backend.api_path == "/v1/chat/completions"


def test_output_requests_approval_requires_structured_marker():
    # F-011: a bare advisory phrase (no structured bold marker) must NOT trip
    # the gate, while the structured markers extract_approval_metadata parses do.
    assert not output_requests_approval("Proceed? (yes/no) before I continue.")
    assert not output_requests_approval(
        "I will reply yes to approve this plan once ready."
    )
    assert output_requests_approval("**Action requiring confirmation:** Delete it")
    assert output_requests_approval("**Deep research plan approval:** Topic X")


def test_run_once_does_not_pause_on_advisory_phrase_without_marker():
    # F-011: an LLM that merely echoes "proceed? (yes/no)" without the structured
    # marker should complete normally, not be parked as waiting_approval.
    store = FakeStore()
    backend = FakeBackend(
        json.dumps(
            {
                "summary": "Considered options. Proceed? (yes/no) is just narration.",
                "feed_items": [{"title": "Finding", "bluf": "Something useful."}],
            }
        )
    )

    run = run_once(
        store=store,
        backend=backend,
        user_id="test-user",
        request={"trigger": "scheduled"},
    )

    assert run["status"] == "completed"
    assert store.approvals == []


def test_approval_reason_is_structured_not_raw_llm_text():
    # F-017a: the stored approval reason is built from parsed metadata only.
    metadata = extract_approval_metadata(
        "**Action requiring confirmation:**\n\nDelete prod table\n\n"
        "Proceed? (yes/no)\n"
        "Approval scope: action_type=`mcp_mutation`, target=`prod-db`."
    )
    reason = _approval_reason(metadata)

    assert "action_type=mcp_mutation" in reason
    assert "target=prod-db" in reason
    assert "risk=medium" in reason


def test_run_once_stores_structured_reason_not_raw_response():
    # F-017a: the raw LLM body must not be persisted as the approval reason.
    store = FakeStore()
    store.pending_approvals["pending-2"] = {
        "user_id": "test-user",
        "action": "Delete the production index",
        "target": "prod-index",
        "server_name": "inventory",
        "tool_name": "delete_index",
        "arguments_preview": '{"name":"prod-index"}',
        "arguments_sha256": "b" * 64,
    }
    raw = (
        "**Action requiring confirmation:** Delete the production index\n\n"
        "SECRET INTERNAL CHAIN OF THOUGHT THAT SHOULD NOT BE PUBLISHED\n\n"
        "Proceed? (yes/no)\n"
        "Approval scope: action_type=`mcp_mutation`, target=`prod-index`, "
        "approval_request_id=`pending-2`."
    )
    backend = FakeBackend(raw)

    run = run_once(
        store=store,
        backend=backend,
        user_id="test-user",
        request={"trigger": "manual"},
    )

    assert run["status"] == "waiting_approval"
    approval = store.approvals[0]
    assert "SECRET INTERNAL CHAIN OF THOUGHT" not in approval["reason"]
    assert "action_type=mcp_mutation" in approval["reason"]
    assert "target=prod-index" in approval["reason"]


def test_request_approval_key_only_for_approval_follow_ups():
    # F-015: the public approval id is stable; the secret never enters prompts.
    assert (
        request_approval_key({"trigger": "approval", "approvalId": "approval-abc"})
        == "approval-abc"
    )
    # A normal manual/scheduled request is never treated as a rerun.
    assert (
        request_approval_key({"trigger": "manual", "approvalId": "approval-abc"}) == ""
    )
    assert request_approval_key({"trigger": "approval", "prompt": "no token"}) == ""


def test_run_once_skips_already_applied_approval():
    # F-015: an approved-then-re-enqueued request must not execute twice.
    store = FakeStore()
    response = json.dumps(
        {
            "summary": "Sent the email.",
            "feed_items": [{"title": "Done", "bluf": "Email sent."}],
        }
    )
    backend = FakeBackend(response)
    request = {
        "id": "request-send",
        "trigger": "approval",
        "approvalId": "approval-send",
        "actionType": "delete_memory",
        "prompt": "Continue the approved action.",
    }
    store.approval_executions["request-send"] = {
        "token": "tok_send",
        "approvalId": "approval-send",
        "actionType": "delete_memory",
        "action": "Delete memory",
        "target": "test-user",
    }

    first = run_once(store=store, backend=backend, user_id="test-user", request=request)
    assert first["status"] == "completed"
    assert "approval-send" in store.applied_approvals
    assert "secret-mcp-token" in backend.messages[-1]["content"]

    # A re-enqueue of the same approved request is skipped, not re-run.
    second_backend = FakeBackend(response)
    second = run_once(
        store=store,
        backend=second_backend,
        user_id="test-user",
        request=dict(request),
    )
    assert second["status"] == "skipped"
    assert second_backend.messages is None  # backend was never called again
    # The feed did not grow from a duplicate execution.
    assert len(store.feed) == 1


def test_mcp_approval_credential_is_header_only_and_exact_context_is_private():
    store = FakeStore()
    store.mcp_receipt_valid = True
    request = {
        "id": "request-scale",
        "trigger": "approval",
        "approvalId": "approval-scale",
        "actionType": "mcp_mutation",
        "prompt": "Continue the approved action.",
    }
    store.approval_executions["request-scale"] = {
        "approvalId": "approval-scale",
        "actionType": "mcp_mutation",
        "action": "Scale API to three replicas",
        "target": "production/api",
        "serverName": "k8s_mcp_server",
        "toolName": "scale_deployment",
        "canonicalArguments": ('{"name":"api","namespace":"production","replicas":3}'),
        "argumentsSha256": "0" * 64,
        "originalPrompt": "Scale the production API to three replicas.",
    }
    backend = FakeBackend(json.dumps({"summary": "Scaled", "feed_items": []}))

    run = run_once(store=store, backend=backend, user_id="test-user", request=request)

    assert run["status"] == "completed"
    assert backend.approval_token == "secret-mcp-token"
    assert store.revoked_approval_tokens == ["secret-mcp-token"]
    assert "approval-scale" in store.applied_approvals
    assert len(store.receipt_consumptions) == 1
    rendered_messages = json.dumps(backend.messages)
    assert "secret-mcp-token" not in rendered_messages
    assert any(
        "replicas" in message["content"] and "production" in message["content"]
        for message in backend.messages
    )


def test_mcp_approval_is_not_applied_when_backend_never_proves_tool_success():
    store = FakeStore()
    request = {
        "id": "request-scale",
        "trigger": "approval",
        "approvalId": "approval-scale",
        "actionType": "mcp_mutation",
        "prompt": "Continue the approved action.",
    }
    store.approval_executions["request-scale"] = {
        "approvalId": "approval-scale",
        "actionType": "mcp_mutation",
        "action": "Scale API to three replicas",
        "target": "production/api",
        "serverName": "k8s_mcp_server",
        "toolName": "scale_deployment",
        "canonicalArguments": ('{"name":"api","namespace":"production","replicas":3}'),
        "argumentsSha256": "0" * 64,
    }
    # A plausible final answer is not execution evidence. This fake backend did
    # not pass through the MCP gate, so no receipt exists.
    backend = FakeBackend(json.dumps({"summary": "Scaled", "feed_items": []}))

    run = run_once(store=store, backend=backend, user_id="test-user", request=request)

    assert run["status"] == "failed"
    assert "success receipt" in run["error"]
    assert "approval-scale" not in store.applied_approvals
    assert len(store.receipt_consumptions) == 1
    assert store.revoked_approval_tokens == ["secret-mcp-token"]


def test_run_once_aborts_when_lease_lost():
    # F-016: a set abort event (lost lease) stops the run before it writes any
    # shared state (feed/workspace), so a second worker is not clobbered.
    import threading

    store = FakeStore()
    backend = FakeBackend(
        json.dumps(
            {
                "summary": "Found something.",
                "feed_items": [{"title": "X", "bluf": "Y"}],
            }
        )
    )
    abort = threading.Event()
    abort.set()

    run = run_once(
        store=store,
        backend=backend,
        user_id="test-user",
        request={"trigger": "scheduled"},
        abort=abort,
    )

    assert run["status"] == "aborted"
    assert store.feed == []
