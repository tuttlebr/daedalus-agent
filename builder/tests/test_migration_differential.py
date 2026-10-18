"""Migration comparison ignores only independent scheduling, never lost rounds."""

import copy
import importlib
from pathlib import Path

import pytest


@pytest.fixture
def differential(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "migration"))
    return importlib.import_module("differential")


def test_http_comparison_ignores_timing_but_preserves_stream_semantics(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "migration"))
    normalized = importlib.import_module("document_tool_receipts_check").normalized
    original = {
        "latency_ms": 100.0,
        "first_answer_ms": 20.0,
        "activity_comments": 1,
        "starts": [{"parent_id": "run-a", "payload": "request"}],
        "ends": [{"parent_id": "run-a", "payload": "answer"}],
        "terminal": "stop",
        "errors": [],
        "done": True,
    }
    changed = {**copy.deepcopy(original), "latency_ms": 300.0, "first_answer_ms": 75.0}
    assert normalized(original) == normalized(changed)
    for field, value in (
        ("ends", []),
        ("terminal", "error"),
        ("done", False),
        ("activity_comments", 0),
    ):
        assert normalized(original) != normalized({**changed, field: value})
    assert original["first_answer_ms"] == 20.0
    assert original["starts"][0]["parent_id"] == "run-a"


def test_conversation_comparison_retains_order_payloads_and_multiplicity(differential):
    first = {"user": "alice-chat", "input": [{"role": "user", "content": "hello"}]}
    second = {
        "user": "alice-chat",
        "input": [{"type": "function_call_output", "output": "exact"}],
    }
    independent = {"user": "bob-chat", "input": [{"role": "user", "content": "other"}]}
    expected = differential.requests_by_conversation(
        {"requests": [first, independent, second]}
    )
    assert (
        differential.requests_by_conversation(
            {"requests": [independent, first, second]}
        )
        == expected
    )
    for changed in (
        [second, first, independent],
        [first, independent],
        [first, second, second, independent],
        [first, {**second, "user": "bob-chat"}, independent],
        [first, {**second, "input": []}, independent],
    ):
        assert differential.requests_by_conversation({"requests": changed}) != expected


def test_legacy_comparison_rejects_unexplained_model_and_schema_changes(differential):
    baseline = {
        "version": 1,
        "model_requests": [
            {
                "user": "alice-chat",
                "model": "fixture",
                "instructions": "Synthetic fixture instructions.",
                "tools": [
                    {
                        "name": "current_datetime_tool",
                        "parameters": {"type": "object", "properties": {}},
                    }
                ],
                "input": [{"role": "user", "content": "BASIC"}],
            }
        ],
    }
    policy = differential.json.loads(
        (
            Path(__file__).resolve().parents[1] / "runtime/resources/tool-policy.json"
        ).read_text()
    )
    current = copy.deepcopy(baseline)
    request = current["model_requests"][0]
    request["instructions"] += "\n\n" + policy["instructions"]
    request["tool_choice"] = "auto"
    request["tools"][0]["description"] = policy["clock_description"]
    differential.compare_preparation(current, baseline, copy.deepcopy(current))
    for field, value in (
        ("model", "wrong-model"),
        ("input", []),
        ("user", "another-user"),
        ("tools", []),
        ("tool_choice", "none"),
    ):
        changed = copy.deepcopy(current)
        changed["model_requests"][0][field] = value
        with pytest.raises(AssertionError, match="Unexplained"):
            differential.compare_preparation(changed, baseline)
        with pytest.raises(AssertionError, match="Current Python/Rust"):
            differential.compare_preparation(current, baseline, changed)
    assert (
        baseline["model_requests"][0]["instructions"]
        == "Synthetic fixture instructions."
    )
    assert "tool_choice" not in baseline["model_requests"][0]
