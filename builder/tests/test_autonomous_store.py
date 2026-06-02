"""Tests for the autonomous worker reliable queue (F-013)."""

import json

from autonomous_agent.models import now_ms
from autonomous_agent.store import RedisStore, key


class _FakeRedis:
    """Minimal in-memory Redis list emulation for queue mechanics."""

    def __init__(self):
        self.lists: dict[str, list[str]] = {}
        self.kv: dict[str, str] = {}

    def execute_command(self, *_args, **_kwargs):
        # Force the store onto its plain GET/SET (non-RedisJSON) code path.
        raise RuntimeError("JSON module unavailable")

    def get(self, k):
        return self.kv.get(k)

    def set(self, k, v, **_kwargs):
        self.kv[k] = v
        return True

    def publish(self, *_args, **_kwargs):
        return 0

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


def test_append_feed_items_dedupes_against_recent_feed():
    store = _store()
    item = {
        "id": "feed_1",
        "title": "NVIDIA announces new GPU",
        "bluf": "Shipped today.",
        "body": "Targets AI training.",
        "sourceUrl": "https://nvidia.com/gpu",
        "createdAt": now_ms(),
    }

    first = store.append_feed_items("u", [dict(item)])
    assert len(first) == 1
    assert first[0]["fingerprint"].startswith("url:")
    assert len(store.list_feed("u")) == 1

    # Same announcement, slightly different URL decoration → dropped.
    repeat = dict(item, id="feed_2", sourceUrl="https://www.nvidia.com/gpu/")
    second = store.append_feed_items("u", [repeat])
    assert second == []
    assert len(store.list_feed("u")) == 1


def test_append_feed_items_returns_only_items_that_survive_max_cap():
    store = _store()
    store.save_config("u", {**store.get_config("u"), "maxFeedItems": 2})
    items = [
        {
            "id": f"feed_{n}",
            "title": f"Distinct finding {n}",
            "bluf": f"Takeaway {n}.",
            "body": f"Body {n}.",
            "sourceUrl": f"https://example.com/{n}",
            "createdAt": now_ms(),
        }
        for n in range(4)
    ]
    stored = store.append_feed_items("u", items)
    # Only the items actually retained after the cap are returned, so a caller's
    # feedItemIds never point at items truncated out of the feed.
    assert len(stored) == 2
    assert len(store.list_feed("u")) == 2
    assert {item["id"] for item in stored} == {
        item["id"] for item in store.list_feed("u")
    }


def test_append_feed_items_respects_disabled_dedupe():
    store = _store()
    store.save_config("u", {**store.get_config("u"), "feedDedupeEnabled": False})
    item = {
        "id": "feed_1",
        "title": "Repeated",
        "bluf": "Same",
        "body": "Same body",
        "sourceUrl": "https://example.com/x",
        "createdAt": None,
    }
    store.append_feed_items("u", [dict(item)])
    store.append_feed_items("u", [dict(item, id="feed_2")])
    assert len(store.list_feed("u")) == 2
