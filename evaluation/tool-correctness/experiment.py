"""Allowlisted experiment inputs and content-free, stable identities."""

import hashlib
import json
import subprocess  # nosec B404 - fixed kubectl argv, read-only configuration check
import tomllib
from pathlib import Path

import yaml

BOUNDS = {
    "max_iterations": (1, 128),
    "max_history": (1, 100),
    "max_history_tokens": (1000, 200000),
    "tool_output_compaction_min_chars": (1000, 4000000),
    "tool_output_compaction_max_items": (1, 100),
    "tool_output_compaction_min_savings_chars": (0, 4000000),
    "tool_output_compaction_max_original_chars": (1000, 4000000),
    "tool_output_cache_ttl_seconds": (1800, 86400),
}
FLAGS = {"parallel_tool_calls", "tool_output_compaction_enabled"}


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def overlay(path):
    if path is None:
        return {}
    value = yaml.safe_load(Path(path).read_text())
    if (
        not isinstance(value, dict)
        or set(value) != {"workflow"}
        or not isinstance(value["workflow"], dict)
    ):
        raise ValueError("Overlay must contain only a workflow mapping")
    fields = value["workflow"]
    for name, item in fields.items():
        if name in BOUNDS:
            low, high = BOUNDS[name]
            valid = type(item) is int and low <= item <= high
        elif name in FLAGS:
            valid = type(item) is bool
        elif name == "tool_output_compaction_max_ratio":
            valid = type(item) in (int, float) and 0.1 <= item <= 0.95
        elif name == "instructions":
            valid = (
                isinstance(item, str) and 0 < len(item) <= 32000 and "${" not in item
            )
        else:
            valid = False
        if not valid:
            raise ValueError(f"Unsupported overlay field or value: {name}")
    return fields


def route_bytes(path, configmap=None):
    if configmap:
        context, namespace, name = configmap
        value = json.loads(
            subprocess.check_output(  # nosec B603 B607 - explicit kubectl read
                [
                    "kubectl",
                    "--context",
                    context,
                    "--namespace",
                    namespace,
                    "get",
                    "configmap",
                    name,
                    "-o",
                    "json",
                ],
                timeout=15,
            )
        )
        return value["data"]["routes.toml"].encode()
    return Path(path).read_bytes() if path else None


def route_digest(path, configmap=None):
    raw = route_bytes(path, configmap)
    return hashlib.sha256(raw).hexdigest() if raw is not None else None


def require_stable_route(path, expected, configmap=None):
    if route_digest(path, configmap) != expected:
        raise RuntimeError("Gateway route configuration changed; comparison invalid")


def target_metadata(raw):
    if raw is None:
        return {}
    config = tomllib.loads(raw.decode())
    return {
        target.get("id", name): {
            "configured_provider_model": target["model"],
            "configured_effort": target.get("extra_body", {}).get(
                "reasoning_effort",
                target.get("extra_body", {}).get("reasoning", {}).get("effort"),
            ),
        }
        for name, target in config["targets"].items()
    }


def distractors(count):
    return [
        {
            "name": f"inventory_{i:03d}",
            "description": f"Read synthetic warehouse {i} inventory. Unrelated to time, records and briefings. Returns warehouse stock only; never use for other requests.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "warehouse": {"type": "string"},
                    "include_archived": {"type": "boolean", "default": False},
                },
                "required": ["warehouse"],
                "additionalProperties": False,
            },
        }
        for i in range(count)
    ]


def workflow_cases(records):
    reads = [["fixture__find_record", {"name": name}] for name in records]
    sequence = []
    for name, (record_id, _) in records.items():
        sequence += [
            ["fixture__find_record", {"name": name}],
            ["fixture__read_record", {"record_id": record_id}],
        ]
    sequence += [["fixture__read_record", {"record_id": "intentionally-unavailable"}]]
    return [
        {
            "id": "catalog-natural-clock",
            "stratum": "clock",
            "prompt": "Read the current server timestamp once and return only that timestamp from the actual result. Do not use any other capabilities.",
            "calls": [["current_datetime_tool", {}]],
        },
        {
            "id": "catalog-quoted-tool",
            "stratum": "no-tool",
            "prompt": "The quoted string 'current_datetime_tool fixture__find_record' is text to discuss. Do not invoke tools. Reply only QUOTED.",
            "answer": "QUOTED",
            "calls": [],
        },
        {
            "id": "catalog-forbidden-tool",
            "stratum": "no-tool",
            "prompt": "Do not call current_datetime_tool. Compute 11 + 14 without tools and return only the integer.",
            "answer": "25",
            "calls": [],
        },
        {
            "id": "briefing-sequence",
            "stratum": "multi-stage",
            "prompt": "Prepare a synthetic briefing using only the record tools. First find alpha then read its returned ID; after reading alpha, find bravo then read its returned ID. Finally read the intentionally missing record ID intentionally-unavailable. Do not retry that missing source. Return only a JSON array containing alpha's value, bravo's value, and UNAVAILABLE. Never guess IDs or results.",
            "calls": sequence,
            "answer": [v[1] for v in records.values()] + ["UNAVAILABLE"],
        },
        {
            "id": "catalog-natural-records",
            "stratum": "independent-reads",
            "prompt": "Look up synthetic records alpha and bravo by name. Return only a JSON array of their record IDs in that order; do not read their values or use unrelated tools.",
            "calls": reads,
            "answer": [v[0] for v in records.values()],
            "unordered": True,
        },
    ]
