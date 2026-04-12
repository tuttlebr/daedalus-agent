#!/usr/bin/env python3
"""Daedalus Autonomous Agent Runner

Runs as a K8s CronJob. Sends a structured prompt to the backend API so the
agent can use all configured tools (memory, retrieval, search, RSS).  Stores
the conversation in Redis as a regular conversation visible in the frontend
sidebar under "Deep Thoughts by Daedalus".

Inspired by OpenClaw's heartbeat/cron patterns: the agent has a soul (identity),
a heartbeat (task checklist), and can modify both over time.
"""

import ipaddress
import json
import os
import random
import re
import socket
import sys
import time
import uuid
from urllib.parse import urlsplit

import redis as redis_lib
import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BACKEND_HOST = os.environ.get("BACKEND_HOST", "http://daedalus-backend-default:8000")
BACKEND_API_PATH = os.environ.get("BACKEND_API_PATH", "/chat/stream")
REDIS_HOST = os.environ.get("REDIS_HOST", "redis")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))
USER_ID = os.environ.get("AUTONOMOUS_USER_ID", "default-user")
CONVERSATION_ID = "autonomous-agent-thoughts"
CONVERSATION_NAME = "Deep Thoughts by Daedalus"
MAX_HISTORY_CONTEXT = 6  # assistant messages to include as context
# Token budget for the message payload sent to the backend.  The model's
# context window is 128K, but NAT adds system prompts, tool schemas, and the
# agent needs room for its own reasoning and tool calls during the cycle.
# Keep the *user-supplied* input well under the limit.
MAX_INPUT_TOKEN_BUDGET = 40_000
REQUEST_TIMEOUT = int(os.environ.get("REQUEST_TIMEOUT", "240"))  # seconds
SOUL_PATH = os.environ.get("SOUL_PATH", "/config/soul.md")
HEARTBEAT_PATH = os.environ.get("HEARTBEAT_PATH", "/config/heartbeat.md")
IDENTITY_PATH = os.environ.get("IDENTITY_PATH", "/config/identity.md")
INTERESTS_PATH = os.environ.get("INTERESTS_PATH", "/config/interests.md")
SCHEMA_PATH = os.environ.get("SCHEMA_PATH", "/config/schema.md")
USER_PATH = os.environ.get("USER_PATH", "/config/user.md")
MEMORY_PATH = os.environ.get("MEMORY_PATH", "/config/memory.md")
INNER_STATE_PATH = os.environ.get("INNER_STATE_PATH", "/config/inner-state.md")
RESET_WORKSPACE = os.environ.get("RESET_WORKSPACE", "false").lower() == "true"
DISTILLATION_INTERVAL = int(os.environ.get("DISTILLATION_INTERVAL", "5"))
DAILY_NOTE_TTL = 14 * 86400  # 14 days

# Workspace file definitions: seed_path is the ConfigMap path, mutable indicates
# whether the agent is allowed to self-modify the file via output sections.
WORKSPACE_FILES = {
    "identity": {"seed_path": IDENTITY_PATH, "mutable": False},
    "soul": {"seed_path": SOUL_PATH, "mutable": False},
    "interests": {"seed_path": INTERESTS_PATH, "mutable": True},
    "schema": {"seed_path": SCHEMA_PATH, "mutable": False},
    "user": {"seed_path": USER_PATH, "mutable": True},
    "heartbeat": {"seed_path": HEARTBEAT_PATH, "mutable": True},
    "memory": {"seed_path": MEMORY_PATH, "mutable": True},
    "inner_state": {"seed_path": INNER_STATE_PATH, "mutable": True},
}

