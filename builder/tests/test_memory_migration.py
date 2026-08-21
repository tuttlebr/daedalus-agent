"""Redis migration contracts for forget-safe Hindsight cutover."""

import asyncio
import datetime
import json

from migrate_redis_memory_to_hindsight import (
    LegacyMemory,
    _eligible_memories,
    _migration_document_id,
    _opaque_user,
)
from nat_helpers.memory_ledger import clear_epoch_key, tombstone_key


def run(coro):
    return asyncio.run(coro)


class FakeRedis:
    def __init__(self):
        self.values = {}

    async def get(self, key):
        return self.values.get(key)

    async def exists(self, key):
        return int(key in self.values)


def memory(key: str, *, created_at: datetime.datetime | None) -> LegacyMemory:
    return LegacyMemory(
        redis_key=key,
        user_id="alice@example.com",
        content="private content that must not appear in migration output",
        tags=["user_profile"],
        metadata={},
        created_at=created_at,
    )


def test_migration_respects_clear_epochs_and_source_tombstones():
    redis = FakeRedis()
    clear_at = datetime.datetime(2026, 8, 20, tzinfo=datetime.UTC)
    redis.values[clear_epoch_key("alice@example.com")] = json.dumps(
        {"at": clear_at.isoformat(), "reason": "user_clear_all"}
    )
    before = memory("nat:memory:before", created_at=clear_at)
    unknown = memory("nat:memory:unknown", created_at=None)
    tombstoned = memory(
        "nat:memory:tombstoned",
        created_at=clear_at + datetime.timedelta(minutes=1),
    )
    eligible = memory(
        "nat:memory:eligible",
        created_at=clear_at + datetime.timedelta(minutes=2),
    )
    redis.values[
        tombstone_key(
            "alice@example.com",
            "source",
            _migration_document_id(tombstoned),
        )
    ] = "{}"

    selected, skipped_clear, skipped_tombstone = run(
        _eligible_memories(redis, [before, unknown, tombstoned, eligible])
    )

    assert selected == [(eligible, _migration_document_id(eligible))]
    assert skipped_clear == 2
    assert skipped_tombstone == 1


def test_migration_user_output_scope_is_opaque():
    scope = _opaque_user("alice@example.com")

    assert len(scope) == 12
    assert "alice" not in scope
