"""Backend-wide internal identity middleware contracts."""

import asyncio
import json

import nat_helpers.internal_auth as internal_auth
import pytest
from nat_helpers.internal_auth import DaedalusInternalAuthMiddleware


class _TestHTTPException(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@pytest.fixture(autouse=True)
def _real_exception_type(monkeypatch):
    monkeypatch.setattr(internal_auth, "HTTPException", _TestHTTPException)


def _run_request(path: str, headers: list[tuple[bytes, bytes]]):
    app_calls = []
    messages = []

    async def app(scope, receive, send):
        app_calls.append(scope["path"])
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    middleware = DaedalusInternalAuthMiddleware(app)
    asyncio.run(
        middleware({"type": "http", "path": path, "headers": headers}, receive, send)
    )
    return app_calls, messages


def test_execution_route_fails_closed_when_internal_auth_is_unconfigured(monkeypatch):
    monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
    monkeypatch.delenv("ALLOW_INSECURE_INTERNAL", raising=False)

    app_calls, messages = _run_request(
        "/v1/chat/completions", [(b"x-user-id", b"alice")]
    )

    assert app_calls == []
    assert messages[0]["status"] == 503
    assert json.loads(messages[1]["body"])["detail"].startswith("Internal API")


def test_execution_route_requires_matching_token_and_user(monkeypatch):
    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "trusted-secret")
    monkeypatch.delenv("ALLOW_INSECURE_INTERNAL", raising=False)

    denied_calls, denied_messages = _run_request(
        "/chat",
        [
            (b"x-user-id", b"alice"),
            (b"x-daedalus-internal-token", b"wrong"),
        ],
    )
    assert denied_calls == []
    assert denied_messages[0]["status"] == 401

    allowed_calls, allowed_messages = _run_request(
        "/chat",
        [
            (b"x-user-id", b"alice"),
            (b"x-daedalus-internal-token", b"trusted-secret"),
        ],
    )
    assert allowed_calls == ["/chat"]
    assert allowed_messages[0]["status"] == 204


def test_health_route_remains_public(monkeypatch):
    monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
    monkeypatch.delenv("ALLOW_INSECURE_INTERNAL", raising=False)

    app_calls, messages = _run_request("/health", [])

    assert app_calls == ["/health"]
    assert messages[0]["status"] == 204


@pytest.mark.parametrize(
    "path",
    [
        "/health/ready",
        "/docs",
        "/docs/oauth2-redirect",
        "/redoc",
        "/openapi.json",
        "/auth/redirect",
    ],
)
def test_explicit_public_routes_remain_public(monkeypatch, path):
    monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
    monkeypatch.delenv("ALLOW_INSECURE_INTERNAL", raising=False)

    app_calls, messages = _run_request(path, [])

    assert app_calls == [path]
    assert messages[0]["status"] == 204


def test_unknown_future_route_is_protected_by_default(monkeypatch):
    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "trusted-secret")
    monkeypatch.delenv("ALLOW_INSECURE_INTERNAL", raising=False)

    app_calls, messages = _run_request("/future-execution-route", [])

    assert app_calls == []
    assert messages[0]["status"] == 401


def test_request_headers_are_isolated_across_concurrent_calls_and_reset(monkeypatch):
    from nat_helpers.identity import (
        _http_request_headers,
        execution_id_from_context_or_none,
        execution_scope_from_context_or_none,
        trusted_request_header_from_context,
    )

    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "trusted-secret")

    async def app(scope, receive, send):
        expected_scope = scope["expected_scope"]
        for _ in range(3):
            await asyncio.sleep(0)
            assert trusted_request_header_from_context("x-user-id") == "same-user"
            assert execution_scope_from_context_or_none() == expected_scope
            assert execution_id_from_context_or_none() == (
                "autonomy-run" if expected_scope == "autonomy" else None
            )
        if scope.get("cancel"):
            raise asyncio.CancelledError

    middleware = DaedalusInternalAuthMiddleware(app)

    async def invoke(execution_scope, cancel=False):
        assert _http_request_headers.get() is None
        try:
            await middleware(
                {
                    "type": "http",
                    "path": "/v1/chat/completions",
                    "expected_scope": execution_scope,
                    "cancel": cancel,
                    "headers": [
                        (b"x-user-id", b"same-user"),
                        (b"x-daedalus-internal-token", b"trusted-secret"),
                        (b"x-daedalus-execution-scope", execution_scope.encode()),
                        (b"x-daedalus-execution-id", b"autonomy-run"),
                    ],
                },
                None,
                None,
            )
        except asyncio.CancelledError:
            assert cancel
        assert _http_request_headers.get() is None

    async def scenario():
        await asyncio.gather(invoke("autonomy"), invoke(""), invoke("autonomy", True))
        await invoke("")

    asyncio.run(scenario())


@pytest.mark.parametrize("fails", [False, True])
def test_request_context_is_isolated_and_restored_after_failure(fails):
    from nat_helpers.identity import (
        _http_request_headers,
        approval_token_from_context,
        authenticated_request_headers_scope,
        execution_scope_from_context_or_none,
    )

    async def request(user, scope, token):
        with authenticated_request_headers_scope(
            {
                "x-user-id": user,
                "x-daedalus-execution-scope": scope,
                "x-daedalus-approval-token": token,
            }
        ):
            await asyncio.sleep(0)
            assert execution_scope_from_context_or_none() == scope
            assert approval_token_from_context() == token
            try:
                with authenticated_request_headers_scope({"x-user-id": "nested"}):
                    await asyncio.sleep(0)
                    assert approval_token_from_context() == ""
                    if fails:
                        raise RuntimeError("fixture")
            except RuntimeError:
                pass
            assert approval_token_from_context() == token
        assert _http_request_headers.get() is None

    async def scenario():
        await asyncio.gather(
            request("alice", "autonomy", "first"), request("bob", "", "second")
        )

    asyncio.run(scenario())


def test_websocket_routes_are_protected_by_default(monkeypatch):
    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "trusted-secret")
    messages = []
    app_calls = []

    async def app(scope, receive, send):
        app_calls.append(scope["path"])

    async def receive():
        return {"type": "websocket.connect"}

    async def send(message):
        messages.append(message)

    middleware = DaedalusInternalAuthMiddleware(app)
    asyncio.run(
        middleware(
            {"type": "websocket", "path": "/future-ws", "headers": []},
            receive,
            send,
        )
    )

    assert app_calls == []
    assert messages == [
        {
            "type": "websocket.close",
            "code": 4401,
            "reason": "Internal API token is required",
        }
    ]
