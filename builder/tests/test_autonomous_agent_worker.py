import json

import pytest
from autonomous_agent.backend_client import (
    OAuthRequiredError,
    extract_oauth_required_payload,
)
from autonomous_agent.dedupe import dedupe_feed_items
from autonomous_agent.models import now_ms
from autonomous_agent.prompt import (
    COMMUNICATION_STYLE_GUIDANCE,
    build_messages,
    feed_items_from_output,
    load_workspace,
    output_requests_approval,
    parse_structured_output,
)
from autonomous_agent.worker import (
    MAX_AUTONOMOUS_REQUEST_TIMEOUT_SECONDS,
    apply_workspace_updates,
    make_backend,
    run_once,
    run_with_lease_heartbeat,
    select_scheduled_goal,
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
        self.cancelled_run_ids = set()

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

    def mark_goal_run(self, user_id, goal_id, timestamp):
        for goal in self.goals:
            if goal.get("id") == goal_id:
                goal["lastRunAt"] = timestamp

    def cancel_requested(self, user_id, run_id):
        return self.cancelled_run_ids and run_id in self.cancelled_run_ids

    def get_text(self, key):
        return self.text.get(key)

    def set_text(self, key, value):
        self.text[key] = value


class FakeBackend:
    def __init__(self, response):
        self.response = response
        self.messages = None
        self.execution_id = ""
        self.abort = None

    def call(self, messages, *, execution_id="", abort=None):
        self.messages = messages
        self.execution_id = execution_id
        self.abort = abort
        return self.response


def test_parse_structured_output_from_json_fence():
    output = parse_structured_output(
        """```json
        {"summary": "done", "feed_items": [{"title": "T", "bluf": "B"}]}
        ```"""
    )

    assert output["summary"] == "done"
    assert output["feed_items"][0]["title"] == "T"


def test_parse_structured_output_rejects_unstructured_text_without_echoing_it():
    private_text = "private model planning that must not reach the UI"

    with pytest.raises(ValueError) as exc_info:
        parse_structured_output(private_text)

    assert str(exc_info.value) == "Backend returned invalid structured output."
    assert private_text not in str(exc_info.value)


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
                "is_update": True,
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
    assert items[0]["isUpdate"] is True


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


def test_apply_workspace_updates_skips_unchanged_content():
    store = FakeStore()
    store.text["autonomous:test-user:workspace:heartbeat"] = "same"

    changed = apply_workspace_updates(
        store,
        "test-user",
        {"workspace_updates": {"heartbeat": "same"}},
    )

    assert changed == []


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
        request={"id": "request-123", "trigger": "manual", "prompt": "go"},
    )

    assert run["status"] == "completed"
    assert store.feed[0]["title"] == "Signal"
    assert store.runs[0]["summary"] == "Found a durable signal."
    assert backend.messages[0]["content"].startswith("[IDENTITY]")
    assert backend.execution_id == "request-123"


def test_run_once_does_not_publish_unstructured_model_text():
    private_text = "I will expose my private research plan before using tools."
    store = FakeStore()
    backend = FakeBackend(private_text)

    run = run_once(
        store=store,
        backend=backend,
        user_id="test-user",
        request={"id": "request-unsafe", "trigger": "manual", "prompt": "go"},
    )

    assert run["status"] == "failed"
    assert run["summary"] == ""
    assert run["error"] == "Backend returned invalid structured output."
    assert private_text not in json.dumps(run)
    assert private_text not in json.dumps(store.events)
    assert store.feed == []


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


def test_build_messages_keeps_communication_style_in_immutable_overlay():
    persisted_text = "Persisted workspace text can change between runs."
    messages = build_messages(
        user_id="test-user",
        config={"actionPolicy": "broad_autonomy"},
        workspace={"identity": persisted_text},
        goals=[],
        recent_runs=[],
        request={"trigger": "scheduled"},
    )

    prompt = messages[-1]["content"]
    assert COMMUNICATION_STYLE_GUIDANCE in prompt
    assert prompt.index(COMMUNICATION_STYLE_GUIDANCE) > prompt.index(persisted_text)


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
    assert len(runtime["already_surfaced"]) == 30
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


