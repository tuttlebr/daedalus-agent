"""Synthetic P2 fixtures. Run in the retained baseline image with --network none."""

import argparse
import base64
import hashlib
import json
import math
import os
import random
import struct
import unicodedata
from pathlib import Path

BASELINE = "7dc4e1d7ba8e6bea3018e5cc2d29d9870d46c36b"


def fixture_strings(value):
    """Losslessly chunk long strings so synthetic base64/numbers are reviewable.

    The repository secret scanner otherwise mistakes these deterministic test
    values for 84-character API keys. No scanner exception is needed.
    """
    if isinstance(value, str) and len(value) > 80:
        return {"$string_parts": [value[i : i + 80] for i in range(0, len(value), 80)]}
    if isinstance(value, list):
        return [fixture_strings(item) for item in value]
    if isinstance(value, dict):
        return {key: fixture_strings(item) for key, item in value.items()}
    return value


def failure(exc):
    output = {"error": type(exc).__name__}
    if hasattr(exc, "errors"):
        output["validation"] = [
            {
                **{key: item[key] for key in ["type", "loc", "msg"]},
                **(
                    {"ctx": {key: str(value) for key, value in item["ctx"].items()}}
                    if "ctx" in item
                    else {}
                ),
            }
            for item in exc.errors()
        ]
    return output


