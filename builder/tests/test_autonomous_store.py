"""Tests for the autonomous worker reliable queue (F-013)."""

import json

import pytest
from autonomous_agent.models import now_ms
from autonomous_agent.store import RedisStore, key


class _FakeRedis:
    """Minimal in-memory Redis list emulation for queue mechanics."""

    def __init__(self):
        self.lists: dict[str, list[str]] = {}
        self.kv: dict[str, str] = {}
        self.sets: dict[str, set[str]] = {}

    def execute_command(self, *_args, **_kwargs):
        # Force the store onto its plain GET/SET (non-RedisJSON) code path.
        raise RuntimeError("JSON module unavailable")

    def get(self, k):
        return self.kv.get(k)

    def set(self, k, v, **kwargs):
        if kwargs.get("nx") and k in self.kv:
            return None
        self.kv[k] = v
        return True

    def setex(self, k, _ttl, v):
        self.kv[k] = v
        return True

    def getdel(self, k):
        return self.kv.pop(k, None)

    def sadd(self, k, *members):
        self.sets.setdefault(k, set()).update(members)
        return len(members)

    def sismember(self, k, member):
        return member in self.sets.get(k, set())

    def expire(self, *_args, **_kwargs):
        return True

    def delete(self, k):
        existed = k in self.kv
        self.kv.pop(k, None)
        return int(existed)

    def eval(self, script, num_keys, *args):
        if "RPOPLPUSH" in script:
            lease_key, processing_key, queue_key, token = args
            if self.kv.get(lease_key) != token:
                return None
            moved = []
            while raw := self.rpoplpush(processing_key, queue_key):
                moved.append(raw)
            return moved
        if "LREM" in script:
            lease_key, processing_key, claim_key, token, raw = args
            if self.kv.get(lease_key) != token:
                return 0
            self.lrem(processing_key, 1, raw)
            self.delete(claim_key)
            return 1
        assert num_keys == 1
        redis_key, token, *_rest = args
        if self.kv.get(redis_key) != token:
            return 0
        if "EXPIRE" in script:
            return 1
        if "DEL" in script:
            self.kv.pop(redis_key, None)
            return 1
        raise AssertionError("unexpected Lua script")

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
    assert store.acquire_lease("u")
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
    assert store.acquire_lease("u")
    store.redis.lpush(key("u", "queue"), json.dumps({"id": "r1"}))
    store.dequeue("u", timeout=0)  # in processing; simulate crash (no complete)
    assert store.redis.llen(key("u", "processing")) == 1

    # A new worker starts against the same Redis.
    restarted = RedisStore()
    restarted.redis = store.redis
    assert restarted.acquire_lease("u") is False
    with pytest.raises(RuntimeError, match="owning the lease"):
        restarted.reclaim_processing("u")

    # Simulate lease expiry. Only then can the replacement acquire and reclaim.
    store.redis.delete(key("u", "lease"))
    assert restarted.acquire_lease("u") is True
    assert restarted.reclaim_processing("u") == 1
    assert restarted.redis.llen(key("u", "processing")) == 0
    # The request is retried rather than silently dropped.
    assert restarted.dequeue("u", timeout=0) == {"id": "r1"}


def test_poison_message_is_dropped_from_processing():
    store = _store()
    assert store.acquire_lease("u")
    store.redis.lpush(key("u", "queue"), "{not valid json")
    assert store.dequeue("u", timeout=0) is None
    assert store.redis.llen(key("u", "processing")) == 0


def test_processing_claim_tracks_owner_and_visibility_deadline():
    store = _store()
    assert store.acquire_lease("u", ttl_seconds=30)
    store.redis.lpush(key("u", "queue"), json.dumps({"id": "r1"}))

    assert store.dequeue("u", timeout=0) == {"id": "r1"}
    raw = store._inflight["u"]
    claim_key = store._processing_claim_key("u", raw)
    claim = json.loads(store.redis.get(claim_key))
    assert claim["ownerToken"] == store._lease_tokens["u"]
    assert claim["visibilityDeadlineAt"] > claim["claimedAt"]

    assert store.refresh_lease("u", ttl_seconds=60) is True
    refreshed_claim = json.loads(store.redis.get(claim_key))
    assert refreshed_claim["visibilityDeadlineAt"] >= (
        refreshed_claim["claimedAt"] + 60_000
    )


