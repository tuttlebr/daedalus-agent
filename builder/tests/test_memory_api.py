"""Authenticated Memory Center and automatic-retention API contracts."""

import asyncio

import memory_api
import pytest


def run(coro):
    return asyncio.run(coro)


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


@pytest.fixture
def configured(monkeypatch):
    fake = FakeHindsight()
    monkeypatch.setenv("ALLOW_INSECURE_INTERNAL", "true")
    monkeypatch.setenv("DAEDALUS_MEMORY_MODE", "hindsight")
    monkeypatch.setattr(memory_api, "client_from_env", lambda: fake)

    async def ignore_forget(*_args, **_kwargs):
        return None

    async def delete_owned(_user_id):
        return 2

    monkeypatch.setattr(memory_api, "record_clear_epoch", ignore_forget)
    monkeypatch.setattr(memory_api, "record_tombstone", ignore_forget)
    monkeypatch.setattr(memory_api, "delete_owned_redis_memories", delete_owned)
    monkeypatch.setattr(memory_api, "HTTPException", _TestHTTPException)
    return fake


def test_retain_turn_uses_trusted_user_and_deterministic_document(configured):
    body = memory_api.RetainTurnRequest(
        request_id="request-1",
        conversation_id="conversation-1",
        content="I prefer Python for automation.",
    )
    result = run(memory_api._retain_turn_for_user(body, "alice"))

    assert result["status"] == "pending"
    operation, kwargs = configured.calls[0]
    assert operation == "retain"
    assert kwargs["user_id"] == "alice"
    assert kwargs["content"] == body.content
    assert kwargs["asynchronous"] is True
    assert "alice" not in kwargs["document_id"]
    assert kwargs["metadata"]["conversation_id"] == "conversation-1"


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
    assert configured.calls[-1] == ("clear_memories", {"user_id": "alice"})


def test_edit_tombstones_the_legacy_source_before_future_migration(
    configured,
    monkeypatch,
):
    tombstones = []

    async def record_tombstone(**kwargs):
        tombstones.append(kwargs)

    monkeypatch.setattr(memory_api, "record_tombstone", record_tombstone)
    result = run(
        memory_api._update_memory_for_user(
            "memory-1",
            memory_api.UpdateMemoryRequest(text="Corrected fact"),
            "alice",
        )
    )

    assert result["document_id"] == "source-1"
    assert tombstones == [
        {
            "user_id": "alice",
            "kind": "source",
            "resource_id": "source-1",
            "reason": "source contains a user-curated memory",
        }
    ]