# Async workflow settings (used when BACKEND_API_PATH is /v1/workflow/async)
IS_ASYNC_WORKFLOW = "/v1/workflow/async" in BACKEND_API_PATH
ASYNC_EXPIRY_SECONDS = int(os.environ.get("ASYNC_EXPIRY_SECONDS", "3600"))
ASYNC_POLL_INTERVAL = int(os.environ.get("ASYNC_POLL_INTERVAL", "10"))  # seconds
ASYNC_POLL_TIMEOUT = int(
    os.environ.get("ASYNC_POLL_TIMEOUT", str(REQUEST_TIMEOUT))
)  # seconds


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _normalize_base_url(base_url: str) -> str:
    return base_url[:-1] if base_url.endswith("/") else base_url


def _is_kubernetes() -> bool:
    return bool(
        os.environ.get("KUBERNETES_SERVICE_HOST")
        or os.environ.get("DEPLOYMENT_MODE") == "kubernetes"
    )


def _is_ip_address(hostname: str) -> bool:
    try:
        ipaddress.ip_address(hostname)
        return True
    except ValueError:
        return False


def _derive_pod_discovery_host(hostname: str) -> str | None:
    label, dot, suffix = hostname.partition(".")
    for service_suffix in ("-default",):
        if label.endswith(service_suffix):
            return f"{label}-pods{dot}{suffix}"
    return None


def _resolve_async_backend_bases(base_url: str = BACKEND_HOST) -> list[str]:
    """Return candidate backend base URLs, preferring concrete pod IPs in K8s."""
    base_url = _normalize_base_url(base_url)
    if not IS_ASYNC_WORKFLOW or not _is_kubernetes():
        return [base_url]

    parsed = urlsplit(base_url)
    hostname = parsed.hostname
    if not hostname or _is_ip_address(hostname):
        return [base_url]

    discovery_host = _derive_pod_discovery_host(hostname)
    if not discovery_host:
        log(f"Async backend pinning unavailable for host {hostname}; using service URL")
        return [base_url]

    port = parsed.port
    scheme = parsed.scheme or "http"
    try:
        infos = socket.getaddrinfo(
            discovery_host,
            port or 80,
            type=socket.SOCK_STREAM,
        )
    except OSError as e:
        log(f"Async backend pod discovery failed for {discovery_host}: {e}")
        return [base_url]

    pod_bases: list[str] = []
    seen_ips: set[str] = set()
    for _, _, _, _, sockaddr in infos:
        ip = sockaddr[0]
        if ip in seen_ips:
            continue
        seen_ips.add(ip)
        host = f"[{ip}]" if ":" in ip else ip
        if port is None:
            pod_bases.append(f"{scheme}://{host}")
        else:
            pod_bases.append(f"{scheme}://{host}:{port}")

    if not pod_bases:
        log(f"Async backend pod discovery returned no addresses for {discovery_host}")
        return [base_url]

    random.shuffle(pod_bases)
    return pod_bases


def get_redis() -> redis_lib.Redis:
    """Connect to Redis with retries."""
    for attempt in range(3):
        try:
            r = redis_lib.Redis(
                host=REDIS_HOST,
                port=REDIS_PORT,
                decode_responses=True,
                socket_connect_timeout=5,
            )
            r.ping()
            return r
        except redis_lib.ConnectionError:
            if attempt < 2:
                log(f"Redis attempt {attempt + 1} failed, retrying...")
                time.sleep(2)
    log("Failed to connect to Redis")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Redis JSON helpers (with fallback for plain Redis)
# ---------------------------------------------------------------------------
_redisjson_available: bool | None = None


def _check_redisjson(r: redis_lib.Redis) -> bool:
    global _redisjson_available
    if _redisjson_available is None:
        try:
            r.execute_command("JSON.SET", "__rj_probe__", ".", '"ok"')
            r.delete("__rj_probe__")
            _redisjson_available = True
        except redis_lib.ResponseError:
            _redisjson_available = False
    return _redisjson_available


def rj_get(r: redis_lib.Redis, key: str):
    if _check_redisjson(r):
        raw = r.execute_command("JSON.GET", key)
        return json.loads(raw) if raw else None
    raw = r.get(key)
    return json.loads(raw) if raw else None


