"""Autonomous jobs must not publish partial or failed backend responses."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from autonomous_agent.backend_client import (
    BackendClient,
    BackendRejectedError,
    OAuthRequiredError,
    RunAbortedError,
)

_PARTIAL = 'data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n'


@pytest.fixture
def backend_stream():
    body = b""
    status_code = 200
    keep_open = False
    release = threading.Event()
    server_finished = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(status_code)
            self.send_header("Content-Type", "text/event-stream")
            if not keep_open:
                self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
            if keep_open:
                release.wait(3)
            server_finished.set()

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    backend = BackendClient(
        base_url=f"http://127.0.0.1:{server.server_port}",
        api_path="/chat",
        user_id="test-user",
        request_timeout=5,
    )

    def invoke(stream, *, hold_open=False, status=200):
        nonlocal body, keep_open, status_code
        body = stream.encode("utf-8")
        keep_open = hold_open
        status_code = status
        return backend.call(
            [{"role": "user", "content": "test"}],
            charter_task={
                "id": "test",
                "kind": "calendar_discovery",
                "max_tool_calls": 5,
            },
        )

    invoke.server_finished = server_finished

    try:
        yield invoke
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        serving.join(2)


@pytest.mark.parametrize(
    ("suffix", "error"),
    [
        ("", "ended before completion"),
        ('event: error\ndata: {"error":{"message":"failed"}}\n\n', "reported an error"),
        (
            'data: {"error":{"message":"failed"}}\n\ndata: [DONE]\n\n',
            "reported an error",
        ),
        (
            'data: {"choices":[{"delta":{},"finish_reason":"error"}]}\n\n'
            "data: [DONE]\n\n",
            "reported an error",
        ),
        ("data: broken JSON\n\ndata: [DONE]\n\n", "invalid stream event"),
        ("data: []\n\ndata: [DONE]\n\n", "invalid stream event"),
    ],
)
def test_backend_stream_rejects_partial_or_failed_answers(
    backend_stream, suffix, error
):
    with pytest.raises(RunAbortedError, match=error):
        backend_stream(_PARTIAL + suffix)


@pytest.mark.parametrize("status", [400, 401, 403, 409, 429])
def test_admission_rejection_is_distinct_from_unknown_execution(backend_stream, status):
    with pytest.raises(BackendRejectedError) as error:
        backend_stream("PRIVATE RESPONSE", status=status)
    assert error.value.status_code == status
    assert "PRIVATE" not in str(error.value)


@pytest.mark.parametrize("status", [408, 500, 502, 503, 504])
def test_server_or_gateway_failure_does_not_claim_no_mutation(backend_stream, status):
    with pytest.raises(RunAbortedError) as error:
        backend_stream("PRIVATE RESPONSE", status=status)
    assert not isinstance(error.value, BackendRejectedError)


def test_backend_stream_preserves_text_and_accepts_optional_sse_spacing(backend_stream):
    assert (
        backend_stream(
            'event:message\ndata:{"choices":[{"delta":{"content":"hello "}}]}\n\n'
            'data: {"choices":[{"delta":{"content":"world 🌍"}}]}\n\n'
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
            "data:[DONE]\n\n"
        )
        == "hello world 🌍"
    )


def test_backend_stream_retains_oauth_failure(backend_stream):
    with pytest.raises(OAuthRequiredError) as raised:
        backend_stream(
            'event:oauth_required\ndata:{"auth_url":"https://example.com/oauth",'
            '"oauth_state":"state"}\n\n'
        )
    assert raised.value.auth_url == "https://example.com/oauth"
    assert raised.value.oauth_state == "state"


def test_source_authentication_prose_is_data_not_an_oauth_control_event(backend_stream):
    # Legacy textual guessing could turn source evidence into a control event.
    text = "Authorization is required for https://example.com/oauth"
    stream = (
        "event:message\ndata:"
        + json.dumps({"notice": text, "choices": [{"delta": {"content": text}}]})
        + "\n\n"
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
    )
    assert backend_stream(stream) == text


def test_backend_stream_accepts_done_without_terminal_choice(backend_stream):
    assert backend_stream(_PARTIAL + "data:[DONE]\n\n") == "partial answer"


@pytest.mark.parametrize(
    "completion",
    [
        {"finish_reason": "stop"},
        {"finish_reason": None, "daedalus_terminal": True},
    ],
)
def test_backend_returns_on_explicit_terminal_while_connection_stays_open(
    backend_stream, completion
):
    terminal = json.dumps(
        {"choices": [{"delta": {"content": " completed"}, **completion}]}
    )
    assert (
        backend_stream(_PARTIAL + f"data: {terminal}\n\n", hold_open=True)
        == "partial answer completed"
    )
    assert (
        not backend_stream.server_finished.is_set()
    ), "Client waited for terminal stream teardown"


@pytest.mark.parametrize(
    "choice",
    [
        None,
        {"finish_reason": True},
        {"daedalus_terminal": "true"},
        {"daedalus_terminal": 1},
        {"finish_reason": "stop", "delta": "invalid"},
        {"finish_reason": "stop", "delta": {"content": {"invalid": "text"}}},
    ],
)
def test_backend_rejects_malformed_terminal_choices(backend_stream, choice):
    with pytest.raises(RunAbortedError, match="invalid stream event"):
        backend_stream(_PARTIAL + "data: " + json.dumps({"choices": [choice]}) + "\n\n")