def test_refresh_lease_reports_lost_ownership():
    store = _store()
    assert store.acquire_lease("u")
    store.redis.kv[key("u", "lease")] = "replacement-owner"

    assert store.refresh_lease("u") is False
    assert store.owns_lease("u") is False


def test_lost_owner_cannot_acknowledge_processing_entry():
    store = _store()
    assert store.acquire_lease("u")
    store.redis.lpush(key("u", "queue"), json.dumps({"id": "r1"}))
    assert store.dequeue("u", timeout=0) == {"id": "r1"}

    store.redis.kv[key("u", "lease")] = "replacement-owner"

    assert store.complete("u") is False
    assert store.redis.llen(key("u", "processing")) == 1


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


def test_mark_goal_run_updates_only_the_selected_goal():
    store = _store()
    store.json_set(
        key("u", "goals"),
        [
            {"id": "goal_a", "lastRunAt": None},
            {"id": "goal_b", "lastRunAt": None},
        ],
    )

    store.mark_goal_run("u", "goal_b", 1234)

    goals = store.list_goals("u")
    assert goals[0]["lastRunAt"] is None
    assert goals[1]["lastRunAt"] == 1234


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


def test_applied_approval_round_trip():
    # F-015: applied-approval keys are recorded and read back.
    store = _store()
    assert store.is_approval_applied("u", "tok_1") is False
    store.mark_approval_applied("u", "tok_1")
    assert store.is_approval_applied("u", "tok_1") is True
    # An empty key is never treated as applied (and is a no-op to record).
    store.mark_approval_applied("u", "")
    assert store.is_approval_applied("u", "") is False


def test_store_consumes_only_exact_mcp_execution_receipt():
    from user_interaction.approval_tokens import record_mcp_execution_receipt

    store = _store()
    token = "worker-only-secret"
    execution = {
        "actionType": "mcp_mutation",
        "serverName": "k8s_mcp_server",
        "toolName": "scale_deployment",
        "argumentsSha256": "a" * 64,
    }
    record_mcp_execution_receipt(
        store.redis,
        user_id="u",
        token=token,
        server_name=execution["serverName"],
        tool_name=execution["toolName"],
        arguments_sha256=execution["argumentsSha256"],
    )

    assert store.consume_mcp_execution_receipt("u", token, execution)
    assert not store.consume_mcp_execution_receipt("u", token, execution)


class _TxnRedis(_FakeRedis):
    """Fake Redis supporting WATCH/MULTI/EXEC so atomic_update can be tested.

    A WATCHed key whose value changed between WATCH and EXEC aborts the
    transaction (raising WatchError), exactly like real Redis optimistic locking.
    """

    def __init__(self):
        super().__init__()
        self.on_watch = None  # optional hook to simulate a concurrent writer

    def pipeline(self):
        return _TxnPipeline(self)


class _WatchError(Exception):
    pass


class _TxnPipeline:
    def __init__(self, redis):
        self.redis = redis
        self.watched_key = None
        self.watched_version = None
        self.queued = []
        self.buffering = False

    def watch(self, redis_key):
        self.watched_key = redis_key
        self.watched_version = self.redis.kv.get(redis_key)
        # Allow a test to mutate the value once, simulating a racing writer.
        if callable(self.redis.on_watch):
            self.redis.on_watch()

    def get(self, redis_key):
        return self.redis.kv.get(redis_key)

    def type(self, redis_key):
        return "string" if redis_key in self.redis.kv else "none"

    def multi(self):
        self.buffering = True

    def set(self, redis_key, value):
        if self.buffering:
            self.queued.append((redis_key, value))
        else:
            self.redis.kv[redis_key] = value

    def execute(self):
        if self.redis.kv.get(self.watched_key) != self.watched_version:
            raise _WatchError("watched key changed")
        for redis_key, value in self.queued:
            self.redis.kv[redis_key] = value
        self.queued = []
        self.buffering = False

    def reset(self):
        self.queued = []
        self.buffering = False


def _txn_store():
    store = RedisStore()
    store.redis = _TxnRedis()
    store._watch_error_type = _WatchError
    return store


