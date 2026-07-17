"""Integration test: real Redis JSON round-trip (F-007).

Skipped by default. Run via ``make test-integration`` (sets
``PYTEST_USE_REAL_REDIS=1``), which disables the conftest ``redis`` mock so the
real client is exercised, closing the gap where unit tests only ever talk to
``MagicMock``/``_FakeRedis`` and never validate real serialization/encoding.

Requires a reachable Redis; the CI ``builder-integration`` job starts one as a
service container. If Redis is unreachable the test skips rather than fails.
"""

import asyncio
import json
import os
import time
import uuid

import pytest
from autonomous_agent.store import RedisStore
from autonomous_agent.store import key as autonomy_key

pytestmark = pytest.mark.integration


def test_redis_json_round_trip():
    # Real module in integration mode (conftest leaves `redis` unmocked when
    # PYTEST_USE_REAL_REDIS is set); importorskip guards the rare misconfig.
    redis = pytest.importorskip("redis")

    url = os.getenv("REDIS_URL", "redis://localhost:6379")
    client = redis.from_url(url, decode_responses=True)
    try:
        client.ping()
    except Exception as exc:  # pragma: no cover - environment dependent
        pytest.skip(f"Redis not reachable at {url}: {exc}")

    key = "daedalus:itest:roundtrip"
    payload = {"user": "alice", "n": 3, "nested": {"ok": True}, "unicode": "café"}
    try:
        client.set(key, json.dumps(payload), ex=60)
        raw = client.get(key)
        assert raw is not None
        assert json.loads(raw) == payload
    finally:
        client.delete(key)


def test_autonomous_lease_fences_live_reclaim_and_recovers_after_expiry():
    pytest.importorskip("redis")
    url = os.getenv("REDIS_URL", "redis://localhost:6379")
    worker_a = RedisStore(url)
    worker_b = RedisStore(url)
    try:
        worker_a.ping()
    except Exception as exc:  # pragma: no cover - environment dependent
        pytest.skip(f"Redis not reachable at {url}: {exc}")

    user_id = f"lease-itest-{uuid.uuid4().hex}"
    queue_key = autonomy_key(user_id, "queue")
    processing_key = autonomy_key(user_id, "processing")
    lease_key = autonomy_key(user_id, "lease")
    try:
        assert worker_a.acquire_lease(user_id, ttl_seconds=1)
        worker_a.redis.lpush(queue_key, json.dumps({"id": "request-1"}))
        assert worker_a.dequeue(user_id, timeout=0) == {"id": "request-1"}

        assert worker_b.acquire_lease(user_id, ttl_seconds=5) is False
        with pytest.raises(RuntimeError, match="owning the lease"):
            worker_b.reclaim_processing(user_id)
        assert worker_a.redis.llen(processing_key) == 1

        deadline = time.monotonic() + 3
        while worker_a.redis.exists(lease_key) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not worker_a.redis.exists(lease_key)

        assert worker_b.acquire_lease(user_id, ttl_seconds=5)
        assert worker_b.reclaim_processing(user_id) == 1
        assert worker_b.reclaim_processing(user_id) == 0
        assert worker_a.refresh_lease(user_id, ttl_seconds=5) is False
        assert worker_b.dequeue(user_id, timeout=0) == {"id": "request-1"}
        assert worker_b.complete(user_id) is True
        assert worker_b.redis.llen(processing_key) == 0
    finally:
        for redis_key in worker_a.redis.scan_iter(match=f"autonomy:{user_id}:*"):
            worker_a.redis.delete(redis_key)


def test_autonomous_local_write_idempotency_is_atomic_in_real_redis(monkeypatch):
    redis = pytest.importorskip("redis")
    from nat_helpers.idempotency import complete_operation, reserve_operation

    url = os.getenv("REDIS_URL", "redis://localhost:6379")
    client = redis.from_url(url, decode_responses=True)
    try:
        client.ping()
    except Exception as exc:  # pragma: no cover - environment dependent
        pytest.skip(f"Redis not reachable at {url}: {exc}")
    monkeypatch.setenv("REDIS_URL", url)
    execution_id = f"idempotency-itest-{uuid.uuid4().hex}"

    async def scenario():
        first, concurrent = await asyncio.gather(
            reserve_operation(
                user_id="alice",
                execution_id=execution_id,
                operation="add_memory",
                arguments={"memory": "one exact write"},
            ),
            reserve_operation(
                user_id="alice",
                execution_id=execution_id,
                operation="add_memory",
                arguments={"memory": "one exact write"},
            ),
        )
        owners = [
            reservation for reservation in (first, concurrent) if reservation.acquired
        ]
        assert len(owners) == 1
        assert await complete_operation(owners[0], "applied")
        replay = await reserve_operation(
            user_id="alice",
            execution_id=execution_id,
            operation="add_memory",
            arguments={"memory": "one exact write"},
        )
        assert replay.state == "completed"
        assert replay.stored_result == "applied"
        return owners[0].key

    key = asyncio.run(scenario())
    client.delete(key)
