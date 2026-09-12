"""Public transport response bounds against a disposable real HTTP peer."""

import asyncio
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import nat_helpers.safe_http as safe
import pytest


@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("kind", ["length", "stream", "compressed", "small"])
def test_public_fetch_binds_body_budget_and_encoding(monkeypatch, asynchronous, kind):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.headers["Accept-Encoding"])
            self.send_response(200)
            if kind == "length":
                self.send_header("Content-Length", "8192")
            if kind == "compressed":
                self.send_header("Content-Encoding", "gzip")
            self.end_headers()
            try:
                self.wfile.write(b"x" * (8 if kind == "small" else 8192))
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    # Test-only resolution; production public-address validation is unchanged.
    monkeypatch.setattr(safe, "resolve_public_addresses", lambda _host: ["127.0.0.1"])
    url = f"http://fixture.test:{server.server_port}/"

    async def async_request():
        async with httpx.AsyncClient(
            transport=safe.PublicAsyncHTTPTransport(max_response_bytes=1024),
            trust_env=False,
        ) as client:
            return await client.get(url)

    def request():
        if asynchronous:
            return asyncio.run(async_request())
        with httpx.Client(
            transport=safe.PublicHTTPTransport(max_response_bytes=1024), trust_env=False
        ) as client:
            return client.get(url)

    try:
        if kind == "small":
            assert request().content == b"x" * 8
        else:
            with pytest.raises(safe.ResponseSizeError):
                request()
        assert requests == ["identity"]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)
