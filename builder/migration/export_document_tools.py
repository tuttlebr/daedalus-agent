"""Freeze the model-facing document adapter's schemas and response formatting.

Run with --network none in the immutable baseline for legacy schemas, or with
--configured and the retained Python revision for current operation contracts.
This captures adapter contracts only; actual service acceptance is separate.
"""

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from export_authorization import BASELINE, fixture_strings


async def export(root, revision, configured):
    import daedalus_runtime.tools as definitions
    import pydantic
    from daedalus_runtime.retrieval import Document
    from nat_nv_ingest import nat_nv_ingest as document
    from pydantic import ValidationError

    with patch.dict(os.environ, {}, clear=True):
        default = document.NvIngestFunctionConfig()
        async with contextlib.asynccontextmanager(document.nv_ingest_function)(
            default, None
        ) as tool:
            if configured:
                tool.configure_contract("nat_nv_ingest", default)
            schema = tool.schema("user_documents")
            reference = {
                "documentId": "synthetic-document",
                "sessionId": "synthetic-session",
            }
            inputs = [
                {},
                {"operation": "list_collections"},
                {"operation": "search", "query": "Synthetic query"},
            ]
            for operation in [
                "ingest",
                "extract",
                "search",
                "list_collections",
                "invalid",
            ]:
                inputs.extend(
                    [
                        {"operation": operation, "documentRef": reference},
                        {"operation": operation, "documentRefs": [reference]},
                        {
                            "operation": operation,
                            "documentRef": reference,
                            "documentRefs": [reference],
                        },
                    ]
                )
            for name in document.UserDocumentInput.model_fields:
                base = {"operation": "ingest", "documentRef": reference}
                if name in {"query", "top_k", "filters"}:
                    base = {"operation": "search", "query": "Synthetic query"}
                elif name == "documentRefs":
                    base = {"operation": "ingest"}
                for value in [None, "", " ", 0, 1, -1, 1.5, True, [], {}, "雪🌲"]:
                    inputs.append({**base, name: value})
            for name in ["top_k", "chunk_size", "chunk_overlap"]:
                base = (
                    {"operation": "search", "query": "Synthetic query"}
                    if name == "top_k"
                    else {"operation": "ingest", "documentRef": reference}
                )
                for value in [
                    1.0,
                    -0.0,
                    float(2**63 - 1024),
                    float(2**63),
                    1e30,
                    10**30,
                    "1",
                    "1.0",
                ]:
                    inputs.append({**base, name: value})
            inputs += [
                {"operation": "list_collections", name: "forged"}
                for name in [
                    "username",
                    "user_id",
                    "collection_scope",
                    "input_message",
                    "unknown",
                ]
            ]
            validation = []
            for raw in inputs:
                errors = list(tool.validator.iter_errors(raw))[:8] if configured else []
                if errors:
                    expected = {
                        "contract_errors": [
                            {
                                "path": list(error.absolute_path),
                                "keyword": error.validator,
                            }
                            for error in errors
                        ]
                    }
                else:
                    try:
                        expected = {
                            "ok": document.UserDocumentInput.model_validate(
                                raw
                            ).model_dump(exclude_unset=True)
                        }
                    except ValidationError as error:
                        expected = {
                            "validation_errors": error.errors(
                                include_url=False,
                                include_context=False,
                                include_input=False,
                            )
                        }
                validation.append({"input": raw, "expected": expected})

        configuration = []
        for name in [*document.NvIngestFunctionConfig.model_fields, "unknown"]:
            for value in [None, "", "synthetic", 0, -1, 1, 1.5, True, [], {}]:
                raw = {name: value}
                try:
                    parsed = document.NvIngestFunctionConfig.model_validate(raw)
                    expected = {"ok": {name: getattr(parsed, name)}}
                except ValidationError as error:
                    expected = {
                        "errors": error.errors(
                            include_url=False,
                            include_context=False,
                            include_input=False,
                        )
                    }
                configuration.append({"input": raw, "expected": expected})

    environment_defaults = []
    for env, overrides in [
        ({}, {}),
        ({"MILVUS_USER": " synthetic-user "}, {}),
        ({"MILVUS_USERNAME": "", "MILVUS_USER": "fallback"}, {}),
        (
            {
                "MILVUS_USERNAME": "primary",
                "MILVUS_USER": "fallback",
                "MILVUS_PASSWORD": " synthetic-password ",
                "MILVUS_TOKEN": " synthetic-token ",
            },
            {},
        ),
        (
            {"MILVUS_USERNAME": "primary", "MILVUS_PASSWORD": "synthetic-password"},
            {"milvus_username": None, "milvus_password": ""},
        ),
        (
            {
                "MINIO_ENDPOINT": " endpoint ",
                "MINIO_ACCESS_KEY": " synthetic-access ",
                "MINIO_SECRET_KEY": " synthetic-secret ",
                "MINIO_BUCKET": " synthetic-bucket ",
            },
            {},
        ),
        ({"MINIO_BUCKET": " "}, {}),
        ({"MINIO_BUCKET": "", "MILVUS_TOKEN": ""}, {}),
        ({"MINIO_BUCKET": "ignored"}, {"minio_bucket": " explicit "}),
    ]:
        with patch.dict(os.environ, env, clear=True):
            parsed = document.NvIngestFunctionConfig.model_validate(overrides)
        environment_defaults.append(
            {"env": env, "input": overrides, "expected": parsed.model_dump()}
        )

    formatting = []
    for status in ["success", "partial", "failure"]:
        for markdown in ["", " ", "Synthetic **Markdown** 雪🌲\n\nContent."]:
            for pages, chunks in [(0, 0), (1, 2), (11, 123)]:
                result = {
                    "status": status,
                    "filename": "Synthetic 雪🌲.txt",
                    "chunks": chunks,
                    "failures": 2,
                    "pages": pages,
                    "collection": "private_collection",
                    "markdown": markdown,
                    "error": "Error: synthetic failure.",
                }
                formatting.append(
                    {
                        "kind": "single",
                        "input": result,
                        "expected": document.format_single_doc_response(result),
                    }
                )
    for status in ["success", "failure"]:
        for truncated in [False, True]:
            result = {
                "status": status,
                "filename": "Synthetic 雪🌲.txt",
                "pages": 2,
                "markdown": 'Synthetic "Markdown" 雪🌲\n\t\u007f',
                "truncated": truncated,
                "original_chars": 123456,
                "error": "Error: synthetic extraction failure.",
            }
            formatting.append(
                {
                    "kind": "extract",
                    "input": result,
                    "expected": document.format_extract_response(result),
                }
            )
    for results in [
        [],
        [{"page_content": "Synthetic passage 雪🌲", "metadata": {}}],
        [
            {
                "page_content": value,
                "metadata": {"filename": "Synthetic 雪🌲.txt", "distance": 1e-5},
            }
            for value in [None, "", "Synthetic passage"]
        ],
        [
            {"page_content": "Synthetic passage", "metadata": metadata}
            for metadata in [
                {
                    "source": "Source",
                    "document_id": "Document",
                    "title": "Title",
                    "distance": 0,
                },
                {
                    "filename": "",
                    "document_id": "Document",
                    "title": "Title",
                    "distance": -0.0,
                },
                {"filename": ["Synthetic", "source"], "distance": None},
                {"source": {}, "title": "Synthetic title", "distance": 10**30},
            ]
        ],
    ]:
        output = SimpleNamespace(
            results=[Document.model_validate(item) for item in results]
        )
        formatting.append(
            {
                "kind": "search",
                "input": {"results": results, "collection": "private_collection"},
                "expected": document.format_user_document_search_results(
                    output, "private_collection"
                ),
            }
        )

    identity = {
        "retained_revision": revision,
        "configured_contract": configured,
        "pydantic": pydantic.__version__,
        "source_sha256": {
            module.__name__: hashlib.sha256(
                Path(module.__file__).read_bytes()
            ).hexdigest()
            for module in [document, definitions]
        },
    }
    if configured:
        import daedalus_runtime.tool_contracts as contracts

        identity["source_sha256"][contracts.__name__] = hashlib.sha256(
            Path(contracts.__file__).read_bytes()
        ).hexdigest()
    resource = {
        **identity,
        "schema": schema,
        "configuration_schema": document.NvIngestFunctionConfig.model_json_schema(),
        "defaults": default.model_dump(),
    }
    fixtures = {
        **identity,
        "validation": validation,
        "configuration": configuration,
        "environment_defaults": environment_defaults,
        "formatting": formatting,
    }
    stem = "document-tools" if configured else "document-tools-legacy"
    for path, value in [
        (root / f"resources/{stem}.json", resource),
        (root / f"tests/fixtures/{stem}.json", fixture_strings(fixtures)),
    ]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--revision", default=BASELINE)
    parser.add_argument("--configured", action="store_true")
    args = parser.parse_args()
    if args.configured and args.revision == BASELINE:
        parser.error(
            "The baseline predates operation contracts; specify the retained revision"
        )
    asyncio.run(export(args.root, args.revision, args.configured))
