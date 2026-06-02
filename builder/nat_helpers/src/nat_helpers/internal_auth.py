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
import os

from fastapi import HTTPException


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
