"""Tests for the autonomous worker reliable queue (F-013)."""

import json
import re

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
        raise RuntimeError("unknown command 'JSON.GET'")

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
        move = re.search(
            r'"(RPOPLPUSH|LMOVE)", KEYS\[2\], KEYS\[3\](?:, "(\w+)", "(\w+)")?',
            script,
        )
        if move:
            # Execute the reclaim script's actual list move, including its
            # directions, so tests observe the real queue order.
            command, source_end, destination_end = move.groups()
            if command == "RPOPLPUSH":
                source_end, destination_end = "RIGHT", "LEFT"
            lease_key, processing_key, queue_key, token = args
            if self.kv.get(lease_key) != token:
                return None
            moved = []
            while raw := self.lmove(
                processing_key, queue_key, source_end, destination_end
            ):
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
        return self.lmove(src, dst, "RIGHT", "LEFT")

    def lmove(self, src, dst, source_end, destination_end):
        # Index 0 is the Redis list head (LEFT); -1 is its tail (RIGHT).
        lst = self.lists.get(src) or []
        if not lst:
            return None
        v = lst.pop(0 if source_end == "LEFT" else -1)
        destination = self.lists.setdefault(dst, [])
        if destination_end == "LEFT":
            destination.insert(0, v)
        else:
            destination.append(v)
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


def test_reclaimed_request_runs_before_requests_queued_behind_it():
    """An interrupted request keeps its place at the front of the FIFO queue."""
    store = _store()
    assert store.acquire_lease("u")
    for request_id in ("r1", "r2", "r3"):
        store.redis.lpush(key("u", "queue"), json.dumps({"id": request_id}))
    assert store.dequeue("u", timeout=0) == {"id": "r1"}  # crashes mid-run

    restarted = RedisStore()
    restarted.redis = store.redis
    store.redis.delete(key("u", "lease"))
    assert restarted.acquire_lease("u")
    assert restarted.reclaim_processing("u") == 1

    order = []
    while request := restarted.dequeue("u", timeout=0):
        order.append(request["id"])
        restarted.complete("u")
    assert order == ["r1", "r2", "r3"]


def test_reclaim_preserves_the_order_of_several_interrupted_requests():
    store = _store()
    assert store.acquire_lease("u")
    for request_id in ("r1", "r2", "r3"):
        store.redis.lpush(key("u", "queue"), json.dumps({"id": request_id}))
    # Two claims left behind by earlier owners, r1 claimed before r2.
    assert store.dequeue("u", timeout=0) == {"id": "r1"}
    assert store.dequeue("u", timeout=0) == {"id": "r2"}

    assert store.reclaim_processing("u") == 2

    order = []
    while request := store.dequeue("u", timeout=0):
        order.append(request["id"])
        store.complete("u")
    assert order == ["r1", "r2", "r3"]


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
    store.json_set(key("u", "config"), {**store.get_config("u"), "maxFeedItems": 2})
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
    store.json_set(
        key("u", "config"), {**store.get_config("u"), "feedDedupeEnabled": False}
    )
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


def test_reclaim_closes_runs_left_running_by_a_stopped_worker():
    # A pod killed mid-run (for example after its termination grace period)
    # leaves its run record "running". The dashboard treats the first such
    # record as the live run, so after the requeued request finishes it would
    # show the dead run as active indefinitely.
    stopped = _txn_store()
    assert stopped.acquire_lease("u")
    stopped.redis.lpush(key("u", "queue"), json.dumps({"id": "r1"}))
    assert stopped.dequeue("u", timeout=0) == {"id": "r1"}
    stopped.upsert_run("u", {"id": "interrupted", "status": "running"})
    stopped.upsert_run("u", {"id": "earlier", "status": "completed"})

    stopped.redis.delete(key("u", "lease"))  # The lease expires.
    replacement = RedisStore()
    replacement.redis = stopped.redis
    replacement._watch_error_type = stopped._watch_error_type
    assert replacement.acquire_lease("u")
    assert replacement.reclaim_processing("u") == 1

    runs = {run["id"]: run for run in replacement.list_runs("u")}
    assert runs["interrupted"]["status"] == "aborted"
    assert runs["interrupted"]["completedAt"]
    assert runs["earlier"]["status"] == "completed"
    assert replacement.dequeue("u", timeout=0) == {"id": "r1"}


