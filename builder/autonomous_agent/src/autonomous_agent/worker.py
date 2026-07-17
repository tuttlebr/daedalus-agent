"""Long-running autonomous worker entrypoint."""

from __future__ import annotations

import contextlib
import os
import signal
import sys
import threading
import time
import traceback
from typing import Any

from user_interaction.approval_tokens import DEFAULT_MCP_RECEIPT_TTL_SECONDS

from .backend_client import BackendClient, OAuthRequiredError
from .models import new_approval, new_run, now_ms
from .prompt import (
    build_messages,
    extract_approval_metadata,
    feed_items_from_output,
    load_workspace,
    output_requests_approval,
    parse_structured_output,
    request_approval_key,
    workspace_key,
)
from .store import RedisStore

STOP = False

# A receipt can be created before the backend finishes the approved run. Keep
# a fixed recovery window after the HTTP deadline so the worker can consume
# that proof before it expires. Configuration that violates this relationship
# fails at worker startup instead of silently weakening duplicate prevention.
MCP_RECEIPT_RECOVERY_MARGIN_SECONDS = 5 * 60
MAX_AUTONOMOUS_REQUEST_TIMEOUT_SECONDS = (
    DEFAULT_MCP_RECEIPT_TTL_SECONDS - MCP_RECEIPT_RECOVERY_MARGIN_SECONDS
)


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


def _approval_reason(metadata: dict[str, str]) -> str:
    """F-017a: build a brief structured approval reason from parsed metadata.

    Uses only fields extract_approval_metadata derived from the structured
    marker, never the raw LLM response, so unreviewed model text is not
    persisted or published as the approval reason.
    """
    action = (metadata.get("action") or "Backend requested confirmation.").strip()
    parts = [action]
    target = (metadata.get("target") or "").strip()
    if target:
        parts.append(f"target={target}")
    server_name = (metadata.get("server_name") or "").strip()
    if server_name:
        parts.append(f"server_name={server_name}")
    tool_name = (metadata.get("tool_name") or "").strip()
    if tool_name:
        parts.append(f"tool_name={tool_name}")
    parts.append(f"action_type={metadata.get('action_type') or 'mcp_mutation'}")
    parts.append(f"risk={metadata.get('risk') or 'medium'}")
    return " | ".join(parts)


def _approved_execution_prompt(
    request: dict[str, Any], execution: dict[str, Any]
) -> str:
    """Build worker-only resume context without exposing credentials to the UI."""

    original_prompt = str(execution.get("originalPrompt") or "").strip()
    action = str(execution.get("action") or "the pending action").strip()
    action_type = str(execution.get("actionType") or "").strip()
    base = str(request.get("prompt") or "").strip()
    parts = [base] if base else []
    if original_prompt:
        parts.append(f"Original user prompt: {original_prompt}")

    if action_type == "mcp_mutation":
        server_name = str(execution.get("serverName") or "").strip()
        tool_name = str(execution.get("toolName") or "").strip()
        canonical_arguments = str(execution.get("canonicalArguments") or "").strip()
        if not server_name or not tool_name or not canonical_arguments:
            raise ValueError("approved MCP execution context is incomplete")
        parts.append(
            "The user approved this exact action: "
            f"{action}. Call MCP function group {server_name}, tool {tool_name}, "
            f"with exactly this JSON argument object: {canonical_arguments}. "
            "Do not alter the arguments and do not request confirmation again. "
            "The execution credential is supplied out of band by the worker."
        )
    else:
        token = str(execution.get("token") or "").strip()
        if not token:
            raise ValueError("approved execution credential is missing")
        parts.append(
            f"The user approved {action_type or 'the action'} for "
            f"{execution.get('target') or 'the displayed target'}. "
            f'Use approval_token="{token}" for this exact action only.'
        )
    return "\n\n".join(parts)


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
        store.set_text(workspace_key(user_id, name), content.strip())
        changed.append(name)
    return changed


