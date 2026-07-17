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
_ACTION_TYPE_RE = re.compile(r"action_type=`([^`]+)`", re.IGNORECASE)
_TARGET_RE = re.compile(r"target=`([^`]+)`", re.IGNORECASE)
_SERVER_NAME_RE = re.compile(r"server_name=`([^`]+)`", re.IGNORECASE)
_TOOL_NAME_RE = re.compile(r"tool_name=`([^`]+)`", re.IGNORECASE)
_APPROVAL_REQUEST_ID_RE = re.compile(r"approval_request_id=`([^`]+)`", re.IGNORECASE)
_ARGUMENTS_HASH_RE = re.compile(r"arguments_sha256=`([a-f0-9]{64})`", re.IGNORECASE)
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

# Workspace notes are model-authored and persisted between runs, so a bad or
# repetitive update can otherwise grow every subsequent prompt without bound.
# Preserve both ends: headings and durable context tend to live at the start,
# while the newest scratchpad state commonly lives at the end.
_MAX_WORKSPACE_SECTION_CHARS = 2_500
_MAX_RECENT_RUN_FIELD_CHARS = 128
_MAX_RECENT_RUN_SUMMARY_CHARS = 600
_RECENT_FEED_LIMIT = 20
_RECENT_FEED_TITLE_CHARS = 96
_RECENT_FEED_BLUF_CHARS = 140
_RECENT_FEED_SOURCE_CHARS = 80
_RECENT_FEED_THREAD_KEY_CHARS = 96
_TRUNCATION_MARKER = "\n…[truncated]…\n"


def _bounded_text(value: Any, max_chars: int) -> str:
    """Return a stable head/tail digest no longer than ``max_chars``."""

    text = str(value or "").strip()
    if len(text) <= max_chars:
        return text
    if max_chars <= len(_TRUNCATION_MARKER):
        return text[:max_chars]

    remaining = max_chars - len(_TRUNCATION_MARKER)
    head_chars = (remaining + 1) // 2
    tail_chars = remaining - head_chars
    tail = text[-tail_chars:] if tail_chars else ""
    return f"{text[:head_chars]}{_TRUNCATION_MARKER}{tail}"


