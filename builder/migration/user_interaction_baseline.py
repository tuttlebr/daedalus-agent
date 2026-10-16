"""Run retained memory-deletion tools against actual Redis and local Hindsight."""

import argparse
import asyncio
import json
import os
from pathlib import Path
from unittest.mock import patch

import httpx


async def main(args):
    from daedalus_runtime.tools import ToolRegistry
    from nat_helpers import hindsight_client
    from nat_helpers.identity import authenticated_request_headers_scope
    from user_interaction import register  # noqa: F401 - register the retained factory

    document = json.loads(args.input.read_text())
    observations = []
    async with httpx.AsyncClient(trust_env=False) as control:
        for case in document["cases"]:
            response = await control.post(document["control"] + "/__reset", json=case)
            response.raise_for_status()
            registry = ToolRegistry(
                {
                    "functions": {
                        "interaction": {
                            "_type": "user_interaction",
                            **case.get("config", {}),
                        }
                    }
                }
            )
            env = {**document["environment"], **case.get("env", {})}
            with patch.dict(os.environ, env):
                try:
                    tool = await registry.get_function("interaction")

                    async def invoke():
                        with authenticated_request_headers_scope(case["headers"]):
                            try:
                                return {"ok": await tool.ainvoke(case["input"])}
                            except Exception as exc:
                                return {"error": type(exc).__name__}

                    if case.get("parallel"):
                        results = await asyncio.gather(
                            *(invoke() for _ in range(case["count"]))
                        )
                    else:
                        results = [await invoke() for _ in range(case.get("count", 1))]
                finally:
                    await registry.close()
                    if hindsight_client._cached_client_from_env.cache_info().currsize:
                        await hindsight_client.client_from_env().aclose()
                        hindsight_client._cached_client_from_env.cache_clear()
            state = await control.get(document["control"] + "/__state")
            state.raise_for_status()
            if case.get("parallel"):
                results.sort(key=lambda value: json.dumps(value, sort_keys=True))
            observations.append(
                {"name": case["name"], "results": results, "state": state.json()}
            )
            print("Python memory deletion:", case["name"], flush=True)
    args.output.write_text(json.dumps(observations, ensure_ascii=True, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(main(parser.parse_args()))
