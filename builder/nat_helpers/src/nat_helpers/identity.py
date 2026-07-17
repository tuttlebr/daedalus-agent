"""Request identity helpers for Daedalus NAT tools."""

from __future__ import annotations

import hmac
import os
from collections.abc import Mapping
from typing import Any


def _configured_internal_token() -> str:
    return (os.getenv("DAEDALUS_INTERNAL_API_TOKEN") or "").strip()


def _allow_insecure_internal() -> bool:
    return (os.getenv("ALLOW_INSECURE_INTERNAL") or "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


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

    expected_token = _configured_internal_token()
    if expected_token:
        provided_token = _header_value(headers, "x-daedalus-internal-token")
        if not provided_token or not hmac.compare_digest(
            provided_token,
            expected_token,
        ):
            raise ValueError("valid x-daedalus-internal-token is required")
    else:
        # Match the custom HTTP-router policy without importing FastAPI or
        # Starlette into this low-level helper.
        if not _allow_insecure_internal():
            raise ValueError("internal API authentication is not configured")

    user_id = _header_value(headers, "x-user-id")
    if not user_id:
        raise ValueError("authenticated user header x-user-id is required")

    return user_id


def authenticated_user_id_from_context() -> str:
    """Resolve the authenticated end user from the current NAT request context."""

    from nat.builder.context import Context

    nat_context = Context.get()
    headers = getattr(getattr(nat_context, "metadata", None), "headers", None)
    return authenticated_user_id_from_headers(headers)


def approval_token_from_context() -> str:
    """Read the worker-supplied approval credential from trusted HTTP metadata.

    Callers must also resolve the authenticated user with
    :func:`authenticated_user_id_from_context`; that validation proves the
    request came through the internal frontend/worker boundary. The credential
    is deliberately not accepted from model/tool arguments.
    """

    from nat.builder.context import Context

    nat_context = Context.get()
    headers = getattr(getattr(nat_context, "metadata", None), "headers", None)
    return _header_value(headers, "x-daedalus-approval-token")


def execution_scope_from_context_or_none() -> str | None:
    """Return the trusted caller scope, or ``None`` for a direct invocation.

    An HTTP request with no scope header returns the empty string. This lets
    consequential tools distinguish ordinary interactive chat from the
    dedicated autonomy worker, while preserving direct-call/test behavior when
    no NAT request metadata exists at all.
    """

    try:
        from nat.builder.context import Context
    except Exception:
        return None

    nat_context = Context.get()
    headers = getattr(getattr(nat_context, "metadata", None), "headers", None)
    if headers is None:
        return None
    return _header_value(headers, "x-daedalus-execution-scope").lower()


def execution_id_from_context_or_none() -> str | None:
    """Return the trusted durable execution ID for autonomous requests.

    The ID is accepted only on the authenticated autonomy path. Interactive
    requests intentionally return ``None`` so ordinary user retries aren't
    deduplicated as though they were queue replays.
    """

    try:
        from nat.builder.context import Context
    except Exception:
        return None

    nat_context = Context.get()
    headers = getattr(getattr(nat_context, "metadata", None), "headers", None)
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
        from nat.builder.context import Context
    except Exception:
        return fallback

    nat_context = Context.get()
    headers = getattr(getattr(nat_context, "metadata", None), "headers", None)
    if headers is None:
        return fallback

    return authenticated_user_id_from_headers(headers)


def resolve_authenticated_user_id(asserted_user_id: str | None = None) -> str:
    """Return the trusted request user and validate an optional legacy assertion.

    ``asserted_user_id`` is never an authority source in an HTTP request. It is
    retained only so direct callers using an older signature get an explicit
    mismatch error during migration. When NAT has no HTTP request context at
    all, the assertion is accepted as the direct-call/test fallback.
    """

    asserted = str(asserted_user_id or "").strip()
    authenticated = authenticated_user_id_from_context_or_fallback(asserted)
    if not authenticated:
        raise ValueError("authenticated user identity is required")
    authenticated = str(authenticated).strip()
    if not authenticated:
        raise ValueError("authenticated user identity is required")
    if asserted and not hmac.compare_digest(asserted, authenticated):
        raise ValueError(
            "supplied user identity does not match the authenticated request"
        )
    return authenticated