def test_atomic_update_commits_under_watch_multi():
    store = _txn_store()
    run = {"id": "r1", "status": "running"}
    store.upsert_run("u", run)
    assert store.list_runs("u")[0]["id"] == "r1"


def test_atomic_update_retries_on_concurrent_writer_without_losing_updates():
    # F-016: a concurrent writer mutates the key between WATCH and EXEC on the
    # first attempt; atomic_update must retry and compose, not clobber.
    store = _txn_store()
    runs_key = key("u", "runs")

    state = {"fired": False}

    def racing_writer():
        if state["fired"]:
            return
        state["fired"] = True
        # Another worker appended its own run after our WATCH.
        store.redis.kv[runs_key] = json.dumps([{"id": "other"}])

    store.redis.on_watch = racing_writer

    store.upsert_run("u", {"id": "mine"})

    ids = {r["id"] for r in store.list_runs("u")}
    # Both the concurrent run and ours survive — no lost update.
    assert ids == {"other", "mine"}


def test_atomic_update_never_falls_back_to_non_atomic_write_after_conflicts():
    store = _txn_store()
    runs_key = key("u", "runs")
    state = {"writes": 0}

    def racing_writer():
        state["writes"] += 1
        store.redis.kv[runs_key] = json.dumps([{"id": f"other-{state['writes']}"}])

    store.redis.on_watch = racing_writer

    with pytest.raises(_WatchError, match="watched key changed"):
        store.atomic_update(
            runs_key,
            lambda current: (current + [{"id": "mine"}], None),
            retries=2,
        )

    # The last concurrent value remains intact; an unsafe final GET/SET fallback
    # would have appended "mine" after the retries were exhausted.
    assert json.loads(store.redis.kv[runs_key]) == [{"id": "other-2"}]


class _JsonTxnRedis(_FakeRedis):
    """RedisJSON-aware transaction fake with mixed JSON and string keys."""

    def __init__(self):
        super().__init__()
        self.json_kv: dict[str, str] = {}
        self.on_watch = None
        self.json_commands: list[str] = []

    def execute_command(self, command, *args):
        command = str(command).upper()
        self.json_commands.append(command)
        if command == "JSON.GET":
            if args[0] in self.kv:
                raise RuntimeError("Existing key has wrong Redis type")
            return self.json_kv.get(args[0])
        if command == "JSON.SET":
            redis_key, _path, value = args
            if redis_key in self.kv:
                raise RuntimeError("Existing key has wrong Redis type")
            self.json_kv[redis_key] = value
            return "OK"
        raise AssertionError(f"unexpected RedisJSON command: {command}")

    def get(self, redis_key):
        if redis_key in self.json_kv:
            raise AssertionError("plain GET cannot read a RedisJSON key")
        return self.kv.get(redis_key)

    def set(self, redis_key, value, **_kwargs):
        if redis_key in self.json_kv:
            raise AssertionError("plain SET cannot write a RedisJSON key")
        self.kv[redis_key] = value
        return True

    def pipeline(self):
        return _JsonTxnPipeline(self)


class _JsonTxnPipeline:
    def __init__(self, redis):
        self.redis = redis
        self.watched_key = None
        self.watched_version = None
        self.json_queued: list[tuple[str, str]] = []
        self.string_queued: list[tuple[str, str]] = []
        self.buffering = False

    def _snapshot(self, redis_key):
        if redis_key in self.redis.json_kv:
            return ("json", self.redis.json_kv[redis_key])
        if redis_key in self.redis.kv:
            return ("string", self.redis.kv[redis_key])
        return ("none", None)

    def watch(self, redis_key):
        self.watched_key = redis_key
        self.watched_version = self._snapshot(redis_key)
        if callable(self.redis.on_watch):
            self.redis.on_watch()

    def type(self, redis_key):
        storage_type, _value = self._snapshot(redis_key)
        return "ReJSON-RL" if storage_type == "json" else storage_type

    def get(self, redis_key):
        if redis_key in self.redis.json_kv:
            raise AssertionError("plain GET cannot read a RedisJSON key")
        return self.redis.kv.get(redis_key)

    def set(self, redis_key, value):
        if redis_key in self.redis.json_kv:
            raise AssertionError("plain SET cannot write a RedisJSON key")
        if self.buffering:
            self.string_queued.append((redis_key, value))
        else:
            self.redis.kv[redis_key] = value

    def execute_command(self, command, *args):
        command = str(command).upper()
        self.redis.json_commands.append(command)
        if command == "JSON.GET" and not self.buffering:
            return self.redis.json_kv.get(args[0])
        if command == "JSON.SET" and self.buffering:
            redis_key, _path, value = args
            self.json_queued.append((redis_key, value))
            return self
        raise AssertionError(f"unexpected transactional command: {command}")

    def multi(self):
        self.buffering = True

    def execute(self):
        if self._snapshot(self.watched_key) != self.watched_version:
            raise _WatchError("watched key changed")
        for redis_key, value in self.json_queued:
            self.redis.json_kv[redis_key] = value
        for redis_key, value in self.string_queued:
            self.redis.kv[redis_key] = value
        self.json_queued = []
        self.string_queued = []
        self.buffering = False

    def reset(self):
        self.json_queued = []
        self.string_queued = []
        self.buffering = False


