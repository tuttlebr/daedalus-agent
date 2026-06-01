"""Shared data models for the autonomous worker.

The frontend stores the same JSON shapes in Redis.  These helpers keep the
worker conservative: unknown fields are preserved by callers in dict form, but
new records are created with stable keys and millisecond timestamps.
"""

from __future__ import annotations

import time
import uuid
from typing import Any


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def default_config(user_id: str) -> dict[str, Any]:
    timestamp = now_ms()
    return {
        "enabled": True,
        "userId": user_id,
        "mode": "hybrid",
        "runtime": "dedicated_worker",
        "actionPolicy": "broad_autonomy",
        "intervalSeconds": 14_400,
        "maxRunsStored": 100,
        "maxFeedItems": 200,
        "sourcePolicy": {
            "disabledSources": [],
            "enabledSources": [],
            "maxResearchToolCalls": 6,
            "requirePlanApproval": True,
        },
        "lastScheduledRunAt": None,
        "createdAt": timestamp,
        "updatedAt": timestamp,
    }


def new_run(
    *,
    user_id: str,
    trigger: str,
    goal_id: str | None = None,
    prompt: str = "",
    requested_by: str = "worker",
) -> dict[str, Any]:
    timestamp = now_ms()
    return {
        "id": new_id("run"),
        "userId": user_id,
        "trigger": trigger,
        "goalId": goal_id,
        "prompt": prompt,
        "requestedBy": requested_by,
        "status": "queued",
        "summary": "",
        "error": "",
        "feedItemIds": [],
        "metrics": {},
        "createdAt": timestamp,
        "startedAt": None,
        "completedAt": None,
        "updatedAt": timestamp,
    }


def new_event(
    *,
    run_id: str,
    event_type: str,
    message: str,
    level: str = "info",
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": new_id("evt"),
        "runId": run_id,
        "type": event_type,
        "level": level,
        "message": message,
        "data": data or {},
        "createdAt": now_ms(),
    }


def new_feed_item(
    *,
    run_id: str,
    lane: str,
    title: str,
    bluf: str,
    body: str,
    source_url: str = "",
    confidence: str = "medium",
    confidence_reason: str = "",
) -> dict[str, Any]:
    timestamp = now_ms()
    return {
        "id": new_id("feed"),
        "runId": run_id,
        "lane": lane,
        "title": title,
        "bluf": bluf,
        "body": body,
        "sourceUrl": source_url,
        "confidence": confidence,
        "confidenceReason": confidence_reason,
        "createdAt": timestamp,
    }


def new_approval(
    *,
    run_id: str,
    action: str,
    reason: str,
    action_type: str = "mcp_mutation",
    target: str = "",
    risk: str = "medium",
    approval_token: str = "",
    auth_url: str = "",
    oauth_state: str = "",
) -> dict[str, Any]:
    timestamp = now_ms()
    return {
        "id": new_id("approval"),
        "runId": run_id,
        "status": "pending",
        "action": action,
        "reason": reason,
        "actionType": action_type,
        "target": target,
        "risk": risk,
        "approvalToken": approval_token,
        "authUrl": auth_url,
        "oauthState": oauth_state,
        "createdAt": timestamp,
        "resolvedAt": None,
    }
