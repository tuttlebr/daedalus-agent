"""Provider-neutral budgeting for inbound chat history."""

import json
from typing import Any

_MESSAGE_OVERHEAD_TOKENS = 8
_BYTES_PER_ESTIMATED_TOKEN = 3
_START_ROLES = {"human", "system", "user"}


def _message_payload(message: object) -> object:
    if isinstance(message, dict):
        return message
    model_dump = getattr(message, "model_dump", None)
    if callable(model_dump):
        return model_dump()
    return {
        "role": getattr(message, "type", "unknown"),
        "content": getattr(message, "content", str(message)),
    }


def _estimate_history_tokens(messages: list[object]) -> int:
    """Conservatively estimate tokens from serialized UTF-8 message bytes."""

    total = 0
    for message in messages:
        serialized = json.dumps(
            _message_payload(message),
            ensure_ascii=False,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
        total += (
            _MESSAGE_OVERHEAD_TOKENS
            + (len(serialized) + _BYTES_PER_ESTIMATED_TOKEN - 1)
            // _BYTES_PER_ESTIMATED_TOKEN
        )
    return total


def _message_role(message: dict[str, Any]) -> str:
    return str(message.get("role") or message.get("type") or "").casefold()


def _select_history_payloads(
    messages: list[dict[str, Any]],
    *,
    max_messages: int,
    max_tokens: int,
) -> list[dict[str, Any]]:
    """Keep the newest whole messages within both limits.

    The latest message is always retained intact, even when it alone exceeds
    the estimate, so budgeting never silently removes the current request.
    """

    candidates = messages[-max_messages:]
    if not candidates:
        return []

    selected = [candidates[-1]]
    used_tokens = _estimate_history_tokens(selected)
    for message in reversed(candidates[:-1]):
        message_tokens = _estimate_history_tokens([message])
        if used_tokens + message_tokens > max_tokens:
            break
        selected.append(message)
        used_tokens += message_tokens
    selected.reverse()
    while len(selected) > 1 and _message_role(selected[0]) not in _START_ROLES:
        selected.pop(0)
    return selected