def test_build_messages_includes_all_active_goal_digests_and_freshness_rules():
    goals = [
        {
            "id": f"goal_{index}",
            "title": f"Goal {index}",
            "description": "full description",
            "status": "active",
            "priority": index,
        }
        for index in range(9)
    ]

    messages = build_messages(
        user_id="test-user",
        config={"actionPolicy": "broad_autonomy"},
        workspace={},
        goals=goals,
        recent_runs=[],
        request={"trigger": "goal", "goalId": "goal_8"},
    )

    prompt = messages[-1]["content"]
    runtime = json.loads(prompt.split("Runtime input:\n", 1)[1])
    assert len(runtime["active_goals"]) == 9
    assert runtime["selected_goal"]["id"] == "goal_8"
    assert "The same fact from a different publisher is corroboration" in prompt
    assert "current_datetime_tool" in prompt
    assert "top_k=20" in prompt
    assert "Do not call tools that can require interactive authentication" in prompt


def test_scheduled_run_rotates_to_never_run_goal_then_marks_it():
    store = FakeStore()
    store.goals = [
        {
            "id": "goal_frequent",
            "title": "Frequent",
            "status": "active",
            "priority": 1,
            "tags": ["cadence:4h"],
            "lastRunAt": 1_700_000_000_000,
        },
        {
            "id": "goal_new",
            "title": "Never run",
            "status": "active",
            "priority": 2,
            "tags": ["cadence:1d"],
            "lastRunAt": None,
        },
    ]
    backend = FakeBackend(json.dumps({"summary": "No new findings.", "feed_items": []}))

    run = run_once(
        store=store,
        backend=backend,
        user_id="test-user",
        request={"trigger": "scheduled"},
    )

    assert run["goalId"] == "goal_new"
    assert store.goals[1]["lastRunAt"] == run["startedAt"]
    assert '"selected_goal": {' in backend.messages[-1]["content"]
    assert '"id": "goal_new"' in backend.messages[-1]["content"]


def test_scheduled_goal_selection_uses_cadence_over_priority_after_initial_run():
    timestamp = 1_800_000_000_000
    selected = select_scheduled_goal(
        [
            {
                "id": "goal_daily",
                "status": "active",
                "priority": 1,
                "tags": ["cadence:1d"],
                "lastRunAt": timestamp - 20 * 3_600_000,
            },
            {
                "id": "goal_frequent",
                "status": "active",
                "priority": 2,
                "tags": ["cadence:4h"],
                "lastRunAt": timestamp - 6 * 3_600_000,
            },
            {
                "id": "goal_paused",
                "status": "paused",
                "priority": 0,
                "lastRunAt": 0,
            },
        ],
        timestamp=timestamp,
    )

    assert selected["id"] == "goal_frequent"


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


def test_run_once_rejects_backend_approval_request():
    arguments_hash = "a" * 64
    store = FakeStore()
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

    assert run["status"] == "failed"
    assert run["error"] == "Autonomous runs cannot request user approval."
    assert store.events[-1]["type"] == "approval_blocked"
    assert output_requests_approval(backend.response)


def test_run_once_rejects_deep_research_plan_approval():
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

    assert run["status"] == "failed"
    assert run["error"] == "Autonomous runs cannot request user approval."
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
    assert "require_deep_research_plan_approval=false" in messages[1]["content"]
    assert "confirm_research_plan" not in messages[1]["content"]


def test_run_once_rejects_backend_oauth_request():
    class OAuthBackend:
        def call(self, messages, *, execution_id="", abort=None):
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

    assert run["status"] == "failed"
    assert run["error"] == (
        "Autonomous runs cannot use tools that require interactive OAuth."
    )
    assert store.events[-1]["type"] == "oauth_blocked"


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
            execution_id="request-123",
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
    assert "x-daedalus-approval-token" not in kwargs["headers"]
    assert kwargs["headers"]["x-daedalus-execution-id"] == "request-123"


