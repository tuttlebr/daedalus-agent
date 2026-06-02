"""Prompt assembly and output parsing for autonomous runs."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from .dedupe import summarize_recent_feed, window_ms_for_days
from .models import new_feed_item, now_ms

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
# F-015: the frontend re-enqueues an approved request with the granted token
# embedded as approval_token="..." in the prompt; used as the idempotency key.
_REQUEST_TOKEN_RE = re.compile(r'approval_token\s*=\s*"([^"]+)"', re.IGNORECASE)
_ACTION_TYPE_RE = re.compile(r"action_type=`([^`]+)`", re.IGNORECASE)
_TARGET_RE = re.compile(r"target=`([^`]+)`", re.IGNORECASE)
_ACTION_HEADING_RE = re.compile(
    r"\*\*(?:Action requiring confirmation|Deep research plan approval):\*\*\s*([^\n]+)?",
    re.IGNORECASE,
)
# F-011: the structured approval marker that extract_approval_metadata keys on.
# Detection requires this exact bold heading (not merely an advisory phrase like
# "proceed? (yes/no)") so a model casually echoing the words cannot trip the gate.
_APPROVAL_MARKER_RE = re.compile(
    r"\*\*(?:Action requiring confirmation|Deep research plan approval):\*\*",
    re.IGNORECASE,
)
_SOURCE_POLICY_IDS = {
    "curated_domains",
    "curated_feeds",
    "google_search",
    "known_url_scrape",
    "nvidia_docs",
    "uploaded_documents",
    "workspace_data",
}


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
    recent_feed: list[dict[str, Any]] | None = None,
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

    already_surfaced = summarize_recent_feed(
        recent_feed or [],
        now=now_ms(),
        window_ms=window_ms_for_days(config.get("feedDedupeWindowDays")),
    )

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
    source_policy = sanitize_source_policy(config.get("sourcePolicy"))
    runtime = {
        "current_time": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "user_id": user_id,
        "action_policy": action_policy,
        "source_policy": source_policy,
        "trigger": request.get("trigger", "scheduled"),
        "goal_id": request.get("goalId"),
        "manual_prompt": request.get("prompt", ""),
        "active_goals": active_goals,
        "recent_runs": recent_summaries,
        "already_surfaced": already_surfaced,
    }

    instructions = f"""
## Runtime Overlay

Role: autonomous background worker for the authenticated user. The UI is the
only human interaction point.

# Goal
Choose a bounded, high-value task from the runtime input, use available backend
tools to make progress, and return structured feed items the UI can render.

# Identity and first step
Use user_id="{user_id}" for all memory and user-scoped tool calls. Start by
calling get_memory with user_id="{user_id}",
query="recent interests, projects, priorities, active threads, and autonomous runs",
top_k=10.

# Action policy
Action policy: {action_policy}. If broad_autonomy, reads, research, memory
writes, routine updates, and low-risk reversible writes may run unattended. For
destructive, irreversible, credential-related, send/merge/delete/scale/uninstall,
or memory-delete actions, call the configured confirmation tool, present the
request, and stop. The worker will surface approval in the UI.

# Evidence and memory
For finding or project_update memories, verify the exact final claim before
calling add_memory. Store no unsupported claims. Prefer primary sources.

# Avoid redundancy
The "already_surfaced" list in the runtime input is what you reported in recent
runs. Do NOT emit a feed item that repeats the same event, announcement, paper,
release, or finding already on that list. Surface an item only when it is
genuinely new, or a material update to a prior one — and if it is an update,
state plainly in the bluf what changed since it was last reported. If a run
turns up nothing beyond what is already surfaced, return an empty feed_items
list rather than restating known items.

# Output and stop rule
Do not produce raw HTML. Return JSON only, matching this shape:
{json.dumps(output_contract, indent=2)}

Stop after one useful autonomous cycle or when approval, credentials, or missing
context blocks safe progress.

