"""Export synthetic golden contracts using the immutable baseline image.

Run with --network none and PYTHONPATH=/workspace in that image. No production
configuration, environment, identity, credentials, or records are consulted.
"""

import argparse
import asyncio
import hashlib
import json
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

BASELINE = "7dc4e1d7ba8e6bea3018e5cc2d29d9870d46c36b"


async def export():
    from daedalus_runtime.config import load_config
    from daedalus_runtime.datetime_tool import DateTimeConfig, current_datetime
    from daedalus_runtime.oauth import token_key
    from daedalus_runtime.service import ToolService
    from nat_helpers.hindsight_client import derive_bank_id
    from nat_helpers.hindsight_memory_context import _bounded_context_payload, _digest
    from nat_helpers.history_budget import _select_history_payloads
    from nat_helpers.tool_output_compaction import (
        CompactionSettings,
        _user_cache_key,
        optimize_tool_content,
        tool_output_reference,
    )

    fixtures = []

    def case(identifier, operation, inputs, expected, matrix):
        fixtures.append(
            {
                "id": identifier,
                "operation": operation,
                "input": inputs,
                "expected": expected,
                "matrix": matrix,
            }
        )

    for index, messages in enumerate(
        [
            [{"role": "user", "content": "hello"}],
            [
                {"role": "assistant", "content": "previous"},
                {"role": "user", "content": "now"},
            ],
            [
                {
                    "role": "user" if i % 2 == 0 else "assistant",
                    "content": "雪🌲é" * (i + 1),
                }
                for i in range(20)
            ],
            [
                {"role": "user", "content": "old"},
                {"role": "assistant", "content": "reply"},
                {"role": "user", "content": "x." * 1500},
            ],
        ]
    ):
        for limit, budget in [(50, 32000), (3, 80), (1, 1)]:
            inputs = {"messages": messages, "max_messages": limit, "max_tokens": budget}
            case(
                f"history-{index}-{limit}",
                "history",
                inputs,
                _select_history_payloads(**inputs),
                ["C02"],
            )

    async with __import__("contextlib").asynccontextmanager(current_datetime)(
        DateTimeConfig(), None
    ) as tool:
        clock = tool.schema("current_datetime_tool")
    case("clock-schema", "clock_schema", {}, clock, ["C09"])

    from nat_helpers.identity import (
        authenticated_request_headers_scope,
        authenticated_user_id_from_context,
        trusted_request_header_from_context,
    )

    headers = {
        "x-user-id": "  synthetic-alice  ",
        "x-timezone": " UTC ",
        "x-daedalus-execution-scope": " AuToNoMy ",
    }
    with patch.dict(os.environ, {"ALLOW_INSECURE_INTERNAL": "1"}, clear=True):
        with authenticated_request_headers_scope(headers):
            expected = {
                "headers": {
                    key: trusted_request_header_from_context(key) for key in headers
                },
                "output_key": _user_cache_key(
                    authenticated_user_id_from_context(), "tor_" + "0" * 32
                ),
            }
    case(
        "trusted-header-whitespace",
        "trusted_headers",
        headers,
        expected,
        ["C05", "C09"],
    )

    class Registry:
        async def get_function(self, name):
            return SimpleNamespace(schema=lambda _: clock)

    class MCP:
        groups = {}

        async def catalogue(self, *args, **kwargs):
            return []

    config = {
        "functions": {"current_datetime_tool": {"_type": "current_datetime"}},
        "llms": {
            "main": {
                "base_url": "http://model.invalid/v1",
                "api_key": "synthetic-model-key",
                "model_name": "fixture",
                "api_type": "responses",
            }
        },
        "workflow": {
            "_type": "daedalus_rust_agent",
            "llm_name": "main",
            "tools": ["current_datetime_tool"],
            "model_routes": {"deep": "fixture/deep", "deep_max": "fixture/max"},
            "request_model_profiles": {"daily_summary": "deep"},
        },
    }
    for profile in [None, "default", "deep", "deep_max", "invalid", 7, False]:
        for daily in [False, True]:
            body = {
                "messages": [
                    {"role": "user", "content": "daily summary" if daily else "hello"}
                ]
            }
            if profile is not None:
                body["additional_props"] = {"model_profile": profile}
            service = ToolService(config, Registry(), MCP())
            request = SimpleNamespace(
                headers={"x-daedalus-request-id": "synthetic-run"}
            )
            with patch.dict(
                os.environ, {"DAEDALUS_MEMORY_MODE": "disabled"}, clear=True
            ), patch(
                "daedalus_runtime.service.authenticated_user_id_from_context",
                return_value="synthetic-alice",
            ):
                try:
                    result = await service.prepare(body, request)
                    result["model"].pop("_type", None)
                    expected = {"ok": result}
                except ValueError:
                    expected = {"error": True}
            case(
                f"prepare-{profile}-{daily}",
                "prepare",
                {"config": config, "body": body},
                expected,
                ["C02"],
            )
            for run in service.runs.values():
                if run.span:
                    run.span.end()

    for limit in [" 8 ", 8.9, "8.9"]:
        numeric_config = json.loads(json.dumps(config))
        numeric_config["workflow"]["max_history"] = limit
        body = {"messages": [{"role": "user", "content": "hello"}]}
        service = ToolService(numeric_config, Registry(), MCP())
        with patch.dict(
            os.environ, {"DAEDALUS_MEMORY_MODE": "disabled"}, clear=True
        ), patch(
            "daedalus_runtime.service.authenticated_user_id_from_context",
            return_value="synthetic-alice",
        ):
            try:
                result = await service.prepare(
                    body,
                    SimpleNamespace(headers={"x-daedalus-request-id": "synthetic-run"}),
                )
                result["model"].pop("_type", None)
                expected = {"ok": result}
            except ValueError:
                expected = {"error": True}
        case(
            f"prepare-numeric-{limit!r}",
            "prepare",
            {"config": numeric_config, "body": body},
            expected,
            ["C01", "C02"],
        )

    for index, (files, env) in enumerate(
        [
            (
                {"config.yaml": "value: ${INPUT:-fallback}\nflag: true\n"},
                {"INPUT": "quoted: data\nsecond: value"},
            ),
            (
                {
                    "base.yaml": "nested: {a: 1, b: 2}\nitems: [1, 2]\n",
                    "config.yaml": "base: base.yaml\nnested: {b: 3}\nitems: [4]\n",
                },
                {},
            ),
            (
                {"config.yaml": "value: ${MISSING}\nempty: ${EMPTY:-fallback}\n"},
                {"EMPTY": ""},
            ),
            ({"config.yaml": "base: config.yaml\n"}, {}),
            ({"config.yaml": "[one, two]\n"}, {}),
            (
                {
                    "config.yaml": "anchor: &defaults {a: 1, b: 2}\nmerged: {<<: *defaults, b: 3}\n"
                },
                {},
            ),
            ({"config.yaml": "flag: yes\nquoted: 'yes'\n"}, {}),
        ]
    ):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, env, clear=True
        ):
            for name, content in files.items():
                (Path(directory) / name).write_text(content)
            try:
                expected = {"ok": load_config(Path(directory) / "config.yaml")}
            except ValueError:
                expected = {"error": True}
        case(
            f"config-{index}", "config", {"files": files, "env": env}, expected, ["C01"]
        )

    class Store:
        async def put(self, user, content, reference):
            return True

    rows = [
        {"index": i, "status": "failed" if i == 20 else "ready", "detail": "雪" * 100}
        for i in range(100)
    ]
    samples = [
        json.dumps(rows, ensure_ascii=False, indent=2),
        "<result>"
        + json.dumps({"items": rows}, ensure_ascii=False, indent=2)
        + "</result>",
        "```json\n" + json.dumps(rows, ensure_ascii=False, indent=2) + "\n```",
        '{"same":1,"same":2,"padding":"' + "x." * 4500 + '"}',
        json.dumps(
            {
                "success": True,
                "source": {"url": "https://example.invalid/article"},
                "content": "public evidence " * 1800,
            }
        ),
        json.dumps({"first": rows, "second": rows}, ensure_ascii=False, indent=2),
        json.dumps(
            [
                {
                    "index": i,
                    "numbers": [1e-5, 1e-6, 1e16, -0.0, 12.5, 10**32],
                    "detail": "synthetic " * 8,
                }
                for i in range(50)
            ],
            indent=2,
        ),
    ]
    for index, content in enumerate(samples):
        for query in ["summarize failures", "show every exact row"]:
            tool = "curated_feed_search_tool" if index == 4 else "fixture_tool"
            result = await optimize_tool_content(
                content,
                tool_name=tool,
                query=query,
                user_id="synthetic-alice",
                store=Store(),
                settings=CompactionSettings(),
            )
            case(
                f"output-{index}-{query.split()[1]}",
                "output",
                {"content": content, "query": query, "tool": tool},
                {
                    "content": result.content,
                    "reference": tool_output_reference(content),
                    "key": _user_cache_key(
                        "synthetic-alice", tool_output_reference(content)
                    ),
                },
                ["C09", "C10"],
            )

    for user in ["synthetic-alice", "synthetic-bob", "雪🌲"]:
        case(
            f"identity-{user}",
            "identity",
            {"user": user},
            {
                "bank": derive_bank_id(user),
                "bootstrap_digest": _digest("v1", derive_bank_id(user)),
                "oauth": {s: token_key(s, user) for s in ["gmail", "calendar", "docs"]},
            },
            ["C05", "C07", "C10"],
        )
    for index, inputs in enumerate(
        [
            {
                "brief": "Remembered preference",
                "pages": [{"name": "Profile", "body": "Synthetic profile"}],
                "facts": [],
            },
            {
                "brief": '雪\\"' * 2400,
                "pages": [{"name": "P", "body": '🌲\\"' * 1800}] * 2,
                "facts": [
                    {"text": 'quoted \\"' * 1000, "type": "world", "mentioned_at": None}
                ]
                * 6,
            },
        ]
    ):
        case(
            f"memory-bounds-{index}",
            "memory_payload",
            inputs,
            _bounded_context_payload(**inputs),
            ["C02", "C10"],
        )

    from daedalus_runtime.service import create_app

    app = create_app()
    routes = [
        {"path": r.path, "methods": sorted(r.methods)}
        for r in app.routes
        if getattr(r, "methods", None)
    ]
    return {
        "fixture_version": 1,
        "baseline_sha": BASELINE,
        "owner": "backend maintainer",
        "owning_test": "migration::golden_contracts",
        "cases": fixtures,
        "routes": routes,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    data = asyncio.run(export())
    args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(
        f"Exported {len(data['cases'])} synthetic cases; SHA256 {hashlib.sha256(args.output.read_bytes()).hexdigest()}"
    )