def test_make_backend_uses_canonical_base_url_env(monkeypatch):
    monkeypatch.setenv("BACKEND_BASE_URL", "http://backend:8000")
    monkeypatch.setenv("BACKEND_API_PATH", "/v1/chat/completions")

    backend = make_backend("test-user")

    assert backend.base_url == "http://backend:8000"
    assert backend.api_path == "/v1/chat/completions"


@pytest.mark.parametrize("request_timeout", ["0", "not-a-number"])
def test_make_backend_rejects_invalid_request_timeout(monkeypatch, request_timeout):
    monkeypatch.setenv("REQUEST_TIMEOUT", request_timeout)

    with pytest.raises(ValueError, match="REQUEST_TIMEOUT"):
        make_backend("test-user")


def test_make_backend_rejects_timeout_that_could_wedge_the_queue(monkeypatch):
    monkeypatch.setenv(
        "REQUEST_TIMEOUT", str(MAX_AUTONOMOUS_REQUEST_TIMEOUT_SECONDS + 1)
    )

    with pytest.raises(ValueError, match="cannot wedge the worker queue"):
        make_backend("test-user")


def test_make_backend_accepts_the_maximum_permitted_timeout(monkeypatch):
    monkeypatch.setenv("REQUEST_TIMEOUT", str(MAX_AUTONOMOUS_REQUEST_TIMEOUT_SECONDS))

    backend = make_backend("test-user")

    assert backend.request_timeout == MAX_AUTONOMOUS_REQUEST_TIMEOUT_SECONDS


def test_output_requests_approval_requires_structured_marker():
    # F-011: a bare advisory phrase (no structured bold marker) must NOT trip
    # the gate, while the approval tool's structured markers do.
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


def test_run_once_does_not_store_raw_approval_response():
    store = FakeStore()
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

    assert run["status"] == "failed"
    assert "SECRET INTERNAL CHAIN OF THOUGHT" not in json.dumps(run)
    assert "SECRET INTERNAL CHAIN OF THOUGHT" not in json.dumps(store.events)


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


def test_run_with_lease_heartbeat_fails_before_backend_after_lease_loss():
    class LostLeaseStore(FakeStore):
        def refresh_lease(self, _user_id, *, ttl_seconds):
            assert ttl_seconds == 60
            return False

    store = LostLeaseStore()
    backend = FakeBackend(json.dumps({"summary": "must not execute"}))

    import pytest

    with pytest.raises(RuntimeError, match="lost before the run started"):
        run_with_lease_heartbeat(
            store=store,
            backend=backend,
            user_id="test-user",
            request={"trigger": "scheduled"},
            lease_ttl=60,
        )

    assert backend.messages is None


def test_run_with_lease_heartbeat_aborts_when_refresh_loses_ownership():
    import threading

    class SequencedLeaseStore(FakeStore):
        def __init__(self):
            super().__init__()
            self.refresh_calls = 0
            self.lease_lost = threading.Event()

        def refresh_lease(self, _user_id, *, ttl_seconds):
            assert ttl_seconds == 1
            self.refresh_calls += 1
            if self.refresh_calls == 1:
                return True
            self.lease_lost.set()
            return False

        def owns_lease(self, _user_id):
            return self.refresh_calls < 2

    class WaitForLeaseLossBackend(FakeBackend):
        def call(self, messages, *, execution_id="", abort=None):
            assert store.lease_lost.wait(timeout=2)
            # The real client raises once abort is set; the post-return
            # lease check still has to classify this as aborted.
            return super().call(messages, execution_id=execution_id, abort=abort)

    store = SequencedLeaseStore()
    backend = WaitForLeaseLossBackend(json.dumps({"summary": "late result"}))

    run = run_with_lease_heartbeat(
        store=store,
        backend=backend,
        user_id="test-user",
        request={"trigger": "scheduled"},
        lease_ttl=1,
    )

    assert run["status"] == "aborted"
    assert store.refresh_calls >= 2
    assert store.feed == []
