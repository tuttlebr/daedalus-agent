"""Execute the user's charter with durable intent, bounded runs and daily reports."""

from __future__ import annotations

import contextlib
import os
import signal
import threading
import time
from typing import Any

from .backend_client import BackendClient, RunAbortedError
from .charter import ActionOutcome, CharterConfig, CharterOutput, task_enabled
from .prompt import build_messages, parse_structured_output
from .store import RedisStore, WorkerLeaseLost, now_ms
from .summary import publish_daily_summary

SHUTDOWN = threading.Event()
CANCEL_POLL_SECONDS = 1.0


def log(message: str) -> None:
    print(f"[autonomy] {message}", flush=True)


def _handle_signal(_signum: int, _frame: Any) -> None:
    SHUTDOWN.set()


def make_backend(user_id: str, config: CharterConfig) -> BackendClient:
    return BackendClient(
        base_url=os.getenv("BACKEND_BASE_URL", "http://daedalus-backend-default:8000"),
        api_path=os.getenv("BACKEND_API_PATH", "/v1/chat/completions"),
        user_id=user_id,
        request_timeout=config.maxRunSeconds,
    )


def run_once(
    *,
    store: RedisStore,
    user_id: str,
    task_id: str,
    lease_ttl: int = 60,
    backend: BackendClient | None = None,
) -> dict | None:
    claim = store.claim(user_id, task_id)
    if claim is None:
        return None
    task, run = claim["task"], claim["run"]
    config = CharterConfig.model_validate(claim["config"])
    if task["kind"] == "daily_summary":
        return store.update(
            user_id,
            lambda state, current: publish_daily_summary(
                state, state["actions"][task_id], current, now_ms()
            ),
        )
    abort = threading.Event()
    stopped = threading.Event()

    def heartbeat() -> None:
        refresh_at = time.monotonic()
        while not stopped.wait(CANCEL_POLL_SECONDS):
            try:
                if (
                    SHUTDOWN.is_set()
                    or store.cancel_requested(user_id, run["id"])
                    or not task_enabled(store.get_config(user_id), task["kind"])
                ):
                    abort.set()
                    return
                if time.monotonic() >= refresh_at:
                    if not store.refresh_lease(user_id, ttl_seconds=lease_ttl):
                        abort.set()
                        return
                    refresh_at = time.monotonic() + max(1, lease_ttl // 3)
            except Exception:
                abort.set()
                return

    thread = threading.Thread(target=heartbeat, name="charter-heartbeat", daemon=True)
    thread.start()
    try:
        if SHUTDOWN.is_set() or not store.owns_lease(user_id):
            raise RunAbortedError("Execution stopped before dispatch")
        messages = build_messages(
            config=config, task=task, state=claim["state"], timestamp=now_ms()
        )
        response = (backend or make_backend(user_id, config)).call(
            messages,
            execution_id=run["id"],
            abort=abort,
            charter_task={
                "id": task_id,
                "kind": task["kind"],
                "max_tool_calls": config.maxToolCalls,
            },
        )
        if abort.is_set() or store.cancel_requested(user_id, run["id"]):
            raise RunAbortedError("Execution stopped before result commit")
        output = parse_structured_output(response)
    except Exception as exc:
        # The model/transport may have changed remote state before failure.
        # Never use arbitrary exception text (which can contain credentials or
        # model text) or automatically retry an unverified mutation.
        log(f"run interrupted: kind={task['kind']} error_class={type(exc).__name__}")
        output = CharterOutput(
            outcome=ActionOutcome(
                status="uncertain",
                mutationAttempted=True,
                summary="Execution stopped without a verified result. Reconcile remote state before another action.",
            )
        )
    finally:
        stopped.set()
        thread.join(timeout=2)
    store.finish(user_id, task_id, run["id"], output)
    return output.model_dump()


def main() -> int:
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)
    user_id = os.getenv("AUTONOMOUS_USER_ID", "").strip()
    if not user_id:
        raise ValueError("AUTONOMOUS_USER_ID must identify the connected user")
    poll = int(os.getenv("AUTONOMY_WORKER_POLL_INTERVAL", "10"))
    lease_ttl = int(os.getenv("AUTONOMY_WORKER_LEASE_TTL", "60"))
    if poll < 1 or lease_ttl < 6:
        raise ValueError(
            "Worker poll must be positive and lease must be at least six seconds"
        )
    store = RedisStore()
    store.ping()
    errors = 0
    while not SHUTDOWN.is_set():
        acquired = False
        had_work = False
        try:
            acquired = store.acquire_lease(user_id, ttl_seconds=lease_ttl)
            if acquired:
                task = store.prepare(user_id)
                if task:
                    had_work = True
                    run_once(
                        store=store,
                        user_id=user_id,
                        task_id=task["id"],
                        lease_ttl=lease_ttl,
                    )
                    # Notification failure must not roll back or replay a result.
                    with contextlib.suppress(Exception):
                        store.publish(user_id)
                    if os.getenv("AUTONOMY_RUN_ONCE", "false").lower() == "true":
                        return 0
                errors = 0
        except WorkerLeaseLost:
            log("worker lease lost; successor will reconcile unfinished work")
        except Exception as exc:
            errors += 1
            log(f"worker error: {type(exc).__name__}")
        finally:
            if acquired:
                with contextlib.suppress(Exception):
                    store.release_lease(user_id)
        if errors or not had_work:
            SHUTDOWN.wait(min(60, poll * 2 ** min(errors, 6)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
