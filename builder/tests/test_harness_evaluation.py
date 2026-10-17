"""Configuration experiments preserve isolation, identity and live failure evidence."""

import importlib.util
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[2] / "evaluation/tool-correctness"


def load(name):
    spec = importlib.util.spec_from_file_location(
        "evaluation_" + name, ROOT / f"{name}.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


experiment = load("experiment")
gateway = load("gateway")


@pytest.mark.parametrize(
    "content",
    [
        "llms: {main: {api_key: secret}}",
        "workflow: {tools: [production_mutation]}",
        "workflow: {max_iterations: true}",
        "workflow: {max_iterations: 0}",
        "workflow: {instructions: '${PRIVATE_TOKEN}'}",
        "workflow: {tool_output_compaction_max_ratio: .nan}",
    ],
)
def test_overlay_rejects_authority_and_invalid_values(tmp_path, content):
    path = tmp_path / "overlay.yaml"
    path.write_text(content)
    with pytest.raises(ValueError):
        experiment.overlay(path)


def test_configuration_identity_and_route_drift(tmp_path):
    path = tmp_path / "overlay.yaml"
    path.write_text(
        "workflow: {max_iterations: 12, tool_output_compaction_enabled: false}"
    )
    fields = experiment.overlay(path)
    assert fields == {"max_iterations": 12, "tool_output_compaction_enabled": False}
    assert experiment.digest(fields) == experiment.digest(
        dict(reversed(list(fields.items())))
    )
    before = experiment.route_digest(path)
    experiment.require_stable_route(path, before)
    path.write_text("changed route")
    with pytest.raises(RuntimeError, match="comparison invalid"):
        experiment.require_stable_route(path, before)


def test_target_mapping_does_not_record_credentials():
    raw = b'[llm_clients.provider]\napi_key_env="PRIVATE_KEY"\n[targets.high]\nid="high"\nmodel="upstream"\nextra_body={reasoning_effort="high"}\n'
    result = experiment.target_metadata(raw)
    assert result == {
        "high": {"configured_provider_model": "upstream", "configured_effort": "high"}
    }
    assert "PRIVATE" not in json.dumps(result)


def test_gateway_records_identity_and_usage_without_changing_stream():
    captured, records = [], []
    data = b'data: {"type":"response.completed","response":{"status":"completed","model":"upstream","usage":{"input_tokens":123,"output_tokens":7,"private":"omit"},"output":[]}}\n\n'

    class Upstream(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            captured.append(
                (
                    self.headers["Authorization"],
                    self.rfile.read(int(self.headers["Content-Length"])),
                )
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("x-model-router-selected-model", "high")
            self.end_headers()
            self.wfile.write(data)

    upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    proxy = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        gateway.handler(
            f"http://127.0.0.1:{upstream.server_port}/v1",
            records,
            {
                "high": {
                    "configured_provider_model": "upstream",
                    "configured_effort": "high",
                }
            },
        ),
    )
    for server in (upstream, proxy):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        body = {"input": "synthetic private prompt"}
        response = httpx.post(
            f"http://127.0.0.1:{proxy.server_port}/v1/responses",
            json=body,
            headers={"Authorization": "Bearer synthetic-secret"},
            trust_env=False,
        )
        assert response.content == data
        assert captured[0][0] == "Bearer synthetic-secret"
        assert json.loads(captured[0][1]) == body
        assert records[0]["configured_effort"] == "high"
        assert records[0]["usage"] == {"input_tokens": 123, "output_tokens": 7}
        assert "private" not in json.dumps(
            records
        ) and "synthetic-secret" not in json.dumps(records)
    finally:
        for server in (proxy, upstream):
            server.shutdown()
            server.server_close()


research = load("research")


def research_result(mode):
    starts, ends = [], []

    def append(name, args, value):
        identifier = str(len(starts))
        starts.append(
            {"id": identifier, "name": "Function Start: " + name, "payload": args}
        )
        ends.append(
            {"id": identifier, "name": "Function Complete: " + name, "payload": value}
        )

    for index, (url, marker) in enumerate(research.SOURCES.items()):
        reference = f"tor_fixture_{index}"
        value = (
            json.dumps(
                {
                    "_daedalus_compacted_tool_output": {"reference": reference},
                    "preview": {
                        "source": {"url": url},
                        "content": "Excerpt without required evidence",
                    },
                }
            )
            if mode == "research"
            else url + " " + marker
        )
        append("webscrape_tool", {"url": url, "output_mode": mode}, value)
        if mode == "research":
            append(
                "tool_output_retriever_tool",
                {"reference": reference, "query": "verification"},
                marker,
            )
    append(
        "webscrape_tool",
        {"url": research.MISSING, "output_mode": mode},
        "Error: source unavailable",
    )
    return {
        "answer": json.dumps(research.EXPECTED),
        "starts": starts,
        "ends": ends,
        "done": True,
        "terminal": "stop",
        "errors": [],
        "latency_ms": 1000,
    }


@pytest.mark.parametrize("mode", ["full", "research"])
def test_research_gate_requires_exact_answer_and_bound_source_evidence(mode):
    result = research_result(mode)
    assert research.assess(result, mode)["passed"]
    result["answer"] = "Here is the answer: " + result["answer"]
    assert not research.assess(result, mode)["passed"]


@pytest.mark.parametrize(
    "fault",
    [
        "missing_evidence",
        "wrong_reference",
        "duplicate_fetch",
        "wrong_binding",
        "invented_gap",
        "wrong_citation",
    ],
)
def test_research_gate_rejects_plausible_but_unsupported_answers(fault):
    result = research_result("research")
    if fault == "missing_evidence":
        result["ends"][1]["payload"] = "No matching evidence"
    elif fault == "wrong_reference":
        result["starts"][1]["payload"]["reference"] = "tor_other_user"
    elif fault == "duplicate_fetch":
        result["starts"].append({**result["starts"][0], "id": "duplicate"})
        result["ends"].append({**result["ends"][0], "id": "duplicate"})
    elif fault == "wrong_binding":
        result["ends"][1]["id"] = "missing"
    elif fault == "invented_gap":
        result["ends"][-1]["payload"] = "The source has no release label."
    else:
        value = json.loads(result["answer"])
        value["findings"][0]["source"] = research.MISSING
        result["answer"] = json.dumps(value)
    assert not research.assess(result, "research")["passed"]
