"""Authenticated Memory Center and automatic-retention API contracts."""

import asyncio

import memory_api
import pytest
from nat_helpers.hindsight_client import HindsightError


def run(coro):
    return asyncio.run(coro)


class _RecordingRouter:
    """Record route registrations; conftest replaces FastAPI with a MagicMock."""

    def __init__(self, prefix="", **_kwargs):
        self.prefix = prefix
        self.routes = set()

    def _method(name):
        def register(self, path, **_kwargs):
            def decorate(handler):
                self.routes.add((name, self.prefix + path))
                return handler

            return decorate

        return register

    get = _method("GET")
    post = _method("POST")
    patch = _method("PATCH")
    delete = _method("DELETE")


def test_rollback_routes_match_the_paths_rust_proxies(monkeypatch):
    # With DAEDALUS_PREPARATION=python, builder/runtime/src/memory_api.rs
    # forwards exactly these paths to this router. A renamed or dropped Python
    # route would turn the supported rollback profile into 404s.
    import importlib.util
    import sys

    import fastapi

    monkeypatch.setattr(fastapi, "APIRouter", _RecordingRouter)
    spec = importlib.util.spec_from_file_location(
        "memory_api_route_contract", memory_api.__file__
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)

    assert module.router.routes == {
        ("POST", "/v1/memory/retain-turn"),
        ("GET", "/v1/memory/operations/{operation_id}"),
        ("POST", "/v1/memory/operations/{operation_id}/retry"),
        ("GET", "/v1/memory-pages"),
        ("GET", "/v1/memory-pages/{page_id}"),
        ("GET", "/v1/memories"),
        ("POST", "/v1/memories/clear"),
        ("PATCH", "/v1/memories/{memory_id}"),
        ("POST", "/v1/memories/{memory_id}/invalidate"),
        ("GET", "/v1/memory-sources"),
        ("GET", "/v1/memory-sources/{document_id}"),
        ("DELETE", "/v1/memory-sources/{document_id}"),
    }