def test_reclaim_leaves_run_records_alone_without_the_lease():
    store = _txn_store()
    store.upsert_run("u", {"id": "live", "status": "running"})
    store.redis.lists[key("u", "processing")] = [json.dumps({"id": "r1"})]
    assert store.acquire_lease("u")
    store.redis.kv[key("u", "lease")] = "replacement-owner"

    with pytest.raises(RuntimeError):
        store.reclaim_processing("u")

    assert store.list_runs("u")[0]["status"] == "running"
    assert store.redis.llen(key("u", "processing")) == 1


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


def test_json_capability_probe_uses_authorized_key():
    store = _json_txn_store()
    config_key = key("u", "config")
    store.redis.json_kv[config_key] = json.dumps({"enabled": False})
    execute = store.redis.execute_command
    accessed_keys = []

    def scoped_execute(command, redis_key, *args):
        accessed_keys.append(redis_key)
        if not redis_key.startswith("autonomy:u:"):
            raise RuntimeError("NOPERM No permissions to access a key")
        return execute(command, redis_key, *args)

    store.redis.execute_command = scoped_execute

    assert store.get_config("u")["enabled"] is False
    assert set(accessed_keys) == {config_key}
    assert store._json_supported is True


@pytest.mark.parametrize(
    "error", ["NOPERM No permissions to access a key", "connection timed out"]
)
def test_json_capability_failure_remains_retryable(error):
    store = _json_txn_store()
    redis_key = key("u", "config")
    store.redis.json_kv[redis_key] = json.dumps({"enabled": False})
    execute = store.redis.execute_command

    def fail(*_args):
        raise RuntimeError(error)

    store.redis.execute_command = fail
    with pytest.raises(RuntimeError, match=error):
        store.get_config("u")
    assert store._json_supported is None

    store.redis.execute_command = execute
    assert store.get_config("u")["enabled"] is False
    assert store._json_supported is True


@pytest.mark.parametrize("operation", ["read", "write"])
def test_json_permission_failure_does_not_fallback_to_string_state(operation):
    store = _json_txn_store()
    redis_key = key("u", "config")
    original = json.dumps({"enabled": False})
    store.redis.json_kv[redis_key] = original
    store._json_supported = True

    def denied(*_args):
        raise RuntimeError("NOPERM No permissions to access a key")

    store.redis.execute_command = denied
    with pytest.raises(RuntimeError, match="NOPERM"):
        if operation == "read":
            store.get_config("u")
        else:
            store.json_set(redis_key, {"enabled": True})
    assert store.redis.json_kv[redis_key] == original
    assert redis_key not in store.redis.kv


def test_json_capability_unknown_command_retains_plain_redis_support():
    store = _store()
    redis_key = key("u", "config")
    store.json_set(redis_key, {"enabled": False})

    assert store._json_supported is False
    assert store.get_config("u")["enabled"] is False


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


class _ScheduleRedis(_TxnRedis):
    """Transactional fake with list pushes and config read/write fault hooks."""

    def __init__(self):
        super().__init__()
        self.after_config_read = None
        self.failed_config_writes = 0

    def get(self, k):
        value = super().get(k)
        if k.endswith(":config") and callable(self.after_config_read):
            hook, self.after_config_read = self.after_config_read, None
            hook()
        return value

    def _fail_config_write(self):
        if self.failed_config_writes:
            self.failed_config_writes -= 1
            raise ConnectionError("config write failed")

    def set(self, k, v, **kwargs):
        if k.endswith(":config"):
            self._fail_config_write()
        return super().set(k, v, **kwargs)

    def pipeline(self):
        return _SchedulePipeline(self)


class _SchedulePipeline(_TxnPipeline):
    def __init__(self, redis):
        super().__init__(redis)
        self.queued_pushes = []

    def get(self, redis_key):
        return self.redis.get(redis_key)

    def lpush(self, redis_key, value):
        if self.buffering:
            self.queued_pushes.append((redis_key, value))
        else:
            self.redis.lpush(redis_key, value)

    def execute(self):
        if any(redis_key.endswith(":config") for redis_key, _ in self.queued):
            self.redis._fail_config_write()
        if self.redis.kv.get(self.watched_key) != self.watched_version:
            raise _WatchError("watched key changed")
        for redis_key, value in self.queued:
            self.redis.kv[redis_key] = value
        for redis_key, value in self.queued_pushes:
            self.redis.lpush(redis_key, value)
        self.reset()

    def reset(self):
        super().reset()
        self.queued_pushes = []


