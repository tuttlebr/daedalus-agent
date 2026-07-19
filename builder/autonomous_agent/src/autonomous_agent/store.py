"""Redis-backed state store for autonomous runs."""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
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
        watch_error_type = getattr(
            getattr(redis, "exceptions", None), "WatchError", None
        )
        self._watch_error_type: type[Exception] | None = (
            watch_error_type
            if isinstance(watch_error_type, type)
            and issubclass(watch_error_type, Exception)
            else None
        )
        self._json_supported: bool | None = None
        self._lease_tokens: dict[str, str] = {}
        self._lease_ttls: dict[str, int] = {}
        # F-013: raw payload of the request currently being processed per user,
        # so it can be removed from the reliable-queue processing list on completion.
        self._inflight: dict[str, str] = {}

    @staticmethod
    def _processing_claim_key(user_id: str, raw_request: str) -> str:
        request_hash = hashlib.sha256(raw_request.encode("utf-8")).hexdigest()[:32]
        return key(user_id, f"processing_claim:{request_hash}")

    def _write_processing_claim(self, user_id: str, raw_request: str) -> None:
        token = self._lease_tokens.get(user_id)
        ttl_seconds = self._lease_ttls.get(user_id)
        if not token or not ttl_seconds:
            raise RuntimeError("cannot claim a request without an active worker lease")
        claimed_at = now_ms()
        claim = {
            "ownerToken": token,
            "claimedAt": claimed_at,
            "visibilityDeadlineAt": claimed_at + ttl_seconds * 1000,
        }
        self.redis.set(
            self._processing_claim_key(user_id, raw_request),
            json.dumps(claim, sort_keys=True, separators=(",", ":")),
            ex=ttl_seconds,
        )

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
        racing. Both RedisJSON and plain-string JSON keys use commands matching
        their storage type inside the transaction. ``mutate`` receives the
        current decoded value (already defaulted to ``[]``) and returns
        ``(new_value, result)``; ``result`` is returned to the caller. Falls back
        to a plain read-modify-write only when the Redis client does not expose
        ``pipeline`` (keeps non-transactional test fakes working).
        """
        pipeline_factory = getattr(self.redis, "pipeline", None)
        if not callable(pipeline_factory):
            current = self.json_get(redis_key, [])
            new_value, result = mutate(current if isinstance(current, list) else [])
            self.json_set(redis_key, new_value)
            return result

        json_supported = self._supports_json()
        attempts = max(1, retries)
        last_watch_error: Exception | None = None
        for _ in range(attempts):
            pipe = pipeline_factory()
            try:
                pipe.watch(redis_key)
                if json_supported:
                    raw = pipe.execute_command("JSON.GET", redis_key)
                else:
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
                serialized = json.dumps(new_value)
                if json_supported:
                    pipe.execute_command("JSON.SET", redis_key, ".", serialized)
                else:
                    pipe.set(redis_key, serialized)
                pipe.execute()
                return result
            except Exception as exc:
                if self._watch_error_type is None or not isinstance(
                    exc, self._watch_error_type
                ):
                    raise
                last_watch_error = exc
                continue
            finally:
                with contextlib.suppress(Exception):
                    pipe.reset()

        # Never degrade to a non-atomic write: under sustained contention it is
        # safer for the caller to retry than to silently clobber another worker.
        if last_watch_error is None:  # pragma: no cover - loop always sets this
            raise RuntimeError(f"Atomic update for {redis_key!r} did not complete")
        raise last_watch_error

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

    def mark_goal_run(self, user_id: str, goal_id: str, timestamp: int) -> None:
        """Record a goal attempt so scheduled runs can rotate across goals."""

        def mutate(current: list[dict[str, Any]]):
            goals = []
            changed = False
            for goal in current:
                if isinstance(goal, dict) and goal.get("id") == goal_id:
                    goal = {**goal, "lastRunAt": timestamp}
                    changed = True
                goals.append(goal)
            return goals, changed

        changed = self.atomic_update(key(user_id, "goals"), mutate)
        if changed:
            self.publish(user_id, "autonomy_status", {"goalsUpdated": True})

    def list_runs(self, user_id: str) -> list[dict[str, Any]]:
        runs = self.json_get(key(user_id, "runs"), [])
        return runs if isinstance(runs, list) else []

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
        def mutate(events: list[dict[str, Any]]):
            events.insert(0, event)
            return events[:500], None

        self.atomic_update(key(user_id, "events"), mutate)
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

    def get_pending_approval(
        self, user_id: str, request_id: str
    ) -> dict[str, Any] | None:
        """Load a protected, non-executable approval intent created by NAT."""

        if not request_id:
            return None
        safe_user = hashlib.sha256(user_id.strip().encode()).hexdigest()[:16]
        raw = self.redis.get(f"approval-pending:{safe_user}:{request_id}")
        if not raw:
            return None
        try:
            pending = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
        if not isinstance(pending, dict) or pending.get("user_id") != user_id.strip():
            return None
        return pending

    def get_approval_execution(
        self, user_id: str, request_id: str
    ) -> dict[str, Any] | None:
        """Load the server-only credential/context for an approved queue item."""

        if not request_id:
            return None
        execution_key = key(user_id, f"approval-execution:{request_id}")
        getdel = getattr(self.redis, "getdel", None)
        if callable(getdel):
            raw = getdel(execution_key)
        else:
            raw = self.redis.eval(
                "local v=redis.call('GET',KEYS[1]); "
                "if v then redis.call('DEL',KEYS[1]) end; return v",
                1,
                execution_key,
            )
        if not raw:
            return None
        try:
            execution = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
        if not isinstance(execution, dict):
            return None
        return execution

    def issue_approval_token(
        self,
        user_id: str,
        execution: dict[str, Any],
        *,
        ttl_seconds: int = 300,
    ) -> str:
        """Mint a short-lived one-use credential only when work is dequeued."""

        from user_interaction.approval_tokens import (
            ApprovalRequest,
            issue_approval_token,
        )

        action_type = str(execution.get("actionType") or "").strip()
        target = str(execution.get("target") or "").strip()
        canonical_arguments = str(execution.get("canonicalArguments") or "").strip()
        arguments_sha256 = str(execution.get("argumentsSha256") or "").strip()
        return issue_approval_token(
            self.redis,
            ApprovalRequest(
                user_id=user_id,
                action_type=action_type,
                target=target,
                server_name=str(execution.get("serverName") or "").strip(),
                tool_name=str(execution.get("toolName") or "").strip(),
                arguments_sha256=arguments_sha256,
                canonical_arguments=canonical_arguments,
            ),
            ttl_seconds=ttl_seconds,
        )

    def revoke_approval_token(self, user_id: str, token: str) -> None:
        """Revoke an unspent credential after any completed worker attempt."""

        if not token:
            return
        from user_interaction.approval_tokens import approval_token_key

        self.redis.delete(approval_token_key(user_id, token))

    def consume_mcp_execution_receipt(
        self,
        user_id: str,
        token: str,
        execution: dict[str, Any],
    ) -> bool:
        """Consume proof that the gate ran the exact approved MCP mutation."""

        if str(execution.get("actionType") or "").strip() != "mcp_mutation":
            return False
        from user_interaction.approval_tokens import consume_mcp_execution_receipt

        return consume_mcp_execution_receipt(
            self.redis,
            user_id=user_id,
            token=token,
            server_name=str(execution.get("serverName") or "").strip(),
            tool_name=str(execution.get("toolName") or "").strip(),
            arguments_sha256=str(execution.get("argumentsSha256") or "").strip(),
        )

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
        if not self.owns_lease(user_id):
            raise RuntimeError("cannot dequeue without owning the worker lease")
        queue_key = key(user_id, "queue")
        processing_key = key(user_id, "processing")
        raw = self.redis.brpoplpush(queue_key, processing_key, timeout)
        if not raw:
            return None
        lease_ttl = self._lease_ttls.get(user_id, 60)
        if not self.refresh_lease(user_id, ttl_seconds=lease_ttl):
            # The request remains in processing for the replacement owner.
            raise RuntimeError("worker lease was lost while dequeuing a request")
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
        self._write_processing_claim(user_id, raw)
        return parsed

    def complete(self, user_id: str) -> bool:
        """Remove the in-flight request from the processing list after handling.

        Call once the run has been recorded (success or a recorded failure). If
        the worker crashes before this, the entry stays in ``processing`` and is
        re-queued by ``reclaim_processing()`` on the next startup (at-least-once).
        """
        raw = self._inflight.pop(user_id, None)
        if raw is None:
            return False
        token = self._lease_tokens.get(user_id)
        if not token:
            return False
        return bool(
            self.redis.eval(
                """
                if redis.call("GET", KEYS[1]) ~= ARGV[1] then
                    return 0
                end
                redis.call("LREM", KEYS[2], 1, ARGV[2])
                redis.call("DEL", KEYS[3])
                return 1
                """,
                3,
                key(user_id, "lease"),
                key(user_id, "processing"),
                self._processing_claim_key(user_id, raw),
                token,
                raw,
            )
        )

    def reclaim_processing(self, user_id: str) -> int:
        """Re-queue crashed work only while holding the user's current lease."""

        token = self._lease_tokens.get(user_id)
        if not token:
            raise RuntimeError(
                "cannot reclaim processing work without owning the lease"
            )
        processing_key = key(user_id, "processing")
        queue_key = key(user_id, "queue")
        moved = self.redis.eval(
            """
            if redis.call("GET", KEYS[1]) ~= ARGV[1] then
                return false
            end
            local moved = {}
            while true do
                local value = redis.call("RPOPLPUSH", KEYS[2], KEYS[3])
                if not value then
                    break
                end
                table.insert(moved, value)
            end
            return moved
            """,
            3,
            key(user_id, "lease"),
            processing_key,
            queue_key,
            token,
        )
        if moved is None or moved is False:
            self._lease_tokens.pop(user_id, None)
            self._lease_ttls.pop(user_id, None)
            raise RuntimeError("cannot reclaim processing work after losing the lease")
        local_inflight = self._inflight.get(user_id)
        if local_inflight in moved:
            self._inflight.pop(user_id, None)
        for raw in moved:
            with contextlib.suppress(Exception):
                self.redis.delete(self._processing_claim_key(user_id, raw))
        return len(moved)

    def acquire_lease(self, user_id: str, ttl_seconds: int = 60) -> bool:
        token = f"{os.getpid()}:{uuid.uuid4().hex}"
        ttl_seconds = max(1, int(ttl_seconds))
        acquired = bool(
            self.redis.set(key(user_id, "lease"), token, nx=True, ex=ttl_seconds)
        )
        if acquired:
            self._lease_tokens[user_id] = token
            self._lease_ttls[user_id] = ttl_seconds
        return acquired

    def owns_lease(self, user_id: str) -> bool:
        token = self._lease_tokens.get(user_id)
        if not token:
            return False
        return self.redis.get(key(user_id, "lease")) == token

    def refresh_lease(self, user_id: str, ttl_seconds: int = 60) -> bool:
        token = self._lease_tokens.get(user_id)
        if not token:
            return False
        ttl_seconds = max(1, int(ttl_seconds))
        refreshed = bool(
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
                ttl_seconds,
            )
        )
        if not refreshed:
            self._lease_tokens.pop(user_id, None)
            self._lease_ttls.pop(user_id, None)
            return False
        self._lease_ttls[user_id] = ttl_seconds
        raw = self._inflight.get(user_id)
        if raw is not None:
            self._write_processing_claim(user_id, raw)
        return True

    def release_lease(self, user_id: str) -> None:
        token = self._lease_tokens.pop(user_id, None)
        self._lease_ttls.pop(user_id, None)
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
        non-idempotent action twice. ``approval_key`` is the stable public
        approval id carried by the re-enqueued request; it is not a credential.
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
