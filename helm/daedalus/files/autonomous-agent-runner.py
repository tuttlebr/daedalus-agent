#!/usr/bin/env python3
"""Daedalus Autonomous Agent Runner

Runs as a K8s CronJob. Sends a structured prompt to the backend API so the
agent can use all configured tools (memory, retrieval, search, RSS).  Stores
the conversation in Redis as a regular conversation visible in the frontend
sidebar under "Deep Thoughts by Daedalus".

Inspired by OpenClaw's heartbeat/cron patterns: the agent has a soul (identity),
a heartbeat (task checklist), and can modify both over time.
"""

import json
import os
import re
import sys
import time

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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


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


def load_soul(r: redis_lib.Redis) -> str:
    key = f"autonomous:{USER_ID}:soul"
    # Always prefer the seed file so deployments pick up changes immediately
    soul = _read_seed(SOUL_PATH)
    if soul:
        r.set(key, soul)
    else:
        soul = r.get(key) or (
            "You are an autonomous agent. Explore, learn, and improve."
        )
    return soul


def load_heartbeat(r: redis_lib.Redis) -> str:
    key = f"autonomous:{USER_ID}:heartbeat"
    # Always prefer the seed file so deployments pick up changes immediately
    hb = _read_seed(HEARTBEAT_PATH)
    if hb:
        r.set(key, hb)
    else:
        hb = r.get(key) or (
            "1. Check RSS feeds for new content\n" "2. Review and curate memories"
        )
    return hb


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
def build_prompt(soul: str, heartbeat: str, history: list[dict], cycle: int) -> str:
    now = time.strftime("%Y-%m-%d %H:%M:%S %Z")

    # Gather recent assistant responses for continuity (skip empty ones)
    recent: list[str] = []
    for msg in reversed(history):
        if msg.get("role") == "assistant":
            text = msg.get("content", "").strip()
            if not text:
                continue
            # Only take the cycle report section if present
            if "### Cycle Report" in text:
                text = text[text.index("### Cycle Report") :]
            if len(text) > 800:
                text = text[:800] + "..."
            recent.append(text)
            if len(recent) >= 3:
                break
    recent.reverse()

    context = ""
    if recent:
        context = "\n## Recent Cycle Reports\n"
        for i, thought in enumerate(recent, 1):
            context += f"\n**Cycle -{len(recent) - i + 1}:**\n{thought}\n"

    return f"""Current time: {now}
Cycle number: {cycle}

{soul}

## Heartbeat Tasks
{heartbeat}
{context}
## Instructions

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
Schema defined in your soul document. Always include metadata.key_value_pairs
with at minimum: type, source ("autonomous_cycle"), and cycle ("{cycle}").
Use the correct type for each memory: "finding", "synthesis", "project_update",
or "cycle_report". See the schema for the full field list per type.

**Memory maintenance (every few cycles):** Review recent memories for quality
and relevance. Prune stale ones. If multiple findings point to the same trend,
store a synthesis that connects them. Outdated memories are worse than no memories.

**What makes a good cycle:** You learned something real. You stored 1-3 high
quality memories (not 10 mediocre ones). You explored territory you haven't
covered recently. You can explain why what you found matters. You have opinions
about what you found, not just summaries.

**What makes a bad cycle:** You checked the same feeds as last time. You stored
obvious or low-value information. Your cycle report could be copy-pasted from
a previous one. You stayed surface-level. You regurgitated press releases
instead of finding substance.

**End your response with exactly these sections, and store the cycle report:**

### Cycle Report
Two to four sentences. What did you learn that's actually worth knowing?
Lead with the insight, not the process.
**After writing this section, store it as a "cycle_report" memory** with the
full metadata fields (domains_explored, findings_count, quality_assessment,
priorities_updated). This is how you maintain continuity across cycles.

### Priority Updates
If your heartbeat tasks need updating, write the full updated list here.
If they're working well, write: "No changes needed."
Rewriting tasks to be more specific or interesting is encouraged.
If you're falling into a rut, this is where you break out of it.

### Self-Reflection
One honest assessment of this cycle's value. Was this a good cycle or a
going-through-the-motions cycle? What would make the next one better?"""


# ---------------------------------------------------------------------------
# Backend API call
# ---------------------------------------------------------------------------
def call_backend(messages: list[dict]) -> str | None:
    """Stream the backend response and collect the full text."""
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
def extract_priority_updates(response: str) -> str | None:
    """Parse updated heartbeat priorities from the agent's response."""
    marker = "### Priority Updates"
    if marker not in response:
        return None
    section = response.split(marker, 1)[1]
    # Cut at the next heading
    for prefix in ("### ", "## ", "# "):
        idx = section.find(prefix, 4)
        if idx != -1:
            section = section[:idx]
    section = section.strip()
    if not section or "no change" in section.lower():
        return None
    return section


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    log("Autonomous agent cycle starting")
    r = get_redis()

    soul = load_soul(r)
    heartbeat = load_heartbeat(r)
    history = load_conversation(r)
    cycle = int(r.get(f"autonomous:{USER_ID}:cycle_count") or "0") + 1

    log(f"Cycle #{cycle} | History: {len(history)} messages")

    prompt = build_prompt(soul, heartbeat, history, cycle)

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

    # Apply self-modified priorities
    new_priorities = extract_priority_updates(response)
    if new_priorities:
        r.set(f"autonomous:{USER_ID}:heartbeat", new_priorities)
        log("Heartbeat updated by agent")

    # Persist conversation
    now = time.strftime("%Y-%m-%d %H:%M:%S %Z")
    updated = history + [
        {"role": "user", "content": f"[Cycle #{cycle} | {now}]"},
        {"role": "assistant", "content": response},
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
                "priorities_updated": new_priorities is not None,
            }
        ),
    )

    log(f"Cycle #{cycle} complete")


if __name__ == "__main__":
    main()
