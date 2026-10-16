"""Capture Perplexity contracts offline using the retained Python implementation.

Transport parity is checked separately against a local HTTP provider. All data
here is synthetic; no API key or external service is needed.
"""

import argparse
import asyncio
import contextlib
import hashlib
import json
import math
import os
import unicodedata
from pathlib import Path

import _strptime
import httpx
from export_authorization import fixture_strings


def observation(fn, *args, **kwargs):
    try:
        return {"ok": fn(*args, **kwargs)}
    except Exception as exc:
        return {"error": type(exc).__name__, "message": str(exc)}


def canonical(value):
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in value.items()}
    if isinstance(value, list):
        return [canonical(item) for item in value]
    return value


async def export(root):
    from perplexity_search import perplexity_search_function as search

    os.environ.pop("PERPLEXITY_SEARCH_API_KEY", None)
    factory = contextlib.asynccontextmanager(search.perplexity_search_function)
    defaults = search.PerplexitySearchConfig()
    async with factory(defaults, None) as tool:
        resources = {
            "schema": tool.schema("perplexity_search"),
            "configuration_schema": defaults.model_json_schema(),
            "defaults": defaults.model_dump(mode="python"),
            "date_patterns": [
                _strptime.TimeRE().pattern(pattern)
                for pattern in ["%m/%d/%Y", "%Y-%m-%d"]
            ],
            "uppercase": {
                chr(point): chr(point).upper()
                for point in range(0x110000)
                if chr(point).upper() != chr(point)
            },
            "invalid_netloc": [
                point
                for point in range(128, 0x110000)
                if any(c in unicodedata.normalize("NFKC", chr(point)) for c in "/?#@:")
            ],
        }
        inputs = []
        for raw in [
            {},
            None,
            [],
            {"query": None},
            {"query": ""},
            {"query": " "},
            {"query": ["one"]},
            {"query": ["one", ""]},
            {"query": ["one", 1]},
            {"query": ["q"] * 6},
            {"query": "q", "max_results": 1.5},
            {"query": "q", "max_results": True},
            {"query": "q", "max_results": "2"},
            {"query": "q", "max_results": 1e30},
            {"query": "q", "search_context_size": "HIGH"},
            {"query": "q", "search_recency_filter": "today"},
            {"query": "q", "extra": 1},
            {"query": "q", "country": 2, "search_after_date_filter": False},
            {"query": ["one", "two"]},
            {"query": "q", "max_results": 2.0},
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
    for field in [*resources["configuration_schema"]["properties"], "unknown"]:
        for value in [
            None,
            "",
            "Synthetic",
            " \t\u001c",
            0,
            -1,
            1,
            1.5,
            5,
            20,
            21,
            30,
            31,
            True,
            False,
            [],
            {},
            "1.5",
            "NaN",
            "inf",
            "off",
            "high",
            "1_0",
            10**30,
        ]:
            raw = {field: value}
            try:
                config = search.PerplexitySearchConfig.model_validate(raw)
                expected = {"ok": canonical(config.model_dump(mode="python"))}
                try:
                    async with factory(config, None) as tool:
                        expected["schema"] = tool.schema("configured_search")
                except Exception as exc:
                    expected["schema_error"] = type(exc).__name__
            except ValueError:
                expected = {"error": True}
            configurations.append({"input": raw, "expected": expected})

    requests = []
    arguments = [
        {},
        {"max_results": -4},
        {"max_results": 0},
        {"max_results": 2},
        {"max_results": 10**30},
        {"default_max_results": 3},
        {"country": " ßx "},
        {"country": "us"},
        {"search_context_size": " HIGH "},
        {"search_language_filter": " EN, FR, ΟΣ, İ, , DE "},
        {"search_domain_filter": ", Example.test, -blocked.test, Example.test, "},
        {"search_domain_filter": ",".join(f"test{i}.test" for i in range(25))},
    ]
    for field in [
        "search_after_date_filter",
        "search_before_date_filter",
        "last_updated_after_filter",
        "last_updated_before_filter",
    ]:
        for date in [
            "",
            " \u001c",
            "10/2/2026",
            "2026-10-2",
            "2024-02-29",
            "2025-02-29",
            "0001-01-01",
            "01/01/0001",
            "2026-1- 2",
            "２０２６-01-02",
            "2026-٠١-02",
            "2026-01-02x",
            "01/01/0000",
        ]:
            arguments.append({field: date, "search_recency_filter": "day"})
    for raw in arguments:
        raw = {"query": "Synthetic 雪", **raw}
        requests.append(
            {
                "input": raw,
                "expected": observation(search._build_request_payload, **raw),
            }
        )
    queries = [
        {"input": raw, "expected": observation(search._normalize_query, raw)}
        for raw in [
            "q",
            " \u001c\u0085雪\t",
            " ",
            [" one ", "two"],
            ["Straße", "STRASSE"],
            ["ΟΣ", "οσ"],
            ["one", " "],
            ["same", "same"],
            ["one"],
            ["q"] * 6,
            None,
            1,
        ]
    ]
    results = []
    urls = [
        "https://www.example.test/a",
        "https://WWW.Example.test:443/a",
        "https://user:pass@www.example.test:80/a",
        "relative/path",
        "//www.example.test/a",
        "https://[::1]:8080/a",
        "https://[invalid]/a",
        "https://[v1.future]/a",
        "https://[127.0.0.1]/a",
        "https://example.test：80/a",
        "https://example.test\n/a",
    ]
    payloads = [
        {},
        {"results": []},
        {"results": None},
        {"results": {}},
        {"results": "abc"},
        [],
        None,
        {"results": [None, {}, {"title": "only"}]},
        {
            "id": "synthetic-search",
            "server_time": 1.5,
            "results": [
                {
                    "title": " 雪 🌲 ",
                    "url": "https://www.example.test/source",
                    "snippet": " line\n雪 ",
                    "date": "2026-10-14",
                    "last_updated": "2026-10-15",
                },
                {"title": "Second", "link": "https://example.test/second"},
            ],
        },
        {
            "results": [
                {
                    "title": True,
                    "url": "relative",
                    "snippet": [None, True, 1],
                    "date": 2,
                }
            ]
        },
        *[{"results": [{"title": "Synthetic", "url": url}]} for url in urls],
        {"results": [None, {}, {"title": "Excluded", "url": "https://example.test"}]},
    ]
    for payload in payloads:
        for query in ["Synthetic 雪", ["one", "two"]]:

            def render():
                value = search._build_payload(payload, query, 2)
                return (
                    search._build_markdown_summary(value)
                    + "\n\n<searchresults>"
                    + json.dumps(value)
                    + "</searchresults>"
                )

            results.append(
                {
                    "input": payload,
                    "query": query,
                    "max_results": 2,
                    "expected": observation(render),
                }
            )
    errors = []
    for status in [301, 400, 401, 403, 404, 429, 500]:
        for body in [
            {},
            {"error": {"code": "INSUFFICIENT_QUOTA"}},
            {"error": {"message": " Synthetic\n bad \u001c argument "}},
            {"message": "雪" * 401},
            {"message": "quota"},
            None,
        ]:
            errors.append(
                {
                    "status": status,
                    "body": body,
                    "expected": search._http_error_for_user(
                        httpx.Response(status, json=body)
                    ),
                }
            )
    fixture = {
        "source_sha256": hashlib.sha256(Path(search.__file__).read_bytes()).hexdigest(),
        "configuration": configurations,
        "inputs": inputs,
        "requests": requests,
        "queries": queries,
        "results": results,
        "errors": errors,
    }
    for folder, value in [
        ("resources", resources),
        ("tests/fixtures", fixture_strings(fixture)),
    ]:
        path = root / folder / "perplexity-search.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                value, indent=2, ensure_ascii=folder == "resources", allow_nan=False
            )
            + "\n"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    asyncio.run(export(parser.parse_args().root))
