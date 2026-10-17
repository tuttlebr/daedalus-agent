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