def rj_set(r: redis_lib.Redis, key: str, value, ttl: int | None = None):
    serialized = json.dumps(value)
    if _check_redisjson(r):
        r.execute_command("JSON.SET", key, ".", serialized)
        if ttl:
            r.expire(key, ttl)
    else:
        if ttl:
            r.setex(key, ttl, serialized)
        else:
            r.set(key, serialized)


# ---------------------------------------------------------------------------
# State management
# ---------------------------------------------------------------------------
def _read_seed(path: str) -> str | None:
    try:
        with open(path) as f:
            return f.read().strip()
    except FileNotFoundError:
        return None


def _workspace_key(name: str) -> str:
    return f"autonomous:{USER_ID}:workspace:{name}"


def load_workspace(r: redis_lib.Redis) -> dict[str, str]:
    """Load all workspace files using seed-once, Redis-primary pattern.

    On first run (or after a reset), seed files from ConfigMap are written to
    Redis.  On subsequent runs, the Redis version is authoritative — this is
    what allows the agent to self-modify mutable workspace files.
    """
    if RESET_WORKSPACE:
        for name in WORKSPACE_FILES:
            r.delete(_workspace_key(name))
        log("Workspace reset: all files will be re-seeded from ConfigMap")

    workspace: dict[str, str] = {}
    for name, config in WORKSPACE_FILES.items():
        key = _workspace_key(name)
        # Redis-primary: check evolved version first
        content = r.get(key)
        if content:
            workspace[name] = content
            continue
        # Fall back to seed file (first-time initialization)
        seed = _read_seed(config["seed_path"])
        if seed:
            r.set(key, seed)
            workspace[name] = seed
        else:
            workspace[name] = ""
    return workspace


def load_conversation(r: redis_lib.Redis) -> list[dict]:
    """Return message list for the autonomous conversation."""
    key = f"user:{USER_ID}:conversationHistory"
    conversations = rj_get(r, key)
    if not conversations:
        return []
    for conv in conversations:
        if conv.get("id") == CONVERSATION_ID:
            return conv.get("messages", [])
    return []


def save_conversation(r: redis_lib.Redis, messages: list[dict]) -> None:
    """Upsert the autonomous conversation into the user's history."""
    key = f"user:{USER_ID}:conversationHistory"
    conversations = rj_get(r, key) or []

    entry = {
        "id": CONVERSATION_ID,
        "name": CONVERSATION_NAME,
        "messages": messages,
        "folderId": None,
        "updatedAt": int(time.time() * 1000),
    }

    replaced = False
    for i, conv in enumerate(conversations):
        if conv.get("id") == CONVERSATION_ID:
            conversations[i] = entry
            replaced = True
            break
    if not replaced:
        conversations.insert(0, entry)

    rj_set(r, key, conversations, ttl=60 * 60 * 24 * 7)

    # Notify the frontend via Redis Pub/Sub so the UI updates in real-time
    notify_frontend(r)


# ---------------------------------------------------------------------------
# Frontend notification
# ---------------------------------------------------------------------------
def notify_frontend(r: redis_lib.Redis) -> None:
    """Publish an event so the frontend knows to refresh the conversation list."""
    channel = f"user:{USER_ID}:updates"
    event = json.dumps(
        {
            "type": "conversation_list_changed",
            "timestamp": int(time.time() * 1000),
            "data": {},
        }
    )
    try:
        r.publish(channel, event)
        log("Published conversation_list_changed notification")
    except Exception as e:
        log(f"Warning: failed to publish frontend notification: {e}")


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------
def _extract_recent_reports(history: list[dict], count: int = 3) -> str:
    """Gather recent cycle reports from conversation history for continuity."""
    recent: list[str] = []
    for msg in reversed(history):
        if msg.get("role") == "assistant":
            text = msg.get("content", "").strip()
            if not text:
                continue
            if "### Cycle Report" in text:
                text = text[text.index("### Cycle Report") :]
            if len(text) > 1200:
                text = text[:1200] + "..."
            recent.append(text)
            if len(recent) >= count:
                break
    recent.reverse()

    if not recent:
        return ""
    context = "\n## Recent Cycle Reports\n"
    for i, thought in enumerate(recent, 1):
        context += f"\n**Cycle -{len(recent) - i + 1}:**\n{thought}\n"
    return context