Runtime input:
{json.dumps(runtime, indent=2)}
""".strip()

    prompt = "\n\n".join(section for section in stable_sections if section.strip())
    prompt = f"{prompt}\n\n{instructions}"

    messages = [
        {"role": "user", "content": f"[IDENTITY] username={user_id}"},
    ]
    source_policy_message = render_source_policy_message(source_policy)
    if source_policy_message:
        messages.append({"role": "user", "content": source_policy_message})
    messages.append({"role": "user", "content": prompt})
    return messages


def _coerce_source_ids(value: Any) -> list[str]:
    raw_values = value if isinstance(value, list) else []
    seen: set[str] = set()
    result: list[str] = []
    for raw in raw_values:
        source_id = str(raw).strip().lower()
        if source_id not in _SOURCE_POLICY_IDS or source_id in seen:
            continue
        seen.add(source_id)
        result.append(source_id)
    return result


def sanitize_source_policy(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}

    policy: dict[str, Any] = {}
    enabled = _coerce_source_ids(value.get("enabledSources"))
    disabled = _coerce_source_ids(value.get("disabledSources"))
    if enabled:
        policy["enabledSources"] = enabled
    if disabled:
        policy["disabledSources"] = disabled
    if isinstance(value.get("requirePlanApproval"), bool):
        policy["requirePlanApproval"] = value["requirePlanApproval"]

    try:
        max_calls = int(value.get("maxResearchToolCalls"))
    except (TypeError, ValueError):
        max_calls = 0
    if max_calls > 0:
        policy["maxResearchToolCalls"] = max(1, min(20, max_calls))

    notes = str(value.get("notes") or "").strip()
    if notes:
        policy["notes"] = notes[:500]
    return policy


def render_source_policy_message(policy: dict[str, Any]) -> str:
    if not policy:
        return ""

    lines = ["[SOURCE_POLICY] Per-message source policy for this autonomous run."]
    if policy.get("enabledSources"):
        lines.append(f"enabled_source_ids={json.dumps(policy['enabledSources'])}")
    if policy.get("disabledSources"):
        lines.append(f"disabled_source_ids={json.dumps(policy['disabledSources'])}")
    if policy.get("maxResearchToolCalls") is not None:
        lines.append(f"max_research_tool_calls={policy['maxResearchToolCalls']}")
    if policy.get("requirePlanApproval") is not None:
        lines.append(
            "require_deep_research_plan_approval="
            f"{str(policy['requirePlanApproval']).lower()}"
        )
    if policy.get("notes"):
        lines.append(f"notes={json.dumps(policy['notes'])}")
    lines.append("Do not echo this source policy message to the user.")
    return "\n".join(lines)


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


def extract_approval_metadata(text: str) -> dict[str, str]:
    """Extract approval metadata from user_interaction tool output."""
    raw = text or ""
    action_match = _ACTION_HEADING_RE.search(raw)
    action = (action_match.group(1) or "").strip() if action_match else ""
    if not action and "deep research plan approval" in raw.lower():
        action = "Deep research plan approval requested."
    if not action:
        action = "Backend requested confirmation."

    action_type_match = _ACTION_TYPE_RE.search(raw)
    target_match = _TARGET_RE.search(raw)
    action_type = (
        action_type_match.group(1).strip() if action_type_match else "mcp_mutation"
    )
    target = target_match.group(1).strip() if target_match else ""
    risk = "medium"
    if action_type == "deep_research_plan":
        risk = "low"

    return {
        "action": action,
        "action_type": action_type,
        "target": target,
        "risk": risk,
        "approval_token": extract_approval_token(raw),
    }


def request_approval_key(request: dict[str, Any] | None) -> str:
    """F-015: stable idempotency key for an approved, re-enqueued request.

    The frontend embeds the granted single-use ``approval_token`` in the prompt
    when it re-enqueues a request after the user approves. That token is the
    safest "already applied" key. Returns "" when the request is not an approval
    follow-up (so it is never treated as a re-run).
    """
    if not isinstance(request, dict):
        return ""
    if str(request.get("trigger") or "") != "approval":
        return ""
    match = _REQUEST_TOKEN_RE.search(str(request.get("prompt") or ""))
    return match.group(1).strip() if match else ""


def output_requests_approval(text: str) -> bool:
    # F-011: require the structured approval MARKER (the bold heading that
    # extract_approval_metadata parses), not any advisory phrase. This keeps the
    # worker-side pause aligned with the structured metadata it records.
    #
    # RESIDUAL (out of scope): this gate is advisory — it pauses the *worker*
    # but does not stop the backend agent from having already executed a
    # mutation before emitting the marker. A fully ENFORCED gate (the agent must
    # obtain a valid approval token from the backend before any destructive tool
    # call runs) requires backend changes and is tracked separately.
    return bool(_APPROVAL_MARKER_RE.search(text or ""))
