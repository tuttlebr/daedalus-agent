"""Long-running autonomous worker entrypoint."""

from __future__ import annotations

import contextlib
import os
import re
import signal
import sys
import threading
import time
import traceback
from typing import Any


from .backend_client import BackendClient, OAuthRequiredError, RunAbortedError
from .models import new_run, now_ms
from .prompt import (
    build_messages,
    feed_items_from_output,
    load_workspace,
    output_requests_approval,
    parse_structured_output,
    workspace_key,
)
from .store import RedisStore

STOP = False
_CADENCE_TAG_RE = re.compile(r"^cadence:(\d+)([hd])$", re.IGNORECASE)

# Hard ceiling on a single autonomous run. A worker blocked on one backend
# request cannot drain its queue, and the run outlives any operator's ability
# to reason about it. Configuration above this fails at worker startup rather
# than wedging the single replica for hours.
MAX_AUTONOMOUS_REQUEST_TIMEOUT_SECONDS = 6900


def log(message: str) -> None:
    print(f"[autonomy] {time.strftime('%Y-%m-%d %H:%M:%S')} {message}", flush=True)


def _request_summary(request: dict[str, Any] | None) -> str:
    if not request:
        return "none"
    prompt = str(request.get("prompt") or "").replace("\n", " ").strip()
    if len(prompt) > 120:
        prompt = f"{prompt[:117]}..."
    return (
        f"id={request.get('id') or 'unknown'} "
        f"trigger={request.get('trigger') or 'manual'} "
        f"requestedBy={request.get('requestedBy') or 'unknown'} "
        f"createdAt={request.get('createdAt') or 'unknown'} "
        f"prompt={prompt!r}"
    )


def start_queue_monitor(
    store: RedisStore,
    user_id: str,
    *,
    interval_seconds: int = 30,
) -> threading.Thread:
    """Log queue visibility even while the worker is blocked in a run."""

    def monitor() -> None:
        last_depth: int | None = None
        while not STOP:
            try:
                depth = store.queue_length(user_id)
                if depth != last_depth or depth > 0:
                    next_request = store.queue_snapshot(user_id, limit=1)
                    next_summary = _request_summary(
                        next_request[0] if next_request else None
                    )
                    log(f"queue status: depth={depth} next={next_summary}")
                    last_depth = depth
            except Exception as exc:
                log(f"queue monitor error: {exc}")
            time.sleep(interval_seconds)

    thread = threading.Thread(
        target=monitor,
        name="autonomy-queue-monitor",
        daemon=True,
    )
    thread.start()
    return thread


def _handle_signal(signum: int, _frame: Any) -> None:
    global STOP
    log(f"received signal {signum}; stopping after current operation")
    STOP = True


def apply_workspace_updates(
    store: RedisStore,
    user_id: str,
    output: dict[str, Any],
) -> list[str]:
    updates = output.get("workspace_updates")
    if not isinstance(updates, dict):
        return []

    allowed = {"heartbeat", "interests", "user", "inner_state", "memory"}
    changed: list[str] = []
    for name, content in updates.items():
        if name not in allowed:
            continue
        if not isinstance(content, str) or not content.strip():
            continue
        content = content.strip()
        key = workspace_key(user_id, name)
        if store.get_text(key) == content:
            continue
        store.set_text(key, content)
        changed.append(name)
    return changed


def _goal_cadence_ms(goal: dict[str, Any]) -> int:
    for tag in goal.get("tags") or []:
        match = _CADENCE_TAG_RE.match(str(tag).strip())
        if not match:
            continue
        value = max(1, int(match.group(1)))
        hours = value * (24 if match.group(2).lower() == "d" else 1)
        return hours * 3_600_000
    return 24 * 3_600_000


def select_scheduled_goal(
    goals: list[dict[str, Any]], *, timestamp: int
) -> dict[str, Any] | None:
    """Pick the never-run or most-overdue active goal, then use priority."""

    active = [
        (index, goal)
        for index, goal in enumerate(goals)
        if isinstance(goal, dict) and goal.get("status", "active") == "active"
    ]
    if not active:
        return None

    def rank(item: tuple[int, dict[str, Any]]) -> tuple[float, float, float, int]:
        index, goal = item
        last_run = goal.get("lastRunAt")
        try:
            priority = float(goal.get("priority"))
        except (TypeError, ValueError):
            priority = 3.0
        if not isinstance(last_run, (int, float)) or last_run <= 0:
            return (1.0, 0.0, -priority, -index)
        overdue = (timestamp - float(last_run)) / _goal_cadence_ms(goal)
        return (0.0, overdue, -priority, -index)

    return max(active, key=rank)[1]


