"""Redis-backed state store for autonomous runs."""

from __future__ import annotations

import contextlib
import json
import os
import time
import uuid
from typing import Any

from .dedupe import dedupe_feed_items, stamp_feed_item, window_ms_for_days
from .models import default_config, new_event, now_ms


def key(user_id: str, name: str) -> str:
    return f"autonomy:{user_id}:{name}"


class RedisStore:
    def __init__(self, redis_url: str | None = None) -> None:
        import redis

        self.redis = redis.from_url(
            redis_url or os.getenv("REDIS_URL", "redis://redis:6379"),
            decode_responses=True,
        )
        self._json_supported: bool | None = None
        self._lease_tokens: dict[str, str] = {}
        # F-013: raw payload of the request currently being processed per user,
        # so it can be removed from the reliable-queue processing list on completion.
        self._inflight: dict[str, str] = {}

    def ping(self) -> None:
        self.redis.ping()

    def _supports_json(self) -> bool:
        if self._json_supported is not None:
            return self._json_supported
        try:
            self.redis.execute_command("JSON.GET", "__autonomy_probe__")
            self._json_supported = True
        except Exception:
            self._json_supported = False
        return self._json_supported

    def json_get(self, redis_key: str, fallback: Any = None) -> Any:
        if self._supports_json():
            try:
                raw = self.redis.execute_command("JSON.GET", redis_key)
                return json.loads(raw) if raw else fallback
            except Exception:
                return fallback
        raw = self.redis.get(redis_key)
        if not raw:
            return fallback
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return fallback

    def json_set(self, redis_key: str, value: Any) -> None:
        serialized = json.dumps(value)
        if self._supports_json():
            with contextlib.suppress(Exception):
                self.redis.execute_command("JSON.SET", redis_key, ".", serialized)
                return
        self.redis.set(redis_key, serialized)

    def atomic_update(self, redis_key: str, mutate: Any, *, retries: int = 5) -> Any:
        """Optimistically read-modify-write a JSON value under WATCH/MULTI.

        F-016: shared per-user state (runs/feed/approvals) is read-modify-written
        from the worker, and a lease that expires lets a second worker run
        concurrently. A plain ``json_get`` + ``json_set`` would then let one
        writer clobber the other's update. ``atomic_update`` guards the key with
        WATCH and retries on a concurrent change so updates compose instead of
        racing. ``mutate`` receives the current decoded value (already defaulted
        to ``[]``) and returns ``(new_value, result)``; ``result`` is returned to
        the caller. Falls back to a plain read-modify-write when the Redis client
        does not expose ``pipeline`` (keeps non-transactional fakes working).
        """
        pipeline_factory = getattr(self.redis, "pipeline", None)
        if not callable(pipeline_factory):
            current = self.json_get(redis_key, [])
            new_value, result = mutate(current if isinstance(current, list) else [])
            self.json_set(redis_key, new_value)
            return result

        for _ in range(max(1, retries)):
            pipe = pipeline_factory()
            try:
                pipe.watch(redis_key)
                raw = pipe.get(redis_key)
                current: Any = []
                if raw:
                    try:
                        decoded = json.loads(raw)
                    except (json.JSONDecodeError, TypeError):
                        decoded = []
                    current = decoded if isinstance(decoded, list) else []
                new_value, result = mutate(current)
                pipe.multi()
                pipe.set(redis_key, json.dumps(new_value))
                pipe.execute()
                return result
            except Exception:  # nosec B112 - intentional: retry on WATCH conflict
                continue
            finally:
                with contextlib.suppress(Exception):
                    pipe.reset()

        # Best-effort fallback after exhausting retries so the update is not lost.
        current = self.json_get(redis_key, [])
        new_value, result = mutate(current if isinstance(current, list) else [])
        self.json_set(redis_key, new_value)
        return result

    def get_text(self, redis_key: str) -> str | None:
        value = self.redis.get(redis_key)
        return str(value) if value is not None else None

    def set_text(self, redis_key: str, value: str) -> None:
        self.redis.set(redis_key, value)

    def publish(self, user_id: str, event_type: str, data: dict[str, Any]) -> None:
        event = {"type": event_type, "timestamp": now_ms(), "data": data}
        self.redis.publish(f"user:{user_id}:updates", json.dumps(event))

    def get_config(self, user_id: str) -> dict[str, Any]:
        config = self.json_get(key(user_id, "config"))
        if isinstance(config, dict):
            return {**default_config(user_id), **config}
        config = default_config(user_id)
        interval = os.getenv("AUTONOMY_INTERVAL_SECONDS")
        if interval and interval.isdigit():
            config["intervalSeconds"] = int(interval)
        self.json_set(key(user_id, "config"), config)
        return config

    def save_config(self, user_id: str, config: dict[str, Any]) -> None:
        config = {**config, "updatedAt": now_ms()}
        self.json_set(key(user_id, "config"), config)
        self.publish(user_id, "autonomy_status", {"config": config})

    def list_goals(self, user_id: str) -> list[dict[str, Any]]:
        goals = self.json_get(key(user_id, "goals"), [])
        return goals if isinstance(goals, list) else []

    def list_runs(self, user_id: str) -> list[dict[str, Any]]:
        runs = self.json_get(key(user_id, "runs"), [])
        return runs if isinstance(runs, list) else []

    def save_runs(self, user_id: str, runs: list[dict[str, Any]]) -> None:
        max_runs = int(self.get_config(user_id).get("maxRunsStored") or 100)
        self.json_set(key(user_id, "runs"), runs[:max_runs])

    def upsert_run(self, user_id: str, run: dict[str, Any]) -> None:
        run["updatedAt"] = now_ms()
        max_runs = int(self.get_config(user_id).get("maxRunsStored") or 100)

        def mutate(current: list[dict[str, Any]]):
            runs = [r for r in current if r.get("id") != run.get("id")]
            runs.insert(0, run)
            return runs[:max_runs], None

        self.atomic_update(key(user_id, "runs"), mutate)
        self.publish(user_id, "autonomy_status", {"run": run})

    def append_event(self, user_id: str, event: dict[str, Any]) -> None:
        events = self.json_get(key(user_id, "events"), [])
        if not isinstance(events, list):
            events = []
        events.insert(0, event)
        self.json_set(key(user_id, "events"), events[:500])
        self.publish(user_id, "autonomy_run_event", event)

    def log_event(
        self,
        user_id: str,
        run_id: str,
        event_type: str,
        message: str,
        *,
        level: str = "info",
        data: dict[str, Any] | None = None,
    ) -> None:
        self.append_event(
            user_id,
            new_event(
                run_id=run_id,
                event_type=event_type,
                message=message,
                level=level,
                data=data,
            ),
        )

    def list_events(
        self, user_id: str, run_id: str | None = None
    ) -> list[dict[str, Any]]:
        events = self.json_get(key(user_id, "events"), [])
        if not isinstance(events, list):
            return []
        if run_id:
            return [event for event in events if event.get("runId") == run_id]
        return events

    def list_feed(self, user_id: str, limit: int | None = None) -> list[dict[str, Any]]:
        feed = self.json_get(key(user_id, "feed"), [])
        if not isinstance(feed, list):
            return []
        return feed[:limit] if limit is not None else feed

    def append_feed_items(
        self, user_id: str, items: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Store new feed items, dropping ones that repeat recent feed entries.

        Returns the items that were actually stored (post de-duplication) so the
        caller can record accurate ``feedItemIds`` and surface a dropped count.
        """
        if not items:
            return []
        config = self.get_config(user_id)
        dedupe_enabled = config.get("feedDedupeEnabled", True)
        window_ms = window_ms_for_days(config.get("feedDedupeWindowDays"))
        max_items = int(config.get("maxFeedItems") or 200)

        # F-016: de-dupe and cap inside an atomic read-modify-write so a
        # concurrent writer (e.g. after a lease expiry) cannot clobber the feed.
        def mutate(feed: list[dict[str, Any]]):
            if dedupe_enabled:
                kept, _dropped = dedupe_feed_items(
                    items,
                    feed,
                    now=now_ms(),
                    window_ms=window_ms,
                )
            else:
                kept = [
                    stamp_feed_item(item) for item in items if isinstance(item, dict)
                ]
            if not kept:
                return feed, []
            # Return only the items that survived the cap so the caller's
            # feedItemIds never reference items that were truncated out of the feed.
            stored = kept[:max_items]
            return (kept + feed)[:max_items], stored

        stored = self.atomic_update(key(user_id, "feed"), mutate)
        if stored:
            self.publish(user_id, "autonomy_feed_updated", {"items": stored})
        return stored

    def append_approval(self, user_id: str, approval: dict[str, Any]) -> None:
        def mutate(approvals: list[dict[str, Any]]):
            approvals.insert(0, approval)
            return approvals[:100], None

        self.atomic_update(key(user_id, "approvals"), mutate)
        self.publish(user_id, "autonomy_approval_requested", approval)

    def enqueue(self, user_id: str, request: dict[str, Any]) -> None:
        self.redis.lpush(key(user_id, "queue"), json.dumps(request))
        self.publish(user_id, "autonomy_status", {"queued": request})

    def queue_length(self, user_id: str) -> int:
        return int(self.redis.llen(key(user_id, "queue")) or 0)

    def queue_snapshot(self, user_id: str, limit: int = 5) -> list[dict[str, Any]]:
        raw_items = self.redis.lrange(key(user_id, "queue"), -limit, -1)
        requests: list[dict[str, Any]] = []
        for raw in reversed(raw_items):
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                requests.append(parsed)
        return requests

    def dequeue(self, user_id: str, timeout: int = 5) -> dict[str, Any] | None:
        # F-013: reliable queue. Atomically MOVE the request to a per-user
        # processing list instead of destructively popping it, so a crash before
        # the run is recorded does not lose the job — reclaim_processing()
        # re-queues anything left behind on the next startup. brpoplpush pops the
        # queue tail (FIFO with lpush) and pushes to the processing-list head.
        queue_key = key(user_id, "queue")
        processing_key = key(user_id, "processing")
        raw = self.redis.brpoplpush(queue_key, processing_key, timeout)
        if not raw:
            return None
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = None
        if not isinstance(parsed, dict):
            # Poison entry: drop it from processing so it cannot wedge the worker.
            with contextlib.suppress(Exception):
                self.redis.lrem(processing_key, 1, raw)
            return None
        self._inflight[user_id] = raw
        return parsed

    def complete(self, user_id: str) -> None:
        """Remove the in-flight request from the processing list after handling.

        Call once the run has been recorded (success or a recorded failure). If
        the worker crashes before this, the entry stays in ``processing`` and is
        re-queued by ``reclaim_processing()`` on the next startup (at-least-once).
        """
        raw = self._inflight.pop(user_id, None)
        if raw is None:
            return
        with contextlib.suppress(Exception):
            self.redis.lrem(key(user_id, "processing"), 1, raw)

    def reclaim_processing(self, user_id: str) -> int:
        """Re-queue requests left in the processing list by a crashed worker."""
        processing_key = key(user_id, "processing")
        queue_key = key(user_id, "queue")
        reclaimed = 0
        while self.redis.rpoplpush(processing_key, queue_key):
            reclaimed += 1
        return reclaimed

    def acquire_lease(self, user_id: str, ttl_seconds: int = 60) -> bool:
        token = f"{os.getpid()}:{uuid.uuid4().hex}"
        acquired = bool(
            self.redis.set(key(user_id, "lease"), token, nx=True, ex=ttl_seconds)
        )
        if acquired:
            self._lease_tokens[user_id] = token
        return acquired

    def refresh_lease(self, user_id: str, ttl_seconds: int = 60) -> None:
        token = self._lease_tokens.get(user_id)
        if not token:
            return
        self.redis.eval(
            """
            if redis.call("GET", KEYS[1]) == ARGV[1] then
                return redis.call("EXPIRE", KEYS[1], ARGV[2])
            end
            return 0
            """,
            1,
            key(user_id, "lease"),
            token,
            int(ttl_seconds),
        )

    def release_lease(self, user_id: str) -> None:
        token = self._lease_tokens.pop(user_id, None)
        if not token:
            return
        self.redis.eval(
            """
            if redis.call("GET", KEYS[1]) == ARGV[1] then
                return redis.call("DEL", KEYS[1])
            end
            return 0
            """,
            1,
            key(user_id, "lease"),
            token,
        )

    def cancel_requested(self, user_id: str, run_id: str) -> bool:
        return bool(self.redis.get(key(user_id, f"cancel:{run_id}")))

    def is_approval_applied(self, user_id: str, approval_key: str) -> bool:
        """F-015: report whether an approval has already been executed.

        Guards against an approved-then-re-enqueued request running a
        non-idempotent action twice. ``approval_key`` is a stable identifier for
        the approval (its single-use approval token, falling back to the
        approval id) carried by the re-enqueued request.
        """
        if not approval_key:
            return False
        return bool(
            self.redis.sismember(key(user_id, "applied_approvals"), approval_key)
        )

    def mark_approval_applied(
        self, user_id: str, approval_key: str, *, ttl_seconds: int = 7 * 24 * 3600
    ) -> None:
        """F-015: record that an approval has been executed so re-runs skip it."""
        if not approval_key:
            return
        applied_key = key(user_id, "applied_approvals")
        self.redis.sadd(applied_key, approval_key)
        with contextlib.suppress(Exception):
            self.redis.expire(applied_key, ttl_seconds)

    def maybe_enqueue_scheduled(self, user_id: str) -> dict[str, Any] | None:
        config = self.get_config(user_id)
        if not config.get("enabled", True):
            return None
        interval = int(config.get("intervalSeconds") or 14_400)
        last = int(config.get("lastScheduledRunAt") or 0)
        current = now_ms()
        if last and current - last < interval * 1000:
            return None
        request = {
            "id": f"scheduled-{current}",
            "trigger": "scheduled",
            "requestedBy": "worker",
            "createdAt": current,
        }
        self.enqueue(user_id, request)
        config["lastScheduledRunAt"] = current
        self.save_config(user_id, config)
        return request

    def sleep_with_lease(self, user_id: str, seconds: int) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.refresh_lease(user_id)
            time.sleep(min(10, max(0, deadline - time.monotonic())))
