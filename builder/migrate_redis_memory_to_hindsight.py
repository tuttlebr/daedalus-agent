#!/usr/bin/env python3
"""Idempotently migrate owned NAT Redis memories into Hindsight user banks.

The command is read-only unless ``--execute`` is supplied. Output contains
counts and opaque user hashes only; it never prints memory text or user IDs.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import hashlib
import json
import sys
from dataclasses import dataclass
from typing import Any

from nat_helpers.hindsight_client import client_from_env, deterministic_document_id
from nat_helpers.memory_ledger import get_clear_epoch, tombstone_key
from nat_helpers.redis_url import close_redis_client, redis_url_from_env


@dataclass(frozen=True)
class LegacyMemory:
    redis_key: str
    user_id: str
    content: str
    tags: list[str]
    metadata: dict[str, Any]
    created_at: datetime.datetime | None


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="write to Hindsight; default is a read-only dry run",
    )
    parser.add_argument(
        "--user-id",
        help="migrate one exact user ID; output still uses only an opaque hash",
    )
    parser.add_argument("--concurrency", type=int, default=4)
    return parser.parse_args()


def _decode(raw: Any) -> dict[str, Any] | None:
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return None
    if isinstance(raw, list) and len(raw) == 1:
        raw = raw[0]
    return raw if isinstance(raw, dict) else None


def _json_value(raw: Any, default: Any) -> Any:
    if not isinstance(raw, str):
        return raw
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default


def _parse_date(
    record: dict[str, Any],
    metadata: dict[str, Any],
) -> datetime.datetime | None:
    candidates = (
        record.get("created_at"),
        record.get("timestamp"),
        metadata.get("imported_at"),
    )
    for candidate in candidates:
        if not candidate:
            continue
        try:
            parsed = datetime.datetime.fromisoformat(
                str(candidate).replace("Z", "+00:00")
            )
        except ValueError:
            continue
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=datetime.UTC)
    return None


def _parse_memory(key: Any, record: dict[str, Any]) -> LegacyMemory | None:
    user_id = str(record.get("user_id") or "").strip()
    content = str(record.get("memory") or "").strip()
    if not user_id or not content:
        return None

    raw_tags = _json_value(record.get("tags") or [], [])
    raw_metadata = _json_value(record.get("metadata") or {}, {})
    tags = [str(tag) for tag in raw_tags] if isinstance(raw_tags, list) else []
    metadata = raw_metadata if isinstance(raw_metadata, dict) else {}
    redis_key = key.decode() if isinstance(key, bytes) else str(key)
    return LegacyMemory(
        redis_key=redis_key,
        user_id=user_id,
        content=content,
        tags=tags,
        metadata=metadata,
        created_at=_parse_date(record, metadata),
    )


def _opaque_user(user_id: str) -> str:
    return hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:12]


async def _load_memories(
    redis_client: Any, user_filter: str | None
) -> list[LegacyMemory]:
    records: list[LegacyMemory] = []
    async for key in redis_client.scan_iter(match="nat:memory:*"):
        try:
            raw = await redis_client.execute_command("JSON.GET", key)
        except Exception:
            raw = await redis_client.get(key)
        record = _decode(raw)
        if not record:
            continue
        memory = _parse_memory(key, record)
        if memory and (not user_filter or memory.user_id == user_filter):
            records.append(memory)
    return records


def _migration_document_id(memory: LegacyMemory) -> str:
    key_hash = hashlib.sha256(memory.redis_key.encode("utf-8")).hexdigest()
    return deterministic_document_id(
        user_id=memory.user_id,
        source="redis",
        request_id=key_hash,
        content=key_hash,
    )


async def _eligible_memories(
    redis_client: Any,
    memories: list[LegacyMemory],
) -> tuple[list[tuple[LegacyMemory, str]], int, int]:
    by_user: dict[str, list[LegacyMemory]] = {}
    for memory in memories:
        by_user.setdefault(memory.user_id, []).append(memory)

    eligible: list[tuple[LegacyMemory, str]] = []
    skipped_clear = 0
    skipped_tombstone = 0
    for user_id, user_memories in by_user.items():
        clear_epoch = await get_clear_epoch(redis_client, user_id)
        for memory in user_memories:
            document_id = _migration_document_id(memory)
            if clear_epoch and (
                memory.created_at is None or memory.created_at <= clear_epoch
            ):
                skipped_clear += 1
                continue
            if await redis_client.exists(tombstone_key(user_id, "source", document_id)):
                skipped_tombstone += 1
                continue
            eligible.append((memory, document_id))
    return eligible, skipped_clear, skipped_tombstone


async def _run(options: argparse.Namespace) -> int:
    if options.concurrency < 1 or options.concurrency > 32:
        raise ValueError("--concurrency must be between 1 and 32")

    from redis import asyncio as redis_async

    redis_client = redis_async.from_url(redis_url_from_env(), decode_responses=True)
    try:
        memories = await _load_memories(redis_client, options.user_id)
        eligible, skipped_clear, skipped_tombstone = await _eligible_memories(
            redis_client,
            memories,
        )
        users = {memory.user_id for memory in memories}
        print(
            json.dumps(
                {
                    "mode": "execute" if options.execute else "dry-run",
                    "users": len(users),
                    "records_scanned": len(memories),
                    "records_eligible": len(eligible),
                    "skipped_clear_epoch": skipped_clear,
                    "skipped_tombstone": skipped_tombstone,
                    "user_scopes": sorted(_opaque_user(user) for user in users),
                },
                sort_keys=True,
            )
        )
        if not options.execute:
            return 0

        client = client_from_env()
        semaphore = asyncio.Semaphore(options.concurrency)
        failures = 0

        async def migrate(memory: LegacyMemory, document_id: str) -> None:
            nonlocal failures
            async with semaphore:
                try:
                    await client.retain(
                        user_id=memory.user_id,
                        content=memory.content,
                        document_id=document_id,
                        context="Daedalus Redis memory migration",
                        tags=["source:redis-migration", *memory.tags],
                        metadata={
                            **memory.metadata,
                            "source": "redis-migration",
                            "legacy_key_hash": hashlib.sha256(
                                memory.redis_key.encode("utf-8")
                            ).hexdigest(),
                        },
                        asynchronous=False,
                    )
                except Exception:
                    failures += 1

        await asyncio.gather(
            *(migrate(memory, document_id) for memory, document_id in eligible)
        )
        print(
            json.dumps(
                {"migrated": len(eligible) - failures, "failed": failures},
                sort_keys=True,
            )
        )
        return 1 if failures else 0
    finally:
        await close_redis_client(redis_client)


def main() -> int:
    try:
        return asyncio.run(_run(_args()))
    except Exception as exc:
        print(f"migration failed: {exc.__class__.__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
