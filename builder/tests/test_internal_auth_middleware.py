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


@pytest.mark.parametrize(
    "token", [b"caf\xe9-secret", b"trusted-secret\xff", "trusted-秘密".encode()]
)
def test_non_ascii_token_is_an_ordinary_denial(monkeypatch, token):
    """Latin-1 header text must not turn a bad credential into a server error."""
    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "trusted-secret")
    monkeypatch.delenv("ALLOW_INSECURE_INTERNAL", raising=False)

    app_calls, messages = _run_request(
        "/v1/images/generate",
        [(b"x-user-id", b"alice"), (b"x-daedalus-internal-token", token)],
    )

    assert app_calls == []
    assert messages[0]["status"] == 401


def test_identity_helpers_deny_non_ascii_credentials_with_value_errors(monkeypatch):
    from nat_helpers.identity import (
        authenticated_request_headers_scope,
        authenticated_user_id_from_headers,
        resolve_authenticated_user_id,
    )

    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "trusted-secret")
    with pytest.raises(ValueError, match="x-daedalus-internal-token"):
        authenticated_user_id_from_headers(
            {"x-user-id": "alice", "x-daedalus-internal-token": "caf\xe9"}
        )
    with authenticated_request_headers_scope(
        {"x-user-id": "alice", "x-daedalus-internal-token": "trusted-secret"}
    ):
        assert resolve_authenticated_user_id() == "alice"
    with authenticated_request_headers_scope(
        {"x-user-id": "alice", "x-daedalus-internal-token": "trusted-secr\xe9t"}
    ):
        with pytest.raises(ValueError, match="x-daedalus-internal-token"):
            resolve_authenticated_user_id()


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
        trusted_request_header_from_context,
    )

    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "trusted-secret")

    async def app(scope, receive, send):
        expected_scope = scope["expected_scope"]
        for _ in range(3):
            await asyncio.sleep(0)
            assert trusted_request_header_from_context("x-user-id") == "same-user"
            assert (
                trusted_request_header_from_context("x-daedalus-execution-scope")
                == expected_scope
            )
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
        authenticated_request_headers_scope,
        execution_id_from_context_or_none,
    )

    async def request(user, execution_id):
        with authenticated_request_headers_scope(
            {
                "x-user-id": user,
                "x-daedalus-execution-scope": "autonomy",
                "x-daedalus-execution-id": execution_id,
            }
        ):
            await asyncio.sleep(0)
            assert execution_id_from_context_or_none() == execution_id
            try:
                with authenticated_request_headers_scope({"x-user-id": "nested"}):
                    await asyncio.sleep(0)
                    assert execution_id_from_context_or_none() is None
                    if fails:
                        raise RuntimeError("fixture")
            except RuntimeError:
                pass
            assert execution_id_from_context_or_none() == execution_id
        assert _http_request_headers.get() is None

    async def scenario():
        await asyncio.gather(request("alice", "first"), request("bob", "second"))

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


@pytest.mark.parametrize(
    "token,insecure,allowed",
    [
        ("", "1", True),
        ("", " TRUE ", True),
        ("", "Yes", True),
        ("", "0", False),
        ("", "", False),
        ("", "on", False),
        (" trusted-secret ", "", True),
    ],
)
def test_router_and_tool_identity_share_one_internal_auth_policy(
    monkeypatch, token, insecure, allowed
):
    """The ASGI gate and tool identity helpers must accept the same requests."""
    from nat_helpers.identity import authenticated_user_id_from_headers

    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", token)
    monkeypatch.setenv("ALLOW_INSECURE_INTERNAL", insecure)
    headers = {"x-user-id": "alice", "x-daedalus-internal-token": "trusted-secret"}

    app_calls, _ = _run_request(
        "/v1/chat/completions", [(k.encode(), v.encode()) for k, v in headers.items()]
    )
    try:
        identity_allowed = authenticated_user_id_from_headers(headers) == "alice"
    except ValueError:
        identity_allowed = False

    assert (app_calls == ["/v1/chat/completions"]) is allowed
    assert identity_allowed is allowed


def test_tool_identity_reads_the_router_internal_auth_settings(monkeypatch):
    """identity.py has no second parser for the internal-token settings."""
    from nat_helpers.identity import authenticated_user_id_from_headers

    monkeypatch.delenv("DAEDALUS_INTERNAL_API_TOKEN", raising=False)
    monkeypatch.delenv("ALLOW_INSECURE_INTERNAL", raising=False)
    monkeypatch.setattr(internal_auth, "allow_insecure_internal", lambda: True)
    assert authenticated_user_id_from_headers({"x-user-id": "alice"}) == "alice"

    monkeypatch.setattr(internal_auth, "configured_internal_token", lambda: "rotated")
    with pytest.raises(ValueError, match="x-daedalus-internal-token"):
        authenticated_user_id_from_headers({"x-user-id": "alice"})
    assert (
        authenticated_user_id_from_headers(
            {"x-user-id": "alice", "x-daedalus-internal-token": "rotated"}
        )
        == "alice"
    )
