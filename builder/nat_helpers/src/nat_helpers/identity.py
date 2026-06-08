"""Request identity helpers for Daedalus NAT tools."""

from __future__ import annotations

import hmac
import os
from collections.abc import Mapping
from typing import Any


def _configured_internal_token() -> str:
    return (os.getenv("DAEDALUS_INTERNAL_API_TOKEN") or "").strip()


def _header_value(headers: Any, name: str) -> str:
    if headers is None:
        return ""

    getter = getattr(headers, "get", None)
    if callable(getter):
        value = getter(name)
        if value is not None:
            return str(value).strip()

    if isinstance(headers, Mapping):
        lower_name = name.lower()
        for key, value in headers.items():
            if str(key).lower() == lower_name and value is not None:
                return str(value).strip()

    return ""


def authenticated_user_id_from_headers(headers: Any) -> str:
    """Resolve the authenticated end user from trusted frontend headers.

    In production, Helm injects ``DAEDALUS_INTERNAL_API_TOKEN`` into both the
    frontend and backend. When it is configured, the identity header is trusted
    only if the request also carries the matching internal token. Local Compose
    deployments historically leave the token unset; in that case we keep the
    legacy behavior and trust ``x-user-id`` for development.
    """

    user_id = _header_value(headers, "x-user-id")
    if not user_id:
        raise ValueError("authenticated user header x-user-id is required")

    expected_token = _configured_internal_token()
    if expected_token:
        provided_token = _header_value(headers, "x-daedalus-internal-token")
        if not provided_token or not hmac.compare_digest(
            provided_token,
            expected_token,
        ):
            raise ValueError("valid x-daedalus-internal-token is required")

    return user_id


def authenticated_user_id_from_context() -> str:
    """Resolve the authenticated end user from the current NAT request context."""

    from nat.builder.context import Context

    nat_context = Context.get()
    headers = getattr(getattr(nat_context, "metadata", None), "headers", None)
    return authenticated_user_id_from_headers(headers)


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