def run_once(
    *,
    store: RedisStore,
    backend: BackendClient,
    user_id: str,
    request: dict[str, Any],
    abort: threading.Event | None = None,
    run_id_holder: dict[str, str] | None = None,
) -> dict[str, Any]:
    request = dict(request)
    goals_snapshot: list[dict[str, Any]] | None = None
    if request.get("trigger", "scheduled") == "scheduled" and not request.get("goalId"):
        goals_snapshot = store.list_goals(user_id)
        selected_goal = select_scheduled_goal(goals_snapshot, timestamp=now_ms())
        if selected_goal:
            request["goalId"] = selected_goal.get("id")

    run = new_run(
        user_id=user_id,
        trigger=str(request.get("trigger") or "manual"),
        goal_id=request.get("goalId"),
        prompt=str(request.get("prompt") or ""),
        requested_by=str(request.get("requestedBy") or "worker"),
    )

    if run_id_holder is not None:
        run_id_holder["id"] = run["id"]

    run["status"] = "running"
    run["startedAt"] = now_ms()
    store.upsert_run(user_id, run)
    store.log_event(user_id, run["id"], "run_started", "Autonomous run started.")
    goal_id = str(run.get("goalId") or "").strip()
    mark_goal_run = getattr(store, "mark_goal_run", None)
    if goal_id and callable(mark_goal_run):
        mark_goal_run(user_id, goal_id, run["startedAt"])

    try:
        config = store.get_config(user_id)
        workspace = load_workspace(store, user_id)
        goals = (
            goals_snapshot if goals_snapshot is not None else store.list_goals(user_id)
        )
        recent_runs = [
            existing
            for existing in store.list_runs(user_id)
            if existing.get("id") != run["id"]
        ]
        recent_feed = store.list_feed(user_id, limit=120)
        messages = build_messages(
            user_id=user_id,
            config=config,
            workspace=workspace,
            goals=goals,
            recent_runs=recent_runs,
            recent_feed=recent_feed,
            request=request,
        )
        store.log_event(user_id, run["id"], "backend_call", "Calling backend workflow.")
        execution_id = str(request.get("id") or run["id"])
        response = backend.call(
            messages, execution_id=execution_id, abort=abort
        )
        run["metrics"]["responseChars"] = len(response or "")

        # F-016: the lease was lost while this run was in flight, so another
        # worker may now own this user. Abort before writing any shared state
        # (feed / workspace) to avoid clobbering the new owner.
        lease_lost = abort is not None and abort.is_set()
        owns_lease = getattr(store, "owns_lease", None)
        if abort is not None and callable(owns_lease):
            try:
                lease_lost = lease_lost or not bool(owns_lease(user_id))
            except Exception:
                lease_lost = True
        if lease_lost:
            run["status"] = "aborted"
            run["completedAt"] = now_ms()
            run["summary"] = "Run aborted after losing the worker lease."
            store.upsert_run(user_id, run)
            store.log_event(
                user_id, run["id"], "run_aborted", run["summary"], level="warn"
            )
            return run

        if store.cancel_requested(user_id, run["id"]):
            run["status"] = "cancelled"
            run["completedAt"] = now_ms()
            run["summary"] = "Run cancelled after backend returned."
            store.upsert_run(user_id, run)
            store.log_event(
                user_id, run["id"], "run_cancelled", run["summary"], level="warn"
            )
            return run

        if output_requests_approval(response):
            # Autonomous work must be non-interactive. The backend safety gates
            # can still refuse a protected operation, but the worker must not
            # turn that refusal into a durable approval task for the user.
            run["status"] = "failed"
            run["error"] = "Autonomous runs cannot request user approval."
            run["completedAt"] = now_ms()
            store.upsert_run(user_id, run)
            store.log_event(
                user_id,
                run["id"],
                "approval_blocked",
                run["error"],
                level="error",
            )
            return run

        output = parse_structured_output(response)
        changed = apply_workspace_updates(store, user_id, output)
        feed_items = feed_items_from_output(run["id"], output)
        stored_items = store.append_feed_items(user_id, feed_items)
        if stored_items is None:  # defensive: legacy stores returned None
            stored_items = feed_items
        deduped = max(0, len(feed_items) - len(stored_items))

        run["status"] = "completed"
        run["summary"] = str(
            output.get("summary") or output.get("executive_summary") or ""
        )
        run["feedItemIds"] = [item["id"] for item in stored_items]
        run["metrics"]["workspaceUpdated"] = changed
        run["metrics"]["feedItemsStored"] = len(stored_items)
        run["metrics"]["feedItemsDeduped"] = deduped
        run["completedAt"] = now_ms()
        store.upsert_run(user_id, run)
        store.log_event(
            user_id,
            run["id"],
            "run_completed",
            "Autonomous run completed.",
            data={
                "feedItems": len(stored_items),
                "feedItemsDeduped": deduped,
                "workspaceUpdated": changed,
            },
        )
        return run
    except RunAbortedError as exc:
        # The stream was stopped mid-flight. A user cancellation and a lost
        # lease are both legitimate; anything else is a run that outran its
        # wall-clock budget or response cap.
        if store.cancel_requested(user_id, run["id"]):
            run["status"] = "cancelled"
            run["summary"] = "Run cancelled while the backend request was open."
            event, level = "run_cancelled", "warn"
        elif abort is not None and abort.is_set():
            run["status"] = "aborted"
            run["summary"] = "Run aborted after losing the worker lease."
            event, level = "run_aborted", "warn"
        else:
            run["status"] = "failed"
            run["error"] = str(exc)
            run["summary"] = "Run stopped before the backend produced an answer."
            event, level = "run_failed", "error"
        run["completedAt"] = now_ms()
        store.upsert_run(user_id, run)
        store.log_event(user_id, run["id"], event, run["summary"], level=level)
        return run
    except OAuthRequiredError:
        # OAuth always requires interactive browser state. Treat an attempted
        # OAuth tool call as a bounded run failure rather than creating an
        # approval loop that can never be autonomous.
        run["status"] = "failed"
        run["error"] = (
            "Autonomous runs cannot use tools that require interactive OAuth."
        )
        run["completedAt"] = now_ms()
        store.upsert_run(user_id, run)
        store.log_event(
            user_id,
            run["id"],
            "oauth_blocked",
            run["error"],
            level="error",
        )
        return run
    except Exception as exc:  # pragma: no cover - exercised through tests with fakes
        run["status"] = "failed"
        run["error"] = str(exc)
        run["completedAt"] = now_ms()
        store.upsert_run(user_id, run)
        store.log_event(
            user_id,
            run["id"],
            "run_failed",
            str(exc),
            level="error",
        )
        return run


