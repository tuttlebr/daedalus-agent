"""Request identity helpers for Daedalus tools."""

from __future__ import annotations

import hmac
from collections.abc import Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from nat_helpers import internal_auth

_http_request_headers: ContextVar[Any] = ContextVar(
    "daedalus_http_request_headers", default=None
)


@contextmanager
def authenticated_request_headers_scope(headers):
    """Snapshot the authenticated ASGI request for tool execution."""
    token = _http_request_headers.set(dict(headers))
    try:
        yield
    finally:
        _http_request_headers.reset(token)


def _request_headers():
    return _http_request_headers.get()


def _header_value(headers: Any, name: str) -> str:
    if headers is None:
        return ""

    getter = getattr(headers, "get", None)
    if callable(getter):
        value = getter(name)
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="ignore").strip()

    if isinstance(headers, Mapping):
        lower_name = name.lower()
        for key, value in headers.items():
            if str(key).lower() != lower_name:
                continue
            if isinstance(value, str):
                return value.strip()
            if isinstance(value, bytes):
                return value.decode("utf-8", errors="ignore").strip()

    return ""


def authenticated_user_id_from_headers(headers: Any) -> str:
    """Resolve the authenticated end user from trusted frontend headers.

    In production, Helm injects ``DAEDALUS_INTERNAL_API_TOKEN`` into both the
    frontend and backend. The identity header is trusted only when the request
    carries that token. An unconfigured token fails closed unless the operator
    explicitly opts into local-development behavior with
    ``ALLOW_INSECURE_INTERNAL``.
    """

    # The HTTP routers' gate owns these settings; tool identity must accept
    # exactly the requests that gate accepts.
    expected_token = internal_auth.configured_internal_token()
    if expected_token:
        provided_token = _header_value(headers, "x-daedalus-internal-token")
        # Byte comparison keeps non-ASCII header text an ordinary mismatch;
        # str comparison raises TypeError instead of denying the request.
        if not provided_token or not hmac.compare_digest(
            provided_token.encode("utf-8"),
            expected_token.encode("utf-8"),
        ):
            raise ValueError("valid x-daedalus-internal-token is required")
    elif not internal_auth.allow_insecure_internal():
        raise ValueError("internal API authentication is not configured")

    user_id = _header_value(headers, "x-user-id")
    if not user_id:
        raise ValueError("authenticated user header x-user-id is required")

    return user_id


def authenticated_user_id_from_context() -> str:
    """Resolve the authenticated end user from the current authenticated request context."""

    return authenticated_user_id_from_headers(_request_headers())


def trusted_request_header_from_context(name: str) -> str:
    """Read a request header after validating the internal identity boundary."""

    headers = _request_headers()
    # Validate the same internal token and user header before trusting any
    # request-scoped metadata carried beside them.
    authenticated_user_id_from_headers(headers)
    return _header_value(headers, name)


def request_id_from_context_or_none() -> str | None:
    try:
        request_id = trusted_request_header_from_context("x-daedalus-request-id")
    except Exception:
        return None
    return request_id or None


def execution_id_from_context_or_none() -> str | None:
    """Return the trusted durable execution ID for autonomous requests.

    The ID is accepted only on the authenticated autonomy path. Interactive
    requests intentionally return ``None`` so ordinary user retries aren't
    deduplicated as though they were queue replays.
    """

    try:
        headers = _request_headers()
    except Exception:
        return None

    if headers is None:
        return None
    if _header_value(headers, "x-daedalus-execution-scope").lower() != "autonomy":
        return None
    execution_id = _header_value(headers, "x-daedalus-execution-id")
    return execution_id or None


def authenticated_user_id_from_context_or_fallback(fallback_user_id: str = "") -> str:
    """Resolve request identity, falling back only when no HTTP context exists."""

    fallback = (fallback_user_id or "").strip()
    try:
        headers = _request_headers()
    except Exception:
        return fallback
    if headers is None:
        return fallback

    return authenticated_user_id_from_headers(headers)


def resolve_authenticated_user_id(asserted_user_id: str | None = None) -> str:
    """Return the trusted request user and validate an optional legacy assertion.

    ``asserted_user_id`` is never an authority source in an HTTP request. It is
    retained only so direct callers using an older signature get an explicit
    mismatch error during migration. When there is no HTTP request context at
    all, the assertion is accepted as the direct-call/test fallback.
    """

    asserted = str(asserted_user_id or "").strip()
    authenticated = authenticated_user_id_from_context_or_fallback(asserted)
    if not authenticated:
        raise ValueError("authenticated user identity is required")
    authenticated = str(authenticated).strip()
    if not authenticated:
        raise ValueError("authenticated user identity is required")
    if asserted and not hmac.compare_digest(
        asserted.encode("utf-8"), authenticated.encode("utf-8")
    ):
        raise ValueError(
            "supplied user identity does not match the authenticated request"
        )
    return authenticated
