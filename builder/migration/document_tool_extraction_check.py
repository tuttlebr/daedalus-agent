#!/usr/bin/env python3
"""Compare staged tool extraction, including its ASCII JSON envelope, over services."""

import argparse
import copy
import json
from pathlib import Path

from document_runner_check import USER, scenarios
from document_tool_ingestion_check import main


def cases(oracle):
    originals = {case["name"]: case for case in scenarios(oracle)}
    results = []

    def add(name, source="success", **changes):
        case = copy.deepcopy(originals[source])
        case.update(
            {
                "name": name,
                "input": {
                    "operation": "extract",
                    "documentRef": case["request"]["documentRef"],
                },
                "tool_call": True,
                "invocations": 1,
                "tool_config": {},
                "invalid_global_redis": True,
                **changes,
            }
        )
        # Extraction may use NV-Ingest but must never contact the index or ledger.
        case["settings"]["script"] = []
        case["headers"] = {
            "x-user-id": USER,
            "x-daedalus-internal-token": "synthetic-internal",
            "x-daedalus-execution-scope": "autonomy",
            "x-daedalus-execution-id": "synthetic-extraction",
        }
        results.append(case)
        return case

    for name in [
        "success",
        "unicode-filename",
        "binary",
        "object",
        "object-foreign",
        "object-wrong-key",
        "object-expired",
        "missing",
        "foreign-owner",
        "unowned",
        "empty-data",
        "invalid-data",
        "null-record",
        "nv-failed",
        "empty",
    ]:
        add(name, name)
    for value in [[], "synthetic", 1, 1.25, True]:
        add("record-type-" + type(value).__name__, record=value)
    reference = originals["success"]["request"]["documentRef"]
    for value in [
        None,
        {},
        {"documentId": "synthetic-document"},
        {"sessionId": "synthetic-session"},
        {"documentId": 0, "sessionId": "synthetic-session"},
        {"documentId": "synthetic-document", "sessionId": False},
    ]:
        add(
            "invalid-reference-" + str(len(results)),
            input={"operation": "extract", "documentRef": value},
        )
    for field, value in [
        ("documentId", 123),
        ("sessionId", True),
        ("documentId", {"id": "a"}),
        ("documentId", "../synthetic"),
        ("sessionId", "雪"),
    ]:
        ref = {**reference, field: value}
        add(
            "reference-coercion-" + str(len(results)),
            input={"operation": "extract", "documentRef": ref},
            record_key=f"document:{ref['sessionId']}:{ref['documentId']}",
        )
    add(
        "batch-rejected",
        input={
            "operation": "extract",
            "documentRef": reference,
            "documentRefs": [reference],
        },
    )
    add(
        "empty-batch-ignored",
        input={"operation": "extract", "documentRef": reference, "documentRefs": []},
    )
    case = add("missing-user")
    case["headers"].pop("x-user-id")
    add("unused-chunk-settings", tool_config={"chunk_size": 0, "chunk_overlap": -1})
    add("no-workers", tool_config={"worker_pool_size": 0})
    add(
        "caption",
        tool_config={
            "enable_captioning": True,
            "caption_endpoint_url": "https://synthetic.invalid/v1/chat/completions",
            "caption_model_name": "synthetic-model",
            "caption_api_key": "synthetic-key",
        },
    )

    def content_case(name, text, **changes):
        reply = {
            "status": "success",
            "data": [
                {
                    "document_type": "text",
                    "metadata": {
                        "content": text,
                        "content_metadata": {"page_number": 0},
                    },
                }
            ],
        }
        return add(name, reply_json=json.dumps(reply), **changes)

    for name, text in [
        ("visible-surrogate", "A\ud800B\udfff"),
        ("literal-escape", r"A\ud800B"),
        ("private-use", "\U000f0000A\ud800B"),
        ("entity-private-use", "&#983040;A\ud800B"),
        ("removed-surrogate", '<div title="\ud800">Safe content</div>'),
        ("long-document", "Synthetic 雪🌲 " * 5000),
        ("truncated-surrogate", "a" * 50001 + "\ud800"),
        ("mixed-escapes", 'A"\\\n\r\t\x7f雪🌲\ud800B'),
    ]:
        content_case(name, text)
    record = {**originals["success"]["record"], "filename": "\U000f0000.txt"}
    content_case("filename-marker-collision", "A\ud800B", record=record)
    for value in [None, [], "bad", 7]:
        add(
            "invalid-metadata-" + str(len(results)),
            reply={
                "status": "success",
                "data": [{"document_type": "text", "metadata": value}],
            },
        )
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-image", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    main(
        parser.parse_args(),
        scenario_factory=cases,
        native_test="actual_extraction_adapter",
    )