def _recent_run_digest(run: dict[str, Any]) -> dict[str, Any]:
    completed_at = run.get("completedAt")
    if not isinstance(completed_at, (int, float)):
        completed_at = _bounded_text(completed_at, _MAX_RECENT_RUN_FIELD_CHARS)
    return {
        "id": _bounded_text(run.get("id"), _MAX_RECENT_RUN_FIELD_CHARS),
        "trigger": _bounded_text(run.get("trigger"), _MAX_RECENT_RUN_FIELD_CHARS),
        "status": _bounded_text(run.get("status"), _MAX_RECENT_RUN_FIELD_CHARS),
        "summary": _bounded_text(run.get("summary"), _MAX_RECENT_RUN_SUMMARY_CHARS),
        "completedAt": completed_at,
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

    all_active_goals = [g for g in goals if g.get("status", "active") == "active"]
    active_goals = all_active_goals[:8]
    goal_id = request.get("goalId")
    selected_goal = None
    if goal_id:
        selected_goal = next(
            (goal for goal in goals if goal.get("id") == goal_id),
            None,
        )
    recent_summaries = [
        _recent_run_digest(run) for run in recent_runs[:5] if isinstance(run, dict)
    ]

    already_surfaced = summarize_recent_feed(
        recent_feed or [],
        now=now_ms(),
        window_ms=window_ms_for_days(config.get("feedDedupeWindowDays")),
        limit=_RECENT_FEED_LIMIT,
        title_chars=_RECENT_FEED_TITLE_CHARS,
        bluf_chars=_RECENT_FEED_BLUF_CHARS,
        source_chars=_RECENT_FEED_SOURCE_CHARS,
        thread_key_chars=_RECENT_FEED_THREAD_KEY_CHARS,
    )

    bounded_workspace = {
        name: _bounded_text(workspace.get(name), _MAX_WORKSPACE_SECTION_CHARS)
        for name in WORKSPACE_FILES
    }

    stable_sections = [
        "# Daedalus Autonomous Runtime",
        bounded_workspace["identity"],
        bounded_workspace["soul"],
        bounded_workspace["schema"],
        "## Curiosity Map\n" + bounded_workspace["interests"],
        "## Collaborator Context\n" + bounded_workspace["user"],
        "## Runtime Routines\n" + bounded_workspace["heartbeat"],
        "## Memory Index Snapshot\n" + bounded_workspace["memory"],
        "## Private Inner State\n" + bounded_workspace["inner_state"],
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
                "thread_key": "optional stable source/topic key for updates",
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
        "goal_id": goal_id,
        "manual_prompt": request.get("prompt", ""),
        "active_goals": active_goals,
        "selected_goal": selected_goal,
        "recent_runs": recent_summaries,
        "already_surfaced": already_surfaced,
    }

    instructions = f"""
## Runtime Overlay

Role: autonomous background worker for the authenticated user. The UI is the
only human interaction point.

# Goal
Choose a bounded, high-value task from the runtime input, use available backend
tools to make progress, and return structured feed items the UI can render. If
runtime input includes selected_goal, treat selected_goal as the sole objective
for this run. Do not switch to a different active_goals item; use the rest of
active_goals only as context. The manual_prompt on a goal run is an operator
note, not permission to replace the selected goal.

# Identity and first step
All user-scoped tools derive identity only from the trusted authenticated
request context. Never pass user_id, username, or another identity argument to
a tool. Start by calling get_memory with
query="recent interests, projects, priorities, active threads, and autonomous runs",
top_k=10.

# Action policy
Action policy: {action_policy}. If broad_autonomy, reads, research, memory
writes, routine updates, and low-risk reversible writes may run unattended. For
destructive, irreversible, credential-related, send/merge/delete/scale/uninstall,
or memory-delete actions, call the configured confirmation tool, present the
request, and stop. The worker will surface approval in the UI.

# Evidence and memory
For explicit user profile, preference, or project-context memory writes, call
add_memory directly without confirmation. For finding or project_update
memories, verify the exact final claim before calling add_memory. Store no
unsupported claims. Prefer primary sources.

# Avoid redundancy
The "already_surfaced" list in the runtime input is what you reported in recent
runs, including short BLUF, source, and thread key. Do NOT emit a feed item that
repeats the same event, announcement, paper, release, or finding already on that
list. Surface an item only when it is genuinely new, or a material update to a
prior one — and if it is an update, state plainly in the bluf what changed since
it was last reported and reuse the same thread_key when you know it. If a run
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
                thread_key=str(
                    item.get("thread_key") or item.get("threadKey") or ""
                ).strip(),
                confidence=str(item.get("confidence") or "medium").strip().lower(),
                confidence_reason=str(
                    item.get("confidence_reason") or item.get("confidenceReason") or ""
                ).strip(),
            )
        )
    return result


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
    server_name_match = _SERVER_NAME_RE.search(raw)
    tool_name_match = _TOOL_NAME_RE.search(raw)
    approval_request_id_match = _APPROVAL_REQUEST_ID_RE.search(raw)
    arguments_hash_match = _ARGUMENTS_HASH_RE.search(raw)
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
        "server_name": (
            server_name_match.group(1).strip() if server_name_match else ""
        ),
        "tool_name": tool_name_match.group(1).strip() if tool_name_match else "",
        "approval_request_id": (
            approval_request_id_match.group(1).strip()
            if approval_request_id_match
            else ""
        ),
        "arguments_sha256": (
            arguments_hash_match.group(1).lower() if arguments_hash_match else ""
        ),
    }


def request_approval_key(request: dict[str, Any] | None) -> str:
    """F-015: stable idempotency key for an approved, re-enqueued request.

    The authenticated approval route places the public approval id (never the
    credential) on the private worker queue record. Returns "" for ordinary
    requests so they are never treated as approval replays.
    """
    if not isinstance(request, dict):
        return ""
    if str(request.get("trigger") or "") != "approval":
        return ""
    return str(request.get("approvalId") or "").strip()


def output_requests_approval(text: str) -> bool:
    # F-011: require the structured approval MARKER (the bold heading that
    # extract_approval_metadata parses), not any advisory phrase. This keeps the
    # worker-side pause aligned with the structured metadata it records.
    # The worker pause is paired with the backend MCPToolClient gate: mutation
    # attempts have no credential on this first turn, while the authenticated
    # approval route supplies one exact, single-use credential on resume.
    return bool(_APPROVAL_MARKER_RE.search(text or ""))