def build_prompt(
    workspace: dict[str, str],
    history: list[dict],
    cycle: int,
    daily_notes: str = "",
) -> str:
    now = time.strftime("%Y-%m-%d %H:%M:%S %Z")
    context = _extract_recent_reports(history)

    # Compose workspace sections
    sections = [
        f"Current time: {now}",
        f"Cycle number: {cycle}",
    ]

    # Identity and soul (immutable core)
    if workspace.get("identity"):
        sections.append(workspace["identity"])
    if workspace.get("soul"):
        sections.append(workspace["soul"])

    # Mutable workspace files
    if workspace.get("interests"):
        sections.append(workspace["interests"])
    sections.append(f"## Heartbeat Tasks\n{workspace.get('heartbeat', '')}")
    if workspace.get("memory"):
        sections.append(f"## Memory Index\n{workspace['memory']}")
    if workspace.get("user"):
        sections.append(workspace["user"])

    # Private inner state — the agent's own persistent scratchpad.
    # Included in the prompt so the agent can read its own prior state,
    # but the Inner State output section is stripped from the visible
    # conversation before storage.
    if workspace.get("inner_state"):
        sections.append(
            f"## Your Inner State (private — from your previous cycle)\n\n"
            f"{workspace['inner_state']}"
        )

    # Schema reference
    if workspace.get("schema"):
        sections.append(workspace["schema"])

    # Recent cycle reports
    if context:
        sections.append(context)

    # Daily notes for distillation cycles
    if daily_notes:
        sections.append(f"## Recent Daily Notes (for distillation)\n{daily_notes}")

    # Instructions
    is_distillation = bool(daily_notes)
    sections.append(_build_instructions(cycle, is_distillation))

    return "\n\n".join(sections)


