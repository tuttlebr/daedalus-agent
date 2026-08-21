"""Provider-neutral normalization for routed Responses API history."""

from __future__ import annotations


def _normalize_responses_replay_items(payload: dict) -> dict:
    """Remove server-owned metadata from replayed Responses items.

    LangChain preserves provider response items when full history is replayed.
    Their ``id`` values belong to the upstream that created them and fail when
    Switchyard routes a later turn to another provider. ``status`` is likewise
    output lifecycle metadata rather than conversation content. Drop both while
    preserving ``call_id``, which links tool calls to their outputs.
    """
    input_items = payload.get("input")
    if not isinstance(input_items, list):
        return payload

    for item in input_items:
        if isinstance(item, dict):
            item.pop("id", None)
            item.pop("status", None)
    return payload
