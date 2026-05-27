import json

from autonomous_agent.backend_client import (
    BackendClient,
    OAuthRequiredError,
    extract_async_job_id,
    extract_oauth_required_payload,
)
from autonomous_agent.prompt import (
    feed_items_from_output,
    load_workspace,
    output_requests_approval,
    parse_structured_output,
)
from autonomous_agent.worker import apply_workspace_updates, make_backend, run_once


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

    def append_feed_items(self, user_id, items):
        self.feed.extend(items)

    def append_approval(self, user_id, approval):
        self.approvals.append(approval)

    def cancel_requested(self, user_id, run_id):
        return False

    def get_text(self, key):
        return self.text.get(key)

    def set_text(self, key, value):
        self.text[key] = value


class FakeBackend:
    def __init__(self, response):
        self.response = response
        self.messages = None

    def call(self, messages):
        self.messages = messages
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
                "confidence": "High",
                "confidence_reason": "Primary source.",
            }
        ]
    }

    items = feed_items_from_output("run-1", output)

    assert len(items) == 1
    assert items[0]["lane"] == "known"
    assert items[0]["sourceUrl"] == "https://example.com"


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


def test_run_once_pauses_when_backend_requests_approval():
    store = FakeStore()
    backend = FakeBackend(
        "**Action requiring confirmation:**\n\nDelete thing\n\nProceed? (yes/no)\n"
        "If approved, use this single-use approval token with the destructive "
        "tool call: `tok_123`"
    )

    run = run_once(
        store=store,
        backend=backend,
        user_id="test-user",
        request={"trigger": "manual"},
    )

    assert run["status"] == "waiting_approval"
    assert store.approvals[0]["approvalToken"] == "tok_123"
    assert output_requests_approval(backend.response)


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


def test_extract_async_job_id_accepts_common_response_shapes():
    assert extract_async_job_id({"job_id": "server-job"}, "local-job") == "server-job"
    assert extract_async_job_id({"job": {"id": "nested-job"}}, "local-job") == "nested-job"
    assert extract_async_job_id({}, "local-job") == "local-job"


def test_backend_client_uses_returned_async_job_id(monkeypatch):
    requested_urls = []

    class FakeResponse:
        status_code = 200

        def __init__(self, payload):
            self.payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    def fake_post(*args, **kwargs):
        return FakeResponse({"job_id": "server-job"})

    def fake_get(url, *args, **kwargs):
        requested_urls.append(url)
        return FakeResponse({"status": "success", "output": {"value": "done"}})

    monkeypatch.setattr("autonomous_agent.backend_client.requests.post", fake_post)
    monkeypatch.setattr("autonomous_agent.backend_client.requests.get", fake_get)
    monkeypatch.setattr("autonomous_agent.backend_client.time.sleep", lambda _: None)

    backend = BackendClient(
        base_url="http://backend:8000",
        api_path="/v1/workflow/async",
        user_id="test-user",
        request_timeout=30,
        poll_interval=1,
    )

    assert backend.call([{"role": "user", "content": "go"}]) == "done"
    assert requested_urls == ["http://backend:8000/v1/workflow/async/job/server-job"]


def test_backend_client_fails_fast_after_repeated_async_404(monkeypatch):
    class FakeResponse:
        status_code = 404

        def __init__(self, payload=None):
            self.payload = payload or {}

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    def fake_post(*args, **kwargs):
        response = FakeResponse({"job_id": "missing-job"})
        response.status_code = 202
        return response

    monkeypatch.setattr("autonomous_agent.backend_client.requests.post", fake_post)
    monkeypatch.setattr(
        "autonomous_agent.backend_client.requests.get",
        lambda *args, **kwargs: FakeResponse(),
    )
    monkeypatch.setattr("autonomous_agent.backend_client.time.sleep", lambda _: None)

    backend = BackendClient(
        base_url="http://backend:8000",
        api_path="/v1/workflow/async",
        user_id="test-user",
        request_timeout=30,
        poll_interval=1,
    )

    try:
        backend.call([{"role": "user", "content": "go"}])
    except RuntimeError as exc:
        assert "missing-job" in str(exc)
        assert "not found" in str(exc)
    else:
        raise AssertionError("expected repeated async 404s to fail fast")


def test_make_backend_uses_canonical_base_url_env(monkeypatch):
    monkeypatch.setenv("BACKEND_BASE_URL", "http://backend:8000")
    monkeypatch.setenv("BACKEND_API_PATH", "/v1/workflow/async")

    backend = make_backend("test-user")

    assert backend.base_url == "http://backend:8000"
    assert backend.api_path == "/v1/workflow/async"
