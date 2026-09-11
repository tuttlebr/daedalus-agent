"""Request-scoped progress accounting shared by tools and the agent graph."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import uuid
from collections import Counter, deque
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field


class LoopGuardSettings(BaseModel):
    enabled: bool = True
    window: int = Field(default=24, ge=4, le=128)
    repeated_call_limit: int = Field(default=4, ge=2, le=32)
    repeated_error_limit: int = Field(default=4, ge=2, le=32)
    repair_call_limit: int = Field(default=12, ge=2, le=128)
    final_response_timeout: float = Field(default=30, gt=0, le=120)


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(
            b["text"]
            for b in value
            if isinstance(b, dict) and isinstance(b.get("text"), str)
        )
    return ""


def _digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()


def _error_key(value: Any) -> str:
    # Character offsets, UUIDs and durations should not make the same error new.
    text = str(value)
    text = re.sub(r"\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b", "<id>", text)
    return _digest(re.sub(r"\b\d+\b", "#", text))


@dataclass
class Outcome:
    comparable: Any
    failed: bool = False
    validated: bool = False
    error: str = ""
    sandbox: bool = False


def tool_outcome(content: Any, *, status: str | None = None) -> Outcome:
    """Interpret explicit results, excluding sandbox request metadata.

    A successful inspection command is not proof that a failed artifact was
    repaired. Only an explicit validation pass or a successful rerun of the
    original failed call discharges that repair episode.
    """
    text = _text(content)
    outcome = Outcome(text, failed=status == "error")
    payload: Any = None
    if text.startswith("## Sandbox Execution Result\n"):
        outcome.sandbox = True
        fields = dict(line.split(": ", 1) for line in text.splitlines() if ": " in line)
        try:
            stdout = json.loads(fields["stdout (JSON string)"])
            stderr = json.loads(fields["stderr (JSON string)"])
            code = int(fields["Exit code"])
            collected = [
                line
                for line in text.splitlines()
                if line.startswith(
                    (
                        "content (UTF-8 JSON string):",
                        "content (base64 JSON string):",
                        "Missing files (JSON):",
                    )
                )
            ]
            outcome.comparable = [code, stdout, stderr, collected]
            outcome.failed |= (
                code != 0
                or fields.get("Timed out") == "True"
                or fields.get("Truncated") == "True"
                or any(
                    line.startswith("Collected file ") and "truncated=True" in line
                    for line in text.splitlines()
                )
            )
            outcome.error = _error_key(stderr or stdout) if outcome.failed else ""
            payload = json.loads(stdout)
        except (ValueError, KeyError, TypeError):
            # Plain stdout is normal; do not infer success from exit code alone.
            pass
    else:
        try:
            payload = json.loads(text)
        except (ValueError, TypeError):
            pass
    if isinstance(payload, dict):
        failed = (
            payload.get("passed") is False
            or payload.get("success") is False
            or payload.get("isError") is True
            or payload.get("status") in ("error", "failed")
            or bool(payload.get("error"))
        )
        outcome.failed |= failed
        outcome.validated = not outcome.failed and (
            payload.get("passed") is True or payload.get("success") is True
        )
        if failed:
            outcome.error = _error_key(
                payload.get("errors") or payload.get("error") or payload
            )
    elif text.startswith("Error:"):
        outcome.failed = True
        outcome.error = _error_key(text)
    if outcome.failed and not outcome.error:
        outcome.error = _error_key(outcome.comparable)
    return outcome


@dataclass
class RepairEpisode:
    failed_calls: set[str] = field(default_factory=set)
    calls: int = 0


@dataclass
class AgentRun:
    settings: LoopGuardSettings = field(default_factory=LoopGuardSettings)
    run_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    processed: int = 0
    model_calls: int = 0
    tool_calls: int = 0
    stop_reason: str | None = None
    terminal_content: str | None = None
    terminal_reason: str | None = None
    briefing: bool = False
    attempts: Counter = field(default_factory=Counter)
    pending: dict = field(default_factory=dict)
    recent: deque = field(default_factory=deque)
    repairs: dict[str, RepairEpisode] = field(default_factory=dict)
    artifact_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_messages: list = field(default_factory=list)
    repair_phase: str | None = None
    phase_calls: int = 0
    phase_call_limit: int = 6

    def observe(self, messages: list) -> None:
        """Account only for this invocation's new messages, before compaction."""
        for message in messages[self.processed :]:
            for call in getattr(message, "tool_calls", None) or []:
                self.pending[call["id"]] = call
            if getattr(message, "type", None) != "tool":
                continue
            self.tool_calls += 1
            if self.repair_phase and self.terminal_content is None:
                self.phase_calls += 1
                if self.phase_calls >= self.phase_call_limit:
                    self.stop_reason = self.stop_reason or "repair_budget_exceeded"
            call = self.pending.pop(getattr(message, "tool_call_id", ""), {})
            name = call.get("name") or getattr(message, "name", "") or "unknown"
            args = call.get("args", {})
            if name == "agent_skills_tool" and isinstance(args, dict):
                if (
                    args.get("operation") == "load_skill"
                    and args.get("skill_name") == "daily-summary"
                ):
                    self.briefing = True
            if not self.settings.enabled:
                continue
            result = tool_outcome(
                message.content, status=getattr(message, "status", None)
            )
            call_key = _digest([name, args])
            repeated = _digest([call_key, result.comparable])
            self.recent.append((repeated, name, result.error))
            while len(self.recent) > self.settings.window:
                self.recent.popleft()
            if (
                sum(r[0] == repeated for r in self.recent)
                >= self.settings.repeated_call_limit
            ):
                self.stop_reason = self.stop_reason or "repeated_tool_result"
            if (
                result.failed
                and sum(r[1:] == (name, result.error) for r in self.recent)
                >= self.settings.repeated_error_limit
            ):
                self.stop_reason = self.stop_reason or "repeated_tool_error"

            episode = self.repairs.get(name)
            if episode is not None:
                # Ordinary successful reads can resolve a failed read. Sandbox
                # inspection and file-write success cannot certify a repair.
                resolved = not result.failed and (
                    result.validated
                    or call_key in episode.failed_calls
                    or (not result.sandbox and name != "llm_sandbox_tool")
                )
                if resolved:
                    del self.repairs[name]
                    episode = None
                else:
                    episode.calls += 1
                    if episode.calls >= self.settings.repair_call_limit:
                        self.stop_reason = self.stop_reason or "repair_budget_exceeded"
            if result.failed:
                episode = self.repairs.setdefault(name, RepairEpisode())
                episode.failed_calls.add(call_key)
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
        yield run
    finally:
        _CURRENT_RUN.reset(token)


def briefing_error_response() -> str:
    """A terminal, deterministic error edition, never an unvalidated report."""
    return (
        '```html\n<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        "<title>The Daily Daedalus — Briefing unavailable</title></head><body>"
        "<main><h1>The Daily Daedalus</h1><h2>Briefing unavailable</h2>"
        "<p>I could not validate this edition within the repair budget. "
        "No completed briefing is available for this run.</p></main></body></html>\n```"
    )
