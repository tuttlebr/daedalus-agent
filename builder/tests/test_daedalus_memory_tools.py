"""Tests for Daedalus memory wrappers with authenticated identity."""

import asyncio


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


def test_authenticated_user_id_from_headers_uses_x_user_id_without_local_token(
    monkeypatch,
):
    from nat_helpers.identity import authenticated_user_id_from_headers

    monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)

    assert authenticated_user_id_from_headers({"x-user-id": " tuttlebr "}) == "tuttlebr"


def test_authenticated_user_id_from_headers_requires_matching_internal_token(
    monkeypatch,
):
    import pytest
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