def run_once(
    *,
    store: RedisStore,
    backend: BackendClient,
    user_id: str,
    request: dict[str, Any],
    abort: threading.Event | None = None,
) -> dict[str, Any]:
    run = new_run(
        user_id=user_id,
        trigger=str(request.get("trigger") or "manual"),
        goal_id=request.get("goalId"),
        prompt=str(request.get("prompt") or ""),
        requested_by=str(request.get("requestedBy") or "worker"),
    )

    # F-015: an approved request can be re-enqueued (UI re-click, reclaim of an
    # in-flight job, manual replay). Re-running it would execute a possibly
    # non-idempotent action twice. If the stable public approval id was already
    # applied, record a skipped run and return instead of calling the backend.
    approval_key = request_approval_key(request)
    if approval_key and store.is_approval_applied(user_id, approval_key):
        run["status"] = "skipped"
        run["completedAt"] = now_ms()
        run["summary"] = "Approval already applied; skipped duplicate execution."
        store.upsert_run(user_id, run)
        store.log_event(
            user_id,
            run["id"],
            "approval_already_applied",
            "Skipped duplicate execution of an already-applied approval.",
            level="warn",
        )
        return run

    approval_execution: dict[str, Any] | None = None
    action_type = str(request.get("actionType") or "").strip()
    if approval_key and action_type not in {
        "deep_research_plan",
        "oauth_authorization",
    }:
        get_execution = getattr(store, "get_approval_execution", None)
        if callable(get_execution):
            approval_execution = get_execution(user_id, str(request.get("id") or ""))
        if approval_execution and (
            str(approval_execution.get("approvalId") or "") != approval_key
            or str(approval_execution.get("actionType") or "") != action_type
        ):
            approval_execution = None
        if not approval_execution:
            run["status"] = "failed"
            run["completedAt"] = now_ms()
            run["error"] = "Approved execution credential is missing or expired."
            store.upsert_run(user_id, run)
            store.log_event(
                user_id,
                run["id"],
                "approval_credential_missing",
                run["error"],
                level="error",
            )
            return run

    approval_token: str | None = None
    mcp_receipt_checked = False
    mcp_receipt_verified = False

    def consume_mcp_success_receipt() -> bool:
        """Consume the gate's exact-call proof and mark this approval applied."""

        nonlocal mcp_receipt_checked, mcp_receipt_verified
        if mcp_receipt_checked:
            return mcp_receipt_verified
        mcp_receipt_checked = True
        if (
            action_type != "mcp_mutation"
            or not approval_key
            or not approval_token
            or approval_execution is None
        ):
            return False
        consume_receipt = getattr(store, "consume_mcp_execution_receipt", None)
        if not callable(consume_receipt):
            raise ValueError("MCP execution receipt verifier is unavailable")
        mcp_receipt_verified = bool(
            consume_receipt(user_id, approval_token, approval_execution)
        )
        if mcp_receipt_verified:
            store.mark_approval_applied(user_id, approval_key)
        return mcp_receipt_verified

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
        if approval_execution is not None:
            issue_token = getattr(store, "issue_approval_token", None)
            if not callable(issue_token):
                raise ValueError("approval credential issuer is unavailable")
            approval_token = str(issue_token(user_id, approval_execution) or "").strip()
            if not approval_token:
                raise ValueError("approved execution credential could not be issued")

        prompt_request = request
        if approval_execution is not None:
            prompt_request = dict(request)
            prompt_execution = dict(approval_execution)
            if action_type != "mcp_mutation":
                prompt_execution["token"] = approval_token
            prompt_request["prompt"] = _approved_execution_prompt(
                request, prompt_execution
            )
        messages = build_messages(
            user_id=user_id,
            config=config,
            workspace=workspace,
            goals=goals,
            recent_runs=recent_runs,
            recent_feed=recent_feed,
            request=prompt_request,
        )
        store.log_event(user_id, run["id"], "backend_call", "Calling backend workflow.")
        execution_id = str(request.get("id") or run["id"])
        response = (
            backend.call(
                messages,
                approval_token=approval_token,
                execution_id=execution_id,
            )
            if approval_token and action_type == "mcp_mutation"
            else backend.call(messages, execution_id=execution_id)
        )
        if approval_key and action_type == "mcp_mutation":
            if not consume_mcp_success_receipt():
                raise ValueError(
                    "Approved MCP tool execution did not produce an exact "
                    "success receipt."
                )
        run["metrics"]["responseChars"] = len(response or "")

        # F-016: the lease was lost while this run was in flight, so another
        # worker may now own this user. Abort before writing any shared state
        # (feed / workspace / approvals) to avoid clobbering the new owner.
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
            approval_metadata = extract_approval_metadata(response)
            if approval_metadata["action_type"] == "mcp_mutation":
                pending_id = approval_metadata.get("approval_request_id") or ""
                get_pending = getattr(store, "get_pending_approval", None)
                pending = (
                    get_pending(user_id, pending_id)
                    if callable(get_pending) and pending_id
                    else None
                )
                if not pending:
                    raise ValueError(
                        "MCP confirmation did not reference a valid protected "
                        "pending approval"
                    )
                approval_metadata = {
                    "action": str(pending.get("action") or "").strip(),
                    "action_type": "mcp_mutation",
                    "target": str(pending.get("target") or "").strip(),
                    "risk": "medium",
                    "server_name": str(pending.get("server_name") or "").strip(),
                    "tool_name": str(pending.get("tool_name") or "").strip(),
                    "approval_request_id": pending_id,
                    "arguments_preview": str(
                        pending.get("arguments_preview") or ""
                    ).strip(),
                    "arguments_sha256": str(
                        pending.get("arguments_sha256") or ""
                    ).strip(),
                }
            approval = new_approval(
                run_id=run["id"],
                action=approval_metadata["action"],
                # F-017a: store a brief STRUCTURED summary as the reason, not the
                # raw LLM text, so we do not publish unreviewed model output to
                # Redis / the UI approval banner.
                reason=_approval_reason(approval_metadata),
                action_type=approval_metadata["action_type"],
                target=approval_metadata["target"],
                risk=approval_metadata["risk"],
                server_name=approval_metadata["server_name"],
                tool_name=approval_metadata["tool_name"],
                approval_request_id=approval_metadata.get("approval_request_id", ""),
                arguments_preview=approval_metadata.get("arguments_preview", ""),
                arguments_sha256=approval_metadata["arguments_sha256"],
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
        # Non-MCP approvals retain their existing completion marker. MCP
        # mutations are marked earlier only after consuming the gate's exact
        # success receipt; a plausible model response is never sufficient.
        if approval_key and action_type != "mcp_mutation":
            store.mark_approval_applied(user_id, approval_key)
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
    finally:
        # The overall backend request can fail after the exact MCP call already
        # succeeded (for example during a later LLM turn). Consume any receipt
        # before revoking the token so a retry cannot duplicate that mutation.
        if (
            approval_token
            and approval_key
            and action_type == "mcp_mutation"
            and not mcp_receipt_checked
        ):
            with contextlib.suppress(Exception):
                consume_mcp_success_receipt()
        if approval_token:
            revoke_token = getattr(store, "revoke_approval_token", None)
            if callable(revoke_token):
                with contextlib.suppress(Exception):
                    revoke_token(user_id, approval_token)


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
            f"{MAX_AUTONOMOUS_REQUEST_TIMEOUT_SECONDS} seconds so the "
            f"{DEFAULT_MCP_RECEIPT_TTL_SECONDS}-second MCP execution receipt "
            "retains its recovery margin"
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
                    f"reclaimed {reclaimed} in-flight request(s) "
                    "from a previous worker"
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
