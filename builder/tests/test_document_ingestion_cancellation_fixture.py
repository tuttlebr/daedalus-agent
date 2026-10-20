"""Cancellation fixture signals completion after recording the held HTTP fetch."""

import importlib
import socket
import threading
from http.client import HTTPResponse
from http.server import ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest


@pytest.mark.parametrize("disconnect", [False, True])
def test_cancelled_fetch_records_call_before_signalling_finished(
    monkeypatch, disconnect
):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "migration"))
    tool_peers = importlib.import_module("document_tool_ingestion_check").ToolPeers
    peers = tool_peers(None)
    peers.case = {"cancel": True, "cancel_phase": "extraction"}
    peers.document_reply = {"status": "success", "data": []}
    server = ThreadingHTTPServer(("127.0.0.1", 0), peers.handler())
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with socket.create_connection(server.server_address, timeout=5) as pending:
            pending.sendall(
                b"GET /v2/fetch_job/synthetic-job HTTP/1.1\r\nHost: localhost\r\n\r\n"
            )
            assert peers.held.wait(5)
            with httpx.Client(
                base_url=f"http://127.0.0.1:{server.server_port}",
                timeout=5,
                trust_env=False,
            ) as client:
                assert client.get("/__tool/held").json() == {
                    "held": True,
                    "finished": False,
                }
                assert client.get("/__runner/calls").json()["nv_calls"] == []
                if disconnect:
                    pending.shutdown(socket.SHUT_RDWR)
                    pending.close()
                client.post("/__tool/release").raise_for_status()
                assert peers.fetch_finished.wait(5)
                assert client.get("/__tool/held").json() == {
                    "held": True,
                    "finished": True,
                }
                assert client.get("/__runner/calls").json() == {
                    "nv_calls": [
                        {"method": "GET", "path": "/v2/fetch_job/JOB", "body": None}
                    ],
                    "object_calls": [],
                }
                if not disconnect:
                    response = HTTPResponse(pending)
                    response.begin()
                    assert response.status == 200
                    assert b'"status": "success"' in response.read()
    finally:
        peers.release.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
