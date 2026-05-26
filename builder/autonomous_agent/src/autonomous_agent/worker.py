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
    extract_approval_token,
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
        messages = build_messages(
            user_id=user_id,
            config=config,
            workspace=workspace,
            goals=goals,
            recent_runs=recent_runs,
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
            approval = new_approval(
                run_id=run["id"],
                action="Backend requested confirmation for an external-state mutation.",
                reason=response[:1800],
                approval_token=extract_approval_token(response),
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
        store.append_feed_items(user_id, feed_items)

        run["status"] = "completed"
        run["summary"] = str(
            output.get("summary") or output.get("executive_summary") or ""
        )
        run["feedItemIds"] = [item["id"] for item in feed_items]
        run["metrics"]["workspaceUpdated"] = changed
        run["completedAt"] = now_ms()
        store.upsert_run(user_id, run)
        store.log_event(
            user_id,
            run["id"],
            "run_completed",
            "Autonomous run completed.",
            data={"feedItems": len(feed_items), "workspaceUpdated": changed},
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
    backend = make_backend(user_id)
    log(f"worker starting for user={user_id}")

    while not STOP:
        if not store.acquire_lease(user_id, ttl_seconds=lease_ttl):
            time.sleep(poll_interval)
            continue
        try:
            store.maybe_enqueue_scheduled(user_id)
            request = store.dequeue(user_id, timeout=poll_interval)
            if request:
                run_with_lease_heartbeat(
                    store=store,
                    backend=backend,
                    user_id=user_id,
                    request=request,
                    lease_ttl=lease_ttl,
                )
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
