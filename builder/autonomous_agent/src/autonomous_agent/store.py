"""Fenced Redis state for the autonomous charter; no retired queue/feed reads."""

from __future__ import annotations

import json
import os
import time
import uuid
from collections.abc import Callable
from typing import Any

import redis

from .charter import CharterConfig, CharterOutput, task_enabled
from .scheduling import empty_state, finish, recover, schedule, select_due


def now_ms() -> int:
    return int(time.time() * 1000)


def key(user_id: str, name: str) -> str:
    return f"autonomy:{user_id}:charter:{name}"


class WorkerLeaseLost(RuntimeError):
    """The worker no longer owns execution or persistence for this account."""


class RedisStore:
    def __init__(self, redis_url: str | None = None) -> None:
        self.redis = redis.from_url(
            redis_url or os.getenv("REDIS_URL", "redis://redis:6379"),
            decode_responses=True,
        )
        self._lease_tokens: dict[str, str] = {}

    def ping(self) -> None:
        self.redis.ping()

    def get_config(self, user_id: str) -> CharterConfig:
        raw = self.redis.get(key(user_id, "config"))
        return CharterConfig.model_validate_json(raw) if raw else CharterConfig()

    def get_state(self, user_id: str) -> dict:
        raw = self.redis.get(key(user_id, "state"))
        return self._decode_state(raw)

    @staticmethod
    def _decode_state(raw: str | None) -> dict:
        if raw is None:
            return empty_state()
        value = json.loads(raw)
        if not isinstance(value, dict) or value.get("version") != 2:
            raise ValueError(
                "Invalid charter state; refusing to replace persisted work"
            )
        for name, default in empty_state().items():
            if type(value.get(name)) is not type(default):
                raise ValueError("Invalid charter state shape")
        return value

    def update(self, user_id: str, mutate: Callable[[dict, CharterConfig], Any]) -> Any:
        """Commit work and run records together, fenced by lease AND configuration.

        The frontend edits config separately. Watching it ensures a concurrent
        pause/config change causes selection to be recomputed before dispatch.
        An expired owner cannot overwrite a successor, even after a CAS retry.
        """
        token = self._lease_tokens.get(user_id)
        if not token:
            raise WorkerLeaseLost("No worker lease")
        state_key, config_key, lease_key = (
            key(user_id, name) for name in ("state", "config", "lease")
        )
        for _ in range(8):
            with self.redis.pipeline() as pipe:
                try:
                    pipe.watch(state_key, config_key, lease_key)
                    if pipe.get(lease_key) != token:
                        raise WorkerLeaseLost("Worker lease expired or transferred")
                    state = self._decode_state(pipe.get(state_key))
                    raw_config = pipe.get(config_key)
                    config = (
                        CharterConfig.model_validate_json(raw_config)
                        if raw_config
                        else CharterConfig()
                    )
                    result = mutate(state, config)
                    pipe.multi()
                    pipe.set(state_key, json.dumps(state, separators=(",", ":")))
                    pipe.execute()
                    return result
                except redis.WatchError:
                    continue
        raise RuntimeError("Charter state remained busy; no work was dispatched")

    def publish(self, user_id: str) -> None:
        self.redis.publish(
            f"user:{user_id}:updates",
            json.dumps(
                {
                    "type": "autonomy_status",
                    "timestamp": now_ms(),
                    "data": {"charter": True},
                }
            ),
        )

    def prepare(self, user_id: str) -> dict | None:
        timestamp = now_ms()

        def mutate(state: dict, config: CharterConfig):
            recover(state, timestamp)
            schedule(state, config, timestamp)
            return select_due(state, config, timestamp)

        return self.update(user_id, mutate)

    def claim(self, user_id: str, task_id: str) -> dict | None:
        timestamp = now_ms()

        def mutate(state: dict, config: CharterConfig):
            task = state["actions"].get(task_id)
            if (
                not task
                or task["status"] != "pending"
                or not task_enabled(config, task["kind"], task["payload"], timestamp)
                or task["dueAt"] > timestamp
            ):
                return None
            # Re-evaluate expiry at dispatch, not only at scheduler selection.
            selected = select_due(state, config, timestamp)
            if selected is None or selected["id"] != task_id:
                return None
            task.update(status="running", updatedAt=timestamp)
            task["attempts"] += 1
            run = {
                "id": f"run_{uuid.uuid4().hex}",
                "actionId": task_id,
                "kind": task["kind"],
                "responsibility": task["responsibility"],
                "status": "running",
                "startedAt": timestamp,
                "completedAt": None,
                "outcome": None,
            }
            task["runId"] = run["id"]
            state["runs"].insert(0, run)
            return {
                "task": task,
                "run": run,
                "config": config.model_dump(),
                "state": state,
            }

        return self.update(user_id, mutate)

    def finish(
        self, user_id: str, task_id: str, run_id: str, output: CharterOutput
    ) -> None:
        timestamp = now_ms()

        def mutate(state: dict, config: CharterConfig):
            task = state["actions"].get(task_id)
            if not task or task.get("runId") != run_id or task["status"] != "running":
                raise WorkerLeaseLost("Execution is no longer current")
            finish(state, task_id, output, config, timestamp)
            for run in state["runs"]:
                if run["id"] == run_id:
                    run.update(
                        status=output.outcome.status,
                        completedAt=timestamp,
                        outcome=output.outcome.model_dump(),
                    )
            state["runs"] = state["runs"][: config.maxRunsStored]

        self.update(user_id, mutate)

    def acquire_lease(self, user_id: str, ttl_seconds: int = 60) -> bool:
        token = uuid.uuid4().hex
        if self.redis.set(key(user_id, "lease"), token, nx=True, ex=ttl_seconds):
            self._lease_tokens[user_id] = token
            return True
        return False

    def owns_lease(self, user_id: str) -> bool:
        token = self._lease_tokens.get(user_id)
        return bool(token and self.redis.get(key(user_id, "lease")) == token)

    def refresh_lease(self, user_id: str, ttl_seconds: int = 60) -> bool:
        token = self._lease_tokens.get(user_id)
        return bool(
            token
            and self.redis.eval(
                "if redis.call('GET', KEYS[1]) == ARGV[1] then "
                "return redis.call('EXPIRE', KEYS[1], ARGV[2]) end return 0",
                1,
                key(user_id, "lease"),
                token,
                ttl_seconds,
            )
        )

    def release_lease(self, user_id: str) -> None:
        token = self._lease_tokens.pop(user_id, None)
        if token:
            self.redis.eval(
                "if redis.call('GET', KEYS[1]) == ARGV[1] then "
                "return redis.call('DEL', KEYS[1]) end return 0",
                1,
                key(user_id, "lease"),
                token,
            )

    def cancel_requested(self, user_id: str, run_id: str) -> bool:
        return bool(self.redis.get(key(user_id, f"cancel:{run_id}")))
