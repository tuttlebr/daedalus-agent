"""Fail-closed idempotency reservations for autonomous local write tools."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from dataclasses import dataclass
from typing import Any

from nat_helpers.redis_url import close_redis_client, redis_client


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
    contract: str | None = None

    @property
    def acquired(self) -> bool:
        return self.owner_token is not None and self.state == "in_progress"


def _ttl_seconds() -> int:
    configured = int(os.getenv("AUTONOMY_IDEMPOTENCY_TTL_SECONDS", "604800"))
    return max(3600, configured)


async def _redis_client():
    return redis_client(timeout_seconds=5)


async def reserve_operation(
    *,
    user_id: str,
    execution_id: str,
    operation: str,
    arguments: Any,
    contract: str | None = None,
    legacy_arguments: Any = None,
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
    record = {
        "state": "in_progress",
        "owner": owner_token,
        "arguments_sha256": arguments_hash,
    }
    if contract is not None:
        record["contract"] = contract
    legacy_key = None
    if legacy_arguments is not None:
        if not contract:
            raise ValueError("A legacy reservation requires a contract marker")
        legacy_key = operation_key(
            user_id=user_id,
            execution_id=execution_id,
            operation=operation,
            arguments_sha256=canonical_arguments_sha256(legacy_arguments),
        )
    payload = json.dumps(
        record,
        sort_keys=True,
        separators=(",", ":"),
    )

    redis = await _redis_client()
    try:
        for _attempt in range(2):
            existing_key = key
            if legacy_key is not None:
                legacy_raw = await redis.get(legacy_key)
                try:
                    legacy_record = json.loads(legacy_raw)
                except (TypeError, ValueError):
                    legacy_record = None
                marked = (
                    isinstance(legacy_record, dict)
                    and legacy_record.get("contract") == contract
                )
                # Check the old receipt and reserve the corrected arguments in
                # one operation. Compare the exact inspected bytes: Redis's
                # JSON decoder cannot read all retained Python receipt strings.
                acquired, existing_key, raw = await redis.eval(
                    """
local current = redis.call('GET', KEYS[1])
if current then return {0, KEYS[1], current} end
local legacy = redis.call('GET', KEYS[2])
if legacy and (ARGV[4] ~= '1' or legacy ~= ARGV[3]) then
  return {0, KEYS[2], legacy}
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return {1, KEYS[1], ''}
""",
                    2,
                    key,
                    legacy_key,
                    payload,
                    str(_ttl_seconds()),
                    legacy_raw or b"",
                    "1" if marked else "0",
                )
                if isinstance(existing_key, bytes):
                    existing_key = existing_key.decode("utf-8")
            else:
                acquired = await redis.set(key, payload, nx=True, ex=_ttl_seconds())
                raw = None if acquired else await redis.get(key)
            if acquired:
                return Reservation(key, owner_token, "in_progress", contract=contract)
            if raw:
                try:
                    existing = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    return Reservation(existing_key, None, "invalid")
                if existing_key != key and existing.get("contract") == contract:
                    # A new default request appeared or completed between the
                    # read and reservation. Recheck once, then fail closed.
                    continue
                state = str(existing.get("state") or "invalid")
                result = existing.get("result")
                return Reservation(
                    existing_key,
                    None,
                    state,
                    str(result) if isinstance(result, str) else None,
                )
        return Reservation(key, None, "in_progress")
    finally:
        await close_redis_client(redis)


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
    record = {"state": "completed", "result": result}
    if reservation.contract is not None:
        record["contract"] = reservation.contract
    completed = json.dumps(
        record,
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
        await close_redis_client(redis)
