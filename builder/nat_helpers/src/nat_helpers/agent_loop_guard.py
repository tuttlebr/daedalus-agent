"""Request-scoped accounting and a guard for identical consecutive failures."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from collections import Counter
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from nat_helpers.approval_context import approval_marker_scope
from pydantic import BaseModel, Field


class LoopGuardSettings(BaseModel):
    enabled: bool = True
    repeated_error_limit: int = Field(default=4, ge=2, le=32)


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
    settings: LoopGuardSettings = field(default_factory=LoopGuardSettings)
    run_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    started_at: float = field(default_factory=time.monotonic)
    request_profile: str = "default"
    final_synthesis_requested: bool = False
    synthesis_retry_attempted: bool = False
    initial_messages: int = 0
    activity_stream_requested: bool = False
    processed: int = 0
    model_calls: int = 0
    tool_calls: int = 0
    stop_reason: str | None = None
    terminal_content: str | None = None
    terminal_reason: str | None = None
    attempts: Counter = field(default_factory=Counter)
    pending: dict = field(default_factory=dict)
    last_failure: str | None = None
    consecutive_failures: int = 0
    artifact_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_messages: list = field(default_factory=list)

    def observe(self, messages: list) -> None:
        """Count this turn only; a success or changed failure resets the guard."""
        for message in messages[self.processed :]:
            for call in getattr(message, "tool_calls", None) or []:
                self.pending[call["id"]] = call
            if getattr(message, "type", None) != "tool":
                continue
            self.tool_calls += 1
            call = self.pending.pop(getattr(message, "tool_call_id", ""), {})
            result = tool_outcome(
                message.content, status=getattr(message, "status", None)
            )
            if not self.settings.enabled or not result.failed:
                self.last_failure = None
                self.consecutive_failures = 0
                continue
            fingerprint = hashlib.sha256(
                json.dumps(
                    [
                        call.get("name") or getattr(message, "name", ""),
                        call.get("args", {}),
                        result.comparable,
                    ],
                    sort_keys=True,
                    ensure_ascii=False,
                    default=str,
                ).encode()
            ).hexdigest()
            self.consecutive_failures = (
                self.consecutive_failures + 1 if fingerprint == self.last_failure else 1
            )
            self.last_failure = fingerprint
        # Decide after the complete parallel tool batch. A later successful
        # sibling result in the same batch is progress and resets this guard.
        if self.consecutive_failures >= self.settings.repeated_error_limit:
            self.stop_reason = "repeated_tool_error"
        self.processed = len(messages)
        self.last_messages = messages


_CURRENT_RUN: ContextVar[AgentRun | None] = ContextVar(
    "daedalus_agent_run", default=None
)


def current_agent_run() -> AgentRun | None:
    return _CURRENT_RUN.get()


@contextmanager
def agent_run_scope(settings: LoopGuardSettings | None = None):
    run = AgentRun(settings=settings or LoopGuardSettings())
    token = _CURRENT_RUN.set(run)
    try:
        with approval_marker_scope():
            yield run
    finally:
        _CURRENT_RUN.reset(token)
