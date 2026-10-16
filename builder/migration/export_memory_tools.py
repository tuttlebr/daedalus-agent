"""Freeze memory tool/service contracts in the immutable baseline image.

Run with --network none, PYTHONPATH=/workspace and a writable --root directory.
Only the external Hindsight transport is substituted; tool/client code is real.
"""

import argparse
import asyncio
import contextlib
import json
import os
from pathlib import Path
from unittest.mock import patch

import httpx
from export_authorization import fixture_strings

BASELINE = "7dc4e1d7ba8e6bea3018e5cc2d29d9870d46c36b"


async def export(root):
    from nat_helpers import daedalus_memory_tools as tools
    from nat_helpers import hindsight_client as hindsight
    from nat_helpers.idempotency import canonical_arguments_sha256, operation_key
    from nat_helpers.identity import authenticated_request_headers_scope

    resources = {}
    factories = {
        "daedalus_add_memory": (
            tools.DaedalusAddMemoryConfig,
            tools.daedalus_add_memory,
        ),
        "daedalus_get_memory": (
            tools.DaedalusGetMemoryConfig,
            tools.daedalus_get_memory,
        ),
    }
    for kind, (config_type, factory) in factories.items():
        async with contextlib.asynccontextmanager(factory)(config_type(), None) as tool:
            resources[kind] = tool.schema(kind)
    resources["daily_terms"] = tools.DAILY_BRIEFING_QUERY_TERMS
    resources["daily_triggers"] = tools.DAILY_BRIEFING_TRIGGERS
    resources["daily_top_k"] = tools.DAILY_BRIEFING_MIN_TOP_K

    reply = {
        "bank_id": "private-bank",
        "results": [
            {
                "id": str(i),
                "text": "Synthetic memory 雪🌲e\u0301\u007f",
                "score": 1e-5,
                "bank_id": "private-bank",
                "nested": {
                    "tenant_id": "private-tenant",
                    "value": [True, None, {"bank_id": "private-bank", "ok": i}],
                },
            }
            for i in range(55)
        ]
        + [None, "skip", 1],
    }
    cases = []
    inputs = [
        (
            "daedalus_get_memory",
            {},
            {"query": query, "user_id": "forged-user", "bank_id": "forged-bank"},
        )
        for query in [
            "",
            " \u001c\t",
            "  Search 雪🌲 \u001c",
            "Daily\tSUMMARY",
            "morning brief",
            "no daily weather",
            "catch me up on today",
        ]
    ]
    inputs += [
        (
            "daedalus_get_memory",
            {"top_k": default},
            {"query": "Synthetic facts", "top_k": limit},
        )
        for default in [1, 11, 50]
        for limit in [None, 1, 11, 50, 5.0]
    ]
    metadata = {
        " key ": {"z": ["雪🌲", 1e-5, -0.0], "a": True},
        " ": "skip",
        "number": 10**30,
        "key_value_pairs": {"old": 1, "same": "old"},
        "source": "user supplied",
    }
    inputs += [
        ("daedalus_add_memory", {}, data)
        for data in [
            {"memory": ""},
            {"memory": " \u001c\t"},
            {"memory": "  Synthetic memory 雪🌲. \u001c"},
            {
                "memory": "Synthetic preference.",
                "tags": ["tag", "tag", "source:explicit", "雪"],
                "metadata": metadata,
                "key_value_pairs": {"same": "new", "new": None},
                "user_id": "forged-user",
                "request_id": "forged-request",
            },
            {
                "memory": "Synthetic preference.",
                "metadata": {"key_value_pairs": "replace"},
                "key_value_pairs": {"x": 2},
            },
            {"memory": "雪" * 12001},
        ]
    ]
    os.environ["DAEDALUS_INTERNAL_API_TOKEN"] = "synthetic-internal"  # nosec B105 - isolated fixture credential
    for kind, config_raw, arguments in inputs:
        calls = []
        request_id = f"memory-case-{len(cases)}"

        async def handler(request):
            calls.append(
                {
                    "path": request.url.path,
                    "method": request.method,
                    "body": json.loads(request.content),
                    "authorization": request.headers["authorization"],
                }
            )
            return httpx.Response(200, json=reply)

        client = hindsight.HindsightClient(
            base_url="http://hindsight.invalid",
            api_key="synthetic-hindsight",
            transport=httpx.MockTransport(handler),
        )
        config_type, factory = factories[kind]
        with patch.object(
            hindsight, "client_from_env", return_value=client
        ), patch.dict(
            os.environ, {"DAEDALUS_MEMORY_MODE": "hindsight"}
        ), authenticated_request_headers_scope(
            {
                "x-user-id": "synthetic-alice",
                "x-daedalus-internal-token": "synthetic-internal",
                "x-daedalus-request-id": request_id,
            }
        ):
            async with contextlib.asynccontextmanager(factory)(
                config_type(**config_raw), None
            ) as tool:
                result = await tool.ainvoke(arguments)
        await client.aclose()
        cases.append(
            {
                "kind": kind,
                "config": config_raw,
                "arguments": arguments,
                "request_id": request_id,
                "reply": reply,
                "expected": result,
                "calls": calls,
            }
        )

    reservations = []
    for arguments in [
        {"memory": "Snow 雪🌲", "tags": ["x"], "metadata": metadata},
        {"a": {"approval_token": "retained", "value": [1e-5, -0.0, 10**30]}},
        {},
    ]:
        digest = canonical_arguments_sha256(arguments)
        reservations.append(
            {
                "arguments": arguments,
                "digest": digest,
                "key": operation_key(
                    user_id="synthetic-alice",
                    execution_id="synthetic-execution",
                    operation="add_memory",
                    arguments_sha256=digest,
                ),
            }
        )
    resource = {"baseline_sha": BASELINE, **resources}
    fixture = {
        "baseline_sha": BASELINE,
        "matrix": ["C09", "C10", "C13", "C16"],
        "cases": cases,
        "reservations": reservations,
    }
    for path, value in [
        (root / "resources/memory-tools.json", resource),
        (root / "tests/fixtures/memory-tools.json", fixture_strings(fixture)),
    ]:
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    asyncio.run(export(parser.parse_args().root))