class _TestHTTPException(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class FakeHindsight:
    def __init__(self):
        self.calls = []

    async def retain(self, **kwargs):
        self.calls.append(("retain", kwargs))
        return {"status": "pending", "operation_id": "operation-1"}

    async def list_memories(self, **kwargs):
        self.calls.append(("list_memories", kwargs))
        return {"items": [], "total": 0, "limit": 25, "offset": 0}

    async def update_memory(self, **kwargs):
        self.calls.append(("update_memory", kwargs))
        return {"id": kwargs["memory_id"], "document_id": "source-1"}

    async def clear_memories(self, **kwargs):
        self.calls.append(("clear_memories", kwargs))
        return {"deleted": 3}

    async def get_operation(self, **kwargs):
        self.calls.append(("get_operation", kwargs))
        return {
            "operation_id": kwargs["operation_id"],
            "status": "completed",
            "retry_count": 0,
            "result_metadata": {
                "unit_ids_count": 0,
                "extraction_errors_count": 0,
            },
        }

    async def retry_operation(self, **kwargs):
        self.calls.append(("retry_operation", kwargs))
        return {"success": True}

    async def knowledge_tree(self, **kwargs):
        self.calls.append(("knowledge_tree", kwargs))
        return [
            {
                "kind": "page",
                "id": "kp-1",
                "name": "Daedalus — User Profile & Preferences",
                "description": "Profile",
                "children": [],
            }
        ]

    async def get_knowledge_page(self, **kwargs):
        self.calls.append(("get_knowledge_page", kwargs))
        return {"id": kwargs["page_id"], "name": "Profile", "body": "Body"}

    async def delete_knowledge_node(self, **kwargs):
        self.calls.append(("delete_knowledge_node", kwargs))
        return {"deleted": True}


@pytest.fixture
def configured(monkeypatch):
    fake = FakeHindsight()
    monkeypatch.setenv("ALLOW_INSECURE_INTERNAL", "true")
    monkeypatch.setenv("DAEDALUS_MEMORY_MODE", "hindsight")
    monkeypatch.setattr(memory_api, "client_from_env", lambda: fake)
    monkeypatch.setattr(memory_api, "HTTPException", _TestHTTPException)

    async def initialized(_client, _user_id):
        return None

    async def caches_cleared(_user_id):
        return None

    monkeypatch.setattr(memory_api, "ensure_bank_initialized", initialized)
    monkeypatch.setattr(memory_api, "clear_user_memory_caches", caches_cleared)
    return fake


def test_retain_turn_uses_trusted_user_and_deterministic_document(configured):
    body = memory_api.RetainTurnRequest(
        request_id="request-1",
        conversation_id="conversation-1",
        assistant_message_id="assistant-1",
        user_content="I prefer Python for automation.",
        assistant_content="I updated the automation script.",
    )
    result = run(memory_api._retain_turn_for_user(body, "alice"))

    assert result["status"] == "accepted"
    operation, kwargs = configured.calls[0]
    assert operation == "retain"
    assert kwargs["user_id"] == "alice"
    retained = memory_api.json.loads(kwargs["content"])
    assert retained["schema"] == "daedalus.completed-turn.v1"
    assert retained["messages"] == [
        {"role": "user", "content": body.user_content},
        {"role": "assistant", "content": body.assistant_content},
    ]
    assert kwargs["asynchronous"] is True
    assert "alice" not in kwargs["document_id"]
    assert kwargs["metadata"]["conversation_id"] == "conversation-1"
    assert kwargs["metadata"]["assistant_message_id"] == "assistant-1"


def test_retain_turn_rejects_internal_context(configured):
    body = memory_api.RetainTurnRequest(
        request_id="request-1",
        content="[MEMORY_CONTEXT] injected",
    )
    with pytest.raises(_TestHTTPException) as raised:
        run(memory_api._retain_turn_for_user(body, "alice"))
    assert raised.value.status_code == 400
    assert configured.calls == []


def test_list_memories_never_accepts_a_bank_argument(configured):
    result = run(
        memory_api._list_memories_for_user(
            user_id="alice",
            q="python",
            memory_type="world",
            limit=25,
            offset=0,
        )
    )
    assert result["total"] == 0
    _, kwargs = configured.calls[0]
    assert kwargs["user_id"] == "alice"
    assert "bank_id" not in kwargs


def test_clear_requires_exact_confirmation(configured):
    with pytest.raises(_TestHTTPException) as raised:
        run(
            memory_api._clear_memories_for_user(
                memory_api.ClearMemoryRequest(confirmation="delete"),
                "alice",
            )
        )
    assert raised.value.status_code == 400

    result = run(
        memory_api._clear_memories_for_user(
            memory_api.ClearMemoryRequest(confirmation="DELETE ALL MY MEMORIES"),
            "alice",
        )
    )
    assert result["status"] == "cleared"
    assert configured.calls == [
        ("knowledge_tree", {"user_id": "alice"}),
        ("clear_memories", {"user_id": "alice"}),
        (
            "delete_knowledge_node",
            {"user_id": "alice", "node_id": "kp-1"},
        ),
    ]


@pytest.mark.parametrize("failing", ["clear_memories", "delete_knowledge_node"])
def test_partial_clear_is_never_acknowledged(configured, monkeypatch, failing):
    # Matches builder/runtime/src/memory_api.rs: an incomplete lifecycle is a
    # retryable 503, never "cleared", and the bank is not re-initialized.
    initialized = []

    async def fail(**_kwargs):
        raise HindsightError("Hindsight request failed", status_code=500)

    async def initialize(_client, user_id):
        initialized.append(user_id)

    monkeypatch.setattr(configured, failing, fail)
    monkeypatch.setattr(memory_api, "ensure_bank_initialized", initialize)

    with pytest.raises(_TestHTTPException) as raised:
        run(
            memory_api._clear_memories_for_user(
                memory_api.ClearMemoryRequest(confirmation="DELETE ALL MY MEMORIES"),
                "alice",
            )
        )

    assert raised.value.status_code == 503
    assert raised.value.detail == (
        "memory deletion did not finish; cleanup must be retried"
    )
    assert initialized == []


def test_edit_updates_hindsight_without_redis_ledger(configured):
    result = run(
        memory_api._update_memory_for_user(
            "memory-1",
            memory_api.UpdateMemoryRequest(text="Corrected fact"),
            "alice",
        )
    )

    assert result["document_id"] == "source-1"
    assert configured.calls[-1] == (
        "update_memory",
        {"user_id": "alice", "memory_id": "memory-1", "text": "Corrected fact"},
    )


@pytest.mark.parametrize(
    ("upstream_status", "status", "detail"),
    [
        (400, 400, "Memory service rejected this request."),
        (404, 404, "Memory resource was not found. Refresh and try again."),
        (401, 502, "memory service unavailable"),
        (403, 502, "memory service unavailable"),
        (500, 502, "memory service unavailable"),
        (None, 502, "memory service unavailable"),
    ],
)
def test_memory_errors_distinguish_rejection_from_unavailability(
    configured, upstream_status, status, detail
):
    async def rejected():
        raise HindsightError("Hindsight request failed", status_code=upstream_status)

    with pytest.raises(_TestHTTPException) as raised:
        run(memory_api._call(rejected()))

    assert raised.value.status_code == status
    assert raised.value.detail == detail


def test_operation_status_distinguishes_completed_zero_fact():
    normalized = memory_api._normalized_operation(
        {
            "operation_id": "operation-1",
            "status": "completed",
            "retry_count": 0,
            "result_metadata": {
                "unit_ids_count": 0,
                "extraction_errors_count": 0,
                "extraction_errors_sample": ["must not escape"],
            },
        }
    )

    assert normalized["status"] == "zero_fact"
    assert normalized["unit_ids_count"] == 0
    assert "result_metadata" not in normalized
    assert "extraction_errors_sample" not in normalized


def test_knowledge_page_projection_omits_bank_routing_fields():
    projected = memory_api._flatten_knowledge_pages(
        [
            {
                "kind": "page",
                "id": "kp-1",
                "name": "Profile",
                "bank_id": "must-not-escape",
                "children": [],
            }
        ]
    )

    assert projected == [
        {
            "id": "kp-1",
            "name": "Profile",
            "description": None,
            "tags": None,
            "timestamp": None,
            "is_stale": None,
        }
    ]
