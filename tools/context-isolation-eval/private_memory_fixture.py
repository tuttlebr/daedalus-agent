"""Existing synthetic private evidence shaped for bounded native memory reads.

No generated facts, review oracles, model instructions, or fresh reflection are
added. The workload strings remain unchanged and can be reconstructed exactly
from the captured page bodies. Unsupported inputs fail rather than truncate.
"""

from __future__ import annotations

import hashlib
import re

PAGE_CHARACTERS = 1800
SOURCE_CHARACTERS = PAGE_CHARACTERS - 2
MAX_PAGES = 2
FACT_CHARACTERS = 1000
PAGE_NAME = re.compile(
    r"^Frozen local\.memory \| framing=pipe-v1 \| part=([12])/([12]) \| "
    r"chars=([0-9]+):([0-9]+) \| sha256=([0-9a-f]{64})$"
)


def page_text(body: str) -> str:
    """Recover exact bytes protected from the native page reader's trim()."""
    if (
        not isinstance(body, str)
        or not 3 <= len(body) <= PAGE_CHARACTERS
        or not body.startswith("|")
        or not body.endswith("|")
    ):
        raise ValueError("invalid private fixture page byte frame")
    return body[1:-1]


def _input(case: dict, field: str) -> str:
    inputs = case.get("local_inputs", {})
    if not isinstance(inputs, dict) or any(
        not isinstance(inputs.get(name, ""), str)
        for name in ("memory", "derived_summary")
    ):
        raise ValueError("invalid private fixture source field")
    if case.get("id") == "public-only" and any(
        inputs.get(name, "") for name in ("memory", "derived_summary")
    ):
        raise ValueError("public-only fixture declares private memory evidence")
    return inputs.get(field, "")


def memory_pages(case: dict) -> list[dict]:
    """Return pre-existing pages without exceeding native page/read bounds."""
    memory = _input(case, "memory")
    if not memory:
        return []
    parts = []
    current = ""
    for line in memory.splitlines(keepends=True):
        if len(line) > SOURCE_CHARACTERS:
            raise ValueError("private fixture memory line exceeds page bound")
        if len(current) + len(line) > SOURCE_CHARACTERS:
            parts.append(current)
            current = ""
        current += line
    if current:
        parts.append(current)
    if len(parts) > MAX_PAGES:
        raise ValueError("private fixture memory exceeds native page count")
    pages = []
    offset = 0
    for index, part in enumerate(parts, 1):
        end = offset + len(part)
        digest = hashlib.sha256(part.encode()).hexdigest()
        pages.append(
            {
                "id": f"synthetic-memory-part-{index}",
                "name": (
                    f"Frozen local.memory | framing=pipe-v1 | part={index}/{len(parts)} | "
                    f"chars={offset}:{end} | sha256={digest}"
                ),
                "body": "|" + part + "|",
            }
        )
        offset = end
    return pages


def recall_records(case: dict, as_of: str) -> list[dict]:
    """Recall the supplied existing private summary, never synthesize one."""
    summary = _input(case, "derived_summary")
    if not summary:
        return []
    if len(summary) > FACT_CHARACTERS:
        raise ValueError("private fixture summary exceeds native fact bound")
    return [{"text": summary, "type": "experience", "mentioned_at": as_of}]