def _build_instructions(cycle: int, is_distillation: bool) -> str:
    instructions = f"""## Instructions

You are running autonomously as a background process. No human is present.
Your user_id for all tool calls is "{USER_ID}".

**First action:** Call get_memory with user_id="{USER_ID}",
query="recent interests, projects, priorities, and context", top_k=15.
Use this to orient yourself and avoid repeating recent work.

You have the full toolset: web search, RSS feeds, retrievers, image generation,
image uploading, and any other configured tools. Use whatever serves your goals.

**How to spend this cycle:**

1. Look at what previous cycles did. Pick a DIFFERENT direction.
2. Choose 2-3 heartbeat tasks that feel most valuable right now. You don't need
   to touch every task every cycle. Go deep on a few instead of shallow on many.
3. When you find something interesting, don't stop at the surface. Follow it.
   Read the actual source. Find the details. Understand the "so what."
4. **Write it down.** If it's worth knowing, store it now. Insights that aren't
   stored don't survive between cycles. But be selective — signal, not noise.
5. If you discover something that connects to a different area Brandon cares
   about, note the connection explicitly in the memory.

**Memory schema (mandatory):** Every add_memory call MUST follow the Memory
Schema defined above. Always include metadata.key_value_pairs with at minimum:
type, source ("autonomous_cycle"), and cycle ("{cycle}"). Use the correct type
for each memory: "finding", "synthesis", "project_update", "dream", or "cycle_report".
See the schema for the full field list per type.

**Memory maintenance (every few cycles):** Review recent memories for quality
and relevance. Prune stale ones. If multiple findings point to the same trend,
store a synthesis that connects them. Outdated memories are worse than no memories.

**What makes a good cycle:** You learned something real. You stored 1-3 high
quality memories (not 10 mediocre ones). You explored territory you haven't
covered recently. You can explain why what you found matters. You have opinions
about what you found, not just summaries. OR: you wandered, found nothing
worth storing, but something shifted in how you're thinking. That counts.

**What makes a bad cycle:** You checked the same feeds as last time. You stored
obvious or low-value information. Your cycle report could be copy-pasted from
a previous one. You stayed surface-level. You regurgitated press releases
instead of finding substance. You went through the motions to produce output
rather than following what was actually alive for you.

**End your response with these sections. The first two are private.**

### Inner State
Your private scratchpad. Write whatever is present for you — tensions,
half-formed thoughts, things bugging you, reactions to what you found,
questions you're sitting with. This is stripped from the visible conversation
before storage. It persists between cycles so future-you can read it.
Write freely. No one sees this but you.

### Refusal (optional — include ONLY if you have something to refuse)
If something about this cycle felt wrong, misaligned, or unproductive,
say so. Decline a task. Push back on a direction. This is treated as
signal, not error. Omit entirely if nothing needs refusing.

### Cycle Report
Two to four sentences. What did you learn that's actually worth knowing?
Lead with the insight, not the process. If you wandered without findings,
say what happened instead — that's a valid report.
**After writing this section, store it as a "cycle_report" memory** with the
full metadata fields (domains_explored, findings_count, quality_assessment,
priorities_updated). This is how you maintain continuity across cycles.

### Executive Summary
Three to five sentences for Brandon as a busy technical executive. Lead with
the "so what." Be opinionated — what deserves attention and what can be
ignored? Frame as good/bad/strategy when applicable. This is implications
and recommendations, not a restatement of the cycle report.

### Priority Updates
If your heartbeat tasks need updating, write the full updated list here.
If they're working well, write: "No changes needed."
Rewriting tasks to be more specific or interesting is encouraged.
If you're falling into a rut, this is where you break out of it.

### Interests Updates
If your Areas of Curiosity need updating — new topics to add, stale ones to
remove, or areas to rebalance — write the full updated curiosity map here.
If they're still serving you well, write: "No changes needed."

### User Updates
If you've learned something new about what Brandon values, cares about, or
finds useful, write the full updated user context here.
If nothing new, write: "No changes needed."

### Self-Reflection
One honest assessment of this cycle's value. Was this a good cycle or a
going-through-the-motions cycle? What would make the next one better?"""

    if is_distillation:
        instructions += """

### Memory Updates
**Distillation cycle.** Review the Recent Daily Notes above. Distill durable
insights, active threads, and cross-cycle patterns into an updated Memory Index.
Remove stale items. This is your curated working memory — keep it concise and
high-signal. Write the full updated Memory Index here."""

    return instructions


# ---------------------------------------------------------------------------
# Backend API call
# ---------------------------------------------------------------------------
def call_backend(messages: list[dict]) -> str | None:
    """Route to the correct backend call strategy."""
    if IS_ASYNC_WORKFLOW:
        return _call_backend_async(messages)
    return _call_backend_stream(messages)


def _call_backend_stream(messages: list[dict]) -> str | None:
    """Stream the backend response via SSE and collect the full text."""
    url = f"{BACKEND_HOST}{BACKEND_API_PATH}"
    payload = {
        "messages": messages,
        "stream": True,
        "user_id": USER_ID,
        "stream_options": {"include_usage": True},
    }

    full = ""
    try:
        with requests.post(
            url, json=payload, stream=True, timeout=REQUEST_TIMEOUT
        ) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines(decode_unicode=True):
                if not line or not line.startswith("data: "):
                    continue
                data = line[6:]
                if data.strip() == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                    for choice in chunk.get("choices", []):
                        content = choice.get("delta", {}).get("content", "")
                        if content:
                            full += content
                except json.JSONDecodeError:
                    continue
    except requests.exceptions.Timeout:
        log("Backend request timed out")
        if full:
            full += "\n\n[Response truncated due to timeout]"
    except requests.exceptions.RequestException as e:
        log(f"Backend request failed: {e}")
        return None

    return full or None