def _request_timeout_seconds() -> int:
    raw_timeout = os.getenv("REQUEST_TIMEOUT", "3600")
    try:
        request_timeout = int(raw_timeout)
    except ValueError as exc:
        raise ValueError(
            "REQUEST_TIMEOUT must be an integer number of seconds"
        ) from exc
    if request_timeout <= 0:
        raise ValueError("REQUEST_TIMEOUT must be greater than zero")
    if request_timeout > MAX_AUTONOMOUS_REQUEST_TIMEOUT_SECONDS:
        raise ValueError(
            "REQUEST_TIMEOUT must be at most "
            f"{MAX_AUTONOMOUS_REQUEST_TIMEOUT_SECONDS} seconds so one run "
            "cannot wedge the worker queue"
        )
    return request_timeout


def make_backend(user_id: str) -> BackendClient:
    return BackendClient(
        base_url=os.getenv("BACKEND_BASE_URL", "http://daedalus-backend-default:8000"),
        api_path=os.getenv("BACKEND_API_PATH", "/v1/chat/completions"),
        user_id=user_id,
        request_timeout=_request_timeout_seconds(),
    )


def run_with_lease_heartbeat(
    *,
    store: RedisStore,
    backend: BackendClient,
    user_id: str,
    request: dict[str, Any],
    lease_ttl: int,
) -> dict[str, Any]:
    stop = threading.Event()
    # F-016: if the lease heartbeat fails the lease can expire and a second
    # worker may start the same user concurrently, racing the non-atomic shared
    # state. Signal the in-progress run to abort instead of ignoring the error.
    abort = threading.Event()
    # run_once mints the run id, so the heartbeat learns it through this holder.
    run_id_holder: dict[str, str] = {}
    heartbeat_interval = max(1, min(20, lease_ttl // 3 or 1))

    def heartbeat() -> None:
        while not stop.wait(heartbeat_interval):
            try:
                if not store.refresh_lease(user_id, ttl_seconds=lease_ttl):
                    abort.set()
                    log("worker lease lost; aborting current run")
                    return
            except Exception as exc:
                log(f"lease heartbeat failed; aborting current run: {exc}")
                abort.set()
                return
            # Cancellation used to be read only after the backend call
            # returned, so cancelling a long run did nothing until it finished
            # on its own. Poll here so the abort reaches the open stream.
            run_id = run_id_holder.get("id") or ""
            if run_id:
                try:
                    if store.cancel_requested(user_id, run_id):
                        abort.set()
                        log(f"cancellation requested; aborting run {run_id}")
                        return
                except Exception as exc:
                    log(f"cancellation check failed: {exc}")

    if not store.refresh_lease(user_id, ttl_seconds=lease_ttl):
        raise RuntimeError("worker lease was lost before the run started")
    thread = threading.Thread(
        target=heartbeat, name="autonomy-lease-heartbeat", daemon=True
    )
    thread.start()
    try:
        return run_once(
            store=store,
            backend=backend,
            user_id=user_id,
            request=request,
            abort=abort,
            run_id_holder=run_id_holder,
        )
    finally:
        stop.set()
        thread.join(timeout=1)


def main() -> int:
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    user_id = os.getenv("AUTONOMOUS_USER_ID", "default-user")
    poll_interval = int(os.getenv("AUTONOMY_WORKER_POLL_INTERVAL", "10"))
    lease_ttl = int(os.getenv("AUTONOMY_WORKER_LEASE_TTL", "60"))
    run_once_only = os.getenv("AUTONOMY_RUN_ONCE", "false").lower() == "true"

    store = RedisStore()
    store.ping()
    backend = make_backend(user_id)
    start_queue_monitor(store, user_id)
    log(f"worker starting for user={user_id}")

    # F-001: a transient Redis error must not kill the worker for every queued
    # job. Errors are caught, logged with a full traceback, the lease is always
    # released, and the loop continues with an exponential backoff so a sustained
    # outage does not spin into a tight error loop.
    consecutive_errors = 0
    max_backoff = max(poll_interval, 60)
    while not STOP:
        if not store.acquire_lease(user_id, ttl_seconds=lease_ttl):
            time.sleep(poll_interval)
            continue
        try:
            # Reclaim only after acquiring the per-user lease. A replacement pod
            # cannot move a live owner's request during a rolling overlap.
            reclaimed = store.reclaim_processing(user_id)
            if reclaimed:
                log(
                    f"reclaimed {reclaimed} in-flight request(s) from a previous worker"
                )
            scheduled = store.maybe_enqueue_scheduled(user_id)
            if scheduled:
                log(f"scheduled request enqueued: {_request_summary(scheduled)}")
            request = store.dequeue(user_id, timeout=poll_interval)
            if request:
                log(
                    "dequeued request: "
                    f"{_request_summary(request)} "
                    f"queue_depth_after={store.queue_length(user_id)}"
                )
                run = run_with_lease_heartbeat(
                    store=store,
                    backend=backend,
                    user_id=user_id,
                    request=request,
                    lease_ttl=lease_ttl,
                )
                log(
                    "run finished: "
                    f"id={run.get('id') or 'unknown'} "
                    f"status={run.get('status') or 'unknown'} "
                    f"error={str(run.get('error') or '')[:240]!r}"
                )
                # F-013: the run has been recorded (incl. recorded failures), so
                # remove it from the processing list. If the worker had crashed
                # before reaching here, reclaim_processing() would have re-queued it.
                if run.get("status") != "aborted":
                    store.complete(user_id)
                if run_once_only:
                    return 0
            else:
                if not store.refresh_lease(user_id, ttl_seconds=lease_ttl):
                    raise RuntimeError("worker lease was lost while idle")
            consecutive_errors = 0
        except Exception:
            consecutive_errors += 1
            log(
                "worker loop error (continuing); "
                f"consecutive_errors={consecutive_errors}\n"
                f"{traceback.format_exc()}"
            )
            backoff = min(max_backoff, poll_interval * (2 ** (consecutive_errors - 1)))
            time.sleep(backoff)
        finally:
            # Always release the lease so a failed iteration cannot strand it,
            # and never let a release error mask the original loop error.
            with contextlib.suppress(Exception):
                store.release_lease(user_id)

    log("worker stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
