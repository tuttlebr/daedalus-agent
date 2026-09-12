"""Real local HTTP cancellation contracts, including a silent peer."""

import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from autonomous_agent.backend_client import BackendClient, RunAbortedError


@pytest.mark.parametrize("send_headers", [False, True])
@pytest.mark.parametrize("cancel", [False, True])
def test_silent_backend_is_interruptible(send_headers, cancel):
    ready, release, abort = threading.Event(), threading.Event(), threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            if send_headers:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.flush()
            ready.set()
            release.wait(3)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    result = []
    backend = BackendClient(
        base_url=f"http://127.0.0.1:{server.server_port}",
        api_path="/chat",
        user_id="test-user",
        request_timeout=5 if cancel else 0.3,
    )

    def invoke():
        try:
            backend.call([{"role": "user", "content": "test"}], abort=abort)
        except Exception as exc:
            result.append(exc)

    thread = threading.Thread(target=invoke)
    try:
        thread.start()
        assert ready.wait(2)
        start = time.monotonic()
        if cancel:
            abort.set()
        thread.join(1)
        assert not thread.is_alive(), "Client remained blocked on a silent peer"
        assert time.monotonic() - start < 1
        assert len(result) == 1
        assert isinstance(result[0], RunAbortedError)
        assert ("aborted" if cancel else "exceeded") in str(result[0])
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        serving.join(2)
        thread.join(2)