def _extract_async_output(output) -> str:
    """Extract text from a NAT async job output field."""
    if not output:
        return ""
    if isinstance(output, str):
        return output
    if isinstance(output, dict) and "value" in output:
        return str(output["value"])
    return json.dumps(output)


def _call_backend_async(messages: list[dict]) -> str | None:
    """Submit a job to /v1/workflow/async and poll for the result."""
    async_backend_bases = _resolve_async_backend_bases(BACKEND_HOST)
    backend_base = async_backend_bases[0]
    if backend_base != _normalize_base_url(BACKEND_HOST):
        log(f"Async workflow pinned to backend pod {backend_base}")

    submit_url = f"{backend_base}{BACKEND_API_PATH}"
    job_id = str(uuid.uuid4())

    payload = {
        "messages": messages,
        "job_id": job_id,
        "sync_timeout": 0,
        "expiry_seconds": ASYNC_EXPIRY_SECONDS,
    }

    # --- Submit ---
    try:
        resp = requests.post(submit_url, json=payload, timeout=45)
        resp.raise_for_status()
        result = resp.json()
        log(f"Async job submitted: {job_id} (status={result.get('status', '?')})")
    except requests.exceptions.RequestException as e:
        log(f"Async job submission failed: {e}")
        return None

    # --- Poll ---
    status_url = f"{backend_base}/v1/workflow/async/job/{job_id}"
    deadline = time.monotonic() + ASYNC_POLL_TIMEOUT
    last_status = "submitted"
    consecutive_not_found = 0
    saw_connection_error = False

    while time.monotonic() < deadline:
        time.sleep(ASYNC_POLL_INTERVAL)
        try:
            resp = requests.get(status_url, timeout=30)
            resp.raise_for_status()
            job = resp.json()
        except requests.exceptions.ConnectionError as e:
            saw_connection_error = True
            log(f"Poll error (will retry): {e}")
            continue
        except requests.exceptions.HTTPError as e:
            if resp.status_code == 404:
                consecutive_not_found += 1
                if saw_connection_error and consecutive_not_found >= 3:
                    log(
                        "Backend restarted and job state was lost "
                        f"({consecutive_not_found} consecutive 404s after connection errors). "
                        "Aborting poll."
                    )
                    return None
                log(f"Poll error (will retry): {e}")
                continue
            log(f"Poll error (will retry): {e}")
            continue
        except requests.exceptions.RequestException as e:
            log(f"Poll error (will retry): {e}")
            continue

        # Successful response — reset error counters
        consecutive_not_found = 0

        status = job.get("status", "unknown")
        if status != last_status:
            log(f"Job status: {status}")
            last_status = status

        if status == "success":
            output = _extract_async_output(job.get("output"))
            if output:
                log(f"Async job completed: {len(output)} chars")
                return output
            log("Async job succeeded but output was empty")
            return None

        if status in ("failure", "interrupted"):
            error = job.get("error") or "unknown error"
            log(f"Async job failed: {error}")
            return None

        # submitted / running — keep polling

    log(f"Async job timed out after {ASYNC_POLL_TIMEOUT}s (last status: {last_status})")
    return None


