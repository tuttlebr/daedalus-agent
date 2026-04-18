"""Shared evaluator helpers."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class EvalScore:
    score: float
    passed: bool
    detail: dict[str, Any] = field(default_factory=dict)


def extract_function_output(payload: str) -> str | None:
    """Pull content between the **Function Output:** code fences in a TOOL_END payload."""
    marker = "**Function Output:**"
    idx = payload.rfind(marker)
    if idx == -1:
        return None
    tail = payload[idx + len(marker) :].lstrip()
    if tail.startswith("```"):
        first_nl = tail.find("\n")
        if first_nl == -1:
            return None
        body = tail[first_nl + 1 :]
        end = body.rfind("```")
        if end != -1:
            body = body[:end]
        return body.strip()
    return tail.strip()


def parse_json_blob(payload: str) -> dict | None:
    """Best-effort: pull a JSON object out of a function-output payload."""
    out = extract_function_output(payload)
    if out is None:
        out = payload
    try:
        return json.loads(out)
    except (json.JSONDecodeError, TypeError):
        pass
    match = re.search(r"\{.*\}", out, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def find_tool_event(events, name: str, event_type: str):
    for ev in events:
        if ev.name == name and ev.event_type == event_type:
            return ev
    return None
