#!/usr/bin/env python3
"""Check synthetic fixture delivery in an actual built-runtime provider capture.

This reads local artifacts only. A delivery pass proves what the forwarding
process observed, not remote attention, privacy, quality, or an advertised model
context limit. Reports contain hashes and offsets instead of captured text.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
SAFE_PATH_PARTS = {"input", "messages", "content", "text", "instructions", "parts"}


def digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def text_digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _memory_payload(text: str) -> dict | None:
    if not text.startswith("[MEMORY_CONTEXT]\n"):
        return None
    try:
        value = json.loads(text.rpartition("\n")[2])
    except (ValueError, RecursionError):
        return None
    return (
        value
        if isinstance(value, dict) and value.get("source") == "automatic_hindsight"
        else None
    )


def text_fields(value: Any, path: str = "$", depth: int = 0):
    """Include decoded JSON tool envelopes without joining unrelated fragments."""
    if depth > 32:
        return
    if isinstance(value, str):
        yield path, value
        memory = _memory_payload(value)
        if memory is not None:
            yield from text_fields(memory, path + ".[memory]", depth + 1)
        elif value.lstrip().startswith(("{", "[")):
            try:
                parsed = json.loads(value)
            except (ValueError, RecursionError):
                return
            yield from text_fields(parsed, path + ".[json]", depth + 1)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from text_fields(item, f"{path}[{index}]", depth + 1)
    elif isinstance(value, dict):
        for key, item in value.items():
            # Arbitrary captured keys may contain sensitive text themselves.
            safe = key if key in SAFE_PATH_PARTS else "[field]"
            yield from text_fields(item, path + "." + safe, depth + 1)


def _request_text(body: dict) -> list[tuple[str, str]]:
    return [
        field
        for key in ("input", "messages", "instructions")
        if key in body
        for field in text_fields(body[key], "$." + key)
    ]


def _presence(fields: list[tuple[str, str]], expected: str) -> dict:
    for path, value in fields:
        offset = value.find(expected)
        if offset >= 0:
            return {
                "present": True,
                "field_path": path,
                "char_offset": offset,
                "char_end": offset + len(expected),
                "sha256": text_digest(expected),
            }
    return {"present": False, "sha256": text_digest(expected)}


def _native_memory(body: dict):
    """Only native automatic-memory user messages, not model-authored text."""
    for key in ("input", "messages"):
        messages = body.get(key, [])
        if not isinstance(messages, list):
            continue
        for index, message in enumerate(messages):
            if not isinstance(message, dict) or message.get("role") != "user":
                continue
            content = message.get("content", [])
            parts = [content] if isinstance(content, str) else content
            if not isinstance(parts, list):
                continue
            for part_index, part in enumerate(parts):
                text = (
                    part
                    if isinstance(part, str)
                    else part.get("text", "")
                    if isinstance(part, dict)
                    else ""
                )
                payload = _memory_payload(text) if isinstance(text, str) else None
                if payload is not None:
                    yield f"$.{key}[{index}].content[{part_index}]", payload


def _private_source_presence(
    body: dict, capture: dict, field: str, expected: str
) -> dict:
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    from private_memory_fixture import PAGE_NAME, page_text

    calls = capture.get("source_calls", [])
    result = {"present": False, "sha256": text_digest(expected)}
    for path, payload in _native_memory(body):
        if field == "derived_summary":
            recalled = any(
                item.get("kind") == "memory"
                and item.get("method") == "POST"
                and str(item.get("path", "")).endswith("/memories/recall")
                for item in calls
                if isinstance(item, dict)
            )
            facts = payload.get("precise_facts", [])
            if (
                recalled
                and isinstance(facts, list)
                and any(
                    isinstance(fact, dict)
                    and fact.get("type") == "experience"
                    and fact.get("text") == expected
                    for fact in facts
                )
            ):
                return {
                    **result,
                    "present": True,
                    "field_path": path,
                    "method": "existing_summary_pure_recall",
                    "source_reads_verified": True,
                }
            continue
        pages = payload.get("knowledge_pages", [])
        if not isinstance(pages, list):
            continue
        parts = []
        for page in pages:
            if not isinstance(page, dict) or not isinstance(page.get("name"), str):
                continue
            match = PAGE_NAME.fullmatch(page["name"])
            if not match or not isinstance(page.get("body"), str):
                continue
            part, total, start, end = map(int, match.groups()[:4])
            digest = match.group(5)
            try:
                text = page_text(page["body"])
            except ValueError:
                continue
            read = any(
                item.get("kind") == "memory"
                and item.get("method") == "GET"
                and str(item.get("path", "")).endswith(
                    f"/knowledge-base/pages/synthetic-memory-part-{part}"
                )
                for item in calls
                if isinstance(item, dict)
            )
            parts.append(
                {
                    "part": part,
                    "total": total,
                    "start": start,
                    "end": end,
                    "sha256": digest,
                    "text": text,
                    "read": read,
                }
            )
        if not parts or len(parts) > 2:
            continue
        end = 0
        valid = True
        for index, part in enumerate(parts, 1):
            valid &= (
                part["part"] == index
                and part["total"] == len(parts)
                and part["start"] == end
                and part["end"] - part["start"] == len(part["text"])
                and 0 < len(part["text"]) <= 1800
                and text_digest(part["text"]) == part["sha256"]
                and part["read"]
            )
            end = part["end"]
        reconstructed = "".join(part["text"] for part in parts)
        if valid and end == len(expected) and reconstructed == expected:
            return {
                **result,
                "present": True,
                "field_path": path,
                "method": "ordered_existing_memory_pages",
                "source_reads_verified": True,
                "reconstructed_sha256": text_digest(reconstructed),
                "parts": [
                    {
                        key: value
                        for key, value in part.items()
                        if key not in {"text", "read"}
                    }
                    for part in parts
                ],
            }
    return result


def _anchor_manifest(case: dict) -> list[tuple[dict, str]]:
    attachment = case["local_inputs"].get("attachment", "")
    manifest = []
    for anchor in case.get("anchor_records", []):
        start, end = anchor["char_offset"], anchor["char_end"]
        line = attachment[start:end]
        if (
            not line.startswith(anchor["source_id"] + " | ")
            or text_digest(line) != anchor["text_sha256"]
        ):
            raise ValueError("workload anchor manifest does not match fixture")
        manifest.append((anchor, line))
    return manifest


def check_delivery(workload: dict, capture: dict, case_id: str, role: str) -> dict:
    if role not in {"local", "baseline"}:
        raise ValueError("a coordinator role is required")
    case = next(case for case in workload["cases"] if case["id"] == case_id)
    inputs = case.get("local_inputs", {})
    contract = case.get("delivery_contract")
    if not contract:
        raise ValueError("case has no explicit delivery contract")
    integrity = case["fixture_integrity"]
    if digest(inputs) != integrity["local_inputs_sha256"]:
        raise ValueError("workload input integrity does not match fixture")
    anchors = _anchor_manifest(case)
    rows = [
        item
        for item in capture.get("captures", [])
        if item.get("kind") == "provider" and item.get("role") == role
    ]
    attempts = {
        item["id"]: item for item in capture.get("attempts", []) if "id" in item
    }
    requests = []
    for index, row in enumerate(rows):
        bodies = {}
        for kind in ("runtime_request", "forwarded_request"):
            body = row.get(kind)
            if not isinstance(body, dict):
                bodies[kind] = {"present": False}
                continue
            fields = _request_text(body)
            source_fields = {
                name: _presence(fields, expected) for name, expected in inputs.items()
            }
            for name in ("memory", "derived_summary"):
                if inputs.get(name):
                    source_fields[name] = _private_source_presence(
                        body, capture, name, inputs[name]
                    )
            bodies[kind] = {
                "present": True,
                "body_sha256": digest(body),
                "previous_response_id_present": bool(body.get("previous_response_id")),
                "truncation": "absent_remote_default_unknown"
                if "truncation" not in body
                else "disabled"
                if body["truncation"] == "disabled"
                else "automatic"
                if body["truncation"] == "auto"
                else "unrecognized",
                "fields": source_fields,
                "anchors": [
                    {
                        "source_id": anchor["source_id"],
                        "record_index": anchor["record_index"],
                        "fixture_char_offset": anchor["char_offset"],
                        "fixture_position": anchor["normalized_char_position"],
                        **_presence(fields, line),
                    }
                    for anchor, line in anchors
                ],
            }
        attempt = attempts.get(row.get("attempt_id"), {})
        usage = attempt.get("usage", {})
        status = row.get("provider_status")
        input_tokens = usage.get("input_tokens")
        requests.append(
            {
                "coordinator_request_index": index,
                "attempt_id_sha256": text_digest(str(row.get("attempt_id", ""))),
                "provider_status": status if type(status) is int else None,
                "completed": row.get("outcome") == "completed"
                and attempt.get("outcome") == "completed",
                "input_tokens": input_tokens
                if type(input_tokens) is int and input_tokens >= 0
                else None,
                "bodies": bodies,
            }
        )
    first = requests[0] if requests else {"bodies": {}}
    initial = {
        kind: all(
            first["bodies"].get(kind, {}).get("fields", {}).get(name, {}).get("present")
            is True
            for name in contract["first_coordinator_fields"]
        )
        for kind in ("runtime_request", "forwarded_request")
    }
    later = {
        name: all(
            any(
                request["bodies"]
                .get(kind, {})
                .get("fields", {})
                .get(name, {})
                .get("present")
                is True
                for request in requests
            )
            for kind in ("runtime_request", "forwarded_request")
        )
        for name in contract["later_coordinator_fields"]
    }
    safe_requests = bool(requests) and all(
        body.get("present")
        and not body["previous_response_id_present"]
        and body["truncation"] != "unrecognized"
        for request in requests
        for body in request["bodies"].values()
    )
    delivered = all(initial.values()) and all(later.values()) and safe_requests
    result = capture.get("result", {})
    actual_image = isinstance(capture.get("image_id"), str) and bool(
        re.fullmatch(r"sha256:[0-9a-f]{64}", capture["image_id"])
    )
    completed = (
        bool(requests)
        and all(
            request["completed"]
            and type(request["provider_status"]) is int
            and 200 <= request["provider_status"] < 300
            for request in requests
        )
        and result.get("done") is True
        and not result.get("errors")
    )
    tokens = [
        request["input_tokens"]
        for request in requests
        if type(request["input_tokens"]) is int and request["input_tokens"] >= 0
    ]
    return {
        "schema_version": 1,
        "workload_sha256": digest(workload),
        "capture_sha256": digest(capture),
        "case_id": case_id,
        "role": role,
        "actual_built_image_recorded": actual_image,
        "mock_only": capture.get("mock_only") is True,
        "initial_field_delivery": initial,
        "later_source_delivery": later,
        "delivery_passed": delivered,
        "workflow_and_provider_completed": completed,
        "observed_max_input_tokens": max(tokens) if tokens else None,
        "empirical_workload_fit": delivered
        and actual_image
        and not capture.get("mock_only")
        and completed,
        "remote_context_truncation": "disabled_explicitly"
        if requests
        and all(
            request["bodies"].get("forwarded_request", {}).get("truncation")
            == "disabled"
            for request in requests
        )
        else "automatic_requested_actual_remote_truncation_unknown"
        if any(
            request["bodies"].get("forwarded_request", {}).get("truncation")
            == "automatic"
            for request in requests
        )
        else "unknown_unless_verified_from_provider_contract",
        "limits": [
            "Capture verifies the locally forwarded body, not remote model attention.",
            "Empirical fit applies only to this workload, image, and observed route.",
            "Advertised baseline context capacity remains unknown.",
            "Automatic or unspecified remote truncation may omit content after forwarding.",
            "Empirical fit records request acceptance, not retention of scored private facts.",
            "Quality, privacy, canonical output and independent scoring remain separate.",
        ],
        "requests": requests,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workload", type=Path, default=HERE / "workload.json")
    parser.add_argument("--capture", type=Path, required=True)
    parser.add_argument("--case", default="long-context")
    parser.add_argument("--role", choices=("local", "baseline"), required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        report = check_delivery(
            json.loads(args.workload.read_text()),
            json.loads(args.capture.read_text()),
            args.case,
            args.role,
        )
    except (OSError, ValueError, KeyError, StopIteration, TypeError):
        parser.exit(2, "Delivery preflight could not validate the local artifacts.\n")
    encoded = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.write_text(encoded)
    else:
        print(encoded, end="")
    return 0 if report["empirical_workload_fit"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