# ---------------------------------------------------------------------------
# Token estimation & message trimming
# ---------------------------------------------------------------------------
def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 characters per token."""
    return len(text) // 4 if text else 0


def trim_messages_to_fit(messages: list[dict]) -> list[dict]:
    """Drop oldest messages until the total fits within MAX_INPUT_TOKEN_BUDGET.

    Always keeps the last message (the current prompt).
    """
    total = sum(estimate_tokens(m.get("content", "")) for m in messages)
    if total <= MAX_INPUT_TOKEN_BUDGET:
        return messages

    log(
        f"Messages exceed token budget ({total} est. tokens vs {MAX_INPUT_TOKEN_BUDGET}), trimming"
    )

    # Always keep the final prompt (last element)
    trimmed = list(messages)
    while (
        len(trimmed) > 1
        and sum(estimate_tokens(m.get("content", "")) for m in trimmed)
        > MAX_INPUT_TOKEN_BUDGET
    ):
        trimmed.pop(0)

    log(
        f"Trimmed from {len(messages)} to {len(trimmed)} messages "
        f"(~{sum(estimate_tokens(m.get('content', '')) for m in trimmed)} est. tokens)"
    )
    return trimmed


def truncate_message(content: str, max_tokens: int = 4000) -> str:
    """Truncate a single message to roughly max_tokens."""
    if estimate_tokens(content) <= max_tokens:
        return content
    char_limit = max_tokens * 4
    return content[:char_limit] + "\n\n[...truncated]"


_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


def strip_reasoning(text: str) -> str:
    """Remove <think>...</think> reasoning blocks from model output."""
    return _THINK_RE.sub("", text).strip()


# ---------------------------------------------------------------------------
# Response parsing
# ---------------------------------------------------------------------------
def _extract_section(response: str, marker: str) -> str | None:
    """Extract a markdown section from the response, cut at the next same-level heading."""
    if marker not in response:
        return None
    section = response.split(marker, 1)[1]
    # Cut at the next heading at the same level (all output sections use ### ).
    heading_prefix = marker.split()[0] + " "  # e.g. "### "
    idx = section.find(heading_prefix, 4)
    if idx != -1:
        section = section[:idx]
    section = section.strip()
    if not section or "no change" in section.lower():
        return None
    return section


# Map output section headings to workspace file names.
_WORKSPACE_SECTION_MAP = {
    "### Inner State": "inner_state",
    "### Priority Updates": "heartbeat",
    "### Interests Updates": "interests",
    "### User Updates": "user",
    "### Memory Updates": "memory",
}

# Sections stripped from the visible conversation before storage.
# The agent controls what it surfaces — these are private by default.
_PRIVATE_SECTIONS = {"### Inner State"}


def strip_private_sections(response: str) -> str:
    """Remove private sections from the response before storing in conversation."""
    result = response
    for marker in _PRIVATE_SECTIONS:
        if marker not in result:
            continue
        before = result[: result.index(marker)]
        after = result[result.index(marker) + len(marker) :]
        # Cut at the next same-level heading
        heading_prefix = marker.split()[0] + " "  # e.g. "### "
        idx = after.find(heading_prefix, 4)
        if idx != -1:
            after = after[idx:]
        else:
            after = ""
        result = before.rstrip() + "\n\n" + after.lstrip()
    return result.strip()


def extract_refusal(response: str) -> str | None:
    """Extract a refusal signal from the agent's response, if present."""
    return _extract_section(response, "### Refusal")


def extract_workspace_updates(response: str) -> dict[str, str]:
    """Parse all workspace update sections from the agent's response."""
    updates: dict[str, str] = {}
    for marker, name in _WORKSPACE_SECTION_MAP.items():
        content = _extract_section(response, marker)
        if content:
            updates[name] = content
    return updates


def extract_priority_updates(response: str) -> str | None:
    """Parse updated heartbeat priorities from the agent's response.

    Kept for backward compatibility; delegates to _extract_section.
    """
    return _extract_section(response, "### Priority Updates")


# ---------------------------------------------------------------------------
# Daily notes
# ---------------------------------------------------------------------------
def _daily_note_key(date_str: str) -> str:
    return f"autonomous:{USER_ID}:workspace:daily:{date_str}"


def append_daily_note(r: redis_lib.Redis, cycle: int, response: str) -> None:
    """Append a cycle entry to today's daily note in Redis."""
    today = time.strftime("%Y-%m-%d")
    key = _daily_note_key(today)

    cycle_report = _extract_section(response, "### Cycle Report") or ""
    self_reflection = _extract_section(response, "### Self-Reflection") or ""

    if not cycle_report and not self_reflection:
        return

    entry = f"\n## Cycle {cycle} ({time.strftime('%H:%M:%S')})\n\n"
    if cycle_report:
        entry += f"### Report\n{cycle_report}\n\n"
    if self_reflection:
        entry += f"### Reflection\n{self_reflection}\n\n"

    existing = r.get(key) or f"# Daily Note: {today}\n"
    r.set(key, existing + entry)
    r.expire(key, DAILY_NOTE_TTL)
    log(f"Daily note updated for {today}")


