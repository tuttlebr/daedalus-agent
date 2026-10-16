"""Freeze document storage checks and MinIO signing in the immutable baseline.

Only the object transport is replaced. All metadata checks, decoding, configuration
parsing, and signing execute the retained implementation with networking disabled.
"""

import argparse
import asyncio
import base64
import datetime
import io
import json
import os
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

from export_authorization import BASELINE, fixture_strings


async def export(root):
    import nat_nv_ingest.nat_nv_ingest as document
    from minio.credentials import Credentials
    from minio.signer import sign_v4_s3

    cases = []
    default_env = {
        "DOCUMENT_OBJECT_ENDPOINT": "http://synthetic.invalid:9000",
        "DOCUMENT_OBJECT_ACCESS_KEY": "synthetic-access",
        "DOCUMENT_OBJECT_SECRET_KEY": "synthetic-secret",
        "DOCUMENT_OBJECT_BUCKET": "synthetic-documents",
    }
    username, session_id, document_id = "alice", "session-1", "document-1"
    object_key = document._expected_document_object_key(
        prefix="daedalus-documents",
        username=username,
        session_id=session_id,
        document_id=document_id,
    )
    record = {
        "userId": username,
        "filename": "fixture.txt",
        "storage": "object-v1",
        "objectBucket": default_env["DOCUMENT_OBJECT_BUCKET"],
        "objectKey": object_key,
        "size": 4,
        "expiresAt": 2_000_000_000_001,
    }

    async def freeze(
        value, env=None, body=b"data", session=session_id, doc=document_id
    ):
        calls = []

        class Response(io.BytesIO):
            def release_conn(self):
                pass

        class Client:
            def get_object(self, bucket, key):
                calls.append([bucket, key])
                return Response(body)

        def factory(*args):
            # Preserve timeout validation even though the transport is synthetic.
            document._document_object_request_timeout_seconds()
            return Client()

        inputs = {
            "record": value,
            "env": {**default_env, **(env or {})},
            "body": base64.b64encode(body).decode(),
            "session": session,
            "document": doc,
            "username": username,
        }
        with (
            patch.dict(os.environ, inputs["env"], clear=True),
            patch.object(document, "_make_document_minio_client", factory),
            patch.object(document.time, "time", return_value=2_000_000_000),
        ):
            try:
                data, filename = await document._load_document_bytes(
                    document_record=value,
                    document_id=doc,
                    session_id=session,
                    username=username,
                )
                expected = {
                    "data": base64.b64encode(data).decode(),
                    "filename": filename,
                }
            except Exception as exc:
                expected = {"error": str(exc), "type": type(exc).__name__}
        cases.append({"input": inputs, "expected": expected, "calls": calls})

    await freeze(record)
    for field, values in {
        "filename": [None, "", 123, True, ["雪", "🌲"], {"x": "y"}],
        "size": [None, True, False, "4", 4.0, 0, -1, 3, 5, 10**30],
        "expiresAt": [
            None,
            "0",
            False,
            True,
            0,
            2_000_000_000_000,
            2_000_000_000_000.5,
        ],
        "objectBucket": [None, "wrong", 1],
        "objectKey": [None, "wrong", 1],
        "storage": [None, "", "wrong"],
        "data": [None, "", 1, "ZGF0YQ=="],
    }.items():
        for value in values:
            await freeze({**record, field: value})
    for data in [
        "AA==",
        "AB==",
        "AAA=",
        "AAB=",
        "AAAA",
        "AAAA=",
        "AAAA==",
        "AAAA===",
        "AA===",
        "AA====",
        "AAA==",
        "====",
        "=AAA",
        "AA=",
        "AA",
        "AAA",
        "A",
        "AAAA=AAAA",
        "AA==AA",
        "AA==\n",
        " AA==",
        "雪",
        "-_==",
        "A=AA",
        "AAAA====A",
    ]:
        await freeze({"data": data})
    for raw in ["", " ", "bad", "0", "-1", "3", "4", "5", "+3", "1_0", "３", "10" * 15]:
        await freeze(record, {"DOCUMENT_INGEST_MAX_SIZE_BYTES": raw})
        await freeze({"data": "ZGF0YQ=="}, {"DOCUMENT_INGEST_MAX_SIZE_BYTES": raw})
    for field, values in {
        "DOCUMENT_OBJECT_ENDPOINT": [
            "",
            "  ",
            "host:9000",
            "https://host:9000/",
            "http://",
            "http://host/path",
        ],
        "DOCUMENT_OBJECT_ACCESS_KEY": ["", "  "],
        "DOCUMENT_OBJECT_SECRET_KEY": ["", "  "],
        "DOCUMENT_OBJECT_BUCKET": ["", "  "],
        "DOCUMENT_OBJECT_PREFIX": ["", "  ", "../x", "a" * 129, " different "],
        "DOCUMENT_OBJECT_REQUEST_TIMEOUT_MS": [
            "",
            " ",
            "bad",
            "99",
            "100",
            "900000",
            "900001",
            "1_000",
            "+100",
            "１００",
        ],
    }.items():
        for value in values:
            await freeze(record, {field: value})
    for value in ["", " ", "../x", "雪", "a" * 129]:
        await freeze(record, session=value)
        await freeze(record, doc=value)
    await freeze(record, body=b"dat")
    await freeze(record, body=b"dataa")
    await freeze(record, {"DOCUMENT_INGEST_MAX_SIZE_BYTES": "4"}, body=b"dataa")
    await freeze(record, {"DOCUMENT_INGEST_MAX_SIZE_BYTES": "3"}, body=b"dataa")

    signatures = []
    for endpoint in ["http://synthetic.invalid:9000", "https://synthetic.invalid"]:
        for token in [None, "synthetic-session-token"]:
            for region in ["us-east-1", "us-west-2"]:
                date = datetime.datetime(2026, 1, 2, 3, 4, 5)
                # Match Minio._build_headers for GET (empty HTTP body).
                payload = (
                    "UNSIGNED-PAYLOAD"
                    if endpoint.startswith("https:")
                    else "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                )
                headers = {
                    "Host": urlsplit(endpoint).netloc,
                    "x-amz-content-sha256": payload,
                    "x-amz-date": "20260102T030405Z",
                }
                if token:
                    headers["X-Amz-Security-Token"] = token
                path = "/synthetic-documents/" + object_key
                sign_v4_s3(
                    method="GET",
                    url=urlsplit(endpoint + path),
                    region=region,
                    headers=headers,
                    credentials=Credentials(
                        "synthetic-access", "synthetic-secret", token
                    ),
                    content_sha256=payload,
                    date=date,
                )
                signatures.append(
                    {
                        "endpoint": endpoint,
                        "path": path,
                        "region": region,
                        "token": token,
                        "headers": headers,
                    }
                )
    fixture = {"baseline_sha": BASELINE, "cases": cases, "signatures": signatures}
    (root / "tests/fixtures/document-storage.json").write_text(
        json.dumps(fixture_strings(fixture), ensure_ascii=False, indent=2) + "\n"
    )
    print({"storage": len(cases), "signatures": len(signatures)})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    asyncio.run(export(parser.parse_args().root))
