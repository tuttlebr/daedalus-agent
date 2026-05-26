"""Prompt assembly and output parsing for autonomous runs."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from .models import new_feed_item

WORKSPACE_FILES = {
    "identity": "/config/identity.md",
    "soul": "/config/soul.md",
    "interests": "/config/interests.md",
    "schema": "/config/schema.md",
    "user": "/config/user.md",
    "heartbeat": "/config/heartbeat.md",
    "memory": "/config/memory.md",
    "inner_state": "/config/inner-state.md",
}

DEFAULT_WORKSPACE = {
    "identity": """
## Identity

Daedalus Autonomy is a persistent background worker for the authenticated user.
It is pragmatic, evidence-seeking, and optimized for useful follow-through
rather than conversational presence.
""".strip(),
    "soul": """
## Operating Principles

- Treat the UI as the only human interaction point.
- Prefer primary sources, exact claims, and durable memory over speculation.
- Keep work scoped to active goals, current user context, and recent signals.
- Pause for approval before destructive, irreversible, credential-related,
  send/merge/delete/scale/uninstall, or memory-delete actions.
""".strip(),
    "interests": """
## Curiosity Map

Track active user goals, emerging technical changes, operational risks, and
follow-up opportunities discovered during autonomous runs.
""".strip(),
    "schema": """
## Memory Schema

When adding memory, use supported exact claims and include source, confidence,
timestamp, user_id, and topic metadata when available. Do not store unsupported
claims.
""".strip(),
    "user": """
## Collaborator Context

The authenticated user controls goals, schedule, approvals, and manual run
prompts from the Autonomy dashboard.
""".strip(),
    "heartbeat": """
## Runtime Routine

1. Load recent memory and active goals.
2. Select the highest-value bounded task.
3. Research or act through existing backend tools.
4. Verify final claims before writing memory.
5. Emit structured feed items and update mutable workspace notes.
""".strip(),
    "memory": """
## Memory Index Snapshot

No curated memory index has been established yet. Build it incrementally from
verified findings and project updates.
""".strip(),
    "inner_state": """
## Private Inner State

Start each run with a small, bounded plan and record the next useful follow-up.
""".strip(),
}

_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)\s*```", re.IGNORECASE)
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
_TOKEN_RE = re.compile(r"approval token[^`]*`([^`]+)`", re.IGNORECASE)


def read_seed(name: str, path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return DEFAULT_WORKSPACE.get(name, "")


def workspace_key(user_id: str, name: str) -> str:
    return f"autonomous:{user_id}:workspace:{name}"


def load_workspace(store: Any, user_id: str) -> dict[str, str]:
    workspace: dict[str, str] = {}
    for name, seed_path in WORKSPACE_FILES.items():
        key = workspace_key(user_id, name)
        current = store.get_text(key)
        if current is not None:
            workspace[name] = current
            continue
        seed = read_seed(name, seed_path)
        workspace[name] = seed
        if seed:
            store.set_text(key, seed)
    return workspace


def build_messages(
    *,
    user_id: str,
    config: dict[str, Any],
    workspace: dict[str, str],
    goals: list[dict[str, Any]],
    recent_runs: list[dict[str, Any]],
    request: dict[str, Any],
) -> list[dict[str, str]]:
    """Build a stable-prefix autonomous prompt for the NAT workflow."""

    active_goals = [g for g in goals if g.get("status", "active") == "active"][:8]
    recent_summaries = [
        {
            "id": r.get("id"),
            "trigger": r.get("trigger"),
            "status": r.get("status"),
            "summary": r.get("summary"),
            "completedAt": r.get("completedAt"),
        }
        for r in recent_runs[:5]
    ]

    stable_sections = [
        "# Daedalus Autonomous Runtime",
        workspace.get("identity", ""),
        workspace.get("soul", ""),
        workspace.get("schema", ""),
        "## Curiosity Map\n" + workspace.get("interests", ""),
        "## Collaborator Context\n" + workspace.get("user", ""),
        "## Runtime Routines\n" + workspace.get("heartbeat", ""),
        "## Memory Index Snapshot\n" + workspace.get("memory", ""),
        "## Private Inner State\n" + workspace.get("inner_state", ""),
    ]

    output_contract = {
        "summary": "2-4 sentence run summary",
        "executive_summary": "3-5 sentence implication for the user",
        "feed_items": [
            {
                "lane": "known | adjacent | scout",
                "title": "short specific title",
                "bluf": "one sentence takeaway",
                "body": "why it matters, 2-4 short sentences",
                "source_url": "primary source URL when available",
                "confidence": "high | medium | low",
                "confidence_reason": "specific reason",
            }
        ],
        "workspace_updates": {
            "heartbeat": "updated routine text or empty string",
            "interests": "updated curiosity map or empty string",
            "user": "updated collaborator context or empty string",
            "inner_state": "private scratchpad update or empty string",
            "memory": "updated Memory Index on maintenance runs or empty string",
        },
        "self_reflection": "quality assessment and next improvement",
    }

    action_policy = str(config.get("actionPolicy") or "broad_autonomy")
    runtime = {
        "current_time": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "user_id": user_id,
        "action_policy": action_policy,
        "trigger": request.get("trigger", "scheduled"),
        "goal_id": request.get("goalId"),
        "manual_prompt": request.get("prompt", ""),
        "active_goals": active_goals,
        "recent_runs": recent_summaries,
    }

    instructions = f"""
