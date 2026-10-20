"""Browser service fixtures preserve independent reads and exact writer RPCs."""

import base64
import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import httpx


def test_browser_ingestion_probe_does_not_leave_an_unconsumed_writer_rpc(monkeypatch):
    builder = Path(__file__).resolve().parents[1]
    monkeypatch.syspath_prepend(str(builder / "migration"))
    browser = importlib.import_module("serve_candidate")
    resets = []

    class Control:
        def post(self, path, *, json):
            assert path == "/reset"
            resets.append(json)
            return httpx.Response(
                200, request=httpx.Request("POST", "http://fixture/reset")
            )

    peers = SimpleNamespace(reset_documents=lambda: None)
    server = browser.browser_control(
        peers, {"control": Control(), "port": 19530}, 0, None
    )
    try:
        response = httpx.post(
            f"http://127.0.0.1:{server.server_port}/ingestion", trust_env=False
        )
        response.raise_for_status()
        collection = response.json()["collection"]
        assert len(resets) == 1
        settings = resets[0]
        assert settings["rename_collections"] == {"private_collection": collection}
        assert (
            settings["reader_authorization"]
            == base64.b64encode(b"synthetic-browser-milvus-token").decode()
        )
        assert settings["reader_database"] == ""
        assert collection not in settings["collections"]
        # Metadata and dimension-probe reads share the read credential/default
        # database. The peer handles both outside the independently scripted
        # writer, whose first real request is GetVersion.
        assert settings["script"][0]["method"] == "GetVersion"
        assert all(
            call["metadata"]["authorization"]
            == base64.b64encode(b"synthetic-user:synthetic-password").decode()
            for call in settings["script"]
        )
        oracle = browser.expand(
            json.loads(
                (builder / "runtime/tests/fixtures/milvus-index.json").read_text()
            )
        )["cases"][0]
        retained = [call for call in oracle["calls"] if call["method"] != "Connect"]
        assert retained[0]["method"] == "ShowCollections"
        # Every writer request, body, metadata field and response stays exact;
        # removing the independently answered probe must not relax that script.
        assert settings["script"] == retained[1:]
    finally:
        server.shutdown()
        server.server_close()