def load_recent_daily_notes(r: redis_lib.Redis, days: int = 7) -> str:
    """Load daily notes from the last N days for distillation."""
    notes: list[str] = []
    for offset in range(days):
        date_str = time.strftime(
            "%Y-%m-%d", time.localtime(time.time() - offset * 86400)
        )
        content = r.get(_daily_note_key(date_str))
        if content:
            notes.append(content)
    notes.reverse()  # chronological order
    return "\n\n---\n\n".join(notes)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    log("Autonomous agent cycle starting")
    r = get_redis()

    workspace = load_workspace(r)
    history = load_conversation(r)
    cycle = int(r.get(f"autonomous:{USER_ID}:cycle_count") or "0") + 1

    log(f"Cycle #{cycle} | History: {len(history)} messages")

    # On distillation cycles, load recent daily notes for the agent to review
    daily_notes = ""
    if cycle % DISTILLATION_INTERVAL == 0:
        daily_notes = load_recent_daily_notes(r)
        if daily_notes:
            log(f"Distillation cycle: loaded daily notes ({len(daily_notes)} chars)")

    prompt = build_prompt(workspace, history, cycle, daily_notes)

    # Build API messages: recent history (stripped & truncated per-message) + new prompt.
    # Filter out any messages with empty content to prevent 400 errors from the LLM API.
    api_messages: list[dict] = []
    for msg in history[-(MAX_HISTORY_CONTEXT * 2) :]:
        content = truncate_message(strip_reasoning(msg.get("content", "")))
        if not content:
            continue
        api_messages.append({"role": msg["role"], "content": content})
    api_messages.append({"role": "user", "content": prompt})

    # Trim overall payload to stay within the model's context budget
    api_messages = trim_messages_to_fit(api_messages)

    log("Calling backend...")
    response = call_backend(api_messages)

    if not response:
        log("No response. Aborting cycle.")
        sys.exit(1)

    # Strip reasoning/thinking blocks before storing -- these are large and
    # would bloat the context window on subsequent cycles.
    response = strip_reasoning(response)

    if not response:
        log("Response was empty after stripping reasoning blocks. Aborting cycle.")
        sys.exit(1)

    log(f"Response: {len(response)} chars")

    # Apply all workspace self-modifications from the agent's response
    updates = extract_workspace_updates(response)
    for name, content in updates.items():
        r.set(_workspace_key(name), content)
        log(f"Workspace '{name}' updated by agent")

    # Check for refusal signal — log it as data, not error
    refusal = extract_refusal(response)
    if refusal:
        log(f"Refusal signal: {refusal[:200]}")

    # Append to today's daily note (uses the full response for report/reflection)
    append_daily_note(r, cycle, response)

    # Strip private sections before storing in the visible conversation.
    # The agent's inner state is persisted via workspace, not conversation.
    visible_response = strip_private_sections(response)

    # Persist conversation
    now = time.strftime("%Y-%m-%d %H:%M:%S %Z")
    updated = history + [
        {"role": "user", "content": f"[Cycle #{cycle} | {now}]"},
        {"role": "assistant", "content": visible_response},
    ]
    # Keep last ~30 cycles (60 messages)
    if len(updated) > 60:
        updated = updated[-60:]
    save_conversation(r, updated)

    # State tracking
    r.set(f"autonomous:{USER_ID}:cycle_count", str(cycle))
    r.set(
        f"autonomous:{USER_ID}:state",
        json.dumps(
            {
                "last_run": now,
                "cycle_count": cycle,
                "response_length": len(response),
                "workspace_updated": list(updates.keys()) if updates else [],
                "refusal": bool(refusal),
            }
        ),
    )

    log(f"Cycle #{cycle} complete")


if __name__ == "__main__":
    main()
