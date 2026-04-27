"""Redis-backed approval tokens for consequential actions."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import time
from dataclasses import dataclass
from typing import Any

try:  # pragma: no cover - import availability depends on runtime image
    import redis
except Exception:  # pragma: no cover
    redis = None  # type: ignore[assignment]


DEFAULT_APPROVAL_TTL_SECONDS = 300


@dataclass(frozen=True)
class ApprovalRequest:
    user_id: str
    action_type: str
    target: str


def _norm(value: str | None, fallback: str = "") -> str:
    return (value or fallback).strip() or fallback


def approval_token_key(user_id: str, token: str) -> str:
    safe_user = hashlib.sha256(_norm(user_id, "anonymous").encode()).hexdigest()[:16]
    return f"approval:{safe_user}:{token}"


def build_redis_url(redis_url: str | None = None) -> str:
    explicit = _norm(redis_url)
    if explicit:
        return explicit
    env_url = _norm(os.getenv("REDIS_URL"))
    if env_url:
        port = _norm(os.getenv("REDIS_PORT"))
        if port and env_url.count(":") == 1 and "://" in env_url:
            return f"{env_url}:{port}"
        return env_url
    host = _norm(os.getenv("RI_REDIS_HOST_DAEDALUS"), "localhost")
    port = _norm(os.getenv("REDIS_PORT"), "6379")
    return f"redis://{host}:{port}"


def make_redis_client(redis_url: str | None = None):
    if redis is None:
        raise RuntimeError("redis package is unavailable")
    return redis.from_url(build_redis_url(redis_url), decode_responses=True)


def issue_approval_token(
    redis_client: Any,
    request: ApprovalRequest,
    ttl_seconds: int = DEFAULT_APPROVAL_TTL_SECONDS,
) -> str:
    token = secrets.token_urlsafe(18)
    payload = {
        "user_id": _norm(request.user_id, "anonymous"),
        "action_type": _norm(request.action_type, "unspecified"),
        "target": _norm(request.target, "*"),
        "created_at": int(time.time()),
    }
    redis_client.setex(
        approval_token_key(payload["user_id"], token),
        max(1, int(ttl_seconds)),
        json.dumps(payload),
    )
    return token


def validate_approval_token(
    redis_client: Any,
    *,
    user_id: str,
    token: str,
    action_type: str,
    target: str = "",
    consume: bool = True,
) -> tuple[bool, str]:
    if not token:
        return False, "approval_token is required"

    key = approval_token_key(user_id, token)
    raw = redis_client.get(key)
    if not raw:
        return False, "approval_token is missing, expired, or already used"

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return False, "approval_token payload is invalid"

    expected = ApprovalRequest(
        user_id=_norm(user_id, "anonymous"),
        action_type=_norm(action_type, "unspecified"),
        target=_norm(target, "*"),
    )
    actual = ApprovalRequest(
        user_id=_norm(payload.get("user_id"), "anonymous"),
        action_type=_norm(payload.get("action_type"), "unspecified"),
        target=_norm(payload.get("target"), "*"),
    )

    if actual.user_id != expected.user_id:
        return False, "approval_token user mismatch"
    if actual.action_type != expected.action_type:
        return False, "approval_token action mismatch"
    if actual.target not in ("*", expected.target):
        return False, "approval_token target mismatch"

    if consume:
        redis_client.delete(key)
    return True, "approved"
