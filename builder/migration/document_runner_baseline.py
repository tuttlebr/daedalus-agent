"""Run the retained document processor with real storage and service clients."""

import argparse
import asyncio
import contextlib
import datetime
import json
import logging
import os
from pathlib import Path
from unittest.mock import patch


def text_observation(value):
    """Compare Python code units without putting invalid UTF-8 in fixture JSON."""
    if isinstance(value, str) and any(0xD800 <= ord(c) <= 0xDFFF for c in value):
        return {"$codepoints": [ord(c) for c in value]}
    return value


async def tool_calls(case, config):
    import httpx
    from nat_helpers.identity import authenticated_request_headers_scope
    from nat_nv_ingest.nat_nv_ingest import nv_ingest_function

    results = []
    with authenticated_request_headers_scope(case["headers"]):
        async with contextlib.asynccontextmanager(nv_ingest_function)(
            config, None
        ) as tool:
            async with httpx.AsyncClient(timeout=15, trust_env=False) as http:
                for index in range(case["invocations"]):
                    try:
                        if index == 0 and case.get("cancel"):
                            task = asyncio.create_task(tool.ainvoke(case["input"]))
                            async with asyncio.timeout(15):
                                while not (
                                    await http.get(case["nv_control"] + "/__tool/held")
                                ).json()["held"]:
                                    await asyncio.sleep(0.02)
                            task.cancel()
                            with contextlib.suppress(asyncio.CancelledError):
                                await task
                            results.append({"cancelled": True})
                        else:
                            headers = dict(case["headers"])
                            if "users" in case:
                                headers["x-user-id"] = case["users"][index]
                            with authenticated_request_headers_scope(headers):
                                results.append(
                                    {
                                        "result": text_observation(
                                            await tool.ainvoke(case["input"])
                                        )
                                    }
                                )
                    except Exception:
                        results.append({"error": True})
                if case.get("cancel"):
                    (
                        await http.post(case["nv_control"] + "/__tool/release")
                    ).raise_for_status()
                    async with asyncio.timeout(15):
                        while (
                            await http.get(case["milvus_control"] + "/script")
                        ).json()["remaining"]:
                            await asyncio.sleep(0.02)
    return results


async def main(args):
    import document_ingest_api
    from nat_nv_ingest.nat_nv_ingest import (
        NvIngestDocumentProcessor,
        NvIngestFunctionConfig,
    )
    from nv_ingest_client.util.vdb import milvus

    case = json.loads(args.input.read_text())
    os.environ.update(case["environment"])
    config = (
        NvIngestFunctionConfig(**case["tool_config"])
        if "tool_config" in case
        else document_ingest_api._default_config()
    )
    processor = NvIngestDocumentProcessor(config)
    events = []

    async def emit(event):
        events.append(event)

    class FixedDatetime(datetime.datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 10, 13, 12, 0, 0, tzinfo=tz)

    logging.getLogger("nv_ingest_client.client.client").setLevel(logging.INFO)
    # Only the receipt clock is deterministic; storage, SDK processing, and
    # both service transports run unchanged from the retained image.
    with patch.object(milvus.datetime, "datetime", FixedDatetime):
        if case.get("tool_call"):
            result = await tool_calls(case, config)
        else:
            result = await processor.process_document(
                **case["request"], progress_callback=emit
            )
    args.output.write_text(json.dumps({"result": result, "events": events}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(main(parser.parse_args()))
