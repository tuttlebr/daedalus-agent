"""Redis-backed forget ledger used to prevent migration resurrection."""

from __future__ import annotations

import datetime
import hashlib
import json
from typing import Any

from nat_helpers.redis_url import close_redis_client, redis_url_from_env


def _scope(user_id: str) -> str:
    return hashlib.sha256(user_id.encode("utf-8")).hexdigest()


def _resource(resource_id: str) -> str:
    return hashlib.sha256(resource_id.encode("utf-8")).hexdigest()


def clear_epoch_key(user_id: str) -> str:
    return f"daedalus:memory-ledger:{_scope(user_id)}:clear-epoch"


def tombstone_key(user_id: str, kind: str, resource_id: str) -> str:
    if kind not in {"memory", "source"}:
        raise ValueError("invalid memory tombstone kind")
    return (
        f"daedalus:memory-ledger:{_scope(user_id)}:"
        f"tombstone:{kind}:{_resource(resource_id)}"
    )


def _event(reason: str) -> str:
    return json.dumps(
        {
            "at": datetime.datetime.now(datetime.UTC).isoformat(),
            "reason": reason,
        },
        separators=(",", ":"),
    )


def record_clear_epoch_sync(redis_client: Any, user_id: str) -> None:
    redis_client.set(clear_epoch_key(user_id), _event("user_clear_all"))


async def _record(key: str, reason: str) -> None:
    from redis import asyncio as redis_async

    client = redis_async.from_url(redis_url_from_env(), decode_responses=True)
    try:
        await client.set(key, _event(reason))
    finally:
        await close_redis_client(client)


async def record_clear_epoch(user_id: str) -> None:
    await _record(clear_epoch_key(user_id), "user_clear_all")


async def record_tombstone(
    *,
    user_id: str,
    kind: str,
    resource_id: str,
    reason: str,
) -> None:
    await _record(tombstone_key(user_id, kind, resource_id), reason)


async def get_clear_epoch(redis_client: Any, user_id: str) -> datetime.datetime | None:
    raw = await redis_client.get(clear_epoch_key(user_id))
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        return datetime.datetime.fromisoformat(str(parsed["at"]))
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        # A corrupt ledger must fail safe: treat it as a current clear marker.
        return datetime.datetime.now(datetime.UTC)


async def delete_owned_redis_memories(user_id: str) -> int:
    """Delete only NAT Redis memory records owned by one authenticated user."""

    from redis import asyncio as redis_async

    client = redis_async.from_url(redis_url_from_env(), decode_responses=True)
    owned_keys: list[Any] = []
    try:
        async for memory_key in client.scan_iter(match="nat:memory:*"):
            raw = None
            try:
                raw = await client.execute_command("JSON.GET", memory_key)
            except Exception:
                raw = await client.get(memory_key)
            try:
                record = json.loads(raw) if isinstance(raw, str) else raw
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(record, list) and len(record) == 1:
                record = record[0]
            if isinstance(record, dict) and record.get("user_id") == user_id:
                owned_keys.append(memory_key)
        if not owned_keys:
            return 0
        return int(await client.delete(*owned_keys) or 0)
    finally:
        await close_redis_client(client)
