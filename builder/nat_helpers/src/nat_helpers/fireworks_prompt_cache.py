"""Request-scoped Fireworks prompt-cache routing headers."""

from __future__ import annotations

import hashlib
import hmac
import os
from typing import Any, Literal

SessionAffinityScope = Literal["user", "conversation"]

_IDENTIFIER_VERSION = "daedalus-fireworks-prompt-cache-v1"


def _opaque_identifier(namespace: str, *parts: str) -> str:
    """Return a stable, non-PII identifier for a Fireworks cache key."""
    payload = "\0".join((_IDENTIFIER_VERSION, namespace, *parts)).encode("utf-8")
    secret = (os.getenv("DAEDALUS_INTERNAL_API_TOKEN") or "").strip()
    if secret:
        digest = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    else:
        # Local development can explicitly run without the internal token. The
        # input is still reduced to an opaque identifier instead of forwarding
        # a username or conversation ID to the model provider.
        digest = hashlib.sha256(payload).hexdigest()
    return digest[:48]


def build_fireworks_prompt_cache_headers(
    user_id: str,
    conversation_id: str | None = None,
    *,
    session_affinity_scope: SessionAffinityScope = "conversation",
    prompt_cache_isolation: bool = True,
) -> dict[str, str]:
    """Build deterministic Fireworks affinity and optional isolation headers."""
    normalized_user_id = user_id.strip()
    if not normalized_user_id:
        return {}

    normalized_conversation_id = (conversation_id or "").strip()
    session_parts = [normalized_user_id]
    if session_affinity_scope == "conversation" and normalized_conversation_id:
        session_parts.append(normalized_conversation_id)

    headers = {
        "x-session-affinity": (
            "daedalus-session-" + _opaque_identifier("session", *session_parts)
        )
    }
    if prompt_cache_isolation:
        headers["x-prompt-cache-isolation-key"] = "daedalus-user-" + _opaque_identifier(
            "user", normalized_user_id
        )
    return headers


def _current_prompt_cache_identity() -> tuple[str, str | None] | None:
    """Resolve trusted identity without copying raw values into provider headers."""
    from nat.builder.context import Context
    from nat_helpers.identity import authenticated_user_id_from_context

    try:
        user_id = authenticated_user_id_from_context()
    except ValueError:
        # CLI and build-time calls do not have authenticated HTTP metadata.
        return None

    context = Context.get()
    conversation_id = context.conversation_id
    if not conversation_id:
        headers = getattr(getattr(context, "metadata", None), "headers", None)
        getter = getattr(headers, "get", None)
        if callable(getter):
            conversation_id = getter("x-conversation-id") or None

    return user_id, conversation_id


class FireworksPromptCacheHeaderHook:
    """Inject Fireworks prompt-cache headers immediately before an HTTP request."""

    def __init__(
        self,
        *,
        session_affinity_scope: SessionAffinityScope = "conversation",
        prompt_cache_isolation: bool = True,
    ) -> None:
        self._session_affinity_scope = session_affinity_scope
        self._prompt_cache_isolation = prompt_cache_isolation

    async def __call__(self, request: Any) -> None:
        identity = _current_prompt_cache_identity()
        if identity is None:
            return

        user_id, conversation_id = identity
        headers = build_fireworks_prompt_cache_headers(
            user_id,
            conversation_id,
            session_affinity_scope=self._session_affinity_scope,
            prompt_cache_isolation=self._prompt_cache_isolation,
        )
        for name, value in headers.items():
            # Trusted request context takes precedence over caller-supplied
            # model kwargs so one user cannot select another user's cache key.
            request.headers[name] = value
