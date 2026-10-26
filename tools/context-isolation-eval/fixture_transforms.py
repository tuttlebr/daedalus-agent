"""Bounded, auditable transforms for synthetic provider evaluation fixtures."""

from __future__ import annotations

import copy
import json
import re
from datetime import datetime, timezone
from typing import Any

RENDERER = "briefing_renderer_tool"
CLOCK = "current_datetime_tool"
DAILY_CLOCK_SECTION = "## Current date and time (trusted backend clock)\n\n"


def _api(api_type: str) -> str:
    if api_type == "responses":
        return "responses"
    if api_type in ("chat", "chat_completions"):
        return "chat"
    raise ValueError("Unsupported provider API type")


def _timestamp(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None
    except ValueError:
        return False


def freeze_clock(body: dict, as_of: str) -> tuple[dict, list[dict]]:
    """Freeze successful clock results by call identity, never matching text."""
    if not isinstance(body, dict) or not _timestamp(as_of):
        raise ValueError(
            "A request object and timezone-aware fixture clock are required"
        )
    result = copy.deepcopy(body)
    records = []
    response_calls = {
        item.get("call_id")
        for item in _items(result.get("input"))
        if isinstance(item, dict)
        and item.get("type") == "function_call"
        and item.get("name") == CLOCK
        and isinstance(item.get("call_id"), str)
    }
    chat_calls = {
        tool.get("id")
        for item in _items(result.get("messages"))
        if isinstance(item, dict) and item.get("role") == "assistant"
        for tool in _items(item.get("tool_calls"))
        if isinstance(tool, dict)
        and tool.get("function", {}).get("name") == CLOCK
        and isinstance(tool.get("id"), str)
    }
    response_skills = {
        item.get("call_id")
        for item in _items(result.get("input"))
        if isinstance(item, dict)
        and item.get("type") == "function_call"
        and item.get("name") == "agent_skills_tool"
        and _daily_skill(item.get("arguments"))
        and isinstance(item.get("call_id"), str)
    }
    chat_skills = {
        tool.get("id")
        for item in _items(result.get("messages"))
        if isinstance(item, dict) and item.get("role") == "assistant"
        for tool in _items(item.get("tool_calls"))
        if isinstance(tool, dict)
        and _object(tool.get("function")).get("name") == "agent_skills_tool"
        and _daily_skill(_object(tool.get("function")).get("arguments"))
        and isinstance(tool.get("id"), str)
    }

    def replace(item, field, identity):
        value = item.get(field)
        if _timestamp(value):
            records.append(
                {
                    "call_id": identity,
                    "field": field,
                    "original_output": value,
                    "frozen_output": as_of,
                }
            )
            item[field] = as_of
        elif isinstance(value, list):
            for index, block in enumerate(value):
                if (
                    isinstance(block, dict)
                    and block.get("type") in ("text", "output_text")
                    and _timestamp(block.get("text"))
                ):
                    records.append(
                        {
                            "call_id": identity,
                            "field": f"{field}/{index}/text",
                            "original_output": block["text"],
                            "frozen_output": as_of,
                        }
                    )
                    block["text"] = as_of

    def replace_skill(item, field, identity):
        value = item.get(field)
        if isinstance(value, str):
            updated, record = _freeze_skill_clock(value, as_of)
            if record is not None:
                item[field] = updated
                records.append(
                    {
                        "call_id": identity,
                        "field": field + "/daily_summary_runtime_clock",
                        **record,
                    }
                )
        elif isinstance(value, list):
            for index, block in enumerate(value):
                if (
                    isinstance(block, dict)
                    and block.get("type") in ("text", "output_text")
                    and isinstance(block.get("text"), str)
                ):
                    updated, record = _freeze_skill_clock(block["text"], as_of)
                    if record is not None:
                        block["text"] = updated
                        records.append(
                            {
                                "call_id": identity,
                                "field": f"{field}/{index}/text/daily_summary_runtime_clock",
                                **record,
                            }
                        )

    for item in _items(result.get("input")):
        if (
            isinstance(item, dict)
            and item.get("type") == "function_call_output"
            and item.get("call_id") in response_calls
        ):
            replace(item, "output", item["call_id"])
        elif (
            isinstance(item, dict)
            and item.get("type") == "function_call_output"
            and item.get("call_id") in response_skills
        ):
            replace_skill(item, "output", item["call_id"])
    for item in _items(result.get("messages")):
        if (
            isinstance(item, dict)
            and item.get("role") == "tool"
            and item.get("tool_call_id") in chat_calls
        ):
            replace(item, "content", item["tool_call_id"])
        elif (
            isinstance(item, dict)
            and item.get("role") == "tool"
            and item.get("tool_call_id") in chat_skills
        ):
            replace_skill(item, "content", item["tool_call_id"])
    return result, records


def _daily_skill(arguments):
    parsed = _json(arguments) if isinstance(arguments, str) else arguments
    return (
        isinstance(parsed, dict)
        and parsed.get("operation") == "load_skill"
        and parsed.get("skill_name") == "daily-summary"
        and parsed.get("resource") in (None, "")
    )


def _freeze_skill_clock(text, as_of):
    if DAILY_CLOCK_SECTION not in text:
        return text, None
    prefix, section = text.rsplit(DAILY_CLOCK_SECTION, 1)
    try:
        clock, end = json.JSONDecoder().raw_decode(section)
    except ValueError:
        return text, None
    suffix = section[end:]
    if (
        not suffix.startswith(
            "\n\n---\n\n## Bundled resource: `references/edition-policy.json`"
        )
        or not isinstance(clock, dict)
        or set(clock) != {"source", "utc", "local", "timezone"}
    ):
        return text, None
    if (
        clock.get("source") != "daily_summary_runtime_clock"
        or not _timestamp(clock.get("utc"))
        or not _timestamp(clock.get("local"))
        or not isinstance(clock.get("timezone"), str)
        or not clock["timezone"]
    ):
        return text, None
    utc = datetime.fromisoformat(clock["utc"].replace("Z", "+00:00"))
    local = datetime.fromisoformat(clock["local"].replace("Z", "+00:00"))
    if utc != local:
        return text, None
    frozen = as_of
    instant = datetime.fromisoformat(as_of.replace("Z", "+00:00"))
    if instant.utcoffset().total_seconds() != 0:
        frozen = instant.astimezone(timezone.utc).isoformat()
    replacement = {
        "source": "daily_summary_runtime_clock",
        "utc": frozen,
        "local": frozen,
        "timezone": "UTC",
    }
    updated = (
        prefix
        + DAILY_CLOCK_SECTION
        + json.dumps(replacement, ensure_ascii=False, indent=2)
        + suffix
    )
    return updated, {"original_output": clock, "frozen_output": replacement}


def _json(value):
    try:
        return json.loads(value)
    except (ValueError, TypeError, UnicodeDecodeError):
        return None


def _object(value):
    return value if isinstance(value, dict) else {}


def _items(value):
    return value if isinstance(value, list) else []


def _fault(arguments, call_id):
    if not isinstance(arguments, str) or not isinstance(call_id, str) or not call_id:
        return None
    parsed = _json(arguments)
    if not isinstance(parsed, dict):
        return None
    faulted = copy.deepcopy(parsed)
    edition = faulted.get("edition")
    target = edition if isinstance(edition, dict) and "format" in edition else faulted
    changed = "format" in target
    if changed:
        del target["format"]
    return {
        "original_arguments": arguments,
        "faulted_arguments": json.dumps(
            faulted, ensure_ascii=False, separators=(",", ":")
        )
        if changed
        else arguments,
        "call_id": call_id,
        "mutated": changed,
    }


def _message_calls(document, api):
    if api == "responses":
        for item in document.get("output", []):
            if isinstance(item, dict) and item.get("type") == "function_call":
                yield item, item.get("name"), item.get("call_id", item.get("id"))
    else:
        for choice in document.get("choices", []):
            for item in choice.get("message", {}).get("tool_calls", []):
                if isinstance(item, dict):
                    yield (
                        item.get("function", {}),
                        item.get("function", {}).get("name"),
                        item.get("id"),
                    )


def _frames(raw):
    """Keep original SSE blocks and separators; decode only complete JSON data."""
    frames = []
    for piece in re.split(rb"(\r?\n\r?\n)", raw):
        if not piece:
            continue
        lines = piece.splitlines(keepends=True)
        data = [
            line[5:].lstrip(b" ").rstrip(b"\r\n")
            for line in lines
            if line.startswith(b"data:")
        ]
        document = _json(b"\n".join(data)) if data else None
        frames.append(
            {
                "raw": piece,
                "lines": lines,
                "document": document if isinstance(document, dict) else None,
            }
        )
    return frames


def _encode_frames(frames, changed):
    output = []
    for index, frame in enumerate(frames):
        if index not in changed:
            output.append(frame["raw"])
            continue
        payload = json.dumps(
            frame["document"], ensure_ascii=False, separators=(",", ":")
        ).encode()
        inserted = False
        for line in frame["lines"]:
            if line.startswith(b"data:"):
                if not inserted:
                    ending = (
                        b"\r\n"
                        if line.endswith(b"\r\n")
                        else b"\n"
                        if line.endswith(b"\n")
                        else b""
                    )
                    output.append(b"data: " + payload + ending)
                    inserted = True
            else:
                output.append(line)
    return b"".join(output)


def _responses_stream(frames):
    calls = []
    by_id, by_index, by_call = {}, {}, {}

    def bind(event, item=None, index=None):
        item = item or {}
        identity = item.get("id", event.get("item_id"))
        position = event.get("output_index", index)
        call_id = item.get("call_id", event.get("call_id"))
        current = by_id.get(identity) or by_call.get(call_id) or by_index.get(position)
        if current is None:
            if identity is None and position is None and call_id is None:
                return None
            current = {
                "name": None,
                "id": None,
                "index": None,
                "call_id": None,
                "arguments": [],
                "deltas": [],
            }
            calls.append(current)
        for field, value, mapping in (
            ("id", identity, by_id),
            ("index", position, by_index),
            ("call_id", call_id, by_call),
        ):
            if value is not None:
                current[field] = value
                mapping[value] = current
        name = item.get("name", event.get("name"))
        if isinstance(name, str):
            current["name"] = name
        arguments = item.get("arguments", event.get("arguments"))
        if isinstance(arguments, str):
            current["arguments"].append(arguments)
        return current

    for frame in frames:
        event = frame["document"]
        if not event:
            continue
        kind = event.get("type", "")
        if (
            kind in ("response.output_item.added", "response.output_item.done")
            and event.get("item", {}).get("type") == "function_call"
        ):
            bind(event, event["item"])
        elif kind in (
            "response.function_call_arguments.delta",
            "response.function_call_arguments.done",
        ):
            current = bind(event)
            if (
                current is not None
                and kind.endswith(".delta")
                and isinstance(event.get("delta"), str)
            ):
                current["deltas"].append(event["delta"])
        for index, item in enumerate(event.get("response", {}).get("output", [])):
            if isinstance(item, dict) and item.get("type") == "function_call":
                bind({}, item, index)

    record, target = None, None
    for current in calls:
        if current["name"] != RENDERER:
            continue
        candidates = [*reversed(current["arguments"]), "".join(current["deltas"])]
        for arguments in candidates:
            record = _fault(arguments, current["call_id"] or current["id"])
            if record is not None:
                target = current
                break
        if record is not None:
            break
    if not record or not record["mutated"]:
        return set(), record

    def matches(event, item=None, index=None):
        item = item or {}
        identity = item.get("id", event.get("item_id"))
        call_id = item.get("call_id", event.get("call_id"))
        if identity is not None and target["id"] is not None:
            return identity == target["id"]
        if call_id is not None and target["call_id"] is not None:
            return call_id == target["call_id"]
        return event.get("output_index", index) == target["index"]

    changed, first_delta = set(), True
    for index, frame in enumerate(frames):
        event = frame["document"]
        if not event:
            continue
        kind = event.get("type", "")
        item = event.get("item", {})
        if (
            kind in ("response.output_item.added", "response.output_item.done")
            and item.get("type") == "function_call"
            and matches(event, item)
        ):
            item["arguments"] = (
                ""
                if kind.endswith(".added") and target["deltas"]
                else record["faulted_arguments"]
            )
            changed.add(index)
        elif kind == "response.function_call_arguments.delta" and matches(event):
            event["delta"] = record["faulted_arguments"] if first_delta else ""
            first_delta = False
            changed.add(index)
        elif kind == "response.function_call_arguments.done" and matches(event):
            event["arguments"] = record["faulted_arguments"]
            changed.add(index)
        for position, output in enumerate(event.get("response", {}).get("output", [])):
            if (
                isinstance(output, dict)
                and output.get("type") == "function_call"
                and matches({}, output, position)
            ):
                output["arguments"] = record["faulted_arguments"]
                changed.add(index)
    return changed, record


def _chat_stream(frames):
    calls = {}
    for frame in frames:
        event = frame["document"] or {}
        for choice in event.get("choices", []):
            for item in choice.get("delta", {}).get("tool_calls", []):
                key = (choice.get("index", 0), item.get("index", 0))
                current = calls.setdefault(
                    key, {"id": None, "name": "", "arguments": []}
                )
                if isinstance(item.get("id"), str):
                    current["id"] = item["id"]
                function = item.get("function", {})
                if isinstance(function.get("name"), str):
                    current["name"] += function["name"]
                if isinstance(function.get("arguments"), str):
                    current["arguments"].append(function["arguments"])
            for position, item in enumerate(
                choice.get("message", {}).get("tool_calls", [])
            ):
                key = (choice.get("index", 0), item.get("index", position))
                current = calls.setdefault(
                    key, {"id": None, "name": "", "arguments": []}
                )
                function = item.get("function", {})
                current["id"] = item.get("id", current["id"])
                current["name"] = function.get("name", current["name"])
                if isinstance(function.get("arguments"), str):
                    current["complete_arguments"] = function["arguments"]
    record, target = None, None
    for key, current in calls.items():
        if current["name"] == RENDERER:
            record = _fault(
                current.get("complete_arguments", "".join(current["arguments"])),
                current["id"],
            )
            if record is not None:
                target = key
                break
    if not record or not record["mutated"]:
        return set(), record
    changed, first_delta = set(), True
    for index, frame in enumerate(frames):
        event = frame["document"] or {}
        for choice in event.get("choices", []):
            for item in choice.get("delta", {}).get("tool_calls", []):
                if (
                    choice.get("index", 0),
                    item.get("index", 0),
                ) == target and "arguments" in item.get("function", {}):
                    item["function"]["arguments"] = (
                        record["faulted_arguments"] if first_delta else ""
                    )
                    first_delta = False
                    changed.add(index)
            for item in choice.get("message", {}).get("tool_calls", []):
                if item.get("id") == record["call_id"]:
                    item["function"]["arguments"] = record["faulted_arguments"]
                    changed.add(index)
    return changed, record


def _mutate(raw, api):
    document = _json(raw)
    if isinstance(document, dict):
        for function, name, call_id in _message_calls(document, api):
            if name != RENDERER:
                continue
            record = _fault(function.get("arguments"), call_id)
            if record is None:
                continue
            if not record["mutated"]:
                return raw, record
            function["arguments"] = record["faulted_arguments"]
            return json.dumps(
                document, ensure_ascii=False, separators=(",", ":")
            ).encode(), record
        return raw, None
    frames = _frames(raw)
    changed, record = (
        _responses_stream(frames) if api == "responses" else _chat_stream(frames)
    )
    return (_encode_frames(frames, changed) if changed else raw), record


def mutate_renderer_response(raw: bytes, api_type: str) -> tuple[bytes, dict | None]:
    """Remove one renderer format field while keeping streaming arguments coherent.

    Malformed provider envelopes remain malformed and untouched. Fault injection
    must not turn an unrelated provider failure into a repaired response.
    """
    api = _api(api_type)
    try:
        return _mutate(raw, api)
    except (AttributeError, KeyError, TypeError):
        return raw, None


UNKNOWN_TERMINAL = "http_success_terminal_unknown"


def _response_terminal(document, streaming):
    response = _object(document.get("response")) if streaming else document
    status = response.get("status")
    kind = document.get("type") if streaming else None
    if not isinstance(kind, str):
        kind = None
    if status is not None and not isinstance(status, str):
        return UNKNOWN_TERMINAL
    hints = {
        "response.completed": "completed",
        "response.incomplete": "incomplete",
        "response.failed": "failed",
        "response.cancelled": "cancelled",
    }
    if status is None:
        status = hints.get(kind)
    reason = _object(response.get("incomplete_details")).get("reason")
    if reason == "content_filter" or status in ("content_filter", "filtered"):
        return "filter"
    if status in ("cancelled", "canceled"):
        return "cancelled"
    if status == "failed":
        return "provider_failed"
    if status == "incomplete":
        return "incomplete"
    if (
        document.get("error") is not None
        or response.get("error") is not None
        or kind == "error"
    ):
        return "provider_error"
    return "completed" if status == "completed" else UNKNOWN_TERMINAL


def _terminal_outcome(documents, api, streaming):
    states = []
    seen, finished = set(), set()
    chat_reasons = {
        "stop": "completed",
        "tool_calls": "completed",
        "function_call": "completed",
        "length": "incomplete",
        "content_filter": "filter",
        "cancelled": "cancelled",
        "canceled": "cancelled",
        "error": "provider_failed",
    }
    for document in documents:
        if api == "responses":
            state = _response_terminal(document, streaming)
            if state != UNKNOWN_TERMINAL:
                states.append(state)
        else:
            if document.get("error") is not None:
                states.append("provider_error")
            for position, choice in enumerate(_items(document.get("choices"))):
                if not isinstance(choice, dict):
                    states.append(UNKNOWN_TERMINAL)
                    continue
                identity = choice.get("index", position)
                if type(identity) is not int:
                    states.append(UNKNOWN_TERMINAL)
                    identity = position
                seen.add(identity)
                reason = choice.get("finish_reason")
                if reason is not None:
                    finished.add(identity)
                    states.append(
                        chat_reasons.get(reason, UNKNOWN_TERMINAL)
                        if isinstance(reason, str)
                        else UNKNOWN_TERMINAL
                    )
    if seen - finished:
        states.append(UNKNOWN_TERMINAL)
    priority = {
        "completed": 0,
        UNKNOWN_TERMINAL: 1,
        "incomplete": 2,
        "filter": 3,
        "cancelled": 4,
        "provider_failed": 5,
        "provider_error": 6,
    }
    return max(states, key=priority.__getitem__) if states else UNKNOWN_TERMINAL


def usage_from_response(raw: bytes, api_type: str) -> dict:
    """Read reported usage; absent, malformed and total-only counts stay unknown."""
    api = _api(api_type)
    parsed = _json(raw)
    streaming = not isinstance(parsed, dict)
    documents = (
        [frame["document"] for frame in _frames(raw) if frame["document"]]
        if streaming
        else [parsed]
    )
    versions, usage = [], {}
    for document in documents:
        response = _object(document.get("response"))
        for model in (document.get("model"), response.get("model")):
            if isinstance(model, str) and model and model not in versions:
                versions.append(model)
        candidate = (
            response.get("usage")
            if api == "responses" and streaming
            else document.get("usage")
        )
        if (
            api == "responses"
            and streaming
            and _response_terminal(document, True) == UNKNOWN_TERMINAL
        ):
            continue
        if api == "responses" and streaming and candidate is None:
            candidate = document.get("usage")
        if isinstance(candidate, dict):
            usage = candidate
        elif api == "responses" and streaming:
            usage = {}

    def count(*values):
        return next(
            (value for value in values if type(value) is int and value >= 0), None
        )

    input_details = _object(usage.get("input_tokens_details"))
    prompt_details = _object(usage.get("prompt_tokens_details"))
    return {
        "terminal_outcome": _terminal_outcome(documents, api, streaming),
        "usage": {
            "input_tokens": count(
                usage.get("input_tokens"), usage.get("prompt_tokens")
            ),
            "output_tokens": count(
                usage.get("output_tokens"), usage.get("completion_tokens")
            ),
            "cached_input_tokens": count(
                input_details.get("cached_tokens"), prompt_details.get("cached_tokens")
            ),
        },
        "model_versions": versions,
    }
