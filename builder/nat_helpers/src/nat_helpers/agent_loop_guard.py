"""Request-scoped leaf-tool state and explicit failure classification.

The Rust agent loop owns run accounting and the repeated-failure guard. Python
classifies each leaf result for that guard and keeps the state its tools share
within one invocation.
"""

from __future__ import annotations

import asyncio
import json
from collections import Counter
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from nat_helpers.approval_context import approval_marker_scope


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(
            b["text"]
            for b in value
            if isinstance(b, dict)
            and b.get("type") in {"text", "output_text"}
            and isinstance(b.get("text"), str)
        )
    return ""


@dataclass
class Outcome:
    comparable: Any
    failed: bool = False


def tool_outcome(content: Any, *, status: str | None = None) -> Outcome:
    """Read explicit failures without judging whether the task is repaired.

    Successful polling, changed commands, and truncated previews are not
    evidence of a stuck agent. Sandbox request IDs and timings are excluded
    only so an unchanged failed command can be recognized.
    """
    text = _text(content)
    outcome = Outcome(text, failed=status == "error")
    payload: Any = None
    if text.startswith("## Sandbox Execution Result\n"):
        fields = dict(line.split(": ", 1) for line in text.splitlines() if ": " in line)
        try:
            stdout = json.loads(fields["stdout (JSON string)"])
            stderr = json.loads(fields["stderr (JSON string)"])
            code = int(fields["Exit code"])
            collected = [
                line
                for line in text.splitlines()
                if line.startswith(
                    ("content (UTF-8 JSON string):", "content (base64 JSON string):")
                )
            ]
            timed_out = fields.get("Timed out") == "True"
            outcome.comparable = [code, timed_out, stdout, stderr, collected]
            outcome.failed |= code != 0 or timed_out
            payload = json.loads(stdout)
        except (ValueError, KeyError, TypeError):
            pass
    else:
        try:
            payload = json.loads(text)
        except (ValueError, TypeError):
            pass
    if isinstance(payload, dict):
        outcome.failed |= (
            payload.get("passed") is False
            or payload.get("success") is False
            or payload.get("isError") is True
            or payload.get("status") in ("error", "failed")
            or bool(payload.get("error"))
        )
    elif text.startswith("Error:"):
        outcome.failed = True
    return outcome


@dataclass
class AgentRun:
    terminal_content: str | None = None
    terminal_reason: str | None = None
    attempts: Counter = field(default_factory=Counter)
    artifact_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # Only sanitized non-retryable MCP read failures, keyed by exact-call hash.
    # The ContextVar lifetime prevents reuse across requests or identities.
    nonretryable_mcp_results: dict[str, str] = field(default_factory=dict)
    # Bounded operational labels only; no edition content or source identifiers.
    briefing_execution: dict[str, str | None] = field(default_factory=dict)


_CURRENT_RUN: ContextVar[AgentRun | None] = ContextVar(
    "daedalus_agent_run", default=None
)


def current_agent_run() -> AgentRun | None:
    return _CURRENT_RUN.get()


@contextmanager
def agent_run_scope(*, run: AgentRun | None = None):
    run = run or AgentRun()
    token = _CURRENT_RUN.set(run)
    try:
        with approval_marker_scope():
            yield run
    finally:
        _CURRENT_RUN.reset(token)
