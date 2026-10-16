"""Run the retained Perplexity factory against the local acceptance provider."""

import argparse
import asyncio
import json
import time
from pathlib import Path

import httpx


async def main(args):
    from daedalus_runtime.tools import ToolRegistry
    from perplexity_search import register  # noqa: F401 - register the retained factory

    observed = []
    async with httpx.AsyncClient(trust_env=False) as control:
        for case in json.loads(args.input.read_text()):
            (
                await control.post(case["control"] + "/__reset", json=case["peer"])
            ).raise_for_status()
            registry = ToolRegistry(
                {
                    "functions": {
                        "search": {
                            "_type": "perplexity_search",
                            "api_key": "synthetic-key",
                            "base_url": case["endpoint"] + "/search",
                            "rate_limit_backoff_seconds": 0,
                            **case.get("config", {}),
                        }
                    }
                }
            )
            start = time.monotonic()
            try:
                tool = await registry.get_function("search")
                try:
                    result = {"ok": await tool.ainvoke(case["input"])}
                except Exception as exc:
                    result = {"error": type(exc).__name__}
                    if hasattr(exc, "errors"):
                        result["validation"] = [
                            {key: item[key] for key in ["type", "loc", "msg"]}
                            for item in exc.errors()
                        ]
            finally:
                await registry.close()
            elapsed = time.monotonic() - start
            if (
                case.get("duration")
                and not case["duration"][0] <= elapsed <= case["duration"][1]
            ):
                raise AssertionError((case["name"], elapsed))
            response = await control.get(case["control"] + "/__calls")
            response.raise_for_status()
            observed.append(
                {"name": case["name"], "result": result, "calls": response.json()}
            )
            print("Python Perplexity:", case["name"], flush=True)
    args.output.write_text(json.dumps(observed, ensure_ascii=True, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(main(parser.parse_args()))