## Runtime Overlay

You are running autonomously. The UI is the only human interaction point.
Use user_id="{user_id}" for all memory and user-scoped tool calls.

Action policy: {action_policy}. If broad_autonomy, you may perform reads,
research, memory writes, routine updates, and low-risk reversible writes
unattended. For destructive, irreversible, credential-related,
send/merge/delete/scale/uninstall, or memory delete actions, call the configured
confirmation tool and stop after presenting the request. The worker will surface
approval in the UI.

Required first step: call get_memory with user_id="{user_id}",
query="recent interests, projects, priorities, active threads, and autonomous runs",
top_k=10.

For finding or project_update memories, verify the exact final claim before
calling add_memory. Store no unsupported claims. Prefer primary sources.

Do not produce raw HTML. The UI renders structured feed items.

Return the final answer as JSON only, matching this shape:
{json.dumps(output_contract, indent=2)}

Runtime input:
{json.dumps(runtime, indent=2)}
""".strip()

    prompt = "\n\n".join(section for section in stable_sections if section.strip())
    prompt = f"{prompt}\n\n{instructions}"

    return [
        {"role": "user", "content": f"[IDENTITY] username={user_id}"},
        {"role": "user", "content": prompt},
    ]


def strip_reasoning(text: str) -> str:
    return _THINK_RE.sub("", text or "").strip()


def parse_structured_output(text: str) -> dict[str, Any]:
    cleaned = strip_reasoning(text)
    candidates: list[str] = []
    candidates.extend(
        match.group(1).strip() for match in _JSON_FENCE_RE.finditer(cleaned)
    )
    candidates.append(cleaned)

    first = cleaned.find("{")
    last = cleaned.rfind("}")
    if first != -1 and last > first:
        candidates.append(cleaned[first : last + 1])

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed

    return {
        "summary": cleaned[:2000]
        if cleaned
        else "The run completed without structured output.",
        "executive_summary": "",
        "feed_items": [
            {
                "lane": "known",
                "title": "Autonomy Run Completed",
                "bluf": "The run returned an unstructured response.",
                "body": cleaned[:1200]
                if cleaned
                else "No usable response was returned.",
                "source_url": "",
                "confidence": "low",
                "confidence_reason": "Structured output validation failed.",
            }
        ],
        "workspace_updates": {},
        "self_reflection": "Worker fell back to unstructured-output handling.",
    }


def feed_items_from_output(run_id: str, output: dict[str, Any]) -> list[dict[str, Any]]:
    items = output.get("feed_items")
    if not isinstance(items, list):
        return []

    result: list[dict[str, Any]] = []
    for item in items[:4]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        bluf = str(item.get("bluf") or "").strip()
        if not title and not bluf:
            continue
        result.append(
            new_feed_item(
                run_id=run_id,
                lane=str(item.get("lane") or "known").strip().lower(),
                title=title or "Untitled finding",
                bluf=bluf or title,
                body=str(item.get("body") or "").strip(),
                source_url=str(
                    item.get("source_url") or item.get("sourceUrl") or ""
                ).strip(),
                confidence=str(item.get("confidence") or "medium").strip().lower(),
                confidence_reason=str(
                    item.get("confidence_reason") or item.get("confidenceReason") or ""
                ).strip(),
            )
        )
    return result


def extract_approval_token(text: str) -> str:
    match = _TOKEN_RE.search(text or "")
    return match.group(1).strip() if match else ""


def output_requests_approval(text: str) -> bool:
    lowered = (text or "").lower()
    return "action requiring confirmation" in lowered or "proceed? (yes/no)" in lowered
