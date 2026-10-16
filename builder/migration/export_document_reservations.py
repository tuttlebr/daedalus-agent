"""Capture the retained tool's immutable upload identities and reservation flow.

Run in the retained Python image with --network none. Storage reads, reservation
I/O and the ingest side effect are substituted. Identity resolution, argument
construction, canonical hashes, and replay decisions run unchanged. Separate
real Redis and built-image acceptance are required before activating the port.
"""

import argparse
import asyncio
import contextlib
import copy
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from export_authorization import fixture_strings


async def export(root, revision):
    from nat_helpers import idempotency
    from nat_helpers.identity import authenticated_request_headers_scope
    from nat_nv_ingest import nat_nv_ingest as document

    user = "synthetic-alice"
    reference = {"documentId": "document-1", "sessionId": "session-1"}
    record = {"userId": user, "size": 9, "data": "U3ludGhldGlj"}
    key = "document:session-1:document-1"
    argument = {"operation": "ingest", "documentRef": reference}
    environment = {
        "DAEDALUS_INTERNAL_API_TOKEN": "synthetic-internal",
        "DOCUMENT_OBJECT_ENDPOINT": "http://synthetic.invalid:9000",
        "DOCUMENT_OBJECT_ACCESS_KEY": "synthetic-object-access",
        "DOCUMENT_OBJECT_SECRET_KEY": "synthetic-object-secret",
        "DOCUMENT_OBJECT_BUCKET": "synthetic-bucket",
    }
    object_record = {
        "userId": user,
        "storage": "object-v1",
        "size": 9,
        "objectBucket": "synthetic-bucket",
        "objectKey": f"daedalus-documents/{hashlib.sha256(user.encode()).hexdigest()[:32]}/session-1/document-1",
        "etag": "synthetic-etag",
    }
    cases = []

    def add(name, **changes):
        cases.append(
            {"name": name, "arguments": argument, "records": {key: record}, **changes}
        )

    add("legacy")
    add("object", records={key: object_record})
    add("object-expired-identity", records={key: {**object_record, "expiresAt": 1}})
    add("no-execution", execution="")
    add("interactive-scope", scope="interactive")
    add("missing", records={})
    for value in [None, [], "synthetic", 1]:
        add("not-a-record", records={key: value})
    for name, value in [
        ("userId", "someone-else"),
        ("userId", ""),
        ("data", ""),
        ("data", None),
        ("data", "Synthetic 雪🌲"),
        ("size", None),
        ("size", "9"),
        ("size", 10**30),
        ("size", {"z": -0.0, "a": 1e-5}),
        ("storage", "unknown-storage"),
    ]:
        add(f"legacy-{name}-{len(cases)}", records={key: {**record, name: value}})
    for name, value in [
        ("objectKey", "foreign/key"),
        ("objectKey", None),
        ("objectBucket", "other-bucket"),
        ("objectBucket", None),
        ("etag", None),
        ("etag", {"z": True, "a": ["雪🌲", 10**30]}),
    ]:
        add(
            f"object-{name}-{len(cases)}", records={key: {**object_record, name: value}}
        )
    for name in ["documentId", "sessionId"]:
        for value in [None, "", 1, "../escape", "雪", "x" * 129]:
            add(
                f"reference-{name}-{len(cases)}",
                arguments={
                    **argument,
                    "documentRef": {**reference, name: value},
                },
            )
    for name, value in [
        ("collection_name", "nvidia"),
        ("collection_name", "synthetic-private-alias"),
        ("chunk_size", 17),
        ("chunk_overlap", 0),
        ("chunk_overlap", 7),
    ]:
        add(f"argument-{name}-{len(cases)}", arguments={**argument, name: value})
    add(
        "duplicates",
        arguments={"operation": "ingest", "documentRefs": [reference, reference]},
    )
    add("config-chunks", config={"chunk_size": 7, "chunk_overlap": 3})
    for state, result in [
        ("in_progress", None),
        ("invalid", None),
        ("completed", None),
        ("completed", ""),
        ("completed", "Stored synthetic receipt 雪🌲"),
    ]:
        add(
            f"existing-{state}-{len(cases)}",
            reservation={"state": state, "result": result},
        )
    add("completion-not-owned", complete=False)
    for name, value in [
        ("DOCUMENT_OBJECT_BUCKET", ""),
        ("DOCUMENT_OBJECT_PREFIX", "../unsafe"),
        ("DOCUMENT_OBJECT_ENDPOINT", "invalid/path"),
    ]:
        add(f"environment-{name}", records={key: object_record}, env={name: value})

    for case in cases:
        calls = []

        def read(command, document_key):
            calls.append({"read": [command, document_key]})
            if document_key not in case["records"]:
                return None
            return json.dumps(case["records"][document_key]).encode()

        async def reserve(**kwargs):
            digest = idempotency.canonical_arguments_sha256(kwargs["arguments"])
            reserved_key = idempotency.operation_key(
                user_id=kwargs["user_id"],
                execution_id=kwargs["execution_id"],
                operation=kwargs["operation"],
                arguments_sha256=digest,
            )
            calls.append(
                {
                    "reserve": copy.deepcopy(kwargs),
                    "digest": digest,
                    "key": reserved_key,
                }
            )
            state = case.get("reservation")
            return idempotency.Reservation(
                reserved_key,
                None if state else "synthetic-owner",
                state["state"] if state else "in_progress",
                state.get("result") if state else None,
            )

        async def complete(reservation, result):
            calls.append({"complete": {"key": reservation.key, "result": result}})
            return case.get("complete", True)

        async def single(_processor, **kwargs):
            calls.append({"single": kwargs})
            return {
                "status": "success",
                "filename": "fixture.txt",
                "chunks": 1,
                "pages": 1,
                "failures": 0,
                "collection": "private_collection",
                "markdown": "Synthetic receipt",
                "error": "",
            }

        async def batch(_processor, **kwargs):
            calls.append({"batch": kwargs})
            return "Synthetic batch receipt"

        headers = {
            "x-user-id": user,
            "x-daedalus-internal-token": "synthetic-internal",
            "x-daedalus-execution-scope": case.get("scope", "autonomy"),
            "x-daedalus-execution-id": case.get("execution", "synthetic-execution"),
        }
        with patch.dict(
            os.environ, {**environment, **case.get("env", {})}, clear=True
        ), authenticated_request_headers_scope(headers), patch.object(
            document.NvIngestDocumentProcessor,
            "_get_redis",
            AsyncMock(return_value=SimpleNamespace(execute_command=read)),
        ), patch.object(
            document.NvIngestDocumentProcessor, "process_document", single
        ), patch.object(
            document.NvIngestDocumentProcessor, "process_multiple_documents", batch
        ), patch.object(idempotency, "reserve_operation", reserve), patch.object(
            idempotency, "complete_operation", complete
        ):
            config = document.NvIngestFunctionConfig(**case.get("config", {}))
            async with contextlib.asynccontextmanager(document.nv_ingest_function)(
                config, None
            ) as tool:
                try:
                    result = await tool.ainvoke(case["arguments"])
                    expected = {"result": result}
                except Exception as error:
                    expected = {"error": type(error).__name__, "message": str(error)}
        case["expected"] = {**expected, "calls": calls}
    if not any("reserve" in call for call in cases[0]["expected"]["calls"]):
        raise AssertionError("The autonomous fixture did not reserve its ingest")
    if not any("complete" in call for call in cases[0]["expected"]["calls"]):
        raise AssertionError("The autonomous fixture did not complete its ingest")
    if len(cases[3]["expected"]["calls"]) != 1:
        raise AssertionError("The interactive fixture unexpectedly reserved an ingest")
    output = {
        "retained_revision": revision,
        "source_sha256": {
            module.__name__: hashlib.sha256(
                Path(module.__file__).read_bytes()
            ).hexdigest()
            for module in [document, idempotency]
        },
        "user": user,
        "environment": environment,
        "cases": cases,
    }
    target = root / "tests/fixtures/document-reservations.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(fixture_strings(output), ensure_ascii=False, indent=2) + "\n"
    )
    print({"cases": len(cases)})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    asyncio.run(export(args.root, args.revision))
