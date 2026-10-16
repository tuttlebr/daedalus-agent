"""Capture NVIDIA docs contracts using the retained Python factory and MCP models.

Run offline in the retained image. No provider is replaced: these captures cover
configuration, validation before dispatch, blank queries and SDK result models.
The separate service acceptance suite must exercise the real MCP transport.
"""

import argparse
import asyncio
import contextlib
import hashlib
import json
from pathlib import Path

from export_authorization import fixture_strings


async def export(root):
    from mcp.types import CallToolResult
    from nat_helpers import nvidia_docs as docs

    defaults = docs.NvidiaDocsConfig()
    async with contextlib.asynccontextmanager(docs.nvidia_docs)(defaults, None) as tool:
        resources = {
            "schema": tool.schema("nvidia_docs"),
            "configuration_schema": defaults.model_json_schema(),
            "defaults": defaults.model_dump(mode="json"),
            "endpoints": docs.NVIDIA_DOCS_ENDPOINTS,
            "result_schema": CallToolResult.model_json_schema(),
        }
        inputs = []
        for raw in [
            {},
            {"product": "dynamo"},
            {"product": "dynamo", "query": ""},
            {"product": "dynamo", "query": " \t\n\u001c\u0085\u2000"},
            {"product": "Dynamo", "query": "Synthetic"},
            {"product": "unknown", "query": "Synthetic"},
            {"product": None, "query": "Synthetic"},
            {"product": "dynamo", "query": 1},
            {"product": "dynamo", "query": "雪" * 2001},
            {"product": "dynamo", "query": "Synthetic", "endpoint": "forged"},
            [],
            None,
        ]:
            try:
                expected = {"ok": await tool.ainvoke(raw)}
            except Exception as exc:
                expected = {"error": type(exc).__name__}
                if hasattr(exc, "errors"):
                    expected["validation"] = [
                        {key: item[key] for key in ["type", "loc", "msg"]}
                        for item in exc.errors()
                    ]
            inputs.append({"input": raw, "expected": expected})

    configurations = []
    for field in ["description", "verbose", "timeout", "unknown"]:
        for value in [
            None,
            "",
            "Synthetic description",
            " \t\u001c",
            0,
            -1,
            1,
            1.5,
            120,
            121,
            True,
            False,
            [],
            {},
            "1.5",
            "NaN",
            "inf",
            "off",
        ]:
            raw = {field: value}
            try:
                config = docs.NvidiaDocsConfig.model_validate(raw)
                expected = {"ok": config.model_dump(mode="json")}
                try:
                    async with contextlib.asynccontextmanager(docs.nvidia_docs)(
                        config, None
                    ) as tool:
                        expected["schema"] = tool.schema("configured_docs")
                except Exception as exc:
                    expected["schema_error"] = type(exc).__name__
            except ValueError:
                expected = {"error": True}
            configurations.append({"input": raw, "expected": expected})

    payloads = [
        {"content": []},
        {"content": [{"type": "text", "text": "Synthetic 雪🌲\u007f"}]},
        {
            "content": [
                {
                    "type": "text",
                    "text": "Synthetic",
                    "_meta": {"x": 1},
                    "annotations": {
                        "audience": ["assistant"],
                        "priority": 0.5,
                        "extension": None,
                    },
                    "extension": None,
                }
            ],
            "_meta": {"trace": "synthetic"},
            "extension": {"a": None},
        },
        {
            "content": [],
            "structuredContent": {"answer": "雪", "nested": [None, 1e-5]},
            "isError": True,
        },
        *[
            {"content": [{"type": kind, "data": "c3ludGhldGlj", "mimeType": mime}]}
            for kind, mime in [("image", "image/png"), ("audio", "audio/wav")]
        ],
        {
            "content": [
                {
                    "type": "resource",
                    "resource": {
                        "uri": "https://EXAMPLE.test:443",
                        "text": "Synthetic",
                        "_meta": {},
                    },
                }
            ]
        },
        {
            "content": [
                {
                    "type": "resource",
                    "resource": {"uri": "synthetic:document", "blob": "c3ludGhldGlj"},
                }
            ]
        },
        {
            "content": [
                {
                    "type": "resource_link",
                    "name": "Synthetic",
                    "uri": "https://EXAMPLE.test:443",
                    "icons": [{"src": "synthetic:icon"}],
                }
            ]
        },
        *[{"content": [], "isError": value} for value in [None, 0, 1, "true", "no", 2]],
        {},
        {"content": None},
        {"content": "invalid"},
        {"content": [{"type": "text"}]},
        {"content": [{"type": "text", "text": 1}]},
        {"content": [{"type": "unknown", "text": "Synthetic"}]},
        {
            "content": [
                {
                    "type": "text",
                    "text": "Synthetic",
                    "annotations": {"priority": "0.5"},
                }
            ]
        },
        {
            "content": [
                {"type": "text", "text": "Synthetic", "annotations": {"priority": 2}}
            ]
        },
    ]
    results = []
    for payload in payloads:
        try:
            result = CallToolResult.model_validate(payload)
            expected = {"ok": docs._result_payload(result)}
        except ValueError:
            expected = {"error": True}
        results.append({"input": payload, "expected": expected})

    for folder, name, value in [
        ("resources", "nvidia-docs.json", resources),
        (
            "tests/fixtures",
            "nvidia-docs.json",
            {
                "source_sha256": hashlib.sha256(
                    Path(docs.__file__).read_bytes()
                ).hexdigest(),
                "configuration": configurations,
                "inputs": inputs,
                "results": results,
            },
        ),
    ]:
        path = root / folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if folder == "tests/fixtures":
            value = fixture_strings(value)
        path.write_text(
            json.dumps(value, indent=2, ensure_ascii=folder == "resources") + "\n"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    asyncio.run(export(parser.parse_args().root))
