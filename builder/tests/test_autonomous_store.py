"""Tests for the autonomous worker reliable queue (F-013)."""

import json

from autonomous_agent.store import RedisStore, key


class _FakeRedis:
    """Minimal in-memory Redis list emulation for queue mechanics."""

    def __init__(self):
        self.lists: dict[str, list[str]] = {}

    def lpush(self, k, v):
        self.lists.setdefault(k, []).insert(0, v)
        return len(self.lists[k])

    def brpoplpush(self, src, dst, timeout=0):
        lst = self.lists.get(src) or []
        if not lst:
            return None
        v = lst.pop()  # tail (oldest, FIFO with lpush)
        self.lists.setdefault(dst, []).insert(0, v)
        return v

    def rpoplpush(self, src, dst):
        lst = self.lists.get(src) or []
        if not lst:
            return None
        v = lst.pop()
        self.lists.setdefault(dst, []).insert(0, v)
        return v

    def lrem(self, k, count, val):
        lst = self.lists.get(k) or []
        if val in lst:
            lst.remove(val)
            return 1
        return 0

    def llen(self, k):
        return len(self.lists.get(k) or [])


def _store():
    store = RedisStore()
    store.redis = _FakeRedis()
    return store


def test_dequeue_moves_to_processing_then_complete_removes():
    store = _store()
    store.redis.lpush(key("u", "queue"), json.dumps({"id": "r1"}))

    req = store.dequeue("u", timeout=0)
    assert req == {"id": "r1"}
    assert store.redis.llen(key("u", "queue")) == 0
    # Held in processing until the run is recorded.
    assert store.redis.llen(key("u", "processing")) == 1

    store.complete("u")
    assert store.redis.llen(key("u", "processing")) == 0


def test_crash_before_complete_is_reclaimed_not_lost():
    store = _store()
    store.redis.lpush(key("u", "queue"), json.dumps({"id": "r1"}))
    store.dequeue("u", timeout=0)  # in processing; simulate crash (no complete)
    assert store.redis.llen(key("u", "processing")) == 1

    # A new worker starts against the same Redis.
    restarted = RedisStore()
    restarted.redis = store.redis
    assert restarted.reclaim_processing("u") == 1
    assert restarted.redis.llen(key("u", "processing")) == 0
    # The request is retried rather than silently dropped.
    assert restarted.dequeue("u", timeout=0) == {"id": "r1"}


def test_poison_message_is_dropped_from_processing():
    store = _store()
    store.redis.lpush(key("u", "queue"), "{not valid json")
    assert store.dequeue("u", timeout=0) is None
    assert store.redis.llen(key("u", "processing")) == 0
