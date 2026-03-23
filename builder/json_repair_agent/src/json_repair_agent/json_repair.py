"""
Lightweight JSON repair for malformed LLM tool-call arguments.

Targets the most common failures produced by weaker models (GLM, Mistral-small, etc.):
  - Missing closing braces / brackets
  - Trailing commas before closing delimiters
  - Unescaped newlines inside string values
"""

import json
import logging
import re

logger = logging.getLogger(__name__)

_TRAILING_COMMA = re.compile(r",\s*([}\]])")


def repair_json_string(raw: str) -> str | None:
    """Attempt to repair a malformed JSON string and return it parsed-then-re-serialised.

    Returns the repaired JSON string on success, or ``None`` if repair is not possible.
    """
    if not raw or not raw.strip():
        return None

    raw = raw.strip()

    if _try_parse(raw) is not None:
        return raw

    repaired = raw

    open_braces = repaired.count("{") - repaired.count("}")
    open_brackets = repaired.count("[") - repaired.count("]")
    if open_braces > 0:
        repaired += "}" * open_braces
    if open_brackets > 0:
        repaired += "]" * open_brackets

    parsed = _try_parse(repaired)
    if parsed is not None:
        return json.dumps(parsed)

    repaired = _TRAILING_COMMA.sub(r"\1", repaired)
    parsed = _try_parse(repaired)
    if parsed is not None:
        return json.dumps(parsed)

    repaired = repaired.replace("\n", "\\n")
    parsed = _try_parse(repaired)
    if parsed is not None:
        return json.dumps(parsed)

    return None


def _try_parse(s: str) -> dict | list | None:
    try:
        return json.loads(s)
    except (json.JSONDecodeError, ValueError):
        return None
