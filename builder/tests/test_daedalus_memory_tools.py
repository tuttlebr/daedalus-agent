"""Tests for Daedalus memory wrappers with authenticated identity."""

import asyncio
import sys
from types import SimpleNamespace

import pytest


def run(coro):
    return asyncio.run(coro)


class FakeMemoryEditor:
    def __init__(self):
        self.added = []
        self.search_calls = []

    async def add_items(self, items):
        self.added.extend(items)

    async def search(self, **kwargs):
        self.search_calls.append(kwargs)
        return [
            {
                "memory": "The user's name is Brandon Tuttle.",
                "user_id": kwargs["user_id"],
            }
        ]


class FakeBuilder:
    def __init__(self, editor):
        self.editor = editor
        self.requested_memory = None

    async def get_memory_client(self, memory):
        self.requested_memory = memory
        return self.editor


def test_authenticated_user_id_from_headers_fails_closed_without_local_token(
    monkeypatch,
):
    from nat_helpers.identity import authenticated_user_id_from_headers

    monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
    monkeypatch.delenv("ALLOW_INSECURE_INTERNAL", raising=False)

    with pytest.raises(ValueError, match="authentication is not configured"):
        authenticated_user_id_from_headers({"x-user-id": " tuttlebr "})


def test_authenticated_user_id_from_headers_allows_explicit_local_opt_out(
    monkeypatch,
):
    from nat_helpers.identity import authenticated_user_id_from_headers

    monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
    monkeypatch.setenv("ALLOW_INSECURE_INTERNAL", "1")

    assert authenticated_user_id_from_headers({"x-user-id": " tuttlebr "}) == "tuttlebr"


def test_authenticated_user_id_from_headers_requires_matching_internal_token(
    monkeypatch,
):
    from nat_helpers.identity import authenticated_user_id_from_headers

    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "secret-token")

    headers = {
        "x-user-id": "tuttlebr",
        "x-daedalus-internal-token": "secret-token",
    }
    assert authenticated_user_id_from_headers(headers) == "tuttlebr"

    with pytest.raises(ValueError, match="valid x-daedalus-internal-token"):
        authenticated_user_id_from_headers(
            {
                "x-user-id": "tuttlebr",
                "x-daedalus-internal-token": "wrong-token",
            }
        )


def test_resolve_authenticated_user_rejects_legacy_identity_mismatch(monkeypatch):
    import nat_helpers.identity as identity

    monkeypatch.setattr(
        identity,
        "authenticated_user_id_from_context_or_fallback",
        lambda _fallback="": "alice",
    )

    with pytest.raises(ValueError, match="does not match"):
        identity.resolve_authenticated_user_id("mallory")


def test_context_fallback_is_used_only_when_request_headers_are_absent(monkeypatch):
    import nat_helpers.identity as identity

    class _NoRequestContext:
        @staticmethod
        def get():
            return SimpleNamespace(metadata=SimpleNamespace(headers=None))

    monkeypatch.setitem(
        sys.modules,
        "nat.builder.context",
        SimpleNamespace(Context=_NoRequestContext),
    )

    assert identity.resolve_authenticated_user_id("direct-test-user") == (
        "direct-test-user"
    )


def test_execution_scope_distinguishes_direct_chat_and_autonomy(monkeypatch):
    import nat_helpers.identity as identity

    class _Context:
        metadata = SimpleNamespace(headers=None)

        @staticmethod
        def get():
            return _Context

    monkeypatch.setitem(
        sys.modules,
        "nat.builder.context",
        SimpleNamespace(Context=_Context),
    )
    assert identity.execution_scope_from_context_or_none() is None

    _Context.metadata.headers = {"x-daedalus-execution-scope": "Autonomy"}
    assert identity.execution_scope_from_context_or_none() == "autonomy"

    _Context.metadata.headers = {"x-user-id": "alice"}
    assert identity.execution_scope_from_context_or_none() == ""


def test_execution_id_is_available_only_in_autonomy_scope(monkeypatch):
    import nat_helpers.identity as identity

    class _Context:
        metadata = SimpleNamespace(headers=None)

        @staticmethod
        def get():
            return _Context

    monkeypatch.setitem(
        sys.modules,
        "nat.builder.context",
        SimpleNamespace(Context=_Context),
    )

    _Context.metadata.headers = {
        "x-daedalus-execution-scope": "interactive",
        "x-daedalus-execution-id": "request-1",
    }
    assert identity.execution_id_from_context_or_none() is None

    _Context.metadata.headers = {
        "x-daedalus-execution-scope": "autonomy",
        "x-daedalus-execution-id": "request-1",
    }
    assert identity.execution_id_from_context_or_none() == "request-1"


