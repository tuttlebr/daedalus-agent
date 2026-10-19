"""Exercise the retained sandbox factory against actual local HTTP/TLS peers."""

import argparse
import asyncio
import json
import time
from pathlib import Path

import httpx
from export_authorization import failure


def observation(text):
    try:
        text.encode()
        return text
    except UnicodeEncodeError:
        return {"$codepoints": list(map(ord, text))}


async def main(args):
    from daedalus_runtime.tools import ToolRegistry
    from llm_sandbox import register  # noqa: F401 - register the retained factory
    from nat_helpers.identity import authenticated_request_headers_scope

    results = []
    async with httpx.AsyncClient(trust_env=False) as control:
        for case in json.loads(args.input.read_text()):
            (
                await control.post(case["control"] + "/__reset", json=case["peer"])
            ).raise_for_status()
            registry = ToolRegistry({"functions": {"sandbox": case["config"]}})
            observations = []
            try:
                tool = await registry.get_function("sandbox")
                for step in case["steps"]:
                    if step.get("sleep"):
                        await asyncio.sleep(step["sleep"])
                    with authenticated_request_headers_scope(
                        step.get(
                            "headers",
                            {
                                "x-user-id": "synthetic-alice",
                                "x-conversation-id": "synthetic-conversation",
                            },
                        )
                    ):
                        if step.get("cancel"):
                            task = asyncio.create_task(tool.ainvoke(step["input"]))
                            deadline = time.monotonic() + 10
                            while not (
                                await control.get(case["control"] + "/__state")
                            ).json()["held"]:
                                if task.done() or time.monotonic() > deadline:
                                    raise AssertionError(
                                        "Sandbox did not reach its cancellation barrier"
                                    )
                                await asyncio.sleep(0.02)
                            task.cancel()
                            try:
                                await task
                                raise AssertionError(
                                    "Sandbox task ignored cancellation"
                                )
                            except asyncio.CancelledError:
                                pass
                            while not (
                                await control.get(case["control"] + "/__state")
                            ).json()["disconnected"]:
                                if time.monotonic() > deadline:
                                    raise AssertionError(
                                        "Sandbox transport survived cancellation"
                                    )
                                await asyncio.sleep(0.02)
                            observations.append({"cancelled": True})
                        else:
                            try:
                                observations.append(
                                    {
                                        "ok": observation(
                                            await tool.ainvoke(step["input"])
                                        )
                                    }
                                )
                            except Exception as error:
                                observations.append(failure(error))
            finally:
                await registry.close()
            state = (await control.get(case["control"] + "/__state")).json()
            results.append(
                {
                    "name": case["name"],
                    "results": observations,
                    "calls": state["calls"],
                    "mutations": state["mutations"],
                    "disconnected": state["disconnected"],
                }
            )
            print("Python sandbox:", case["name"], flush=True)
    args.output.write_text(json.dumps(results, ensure_ascii=True, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(main(parser.parse_args()))