def _json_txn_store():
    store = RedisStore()
    store.redis = _JsonTxnRedis()
    store._watch_error_type = _WatchError
    return store


def test_atomic_update_uses_redisjson_for_a_missing_key():
    store = _json_txn_store()
    redis_key = key("u", "approvals")

    result = store.atomic_update(
        redis_key,
        lambda current: (current + [{"id": "approval-1"}], "stored"),
    )

    assert result == "stored"
    assert json.loads(store.redis.json_kv[redis_key]) == [{"id": "approval-1"}]
    assert store.redis.json_commands.count("JSON.GET") == 1  # capability probe
    assert "JSON.SET" in store.redis.json_commands


def test_atomic_update_uses_redisjson_commands_for_an_existing_json_key():
    store = _json_txn_store()
    runs_key = key("u", "runs")
    store.redis.json_kv[runs_key] = json.dumps([{"id": "existing"}])

    store.atomic_update(
        runs_key,
        lambda current: (current + [{"id": "new"}], None),
    )

    assert json.loads(store.redis.json_kv[runs_key]) == [
        {"id": "existing"},
        {"id": "new"},
    ]
    assert runs_key not in store.redis.kv
    assert store.redis.json_commands.count("JSON.GET") >= 2
    assert "JSON.SET" in store.redis.json_commands


def test_atomic_update_preserves_string_key_when_redisjson_is_available():
    store = _json_txn_store()
    runs_key = key("u", "runs")
    store.redis.kv[runs_key] = json.dumps([{"id": "legacy"}])

    store.atomic_update(
        runs_key,
        lambda current: (current + [{"id": "new"}], None),
    )

    assert json.loads(store.redis.kv[runs_key]) == [
        {"id": "legacy"},
        {"id": "new"},
    ]
    assert runs_key not in store.redis.json_kv
    assert store.redis.json_commands == ["JSON.GET"]  # capability probe only


def test_json_get_reads_legacy_string_key_when_redisjson_is_available():
    store = _json_txn_store()
    runs_key = key("u", "runs")
    store.redis.kv[runs_key] = json.dumps([{"id": "legacy"}])

    assert store.list_runs("u") == [{"id": "legacy"}]


def test_append_event_retries_redisjson_conflict_without_losing_event():
    store = _json_txn_store()
    events_key = key("u", "events")
    state = {"fired": False}

    def racing_writer():
        if state["fired"]:
            return
        state["fired"] = True
        store.redis.json_kv[events_key] = json.dumps([{"id": "other"}])

    store.redis.on_watch = racing_writer
    store.append_event("u", {"id": "mine"})

    assert [event["id"] for event in store.json_get(events_key)] == ["mine", "other"]


class _BrokenTxnRedis(_TxnRedis):
    def pipeline(self):
        return _BrokenTxnPipeline(self)


class _BrokenTxnPipeline(_TxnPipeline):
    def type(self, _redis_key):
        raise RuntimeError("redis connection failed")


def test_atomic_update_does_not_hide_non_watch_redis_errors():
    store = RedisStore()
    store.redis = _BrokenTxnRedis()

    with pytest.raises(RuntimeError, match="redis connection failed"):
        store.atomic_update(key("u", "runs"), lambda current: (current, None))