def test_add_memory_uses_authenticated_user_not_llm_supplied_user_id(monkeypatch):
    async def _run():
        from nat_helpers import daedalus_memory_tools as tools

        monkeypatch.setattr(
            tools,
            "authenticated_user_id_from_context",
            lambda: "tuttlebr",
        )
        editor = FakeMemoryEditor()
        emitted = []
        async for item in tools.daedalus_add_memory(
            tools.DaedalusAddMemoryConfig(memory="redis_memory"),
            FakeBuilder(editor),
        ):
            emitted.append(item)

        add_input = tools.AddMemoryInput.model_validate(
            {
                "memory": "The user's name is Brandon Tuttle.",
                "tags": ["user_profile"],
                "metadata": {"type": "preference"},
                "user_id": "Brandon Tuttle",
            }
        )
        result = await emitted[0].fn(add_input)
        return result, editor.added

    result, added = run(_run())

    assert result.startswith("Memory added successfully")
    assert len(added) == 1
    assert added[0].user_id == "tuttlebr"
    assert added[0].memory == "The user's name is Brandon Tuttle."
    assert added[0].tags == ["user_profile"]
    assert added[0].metadata == {"type": "preference"}


def test_add_memory_replays_completed_autonomous_write_without_second_effect(
    monkeypatch,
):
    async def _run():
        from nat_helpers import daedalus_memory_tools as tools
        from nat_helpers import idempotency

        monkeypatch.setattr(
            tools,
            "authenticated_user_id_from_context",
            lambda: "tuttlebr",
        )
        monkeypatch.setattr(
            tools,
            "execution_id_from_context_or_none",
            lambda: "request-123",
        )

        reservations = [
            SimpleNamespace(
                acquired=True,
                state="in_progress",
                stored_result=None,
            ),
            SimpleNamespace(
                acquired=False,
                state="completed",
                stored_result="Memory added successfully. replayed",
            ),
        ]

        async def reserve_operation(**kwargs):
            assert kwargs["user_id"] == "tuttlebr"
            assert kwargs["execution_id"] == "request-123"
            return reservations.pop(0)

        completions = []

        async def complete_operation(reservation, result):
            completions.append((reservation, result))
            return True

        monkeypatch.setattr(idempotency, "reserve_operation", reserve_operation)
        monkeypatch.setattr(idempotency, "complete_operation", complete_operation)

        editor = FakeMemoryEditor()
        emitted = []
        async for item in tools.daedalus_add_memory(
            tools.DaedalusAddMemoryConfig(memory="redis_memory"),
            FakeBuilder(editor),
        ):
            emitted.append(item)
        add_input = tools.AddMemoryInput(memory="Remember this")
        first = await emitted[0].fn(add_input)
        replay = await emitted[0].fn(add_input)
        return first, replay, editor.added, completions

    first, replay, added, completions = run(_run())

    assert first.startswith("Memory added successfully")
    assert replay == "Memory added successfully. replayed"
    assert len(added) == 1
    assert len(completions) == 1


def test_get_memory_uses_authenticated_user_not_llm_supplied_user_id(monkeypatch):
    async def _run():
        from nat_helpers import daedalus_memory_tools as tools

        monkeypatch.setattr(
            tools,
            "authenticated_user_id_from_context",
            lambda: "tuttlebr",
        )
        editor = FakeMemoryEditor()
        emitted = []
        async for item in tools.daedalus_get_memory(
            tools.DaedalusGetMemoryConfig(memory="redis_memory"),
            FakeBuilder(editor),
        ):
            emitted.append(item)

        get_input = tools.GetMemoryInput.model_validate(
            {
                "query": "What is my name?",
                "top_k": 3,
                "user_id": "Brandon Tuttle",
            }
        )
        result = await emitted[0].fn(get_input)
        return result, editor.search_calls

    result, search_calls = run(_run())

    assert search_calls == [
        {"query": "What is my name?", "top_k": 3, "user_id": "tuttlebr"}
    ]
    assert '"user_id": "tuttlebr"' in result


def test_get_memory_expands_daily_summary_queries(monkeypatch):
    async def _run():
        from nat_helpers import daedalus_memory_tools as tools

        monkeypatch.setattr(
            tools,
            "authenticated_user_id_from_context",
            lambda: "tuttlebr",
        )
        editor = FakeMemoryEditor()
        emitted = []
        async for item in tools.daedalus_get_memory(
            tools.DaedalusGetMemoryConfig(memory="redis_memory"),
            FakeBuilder(editor),
        ):
            emitted.append(item)

        get_input = tools.GetMemoryInput.model_validate(
            {
                "query": (
                    "daily summary briefing preferences what to include "
                    "calendar gmail news personal daily brief"
                ),
                "top_k": 5,
            }
        )
        await emitted[0].fn(get_input)
        return editor.search_calls

    search_calls = run(_run())

    assert len(search_calls) == 1
    call = search_calls[0]
    assert call["top_k"] == 12
    assert call["user_id"] == "tuttlebr"
    assert "daily summary briefing preferences" in call["query"]
    assert "Kubernetes cluster status" in call["query"]
    assert "k8s_mcp_server" in call["query"]
    assert "required live cards" in call["query"]
    assert "nv-html" in call["query"]
    assert "NVIDIA HTML" in call["query"]
    assert "no Markdown" in call["query"]
    assert "agent_skills_tool" in call["query"]
