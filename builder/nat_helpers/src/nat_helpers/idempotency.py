"""Fail-closed idempotency reservations for autonomous local write tools."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from dataclasses import dataclass
from typing import Any

from nat_helpers.redis_url import redis_url_from_env


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical_arguments_sha256(arguments: Any) -> str:
    """Hash one canonical JSON representation of a tool's write arguments."""

    serialized = json.dumps(
        arguments,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    )
    return _digest(serialized)


def operation_key(
    *, user_id: str, execution_id: str, operation: str, arguments_sha256: str
) -> str:
    """Build a bounded key without exposing user IDs or tool arguments."""

    return (
        "daedalus:idempotency:v1:"
        f"{_digest(user_id)}:{_digest(execution_id)}:"
        f"{_digest(operation)}:{arguments_sha256}"
    )


@dataclass(frozen=True)
class Reservation:
    key: str
    owner_token: str | None
    state: str
    stored_result: str | None = None

    @property
    def acquired(self) -> bool:
        return self.owner_token is not None and self.state == "in_progress"


def _ttl_seconds() -> int:
    configured = int(os.getenv("AUTONOMY_IDEMPOTENCY_TTL_SECONDS", "604800"))
    return max(3600, configured)


async def _redis_client():
    from redis.asyncio import Redis

    return Redis.from_url(
        redis_url_from_env(),
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=5,
    )


async def reserve_operation(
    *,
    user_id: str,
    execution_id: str,
    operation: str,
    arguments: Any,
) -> Reservation:
    """Reserve an exact local write before its side effect is attempted.

    A surviving ``in_progress`` record is treated as an ambiguous prior
    outcome and isn't automatically retried. This favors no duplicate effect
    over silently repeating a write whose first result can't be proven.
    """

    arguments_hash = canonical_arguments_sha256(arguments)
    key = operation_key(
        user_id=user_id,
        execution_id=execution_id,
        operation=operation,
        arguments_sha256=arguments_hash,
    )
    owner_token = secrets.token_urlsafe(24)
    payload = json.dumps(
        {
            "state": "in_progress",
            "owner": owner_token,
            "arguments_sha256": arguments_hash,
        },
        sort_keys=True,
        separators=(",", ":"),
    )

    redis = await _redis_client()
    try:
        for _attempt in range(2):
            if await redis.set(key, payload, nx=True, ex=_ttl_seconds()):
                return Reservation(key, owner_token, "in_progress")
            raw = await redis.get(key)
            if raw:
                try:
                    existing = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    return Reservation(key, None, "invalid")
                state = str(existing.get("state") or "invalid")
                result = existing.get("result")
                return Reservation(
                    key,
                    None,
                    state,
                    str(result) if isinstance(result, str) else None,
                )
        return Reservation(key, None, "in_progress")
    finally:
        await redis.aclose()


async def complete_operation(reservation: Reservation, result: str) -> bool:
    """Publish a result only when this caller still owns the reservation."""

    if not reservation.acquired or not reservation.owner_token:
        return False
    script = """
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local decoded = cjson.decode(current)
if decoded['state'] ~= 'in_progress' or decoded['owner'] ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
"""
    completed = json.dumps(
        {"state": "completed", "result": result},
        sort_keys=True,
        separators=(",", ":"),
    )
    redis = await _redis_client()
    try:
        return bool(
            await redis.eval(
                script,
                1,
                reservation.key,
                reservation.owner_token,
                completed,
                str(_ttl_seconds()),
            )
        )
    finally:
        await redis.aclose()
