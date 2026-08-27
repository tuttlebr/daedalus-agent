"""Quality and contract tests for reversible tool-output compaction."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, replace
from pathlib import Path

import pytest
import yaml
from nat_helpers import tool_output_retriever as retriever_module
from nat_helpers.tool_output_compaction import (
    COMPACTION_MARKER,
    CompactionSettings,
    OptimizationCache,
    ToolOutputStore,
    _estimate_tokens,
    optimize_tool_content,
    optimize_tool_messages,
    tool_output_reference,
)
from nat_helpers.tool_output_retriever import (
    ToolOutputRetrieverConfig,
    ToolOutputRetrieverInput,
    _build_retriever_runner,
)


class MemoryStore:
    def __init__(self, *, accept: bool = True):
        self.accept = accept
        self.values: dict[tuple[str, str], str] = {}

        self.put_calls = 0

    async def put(self, user_id: str, content: str, reference: str) -> bool:
        self.put_calls += 1
        if not self.accept:
            return False
        self.values[(user_id, reference)] = content
        return True

    async def get(self, user_id: str, reference: str) -> str | None:
        return self.values.get((user_id, reference))


def _run(coro):
    return asyncio.run(coro)


def _large_rows() -> list[dict[str, object]]:
    rows = [
        {
            "id": index,
            "name": f"routine-worker-{index}",
            "status": "ready",
            "detail": "ordinary repeated metadata used to make a realistic result",
        }
        for index in range(120)
    ]
    rows[67]["status"] = "critical failure"
    rows[67]["detail"] = "database timeout on the only unhealthy worker"
    rows[73]["detail"] = "needle-project owns the requested deployment"
    return rows


def _settings(**updates) -> CompactionSettings:
    return replace(
        CompactionSettings(),
        min_chars=1_000,
        max_items=14,
        min_savings_chars=500,
        max_compacted_ratio=0.8,
        **updates,
    )


def test_large_json_preview_is_smaller_and_exactly_recoverable():
    original = json.dumps({"items": _large_rows(), "source": "cluster"}, indent=2)
    store = MemoryStore()

    result = _run(
        optimize_tool_content(
            original,
            tool_name="list_workers",
            query="Which needle-project worker failed?",
            user_id="user-a",
            store=store,  # type: ignore[arg-type]
            settings=_settings(),
        )
    )

    assert result.mode == "reversible_preview"
    assert result.reference == tool_output_reference(original)
    assert store.values[("user-a", result.reference)] == original
    assert len(result.content) < len(original) * 0.5
    assert _estimate_tokens(result.content) < _estimate_tokens(original) * 0.5

    payload = json.loads(result.content)
    marker = payload[COMPACTION_MARKER]
    assert marker["total_items"] == 120
    assert marker["omitted_items"] == 106
    shown = payload["preview"]["items"]["items"]
    shown_indices = {entry["index"] for entry in shown}
    assert 67 in shown_indices  # anomaly retention
    assert 73 in shown_indices  # current-query relevance


def test_cache_failure_fails_open_to_lossless_json():
    original_value = {"items": _large_rows()}
    original = json.dumps(original_value, indent=4)

    result = _run(
        optimize_tool_content(
            original,
            tool_name="list_workers",
            query="find failures",
            user_id="user-a",
            store=MemoryStore(accept=False),  # type: ignore[arg-type]
            settings=_settings(),
        )
    )

    assert result.mode == "lossless_json"
    assert json.loads(result.content) == original_value
    assert COMPACTION_MARKER not in result.content


def test_exhaustive_query_keeps_every_row_without_retrieval_dependency():
    original_value = {"items": _large_rows()}
    original = json.dumps(original_value, indent=2)

    result = _run(
        optimize_tool_content(
            original,
            tool_name="list_workers",
            query="List all workers exactly",
            user_id="user-a",
            store=MemoryStore(),  # type: ignore[arg-type]
            settings=_settings(),
        )
    )

    assert result.mode == "lossless_json"
    assert json.loads(result.content) == original_value
    assert COMPACTION_MARKER not in result.content


@pytest.mark.parametrize(
    "content",
    [
        "plain prose " * 2_000,
        "def important_function():\n    return 'preserve code'\n" * 400,
        '{"duplicate":1,"duplicate":2}',
        '{"not_finite":NaN}',
    ],
)
def test_unstructured_or_unsafe_content_passes_through(content):
    result = _run(
        optimize_tool_content(
            content,
            tool_name="read",
            query="analyze it",
            user_id="user-a",
            store=MemoryStore(),  # type: ignore[arg-type]
            settings=_settings(),
        )
    )
    assert result.mode == "unchanged"
    assert result.content == content


def test_tagged_json_is_compacted_without_dropping_wrapper():
    original = f"<searchresults>{json.dumps(_large_rows(), indent=2)}</searchresults>"
    result = _run(
        optimize_tool_content(
            original,
            tool_name="search",
            query="database timeout",
            user_id="user-a",
            store=MemoryStore(),  # type: ignore[arg-type]
            settings=_settings(),
        )
    )
    assert result.mode == "reversible_preview"
    assert result.content.startswith("<searchresults>")
    assert result.content.endswith("</searchresults>")


@dataclass
class FakeMessage:
    type: str
    content: str
    name: str = ""

    def model_copy(self, *, update: dict[str, str]):
        return replace(self, **update)


def test_only_model_facing_tool_message_copy_is_changed():
    original = json.dumps(_large_rows(), indent=2)
    messages = [
        FakeMessage("human", "Find the database timeout"),
        FakeMessage("tool", original, "list_workers"),
        FakeMessage("tool", original, "tool_output_retriever_tool"),
    ]

    optimized = _run(
        optimize_tool_messages(
            messages,
            user_id="user-a",
            store=MemoryStore(),  # type: ignore[arg-type]
            settings=_settings(),
        )
    )

    assert messages[1].content == original  # graph state retains exact content
    assert COMPACTION_MARKER in optimized[1].content
    assert optimized[2] is messages[2]  # retrieval output is never re-compacted


def test_optimization_cache_avoids_repeating_work_each_agent_iteration():
    """The agent node re-runs on a growing message list once per iteration.

    Without a memo, every prior tool result is re-parsed, re-serialized,
    re-hashed, re-compressed, and written back to Redis on each pass — up to
    max_iterations times per turn, synchronously on the shared event loop.
    """
    original = json.dumps(_large_rows(), indent=2)
    store = MemoryStore()
    cache = OptimizationCache()
    messages = [
        FakeMessage("human", "Find the database timeout"),
        FakeMessage("tool", original, "list_workers"),
    ]

    first = _run(
        optimize_tool_messages(
            messages,
            user_id="user-a",
            store=store,  # type: ignore[arg-type]
            settings=_settings(),
            cache=cache,
        )
    )
    after_first = store.put_calls
    assert after_first == 1
    assert COMPACTION_MARKER in first[1].content

    second = _run(
        optimize_tool_messages(
            messages,
            user_id="user-a",
            store=store,  # type: ignore[arg-type]
            settings=_settings(),
            cache=cache,
        )
    )

    assert store.put_calls == after_first  # no redundant re-store
    assert second[1].content == first[1].content


def test_optimization_cache_recomputes_when_the_user_query_changes():
    """The preview is query-aware, so a new turn must not reuse the old one."""
    original = json.dumps(_large_rows(), indent=2)
    store = MemoryStore()
    cache = OptimizationCache()

    _run(
        optimize_tool_messages(
            [
                FakeMessage("human", "Find the database timeout"),
                FakeMessage("tool", original, "list_workers"),
            ],
            user_id="user-a",
            store=store,  # type: ignore[arg-type]
            settings=_settings(),
            cache=cache,
        )
    )
    assert store.put_calls == 1

    _run(
        optimize_tool_messages(
            [
                FakeMessage("human", "Which workers are draining?"),
                FakeMessage("tool", original, "list_workers"),
            ],
            user_id="user-a",
            store=store,  # type: ignore[arg-type]
            settings=_settings(),
            cache=cache,
        )
    )
    assert store.put_calls == 2


def test_responses_user_blocks_protect_exhaustive_queries():
    original = json.dumps(_large_rows(), indent=2)
    messages = [
        FakeMessage(
            "human",
            [{"type": "input_text", "text": "List every worker exactly"}],
        ),
        FakeMessage("tool", original, "list_workers"),
    ]

    optimized = _run(
        optimize_tool_messages(
            messages,
            user_id="user-a",
            store=MemoryStore(),  # type: ignore[arg-type]
            settings=_settings(),
        )
    )

    assert json.loads(optimized[1].content) == _large_rows()
    assert COMPACTION_MARKER not in optimized[1].content


class FailingStore(MemoryStore):
    async def put(self, user_id: str, content: str, reference: str) -> bool:
        raise RuntimeError("synthetic cache bug")


def test_unexpected_optimizer_error_fails_open_per_message():
    original = json.dumps(_large_rows(), indent=2)
    messages = [
        FakeMessage("human", "Find the failure"),
        FakeMessage("tool", original, "list_workers"),
    ]

    optimized = _run(
        optimize_tool_messages(
            messages,
            user_id="user-a",
            store=FailingStore(),  # type: ignore[arg-type]
            settings=_settings(),
        )
    )

    assert optimized == messages


class FakeRedis:
    def __init__(self):
        self.values: dict[str, bytes] = {}

    async def set(self, key, value, **_kwargs):
        self.values[key] = value
        return True

    async def get(self, key):
        return self.values.get(key)


def test_store_keys_and_reads_are_user_isolated():
    store = ToolOutputStore(redis_url="redis://unused")
    store._client = FakeRedis()
    content = json.dumps(_large_rows())
    reference = tool_output_reference(content)

    assert _run(store.put("user-a", content, reference))
    assert _run(store.get("user-a", reference)) == content
    assert _run(store.get("user-b", reference)) is None
    assert len(store._client.values) == 1


def test_retriever_searches_and_pages_exact_original(monkeypatch):
    content = "prefix\nneedle value\nsuffix"
    reference = tool_output_reference(content)
    store = MemoryStore()
    store.values[("user-a", reference)] = content
    monkeypatch.setattr(
        retriever_module,
        "authenticated_user_id_from_context",
        lambda: "user-a",
    )
    runner = _build_retriever_runner(
        ToolOutputRetrieverConfig(max_chunk_chars=1_000, context_chars=50),
        store,  # type: ignore[arg-type]
    )

    searched = json.loads(
        _run(runner(ToolOutputRetrieverInput(reference=reference, query="needle")))
    )
    assert searched["matches_returned"] == 1
    assert "needle value" in searched["matches"][0]["content"]

    paged = json.loads(
        _run(
            runner(
                ToolOutputRetrieverInput(
                    reference=reference,
                    offset=7,
                    max_chars=1_000,
                )
            )
        )
    )
    assert paged["content"] == content[7:]
    assert paged["complete"] is True


def test_retriever_does_not_cross_user_boundary(monkeypatch):
    content = "private exact output"
    reference = tool_output_reference(content)
    store = MemoryStore()
    store.values[("user-a", reference)] = content
    monkeypatch.setattr(
        retriever_module,
        "authenticated_user_id_from_context",
        lambda: "user-b",
    )
    runner = _build_retriever_runner(
        ToolOutputRetrieverConfig(),
        store,  # type: ignore[arg-type]
    )

    result = json.loads(_run(runner(ToolOutputRetrieverInput(reference=reference))))
    assert result["error"] == "tool_output_not_found"


def test_backend_enables_reversible_compaction_contract():
    config_path = (
        Path(__file__).resolve().parents[2] / "backend/tool-calling-config.yaml"
    )
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    workflow = config["workflow"]

    assert config["functions"]["tool_output_retriever_tool"]["_type"] == (
        "tool_output_retriever"
    )
    assert "tool_output_retriever_tool" in workflow["nat_tools"]
    assert workflow["tool_output_compaction_enabled"] is True
    assert workflow["tool_output_compaction_min_chars"] >= 1_000
    assert workflow["tool_output_compaction_max_items"] >= 5
    assert workflow["tool_output_cache_ttl_seconds"] >= 300
