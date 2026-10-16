"""Invoke the retained NVIDIA docs factory against the acceptance suite's peer."""

import argparse
import asyncio
import json
from pathlib import Path

import httpx


async def main(args):
    from daedalus_runtime.tools import ToolRegistry
    from nat_helpers import nvidia_docs as docs

    cases = json.loads(args.input.read_text())
    observations = []
    async with httpx.AsyncClient(trust_env=False) as control:
        for case in cases:
            endpoint = case["endpoint"]
            control_endpoint = case.get("control", endpoint)
            docs.NVIDIA_DOCS_ENDPOINTS.update(
                {
                    product: ("https://docs.nvidia.com/" + product + "/_mcp/server")
                    if case.get("fixed_endpoints")
                    else endpoint + "/" + product
                    for product in docs.NVIDIA_DOCS_ENDPOINTS
                }
            )
            response = await control.post(
                control_endpoint + "/__reset", json=case["peer"]
            )
            response.raise_for_status()
            registry = ToolRegistry(
                {
                    "functions": {
                        "docs": {
                            "_type": "nvidia_docs",
                            "timeout": case["timeout"],
                        }
                    }
                }
            )
            try:
                tool = await registry.get_function("docs")
                try:
                    result = {"ok": await tool.ainvoke(case["input"])}
                except Exception as exc:
                    result = {"error": type(exc).__name__}
            finally:
                await registry.close()
            if case.get("settle"):
                await asyncio.sleep(case["settle"])
            response = await control.get(control_endpoint + "/__calls")
            response.raise_for_status()
            observations.append(
                {"name": case["name"], "result": result, "calls": response.json()}
            )
            print("Python NVIDIA docs:", case["name"], flush=True)
    args.output.write_text(json.dumps(observations, indent=2, ensure_ascii=True) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(main(parser.parse_args()))
