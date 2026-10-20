"""Migration comparison ignores only independent scheduling, never lost rounds."""

import copy
import importlib
import io
import json
from pathlib import Path

import httpx
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


def test_conversation_comparison_ignores_only_parallel_output_order(differential):
    calls = [
        {"type": "function_call", "call_id": name, "name": name, "arguments": "{}"}
        for name in ("read", "clock")
    ]
    outputs = [
        {"type": "function_call_output", "call_id": name, "output": result}
        for name, result in (("read", "exact evidence"), ("clock", "<clock-instant>"))
    ]
    message = {"role": "user", "content": "next turn"}
    report = {
        "requests": [
            {"user": "alice-chat", "input": calls},
            {"user": "alice-chat", "input": calls + outputs + [message]},
        ]
    }
    original = copy.deepcopy(report)
    expected = differential.requests_by_conversation(report)

    def compared(items):
        changed = copy.deepcopy(report)
        changed["requests"][1]["input"] = items
        return differential.requests_by_conversation(changed)

    assert compared(calls + outputs[::-1] + [message]) == expected
    for changed in (
        calls + outputs[:1] + [message],
        calls + outputs + outputs[:1] + [message],
        calls + [outputs[0], {**outputs[1], "output": "changed"}, message],
        calls + [outputs[0], {**outputs[1], "call_id": "other"}, message],
        calls + [outputs[0], message, outputs[1]],
        calls[::-1] + outputs + [message],
    ):
        assert compared(changed) != expected
    assert report == original


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


@pytest.fixture
def memory_report():
    bank = "/v1/default/banks/synthetic-alice"
    return {
        "model_requests": [],
        "memory_requests": {
            "first-chat": [
                ["GET", bank + "/config", None],
                ["PATCH", bank + "/config", {"updates": {"budget": "low"}}],
                ["GET", bank + "/knowledge-base/search?q=previous+project", None],
                ["GET", bank + "/knowledge-base/pages/project", None],
                [
                    "POST",
                    bank + "/memories/recall",
                    {"query": "previous project", "budget": "low"},
                ],
            ],
            "second-chat": [],
        },
        "status": "passed",
    }


@pytest.mark.parametrize("recall_position", [2, 3, 4])
def test_memory_comparison_allows_independent_recall_scheduling(
    differential, memory_report, recall_position
):
    original = copy.deepcopy(memory_report)
    concurrent = copy.deepcopy(memory_report)
    requests = concurrent["memory_requests"]["first-chat"]
    requests.insert(recall_position, requests.pop())
    differential.compare_preparation(concurrent, memory_report, memory_report)
    differential.compare_preparation(memory_report, memory_report, concurrent)
    assert memory_report == original
    assert requests[recall_position][1].endswith("/memories/recall")


@pytest.mark.parametrize(
    "change",
    [
        "missing",
        "duplicate",
        "body",
        "bank",
        "conversation",
        "page_before_search",
        "recall_before_bootstrap",
        "mutation_order",
    ],
)
def test_memory_comparison_rejects_contract_changes(
    differential, memory_report, change
):
    changed = copy.deepcopy(memory_report)
    requests = changed["memory_requests"]["first-chat"]
    if change == "missing":
        requests.pop()
    elif change == "duplicate":
        requests.append(copy.deepcopy(requests[-1]))
    elif change == "body":
        requests[-1][2]["query"] = "another project"
    elif change == "bank":
        requests[-1][1] = requests[-1][1].replace("synthetic-alice", "synthetic-bob")
    elif change == "conversation":
        changed["memory_requests"]["second-chat"].append(requests.pop())
    elif change == "page_before_search":
        requests[2], requests[3] = requests[3], requests[2]
    elif change == "recall_before_bootstrap":
        requests.insert(1, requests.pop())
    elif change == "mutation_order":
        requests[0], requests[1] = requests[1], requests[0]
    with pytest.raises(AssertionError, match="Unexplained"):
        differential.compare_preparation(changed, memory_report)
    with pytest.raises(AssertionError, match="Current Python/Rust"):
        differential.compare_preparation(memory_report, memory_report, changed)


def test_public_memory_transport_correction_keeps_exact_dispatch_contract(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "migration"))
    compare = importlib.import_module("memory_api_check").compare_public_memory_response
    old = {
        "scenario": "upstream_lost_response",
        "status": 500,
        "body": "Internal Server Error",
        "calls": [
            {
                "method": "PATCH",
                "path": "/v1/default/banks/alice/memories/fact-1",
                "body": {"text": "Synthetic rejected change"},
                "authorization": "Bearer synthetic-hindsight",
            }
        ],
    }
    expected = {**old, "status": 502, "body": {"detail": "memory service unavailable"}}
    compare(old, expected, 84)
    for changed in (
        old,
        {**expected, "status": 200},
        {**expected, "body": {"detail": "SYNTHETIC_PRIVATE_UPSTREAM"}},
        {**expected, "calls": []},
        {**expected, "calls": old["calls"] * 2},
        {**expected, "calls": [{**old["calls"][0], "body": {"text": "changed"}}]},
        {**expected, "calls": [{**old["calls"][0], "path": "/another-user"}]},
    ):
        with pytest.raises(AssertionError, match="Public memory parity"):
            compare(old, changed, 84)
    unrelated = {key: value for key, value in old.items() if key != "scenario"}
    compare(unrelated, unrelated, 0)
    with pytest.raises(AssertionError, match="Public memory parity"):
        compare(unrelated, {**unrelated, "status": 502}, 0)
    assert old["status"] == 500


def test_live_research_proxy_preserves_unicode_inside_provider_events(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "migration"))
    research = importlib.import_module("research_check")
    events = [
        {
            "type": "response.output_text.delta",
            "delta": "Evidence\u0085snow\u2028雪\u2029🌲",
        },
        {
            "type": "response.completed",
            "response": {"model": "fixture", "usage": {"total_tokens": 7}},
        },
    ]
    wire = b"".join(
        ("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode()
        for event in events
    )
    client_type = httpx.Client

    def upstream(request):
        assert request.url == "http://synthetic-provider/v1/responses"
        return httpx.Response(200, content=wire)

    monkeypatch.setattr(
        research.httpx,
        "Client",
        lambda **kwargs: client_type(**kwargs, transport=httpx.MockTransport(upstream)),
    )
    peers = research.LiveResearchPeers("http://synthetic-provider/v1", "fixture")
    handler_type = peers.handler()
    handler = object.__new__(handler_type)
    body = json.dumps(
        {"input": [{"role": "user", "content": "Read evidence"}]}
    ).encode()
    handler.headers = {"Content-Length": str(len(body))}
    handler.rfile = io.BytesIO(body)
    handler.wfile = io.BytesIO()
    handler.send_response = lambda *_: None
    handler.send_header = lambda *_: None
    handler.end_headers = lambda: None
    handler.do_POST()
    assert handler.wfile.getvalue() == wire
    assert peers.usage == [{"total_tokens": 7}]
    assert peers.model_calls[0]["provider_reported_model"] == "fixture"
