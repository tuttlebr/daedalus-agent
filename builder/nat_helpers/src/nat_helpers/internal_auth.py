"""Shared trusted frontend->backend internal-token auth for Daedalus HTTP routers (F-019).

The image (`/v1/images/*`) and document-ingest (`/v1/documents/*`) routers each
previously defined this identical token/identity gate verbatim. Consolidating it
here removes the drift risk in security-relevant code: the internal token
(``DAEDALUS_INTERNAL_API_TOKEN``) authenticates the trusted frontend, and the
``x-user-id`` header carries the authenticated end user. The check fails closed
when the token is unconfigured, unless an operator explicitly opts out via
``ALLOW_INSECURE_INTERNAL`` (local/dev only).
"""

from __future__ import annotations

import hmac
import json
import os
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import HTTPException

_PUBLIC_HTTP_PATHS = frozenset(
    {
        "/health",
        "/health/ready",
        "/docs",
        "/docs/oauth2-redirect",
        "/redoc",
        "/openapi.json",
        "/auth/redirect",
    }
)


def configured_internal_token() -> str:
    return (os.getenv("DAEDALUS_INTERNAL_API_TOKEN") or "").strip()


def allow_insecure_internal() -> bool:
    """True only when an operator has explicitly opted out of token auth.

    Intended for local development (Docker Compose) where no internal token is
    provisioned. Production must leave this unset so a missing token fails closed.
    """
    return (os.getenv("ALLOW_INSECURE_INTERNAL") or "").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def require_internal_token(x_daedalus_internal_token: str | None) -> None:
    expected = configured_internal_token()
    if not expected:
        # Fail closed: a missing token means trusted frontend->backend auth is
        # unconfigured. Refuse rather than trusting an arbitrary caller's
        # x-user-id header. Local/dev opts out explicitly via ALLOW_INSECURE_INTERNAL=1.
        if allow_insecure_internal():
            return
        raise HTTPException(
            status_code=503,
            detail="Internal API authentication is not configured",
        )

    provided = (x_daedalus_internal_token or "").strip()
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Internal API token is required")


def require_trusted_user(
    x_user_id: str | None,
    x_daedalus_internal_token: str | None = None,
) -> str:
    require_internal_token(x_daedalus_internal_token)
    user_id = (x_user_id or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="Authenticated user is required")
    return user_id


class DaedalusInternalAuthMiddleware:
    """Enforce trusted frontend identity on every backend execution route.

    Health, documentation, OpenAPI, and the browser-facing OAuth redirect stay
    public. All NAT and Daedalus execution APIs share the same fail-closed gate.
    """

    def __init__(self, app: Callable[..., Awaitable[None]]) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive, send) -> None:
        scope_type = scope.get("type")
        if scope_type not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        path = str(scope.get("path") or "/").rstrip("/") or "/"
        # Protect by default so a newly added NAT execution route cannot bypass
        # identity enforcement merely because its prefix was not anticipated.
        protected = scope_type == "websocket" or path not in _PUBLIC_HTTP_PATHS
        if protected:
            headers = {
                bytes(key).decode("latin-1").lower(): bytes(value).decode("latin-1")
                for key, value in scope.get("headers", [])
            }
            try:
                require_trusted_user(
                    headers.get("x-user-id"),
                    headers.get("x-daedalus-internal-token"),
                )
            except HTTPException as exc:
                if scope_type == "websocket":
                    await send(
                        {
                            "type": "websocket.close",
                            "code": 4401 if exc.status_code == 401 else 4503,
                            "reason": str(exc.detail),
                        }
                    )
                    return
                body = json.dumps({"detail": exc.detail}).encode("utf-8")
                await send(
                    {
                        "type": "http.response.start",
                        "status": exc.status_code,
                        "headers": [
                            (b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode("ascii")),
                        ],
                    }
                )
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)
