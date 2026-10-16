"""Freeze per-document orchestration, replacing storage and the SDK work body."""

import argparse
import asyncio
import base64
import copy
import json
import logging
from pathlib import Path
from unittest.mock import AsyncMock, patch

from export_authorization import BASELINE, fixture_strings


async def export(root):
    import nat_nv_ingest.nat_nv_ingest as document
    import redis

    reference = {
        "documentId": "synthetic-document",
        "sessionId": "synthetic-session",
        "filename": "Upload.txt",
    }
    stored = {
        "userId": "alice",
        "filename": "Stored 雪🌲.txt",
        "data": base64.b64encode(b"Synthetic text").decode(),
    }
    result = [
        [
            {
                "document_type": "text",
                "metadata": {
                    "content": "Synthetic extracted 雪🌲",
                    "content_metadata": {"page_number": 0},
                },
            }
        ]
    ]
    cases = []

    def add(name, **fields):
        request = {"documentRef": reference, "username": "alice"}
        request.update(fields.pop("request", {}))
        cases.append({"name": name, "request": request, **fields})

    add("success")
    for refs in [None, {}, [], "bad", {"documentId": "id"}, {"sessionId": "session"}]:
        add(f"invalid-reference-{len(cases)}", request={"documentRef": refs})
    for username in ["", "bob", " alice "]:
        add(f"user-{len(cases)}", request={"username": username})
    for collection in [None, "", "new", "old_alice", "nvidia", " NVIDIA "]:
        add(f"collection-{len(cases)}", request={"collection_name": collection})
    for scope in [None, "user", "shared", " USER ", "invalid"]:
        add(f"scope-{len(cases)}", request={"collection_scope": scope})
    for raw in [None, "", "not-json", "null", "[]", "{}"]:
        add(f"stored-json-{len(cases)}", raw=raw)
    for field, values in {
        "userId": [None, "", "bob", " alice ", 1],
        "filename": [None, "", 1, "odd.bin"],
        "data": [None, "", 1, "invalid", "AA=="],
    }.items():
        for value in values:
            add(f"stored-field-{len(cases)}", record={**stored, field: value})
    add("redis-error", storage_error=True)
    add("redis-initialization-error", redis_initialization_error=True)
    add("nv-initialization-error", nv_initialization_error=True)
    add("callback-errors", callback_error=True)
    add("chunk-overrides", request={"chunk_size": 32, "chunk_overlap": 0})
    add("config-chunks", config={"chunk_size": 64, "chunk_overlap": 4})
    add("provenance", request={"provenance": {"source": "synthetic"}})
    for stage in ["build", "ingest", "timeout"]:
        for failed_attempts in [1, 3]:
            add(
                f"{stage}-{failed_attempts}",
                error_stage=stage,
                failed_attempts=failed_attempts,
            )
    add("no-attempts", config={"ingest_max_retries": -1})
    for results in [
        [],
        [[]],
        [None],
        [{}],
        [[result[0][0], result[0][0]]],
        [[{"document_type": "unknown", "metadata": {}}]],
    ]:
        add(f"results-{len(cases)}", results=results)
    for failures in [
        [],
        [[]],
        [None],
        [["job-id", "Synthetic failure"]],
        [["a", "b"], ["c", "d"]],
    ]:
        add(f"failures-{len(cases)}", failures=failures)
    add(
        "failed-with-no-results", results=[], failures=[["job-id", "Synthetic failure"]]
    )
    add("render-error", results=[[{"document_type": "text", "metadata": None}]])

    output = []
    client_logger = logging.getLogger("nv_ingest_client.client.client")
    previous_level = client_logger.level
    client_logger.setLevel(logging.INFO)
    try:
        for case in cases:
            events, reads, builds = [], [], []
            attempts = 0

            async def emit(event):
                events.append(copy.deepcopy(event))
                if case.get("callback_error"):
                    raise RuntimeError("Synthetic callback failure")

            class Storage:
                def execute_command(self, *args):
                    reads.append(list(args))
                    if case.get("storage_error"):
                        raise redis.RedisError("Synthetic storage failure")
                    return case.get("raw", json.dumps(case.get("record", stored)))

            class Ingestor:
                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return False

                def ingest(self, **kwargs):
                    if kwargs != {"show_progress": False, "return_failures": True}:
                        raise RuntimeError("Unexpected SDK execution flags")
                    if attempts <= case.get("failed_attempts", 0):
                        if case.get("error_stage") == "ingest":
                            raise RuntimeError("Synthetic ingest failure")
                        if case.get("error_stage") == "timeout":
                            raise TimeoutError("Synthetic timeout")
                    client_logger.info("Batch processing finished")
                    return copy.deepcopy(case.get("results", result)), copy.deepcopy(
                        case.get("failures", [])
                    )

            def build(**kwargs):
                nonlocal attempts
                attempts += 1
                builds.append(
                    {
                        key: base64.b64encode(value).decode()
                        if isinstance(value, bytes)
                        else value
                        for key, value in kwargs.items()
                        if key not in {"nv_client", "config"}
                    }
                )
                if case.get("error_stage") == "build" and attempts <= case.get(
                    "failed_attempts", 0
                ):
                    raise RuntimeError("Synthetic build failure")
                return Ingestor()

            config = document.NvIngestFunctionConfig(
                **{"ingest_retry_delay": 0, **case.get("config", {})}
            )
            processor = document.NvIngestDocumentProcessor(config)
            get_redis = AsyncMock(return_value=Storage())
            get_nv = AsyncMock(return_value=object())
            if case.get("redis_initialization_error"):
                get_redis.side_effect = RuntimeError(
                    "Synthetic Redis initialization failure"
                )
            if case.get("nv_initialization_error"):
                get_nv.side_effect = RuntimeError("Synthetic NV initialization failure")
            with patch.object(processor, "_get_redis", get_redis), patch.object(
                processor, "_get_nv_client", get_nv
            ), patch.object(document, "_build_ingestor", build):
                expected = await processor.process_document(
                    **copy.deepcopy(case["request"]), progress_callback=emit
                )
            output.append(
                {
                    **case,
                    "expected": expected,
                    "events": events,
                    "reads": reads,
                    "builds": builds,
                }
            )
    finally:
        client_logger.setLevel(previous_level)
    (root / "tests/fixtures/document-process.json").write_text(
        json.dumps(
            fixture_strings(
                {
                    "baseline_sha": BASELINE,
                    "stored": stored,
                    "result": result,
                    "cases": output,
                }
            ),
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    print(f"Frozen {len(output)} retained per-document scenarios")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    asyncio.run(export(parser.parse_args().root))