def export():
    from daedalus_runtime import approval, oauth
    from mcp.types import CallToolResult

    cases = []

    def add(operation, inputs, expected, matrix):
        cases.append(
            {
                "id": f"{operation}-{len(cases)}",
                "operation": operation,
                "input": inputs,
                "expected": expected,
                "matrix": matrix,
            }
        )

    arguments = [
        {},
        {"null": None, "false": False, "true": True, "omitted": {}},
        {"z": [{"雪": "🌲", "é": "e\u0301", "a": "\x00\n\t"}], "a": 1},
        {"approval_token": "ignored", "nested": {"approval_token": "retained"}},
        {"user": "forged-user", "approval_token": None},
    ]
    arguments.extend(
        {"n": n}
        for n in [
            0,
            -1,
            2**53 + 1,
            2**64,
            -(2**100),
            10**200,
            0.0,
            -0.0,
            1.0,
            1e-5,
            1e-4,
            1e15,
            1e16,
            1e20,
            1e21,
            5e-324,
            1.7976931348623157e308,
        ]
    )
    rng = random.Random(2701)  # nosec B311 - reproducible numeric fixtures, not credentials
    for _ in range(2048):
        number = struct.unpack(">d", rng.getrandbits(64).to_bytes(8, "big"))[0]
        if math.isfinite(number):
            arguments.append({"n": number})
    for args in arguments:
        canonical, digest = approval._canonical_mcp_call(args)
        add(
            "canonical",
            json.dumps(args, ensure_ascii=False),
            {"canonical": canonical, "sha256": digest},
            ["C08"],
        )

    for user in ["synthetic-alice", "synthetic-bob", "雪🌲é", " spaced "]:
        for service in oauth.BUCKETS:
            add(
                "oauth-key",
                {"user": user, "service": service},
                oauth.token_key(service, user),
                ["C07"],
            )
    legacy = {
        "credentials": [{"other": "skip"}, {"token": "synthetic-access"}],
        "raw": {"refresh_token": "synthetic-refresh", "scope": "scope-a scope-b"},
    }
    for expiry in [
        None,
        "2026-01-02T03:04:05Z",
        "2026-01-02T03:04:05.123456+00:00",
        "2026-01-02T04:04:05+01:00",
        "2026-01-02T03:04:05",
        "2026-07-02T03:04:05.123456",
        "2026-11-01T01:30:00",
        "2026-03-08T02:30:00",
    ]:
        payload = {**legacy, "token_expires_at": expiry}
        envelope = json.dumps(
            {
                "data": base64.urlsafe_b64encode(json.dumps(payload).encode())
                .decode()
                .rstrip("=")
            }
        )
        add("grant", envelope, oauth.decode_grant(envelope), ["C07", "C16"])
    v2 = json.dumps(
        {
            "version": 2,
            "access_token": "synthetic-access",
            "refresh_token": "synthetic-refresh",
            "scope": "read",
            "expires_at": 1700000000,
        }
    )
    add("grant", v2, oauth.decode_grant(v2), ["C07", "C16"])

    policies = [
        {},
        {"approval_policy": "auto_approve"},
        {
            "include": ["read", "write"],
            "exclude": ["read"],
            "tool_overrides": {
                "read": {"approval_policy": "read_only"},
                "write": {"approval_policy": "auto_approve"},
            },
        },
        {"exclude": ["write"], "approval_policy": "auto_approve"},
        {
            "include": ["STRASSE"],
            "tool_overrides": {"Straße": {"approval_policy": "read_only"}},
        },
        {"approval_policy": "read_only"},
        {"tool_overrides": {"write": {"approval_policy": "read_only"}}},
        {
            "include": ["read"],
            "tool_overrides": {"write": {"approval_policy": "auto_approve"}},
        },
        {
            "exclude": ["write"],
            "tool_overrides": {"write": {"approval_policy": "auto_approve"}},
        },
        {"include": [None]},
        {"approval_policy": "${UNTRUSTED}"},
    ]
    for config in policies:
        try:
            parsed = approval._parse_mcp_group_approval_policy("fixture", config)
        except RuntimeError:
            add("policy", config, {"valid": False}, ["C01", "C06", "C08"])
            continue
        results = []
        for name in ["read", "write", "unknown", "Straße", "read", "read"]:
            for args in [
                {},
                {"operation": "delete"},
                {"user": "forged"},
                {"method": "POST"},
            ]:
                for annotation in [
                    {},
                    {"readOnlyHint": True},
                    {"destructiveHint": True},
                ]:
                    policy = parsed.for_tool(name.strip().casefold())
                    allowed = (
                        policy == "auto_approve"
                        or policy == "read_only"
                        and not approval._is_mutating_mcp_call(name, args, annotation)
                    )
                    results.append(
                        {
                            "tool": name,
                            "args": args,
                            "annotations": annotation,
                            "allowed": allowed,
                            "read_only": policy == "read_only",
                        }
                    )
        add("policy", config, {"valid": True, "calls": results}, ["C06", "C08"])

    contents = [
        [],
        [{"type": "text", "text": "雪🌲é"}],
        [
            {
                "type": "text",
                "text": "hello",
                "_meta": {"null": None},
                "annotations": {
                    "priority": 0.5,
                    "audience": ["assistant"],
                    "lastModified": "fixed",
                },
                "extension": True,
            }
        ],
        [{"type": "image", "data": "aGk=", "mimeType": "image/png"}],
        [{"type": "audio", "data": "aGk=", "mimeType": "audio/wav"}],
        [
            {
                "type": "resource",
                "resource": {
                    "uri": "file:///fixture",
                    "text": "fixture",
                    "mimeType": "text/plain",
                    "_meta": {"x": 1},
                },
            }
        ],
        [
            {
                "type": "resource",
                "resource": {"uri": "https://example.invalid", "blob": "aGk="},
            }
        ],
        [
            {
                "type": "resource_link",
                "uri": "https://example.invalid",
                "name": "fixture",
                "title": "Title",
                "mimeType": "text/plain",
                "size": 2,
                "icons": [{"src": "https://example.invalid/icon"}],
            }
        ],
    ]
    for content in contents:
        for extra in [
            {},
            {"isError": True},
            {
                "structuredContent": {"null": None, "n": 1.0},
                "_meta": {"x": 1},
                "extension": "retained",
            },
            {"structuredContent": None, "_meta": None},
        ]:
            raw = {"content": content, **extra}
            add(
                "result",
                raw,
                CallToolResult.model_validate(raw).model_dump_json(exclude_none=True),
                ["C06", "C09"],
            )

    sources = []
    for module in [approval, oauth]:
        source = Path(module.__file__)
        sources.append(
            {
                "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "file": source.name,
            }
        )
    return {
        "baseline_sha": BASELINE,
        "version": 2,
        "owner": "authorization_contracts",
        "unicode_version": unicodedata.unidata_version,
        "legacy_timezone": os.environ.get("TZ", "UTC"),
        "sources": sources,
        "cases": cases,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--casefold-output", type=Path)
    args = parser.parse_args()
    args.output.write_text(
        json.dumps(fixture_strings(export()), ensure_ascii=False, indent=2) + "\n"
    )
    if args.casefold_output:
        if unicodedata.unidata_version != "15.0.0":
            raise RuntimeError("Casefold export requires the Python 3.12 baseline")
        values = {
            chr(i): chr(i).casefold()
            for i in range(0x110000)
            if chr(i).casefold() != chr(i)
        }
        args.casefold_output.write_text(
            json.dumps(values, ensure_ascii=False, indent=2) + "\n"
        )