def _schedule_store(config=None):
    store = RedisStore()
    store.redis = _ScheduleRedis()
    store._watch_error_type = _WatchError
    if config is not None:
        store.redis.kv[key("u", "config")] = json.dumps(config)
    return store


def _stored_config(store):
    return json.loads(store.redis.kv[key("u", "config")])


def test_scheduled_enqueue_preserves_a_concurrent_dashboard_config_change():
    # The dashboard saves config with compare-and-set while the worker decides
    # whether a scheduled run is due. The worker must merge only its marker.
    store = _schedule_store({"enabled": True, "maxFeedItems": 200})

    def dashboard_save():
        store.redis.kv[key("u", "config")] = json.dumps(
            {
                "enabled": True,
                "maxFeedItems": 7,
                "sourcePolicy": {"disabledSources": ["perplexity_search"]},
            }
        )

    store.redis.after_config_read = dashboard_save

    request = store.maybe_enqueue_scheduled("u")

    assert request is not None and request["trigger"] == "scheduled"
    config = _stored_config(store)
    assert config["maxFeedItems"] == 7
    assert config["sourcePolicy"] == {"disabledSources": ["perplexity_search"]}
    assert config["lastScheduledRunAt"] == request["createdAt"]
    assert store.queue_length("u") == 1


def test_scheduled_enqueue_retries_when_config_changes_inside_the_transaction():
    store = _schedule_store({"enabled": True, "maxFeedItems": 200})
    state = {"fired": False}

    def dashboard_save_after_watch():
        if state["fired"]:
            return
        state["fired"] = True
        store.redis.kv[key("u", "config")] = json.dumps(
            {"enabled": True, "maxFeedItems": 9}
        )

    store.redis.on_watch = dashboard_save_after_watch

    assert store.maybe_enqueue_scheduled("u") is not None
    assert _stored_config(store)["maxFeedItems"] == 9
    assert store.queue_length("u") == 1


def test_scheduled_slot_is_not_enqueued_twice_after_a_failed_config_write():
    store = _schedule_store({"enabled": True})
    store.redis.failed_config_writes = 1

    with pytest.raises(ConnectionError):
        store.maybe_enqueue_scheduled("u")
    assert store.maybe_enqueue_scheduled("u") is not None
    # A second call in the same interval is not due.
    assert store.maybe_enqueue_scheduled("u") is None

    assert store.queue_length("u") == 1
    assert _stored_config(store)["lastScheduledRunAt"]


def test_scheduled_enqueue_rechecks_a_dashboard_disable():
    store = _schedule_store({"enabled": True})

    def dashboard_disable():
        store.redis.kv[key("u", "config")] = json.dumps({"enabled": False})

    store.redis.after_config_read = dashboard_disable

    assert store.maybe_enqueue_scheduled("u") is None
    assert store.queue_length("u") == 0
    assert _stored_config(store) == {"enabled": False}


@pytest.mark.parametrize("interval", [0, 1, -5, "60", None, True])
def test_scheduled_interval_uses_the_dashboard_floor(interval):
    recent = now_ms() - 120_000  # two minutes ago
    store = _schedule_store(
        {"enabled": True, "intervalSeconds": interval, "lastScheduledRunAt": recent}
    )

    assert store.maybe_enqueue_scheduled("u") is None
    assert store.queue_length("u") == 0
    assert _stored_config(store)["lastScheduledRunAt"] == recent


def test_environment_interval_default_is_clamped_to_the_dashboard_floor(monkeypatch):
    monkeypatch.setenv("AUTONOMY_INTERVAL_SECONDS", "60")
    store = _schedule_store()

    assert store.get_config("u")["intervalSeconds"] == 300
    assert _stored_config(store)["intervalSeconds"] == 300


def test_default_config_never_overwrites_a_concurrent_dashboard_create(monkeypatch):
    monkeypatch.delenv("AUTONOMY_INTERVAL_SECONDS", raising=False)
    store = _schedule_store()

    def dashboard_create():
        store.redis.kv[key("u", "config")] = json.dumps(
            {"enabled": False, "intervalSeconds": 7200}
        )

    store.redis.after_config_read = dashboard_create

    config = store.get_config("u")

    assert config["enabled"] is False
    assert config["intervalSeconds"] == 7200
    assert _stored_config(store) == {"enabled": False, "intervalSeconds": 7200}
