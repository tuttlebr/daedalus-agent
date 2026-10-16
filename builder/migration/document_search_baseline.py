"""Invoke retained document search through the actual tool and embedder registry."""

import argparse
import asyncio
import copy
import datetime
import json
import logging
import os
import time
from pathlib import Path
from unittest.mock import patch


async def acknowledged_write(write, control, endpoint):
    from nat_nv_ingest.nat_nv_ingest import (
        NvIngestFunctionConfig,
        _validate_embedding_dimension,
    )
    from nv_ingest_client.util.vdb import milvus as sdk

    (
        await control.post(endpoint + "/configure", json=write["settings"])
    ).raise_for_status()

    def perform():
        config = NvIngestFunctionConfig(  # nosec B106 - synthetic loopback credentials
            milvus_uri=write["uri"],
            milvus_username="synthetic-user",
            milvus_password="synthetic-password",
            embedder_dim=2,
            recreate_collection=write["recreate"],
        )

        class FixedDatetime(datetime.datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 10, 13, 12, 0, 0, tzinfo=tz)

        try:
            _validate_embedding_dimension(config, write["collection"])
            op = sdk.Milvus(
                collection_name=write["collection"],
                milvus_uri=write["uri"],
                username=config.milvus_username,
                password=config.milvus_password,
                gpu_index=False,
                gpu_search=False,
                dense_dim=2,
                recreate=write["recreate"],
                stream=True,
            )
            with patch.object(sdk.datetime, "datetime", FixedDatetime):
                op.run(copy.deepcopy(write["records"]))
            return True
        except Exception as error:
            print(f"Retained mutation outcome: {type(error).__name__}", flush=True)
            return False

    success = await asyncio.to_thread(perform)
    state = (await control.get(endpoint + "/script")).json()
    if success != write["success"] or state != {"remaining": 0, "errors": []}:
        raise AssertionError(f"Retained mutation failed: {success}; {state}")


async def invoke(case, control, endpoint):
    from daedalus_runtime.tools import ToolRegistry
    from nat_helpers.identity import authenticated_request_headers_scope
    from pydantic import ValidationError

    registry = ToolRegistry(case["configuration"])

    async def execute(invocation):
        for write in invocation.get("writes", []):
            await acknowledged_write(write, control, endpoint)
        if invocation.get("writes"):
            (
                await control.post(endpoint + "/configure", json=case["settings"])
            ).raise_for_status()
        if invocation.get("sleep"):
            await asyncio.sleep(invocation["sleep"])
        headers = {**case["headers"], **invocation.get("headers", {})}
        started = time.monotonic()
        try:
            with authenticated_request_headers_scope(headers):
                tool = await registry.get_function(invocation.get("tool", "documents"))
                result = await tool.ainvoke(invocation["input"])
            observed = {"result": result}
        except Exception as error:
            observed = {"error": type(error).__name__}
            if isinstance(error, ValidationError):
                observed["validation"] = error.errors(
                    include_input=False, include_url=False
                )
        if bounds := invocation.get("duration_range"):
            elapsed = time.monotonic() - started
            if not bounds[0] <= elapsed <= bounds[1]:
                raise AssertionError(
                    f"Retained {case['name']} took {elapsed:.3f}s, expected {bounds}"
                )
            print(f"Retained {case['name']} duration: {elapsed:.3f}s", flush=True)
        if invocation.get("settle"):
            await asyncio.sleep(invocation["settle"])
        return observed

    try:
        if case.get("parallel"):
            tasks = [
                asyncio.create_task(execute(invocation))
                for invocation in case["invocations"]
            ]
            try:
                async with asyncio.timeout(10):
                    while True:
                        calls = (await control.get(endpoint + "/calls")).json()
                        count = sum(call["method"] == "Search" for call in calls)
                        if count >= 8:
                            break
                        await asyncio.sleep(0.01)
                await asyncio.sleep(0.2)
                calls = (await control.get(endpoint + "/calls")).json()
                if sum(call["method"] == "Search" for call in calls) != 8:
                    raise RuntimeError(
                        "Retained retriever exceeded eight concurrent searches"
                    )
            finally:
                (await control.post(endpoint + "/release")).raise_for_status()
                results = await asyncio.gather(*tasks)
            return results
        return [await execute(invocation) for invocation in case["invocations"]]
    finally:
        await registry.close()


async def main(args):
    import httpx
    from daedalus_runtime.tools import load_tool_factories
    from pymilvus import connections
    from pymilvus.client.cache import GlobalCache

    fixture = json.loads(args.input.read_text())
    logging.disable(logging.CRITICAL)
    load_tool_factories()
    original_environment = dict(os.environ)
    observations = []
    async with httpx.AsyncClient(trust_env=False, timeout=15) as control:
        for case in fixture["cases"]:
            for alias, _ in connections.list_connections():
                connections.disconnect(alias)
            GlobalCache._reset_for_testing()
            os.environ.clear()
            os.environ.update(original_environment)
            os.environ.update(case["environment"])
            (
                await control.post(fixture["control"] + "/reset", json=case["settings"])
            ).raise_for_status()
            (
                await control.post(
                    fixture["embedding_control"] + "/__reset", json=case["embedding"]
                )
            ).raise_for_status()
            (
                await control.post(
                    fixture["reranking_control"] + "/__reset", json=case["reranking"]
                )
            ).raise_for_status()
            results = await invoke(case, control, fixture["control"])
            milvus = (await control.get(fixture["control"] + "/calls")).json()
            embedding = (
                await control.get(fixture["embedding_control"] + "/calls")
            ).json()
            reranking = (
                await control.get(fixture["reranking_control"] + "/calls")
            ).json()
            observations.append(
                {
                    "expected": results,
                    "milvus": milvus,
                    "embedding": embedding,
                    "reranking": reranking,
                }
            )
            print(
                f"Retained search {case['name']}: {len(milvus)} Milvus RPCs, {len(embedding)} embedding requests",
                flush=True,
            )
    # The tool service stringifies exception objects in validation contexts.
    args.output.write_text(
        json.dumps(observations, ensure_ascii=True, default=str) + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(main(parser.parse_args()))
