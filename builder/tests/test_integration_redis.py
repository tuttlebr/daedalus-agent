"""Integration test: real Redis JSON round-trip (F-007).

Skipped by default. Run via ``make test-integration`` (sets
``PYTEST_USE_REAL_REDIS=1``), which disables the conftest ``redis`` mock so the
real client is exercised, closing the gap where unit tests only ever talk to
``MagicMock``/``_FakeRedis`` and never validate real serialization/encoding.

Requires a reachable Redis; the CI ``builder-integration`` job starts one as a
service container. If Redis is unreachable the test skips rather than fails.
"""

import json
import os

import pytest

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
