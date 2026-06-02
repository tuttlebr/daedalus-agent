"""Long-running autonomous worker entrypoint."""

from __future__ import annotations

import os
import signal
import sys
import threading
import time
from typing import Any

from .backend_client import BackendClient, OAuthRequiredError
from .models import new_approval, new_run, now_ms
from .prompt import (
    build_messages,
    extract_approval_metadata,
    feed_items_from_output,
    load_workspace,
    output_requests_approval,
    parse_structured_output,
    workspace_key,
)
from .store import RedisStore

STOP = False


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
                    log("queue status: " f"depth={depth} next={next_summary}")
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
        store.set_text(workspace_key(user_id, name), content.strip())
        changed.append(name)
    return changed


def run_once(
    *,
    store: RedisStore,
    backend: BackendClient,
    user_id: str,
    request: dict[str, Any],
) -> dict[str, Any]:
    run = new_run(
        user_id=user_id,
        trigger=str(request.get("trigger") or "manual"),
        goal_id=request.get("goalId"),
        prompt=str(request.get("prompt") or ""),
        requested_by=str(request.get("requestedBy") or "worker"),
    )
    run["status"] = "running"
    run["startedAt"] = now_ms()
    store.upsert_run(user_id, run)
    store.log_event(user_id, run["id"], "run_started", "Autonomous run started.")

    try:
        config = store.get_config(user_id)
        workspace = load_workspace(store, user_id)
        goals = store.list_goals(user_id)
        recent_runs = [
            existing
            for existing in store.list_runs(user_id)
            if existing.get("id") != run["id"]
        ]
        recent_feed = store.list_feed(user_id, limit=60)
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
        response = backend.call(messages)
        run["metrics"]["responseChars"] = len(response or "")

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
            approval_metadata = extract_approval_metadata(response)
            approval = new_approval(
                run_id=run["id"],
                action=approval_metadata["action"],
                reason=response[:1800],
                action_type=approval_metadata["action_type"],
                target=approval_metadata["target"],
                risk=approval_metadata["risk"],
                approval_token=approval_metadata["approval_token"],
            )
            store.append_approval(user_id, approval)
            run["status"] = "waiting_approval"
            run["summary"] = "Waiting for UI approval before continuing."
            run["completedAt"] = now_ms()
            store.upsert_run(user_id, run)
            store.log_event(
                user_id,
                run["id"],
                "approval_requested",
                "Run paused for UI approval.",
                level="warn",
                data={"approvalId": approval["id"]},
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
    except OAuthRequiredError as exc:
        approval = new_approval(
            run_id=run["id"],
            action="OAuth authorization required.",
            reason=(
                "The backend needs browser authorization before this autonomous "
                "run can use the requested authenticated tool."
            ),
            action_type="oauth_authorization",
            target="google_workspace",
            risk="low",
            auth_url=exc.auth_url,
            oauth_state=exc.oauth_state,
        )
        store.append_approval(user_id, approval)
        run["status"] = "waiting_approval"
        run["summary"] = "Waiting for OAuth authorization before continuing."
        run["completedAt"] = now_ms()
        store.upsert_run(user_id, run)
        store.log_event(
            user_id,
            run["id"],
            "oauth_authorization_requested",
            "Run paused for browser authorization.",
            level="warn",
            data={"approvalId": approval["id"], "hasAuthUrl": bool(exc.auth_url)},
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


def make_backend(user_id: str) -> BackendClient:
    return BackendClient(
        base_url=os.getenv("BACKEND_BASE_URL", "http://daedalus-backend-default:8000"),
        api_path=os.getenv("BACKEND_API_PATH", "/v1/workflow/async"),
        user_id=user_id,
        request_timeout=int(os.getenv("REQUEST_TIMEOUT", "3600")),
        poll_interval=int(os.getenv("ASYNC_POLL_INTERVAL", "10")),
        expiry_seconds=int(os.getenv("ASYNC_EXPIRY_SECONDS", "3600")),
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
    heartbeat_interval = max(1, min(20, lease_ttl // 3 or 1))

    def heartbeat() -> None:
        while not stop.wait(heartbeat_interval):
            try:
                store.refresh_lease(user_id, ttl_seconds=lease_ttl)
            except Exception as exc:
                log(f"lease heartbeat failed: {exc}")

    store.refresh_lease(user_id, ttl_seconds=lease_ttl)
    thread = threading.Thread(
        target=heartbeat, name="autonomy-lease-heartbeat", daemon=True
    )
    thread.start()
    try:
        return run_once(store=store, backend=backend, user_id=user_id, request=request)
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
    # F-013: re-queue any request a previous worker popped but did not finish
    # (crash / OOM / SIGKILL mid-run) so it is retried rather than silently lost.
    reclaimed = store.reclaim_processing(user_id)
    if reclaimed:
        log(f"reclaimed {reclaimed} in-flight request(s) from a previous worker")
    backend = make_backend(user_id)
    start_queue_monitor(store, user_id)
    log(f"worker starting for user={user_id}")

    while not STOP:
        if not store.acquire_lease(user_id, ttl_seconds=lease_ttl):
            time.sleep(poll_interval)
            continue
        try:
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
                run_with_lease_heartbeat(
                    store=store,
                    backend=backend,
                    user_id=user_id,
                    request=request,
                    lease_ttl=lease_ttl,
                )
                # F-013: the run has been recorded (incl. recorded failures), so
                # remove it from the processing list. If the worker had crashed
                # before reaching here, reclaim_processing() would have re-queued it.
                store.complete(user_id)
                if run_once_only:
                    return 0
            else:
                store.refresh_lease(user_id, ttl_seconds=lease_ttl)
        finally:
            store.release_lease(user_id)

    log("worker stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
