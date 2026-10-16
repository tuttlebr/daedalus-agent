"""Capture named-tool pipeline options from the immutable Python baseline.

Run with --network none. Only the dimension read is replaced; job construction,
caption validation and the local Milvus operator use the pinned SDK unchanged.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
from unittest.mock import patch

from export_authorization import BASELINE, fixture_strings


def export(root):
    from nat_nv_ingest import nat_nv_ingest as document
    from nv_ingest_client.client import NvIngestClient

    client = NvIngestClient(message_client_hostname="127.0.0.1", message_client_port=1)
    caption = {
        "enable_captioning": True,
        "caption_endpoint_url": "https://synthetic.invalid/v1/chat/completions",
        "caption_model_name": "synthetic-model",
    }
    profiles = [{}, caption, {**caption, "enable_captioning": False}]
    for field in ["caption_endpoint_url", "caption_model_name", "caption_api_key"]:
        for value in [None, "", " ", "Synthetic 雪🌲"]:
            profiles.append({**caption, field: value})
    profiles += [
        {**caption, "enable_image_filter": False},
        {**caption, "use_v2_api": True, "pdf_pages_per_chunk": 500},
        {**caption, "extract_method": "ocr"},
        {"recreate_collection": True},
        {"chunk_size": 4, "chunk_overlap": 0, "tokenizer": "synthetic-tokenizer"},
        {"chunk_size": 0},
        {"milvus_username": " user ", "milvus_password": " password "},
        {"milvus_token": " user:password "},
        {"milvus_token": "synthetic-opaque-token"},
        {"minio_bucket": "different-bucket"},
        {"minio_bucket": ""},
    ]
    inputs = [(raw, {}) for raw in profiles]
    inputs += [
        (raw, {"MINIO_BUCKET": bucket})
        for bucket in ["synthetic-bucket", "", " synthetic-bucket "]
        for raw in [{}, {"minio_bucket": bucket}]
    ]
    cases = []
    for raw, env in inputs:
        for filename in ["fixture.txt", "fixture.pdf"]:
            for extract_only in [True, False]:
                with patch.dict(os.environ, env, clear=True), patch.object(
                    document, "_validate_embedding_dimension"
                ) as probe:
                    config = document.NvIngestFunctionConfig(**raw)
                    try:
                        ingestor = document._build_ingestor(
                            nv_client=client,
                            document_bytes=b"Synthetic",
                            filename=filename,
                            config=config,
                            collection_name="private_collection",
                            chunk_size=config.chunk_size,
                            chunk_overlap=config.chunk_overlap,
                            extract_only=extract_only,
                        )
                        expected = {"ok": ingestor._job_specs.to_dict()}
                        if not extract_only:
                            operator = ingestor._vdb_bulk_upload
                            expected["writer"] = {
                                field: getattr(operator, field)
                                for field in [
                                    "collection_name",
                                    "milvus_uri",
                                    "dense_dim",
                                    "recreate",
                                    "username",
                                    "password",
                                    "stream",
                                ]
                            }
                    except Exception as error:
                        expected = {
                            "error": type(error).__name__,
                            "message": str(error),
                        }
                    cases.append(
                        {
                            "input": raw,
                            "env": env,
                            "filename": filename,
                            "extract_only": extract_only,
                            "dimension_probes": probe.call_count,
                            "expected": expected,
                        }
                    )
    output = {
        "baseline_sha": BASELINE,
        "source_sha256": hashlib.sha256(
            Path(document.__file__).read_bytes()
        ).hexdigest(),
        "cases": cases,
    }
    target = root / "tests/fixtures/document-tool-pipeline.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(fixture_strings(output), ensure_ascii=False, indent=2) + "\n"
    )
    print({"cases": len(cases)})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    export(parser.parse_args().root)
