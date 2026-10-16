"""Freeze ingest validation, summaries, jobs and Milvus record preparation."""

import argparse
import asyncio
import copy
import json
import os
from pathlib import Path
from unittest.mock import patch

from export_authorization import BASELINE, fixture_strings


async def export(root):
    import document_ingest_api as api
    import httpx
    import nat_nv_ingest.nat_nv_ingest as document
    from fastapi import FastAPI, HTTPException
    from nv_ingest_client.client import NvIngestClient
    from nv_ingest_client.util.vdb import milvus

    app = FastAPI()

    @app.post("/validate")
    async def validate(body: api.IngestRequest):
        return body.model_dump(exclude_none=True)

    reference = {"documentId": "document-1", "sessionId": "session-1"}
    inputs = [None, [], {}, {"documentRef": reference}]
    values = [None, "", " ", 0, -1, 1, True, False, [], {}, "雪🌲"]
    for field in [
        "documentRef",
        "documentRefs",
        "collection_name",
        "collection",
        "collection_scope",
        "provenance",
        "username",
        "chunk_size",
        "chunk_overlap",
    ]:
        inputs += [{"documentRef": reference, field: value} for value in values]
    for field in ["chunk_size", "chunk_overlap"]:
        inputs += [
            {"documentRef": reference, field: value}
            for value in [
                1.0,
                -0.0,
                1.5,
                1e30,
                -1e30,
                float(2**63 - 1024),
                float(2**63),
                float(2**64),
                10**30,
                "1.0",
                "01",
                "+2",
                "1_000",
                " 2 ",
                "１",
                "1e3",
                "1__0",
                "1_0.00",
                str(10**30),
            ]
        ]
    for field in ["documentId", "sessionId", "filename", "mimeType", "userId"]:
        for value in values:
            inputs.append({"documentRefs": [{**reference, field: value}, reference]})
    inputs += [
        {"documentRefs": value} for value in [[None], [{}], [[], "bad"], [reference]]
    ]
    validation = []
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://fixture"
    ) as client:
        for value in inputs:
            response = await client.post(
                "/validate",
                content=json.dumps(value),
                headers={"Content-Type": "application/json"},
            )
            validation.append(
                {
                    "input": value,
                    "status": response.status_code,
                    "expected": response.json(),
                }
            )

    resolutions = []
    for body in [
        {},
        {"documentRefs": []},
        {"documentRef": reference},
        {"documentRef": reference, "documentRefs": [reference, reference]},
        {"documentRef": reference, "documentRefs": []},
        {"documentRefs": [reference] * 500},
        {"documentRefs": [reference] * 501},
        *[
            {"documentRef": reference, field: value}
            for field in [
                "username",
                "collection",
                "collection_name",
                "collection_scope",
            ]
            for value in [
                None,
                "",
                " alice ",
                "alice",
                "bob",
                " NVIDIA ",
                "user",
                "shared",
            ]
        ],
        {
            "documentRef": reference,
            "collection": "old",
            "collection_name": "new",
            "provenance": {"source": "synthetic"},
        },
    ]:
        with patch.dict(
            os.environ, {"DAEDALUS_INTERNAL_API_TOKEN": "synthetic-token"}, clear=True
        ):
            try:
                expected = {
                    "ok": api._resolve_request(
                        api.IngestRequest(**body), "alice", "synthetic-token"
                    )
                }
            except HTTPException as error:
                expected = {"status": error.status_code, "detail": error.detail}
        resolutions.append({"input": body, "expected": expected})

    helpers = []

    def freeze(kind, value, function):
        try:
            expected = {"ok": function(copy.deepcopy(value))}
        except Exception as error:
            expected = {"error": type(error).__name__, "message": str(error)}
        helpers.append({"kind": kind, "input": value, "expected": expected})

    for count in [0, 1, 2, 10, 11]:
        for failed in [0, 1, 10, 11]:
            success = [
                {"id": f"success-{i} 雪🌲", "chunks": i, "pages": i + 1}
                for i in range(count)
            ]
            failures = [
                {"id": f"failure-{i}", "error": "Synthetic failure 雪🌲 " * 10}
                for i in range(failed)
            ]
            args = [
                count + failed,
                success,
                failures,
                123,
                9,
                "private_collection",
                1024,
                150,
            ]
            freeze("summary", args, lambda a: document.format_batch_response(*a))
    for value in [
        "",
        "Error: bad",
        " ERROR: bad",
        "Failed to process any documents",
        "Partially completed batch processing",
        "Success",
        "prefix ERROR: bad",
    ]:
        freeze("classify", value, api._classify_status)
    for refs in [
        [],
        [reference, reference],
        [reference, {**reference, "sessionId": "other"}],
        [None, {}, [], {"documentId": ""}, {"documentId": 0}],
        [{"documentId": True}, {"documentId": 1}, {"documentId": "1"}],
        [{"documentId": []}],
        [{"documentId": [1]}],
    ]:
        freeze("dedup", refs, document._dedup_document_refs)
    for value in [
        None,
        {},
        {"fields": []},
        {"fields": [None, 1]},
        {"fields": {"wrong": 1}},
    ]:
        freeze(
            "dimension", [value, "vector"], lambda a: document._extract_dense_dim(*a)
        )
    for dim in [None, "", "2", " ２_０ ", "2.0", 2, 2.8, True, [], {}, -1, 0, 10**30]:
        for preferred in [True, False]:
            desc = {
                "fields": [
                    {"name": "other", "params": {"dim": 7}},
                    {
                        "name": "vector" if preferred else "extra",
                        "params": {"dim": dim},
                    },
                ]
            }
            freeze(
                "dimension", [desc, "vector"], lambda a: document._extract_dense_dim(*a)
            )

    raw_entry = {
        "document_type": "text",
        "metadata": {
            "content": "Synthetic indexed 雪🌲",
            "embedding": [0.25, -0.5],
            "source_metadata": {
                "source_name": "synthetic.txt",
                "source_id": "synthetic.txt",
            },
            "content_metadata": {"page_number": 0},
            "extra": {"owner": "synthetic"},
        },
    }
    records = [None, [], [None], [[raw_entry]], [raw_entry], [[raw_entry], [raw_entry]]]
    for kind in ["text", "structured", "image", "audio", "unknown"]:
        for subtype in ["table", "chart", "infographic", "page_image", "other"]:
            entry = copy.deepcopy(raw_entry)
            entry["document_type"] = kind
            entry["metadata"]["content_metadata"]["subtype"] = subtype
            entry["metadata"]["table_metadata"] = {
                "table_content": "Table content",
                "table_location": [1, 2, 3, 4],
                "table_location_max_dimensions": [100, 200],
            }
            entry["metadata"]["image_metadata"] = {
                "caption": "Image caption",
                "text": "Page text",
                "image_location": [5, 6, 7, 8],
                "image_location_max_dimensions": [300, 400],
            }
            entry["metadata"]["audio_metadata"] = {"audio_transcript": "Audio content"}
            records.append([[entry]])
    for field, value in [
        ("embedding", None),
        ("embedding", []),
        ("content", ""),
        ("content", "雪" * 65535),
        ("content", "雪" * 65536),
        ("content_metadata", None),
        ("source_metadata", {}),
        ("embedding", "bad"),
    ]:
        entry = copy.deepcopy(raw_entry)
        entry["metadata"][field] = value
        records.append([[entry]])
    for record in records:
        freeze(
            "records",
            record,
            lambda r: {"records": milvus.cleanup_records(r), "results": r},
        )

    jobs = []
    client = NvIngestClient(message_client_hostname="127.0.0.1", message_client_port=1)
    with patch.object(document, "_validate_embedding_dimension"), patch.dict(
        os.environ, {"MINIO_BUCKET": "synthetic-index-fixture"}
    ):
        for extension in ["txt", "pdf", "docx"]:
            for chunk_size, chunk_overlap in [
                (1024, 150),
                (1, 0),
                (4, 5),
                (0, 0),
                (-1, -1),
                (10**30, 0),
            ]:
                config = document.NvIngestFunctionConfig(
                    minio_bucket="synthetic-index-fixture"
                )
                filename = "synthetic." + extension
                try:
                    ingestor = document._build_ingestor(
                        nv_client=client,
                        document_bytes=b"Synthetic document",
                        filename=filename,
                        config=config,
                        collection_name="private_collection",
                        chunk_size=chunk_size,
                        chunk_overlap=chunk_overlap,
                    )
                    expected = {"ok": ingestor._job_specs.to_dict()}
                except Exception as error:
                    expected = {"error": type(error).__name__, "message": str(error)}
                jobs.append(
                    {
                        "filename": filename,
                        "chunk_size": chunk_size,
                        "chunk_overlap": chunk_overlap,
                        "expected": expected,
                    }
                )
    output = {
        "baseline_sha": BASELINE,
        "validation": validation,
        "resolutions": resolutions,
        "helpers": helpers,
        "jobs": jobs,
        "weights": document._PROGRESS_PHASE_WEIGHTS,
    }
    print({k: len(output[k]) for k in ["validation", "resolutions", "helpers", "jobs"]})
    del output["helpers"]
    for i in range(3):
        (root / f"tests/fixtures/document-index-helpers-{i}.json").write_text(
            json.dumps(fixture_strings(helpers[i::3]), ensure_ascii=False, indent=2)
            + "\n"
        )
    (root / "tests/fixtures/document-index.json").write_text(
        json.dumps(fixture_strings(output), ensure_ascii=False, indent=2) + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    asyncio.run(export(parser.parse_args().root))
