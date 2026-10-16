#!/usr/bin/env python3
"""Document HTTP contracts with real images, TLS/ACL RedisJSON, and NV-Ingest wire peers.

Without candidate arguments this captures the retained service only. With
candidate images it compares every response, attachment header, and NV-Ingest
job across the baseline, Python rollback, minimal Rust, and full Rust profiles.
"""

import argparse
import base64
import copy
import hashlib
import json
import socket
import threading
import time
from pathlib import Path

from image_check import environment, require, run
from profile_import_check import DEFAULT, ProfilePeers, expand

ROOT = Path(__file__).resolve().parents[1]


class DocumentPeers(ProfilePeers):
    def __init__(self):
        super().__init__()
        self.document_calls = []
        self.document_jobs = {}
        self.document_fault = None
        self.document_attempts = {}
        self.document_lock = threading.Lock()
        self.document_reply = DEFAULT

    def reset_documents(self, fault=None):
        with self.document_lock:
            self.document_calls.clear()
            self.document_attempts.clear()
            self.document_fault = fault

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def document_call(self, body=None):
                with peers.document_lock:
                    peers.document_calls.append(
                        {"method": self.command, "path": self.path, "body": body}
                    )
                    attempt = peers.document_attempts.get(self.command, 0)
                    peers.document_attempts[self.command] = attempt + 1
                    fault = peers.document_fault
                if fault and fault[0] == self.command and attempt < fault[2]:
                    if fault[1] == "lost":
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.close_connection = True
                    else:
                        self.reply({"detail": "synthetic peer failure"}, fault[1])
                    return True
                return False

            def do_POST(self):
                if self.path not in ["/v1/submit_job", "/v2/submit_job"]:
                    return super().do_POST()
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                job = json.loads(body["payload"])
                # Capture parsed payloads, including every job/task field.
                if self.document_call(job):
                    return
                key = "synthetic-job-" + str(len(peers.document_jobs))
                peers.document_jobs[key] = job
                self.reply(key)

            def do_GET(self):
                if not self.path.startswith(("/v1/fetch_job/", "/v2/fetch_job/")):
                    return super().do_GET()
                if self.document_call():
                    return
                if peers.document_reply is not DEFAULT:
                    self.reply(peers.document_reply)
                    return
                key = self.path.rsplit("/", 1)[-1]
                job = peers.document_jobs[key]
                payload = job["job_payload"]
                text = payload["content"][0]
                if payload["document_type"][0] not in ["text", "html"]:
                    text = "Synthetic binary document 雪🌲."
                self.reply(
                    {
                        "status": "success",
                        "description": "Synthetic document extraction",
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
                )

        return Handler


def exercise(image, redis_image, *, rust=False, minimal=False, settings=None):
    peers = DocumentPeers()
    records = []
    with environment(
        image,
        redis_image,
        minimal=minimal,
        memory=False,
        peers=peers,
        redis_json=True,
        extra_env=lambda port: {
            "DAEDALUS_PREPARATION": "rust" if rust else "python",
            "DAEDALUS_AUTHORIZATION": "rust" if rust else "python",
            "NV_INGEST_HOST": "127.0.0.1",
            "NV_INGEST_PORT": str(port),
            "DOCUMENT_INGEST_TIMEOUT_SECONDS": "10",
            **(settings or {}),
        },
    ) as fixture:
        ref = {"documentId": "document-1", "sessionId": "session-1"}

        def store(data, *, owner="synthetic-alice", filename="fixture.txt"):
            fixture["redis"].execute_command(
                "JSON.SET",
                "document:session-1:document-1",
                "$",
                json.dumps(
                    {
                        "userId": owner,
                        "filename": filename,
                        "data": base64.b64encode(data).decode(),
                    }
                ),
            )

        def call(name, body, *, route="extract", headers=None, fault=None):
            peers.reset_documents(fault)
            response = fixture["client"].post(
                fixture["base"] + "/v1/documents/" + route,
                headers=fixture["headers"] if headers is None else headers,
                json=body,
            )
            calls = copy.deepcopy(peers.document_calls)
            for outgoing in calls:
                if "/fetch_job/" in outgoing["path"]:
                    outgoing["path"] = outgoing["path"].rsplit("/", 1)[0] + "/JOB"
            result = {
                "name": name,
                "status": response.status_code,
                "body": response.json()
                if "application/json" in response.headers.get("content-type", "")
                else response.text,
                "headers": {
                    k: response.headers[k]
                    for k in [
                        "content-type",
                        "content-disposition",
                        "x-document-pages",
                        "x-original-chars",
                        "cache-control",
                    ]
                    if k in response.headers
                },
                "calls": calls,
            }
            records.append(result)
            if (
                response.status_code == 500
                and result["body"] == "Internal Server Error"
            ):
                # Uvicorn closes its connection after an uncaught response
                # encoding error. Let the retained proxy observe that close
                # before the next independent request; never replay a call.
                time.sleep(0.05)
            return result

        if settings is not None:
            call("configured-missing", {"documentRef": ref})
            store(b"Synthetic private fixture", owner="another-user")
            call("configured-foreign", {"documentRef": ref})
            for suffix in ["txt", "pdf"]:
                store(b"Synthetic configured fixture", filename="fixture." + suffix)
                call("configured-" + suffix, {"documentRef": ref})
            return records

        for route in ["extract", "markdown"]:
            result = call(
                "missing-auth-" + route, {"documentRef": ref}, route=route, headers={}
            )
            require(
                result["status"] == 401 and not result["calls"],
                "Missing document auth accepted",
            )
        validation = expand(
            json.loads((ROOT / "runtime/tests/fixtures/documents.json").read_text())
        )["validation"]
        for i, case in enumerate(validation):
            if case["status"] != 422:
                continue
            result = call(f"validation-{i}", case["input"], route=case["route"])
            require(
                result["status"] == 422
                and result["body"] == case["expected"]
                and not result["calls"],
                f"Document validation changed: {i}",
            )
        store("Synthetic document 雪🌲".encode())
        for route in ["extract", "markdown"]:
            result = call(
                "unicode-" + route,
                {"documentRef": {**ref, "filename": "forged.pdf", "userId": "forged"}},
                route=route,
            )
            require(result["status"] == 200, f"Document {route} failed: {result}")
        for limit in [1, 54, 55, 56, 57, 500000]:
            store(("Long synthetic 雪🌲 document. " * 3000).encode())
            result = call(
                "limit-" + str(limit), {"documentRef": ref, "char_limit": limit}
            )
            require(
                result["status"] == 200 and len(result["body"]["markdown"]) <= limit,
                "Inline character limit changed",
            )
        full = call(
            "complete-download", {"documentRef": ref, "char_limit": 1}, route="markdown"
        )
        require(
            full["status"] == 200
            and len(full["body"]) > 50000
            and int(full["headers"]["x-original-chars"]) == len(full["body"]),
            "Download truncated",
        )
        store(b"owner secret", owner="another-user")
        forbidden = call(
            "foreign-owner", {"documentRef": {**ref, "userId": "synthetic-alice"}}
        )
        require(
            forbidden["status"] == 403 and not forbidden["calls"],
            "Foreign document dispatched",
        )
        store(b"ownerless secret", owner=None)
        forbidden = call("ownerless-authenticated", {"documentRef": ref})
        require(
            forbidden["status"] == 403 and not forbidden["calls"],
            "Ownerless document disclosed",
        )
        anonymous = {**fixture["headers"], "x-user-id": "anonymous"}
        require(
            call("ownerless-anonymous", {"documentRef": ref}, headers=anonymous)[
                "status"
            ]
            == 200,
            "Legacy anonymous document rejected",
        )
        fixture["redis"].delete("document:session-1:document-1")
        missing = call("missing-record", {"documentRef": ref})
        require(
            missing["status"] == 404 and not missing["calls"],
            "Missing document changed",
        )
        encodings = expand(
            json.loads((ROOT / "runtime/tests/fixtures/documents.json").read_text())
        )["encodings"]
        for i, case in enumerate(encodings):
            store(base64.b64decode(case["data"]))
            result = call(f"encoding-{i}-{case['encoding']}", {"documentRef": ref})
            require(result["status"] == 200, f"Encoding probe failed: {result}")
            require(
                result["calls"][0]["body"]["job_payload"]["content"][0]
                == case["expected"]["ok"],
                "SDK text decode changed",
            )
        store(b"transport fixture")
        for method, status in [
            ("POST", 503),
            ("GET", 500),
            ("GET", 202),
            ("POST", 502),
            ("GET", 502),
            ("POST", "lost"),
            ("GET", "lost"),
        ]:
            result = call(
                f"fault-{method}-{status}",
                {"documentRef": ref},
                fault=(method, status, 1),
            )
            require(
                result["status"] == 200, f"NV-Ingest failure mapping changed: {result}"
            )
        for suffix in [
            "pdf",
            "docx",
            "pptx",
            "html",
            "json",
            "sh",
            "bmp",
            "jpg",
            "jpeg",
            "png",
            "svg",
            "tiff",
            "mp3",
            "wav",
            "mp4",
            "mov",
            "avi",
            "mkv",
            "unsupported",
        ]:
            store(b"Synthetic document", filename=f"fixture.{suffix}")
            call("filetype-" + suffix, {"documentRef": ref})
        envelopes = expand(
            json.loads((ROOT / "runtime/tests/fixtures/nv-ingest.json").read_text())
        )["results"]
        store(b"Synthetic document")
        for i, case in enumerate(envelopes):
            peers.document_reply = case["input"]
            for route in ["extract", "markdown"]:
                call(f"envelope-{i}-{route}", {"documentRef": ref}, route=route)
        for label, text in [
            ("visible", "A\ud800B"),
            ("html-removed", 'A<div title="\ud800">B</div>'),
            ("private-use", "\U000f0000A\ud800B"),
            ("entity-private-use", "&#983040;A\ud800B"),
        ]:
            peers.document_reply = {
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
            for route in ["extract", "markdown"]:
                call(
                    f"surrogate-reply-{label}-{route}",
                    {"documentRef": ref},
                    route=route,
                )
            call(
                f"surrogate-reply-{label}-limited",
                {"documentRef": ref, "char_limit": 1},
            )
        peers.document_reply = {"status": "success", "ignored": "\ud800", "data": []}
        call("surrogate-ignored", {"documentRef": ref})
        # Exercise the real nested JSON transport with isolated surrogates. The
        # scripted extractor returns safe text so its own UTF-8 response is not
        # confused with correctness of the submitted document text.
        peers.document_reply = {"status": "success", "data": []}
        for text in [
            "\ufeffSynthetic document " * 20 + "\ud800A\udfff",
            "\ufeff\ud800",
        ]:
            store(text.encode("utf_7"))
            result = call("utf7-surrogate-" + str(len(text)), {"documentRef": ref})
            require(result["status"] == 200, "UTF-7 document rejected")
            require(
                result["calls"][0]["body"]["job_payload"]["content"][0] == text,
                "UTF-7 surrogates were replaced in the NV-Ingest job",
            )
        peers.document_reply = DEFAULT
        # This repeated BOM-less UTF-8 sample is detected as Shift-JIS by the
        # retained SDK. Preserve that behavior during the migration.
        store(
            ("Synthetic S3 document 雪🌲 with complete content. " * 2000)
            .strip()
            .encode()
        )
        call("ambiguous-long-utf8", {"documentRef": ref})
        storage = expand(
            json.loads(
                (ROOT / "runtime/tests/fixtures/document-storage.json").read_text()
            )
        )["cases"]
        for i, case in enumerate(storage):
            record = copy.deepcopy(case["input"]["record"])
            if not isinstance(record, dict) or record.get("storage") == "object-v1":
                continue
            record["userId"] = "synthetic-alice"
            fixture["redis"].execute_command(
                "JSON.SET", "document:session-1:document-1", "$", json.dumps(record)
            )
            call(f"storage-{i}", {"documentRef": ref})
        if minimal:
            run(
                "docker",
                "exec",
                fixture["container"],
                "sh",
                "-c",
                "! command -v python && ! command -v python3",
            )
    return records


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--image")
    parser.add_argument("--full-image")
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if bool(args.image) != bool(args.full_image):
        parser.error("--image and --full-image must be supplied together")
    results = exercise(args.baseline, args.redis_image)
    images = [args.baseline, args.redis_image]
    if args.image:
        images += [args.image, args.full_image]
        for candidate, rust, minimal in [
            (args.full_image, False, False),
            (args.image, True, True),
            (args.full_image, True, False),
        ]:
            actual = exercise(candidate, args.redis_image, rust=rust, minimal=minimal)
            for old, new in zip(results, actual, strict=True):
                require(old == new, f"Document parity: expected={old}\nactual={new}")
        for settings in [
            {
                "DOCUMENT_INGEST_USE_V2_API": " yes ",
                "DOCUMENT_INGEST_EXTRACT_METHOD": "pdfium_hybrid",
                "DOCUMENT_INGEST_ENABLE_IMAGE_FILTER": "",
                "DOCUMENT_INGEST_PDF_PAGES_PER_CHUNK": "١_٢٩",
                "DOCUMENT_INGEST_TIMEOUT_SECONDS": "１_０.０",
                "DOCUMENT_INGEST_RETRY_DELAY": "1_0.0_1e-2",
            },
            {"DOCUMENT_INGEST_CHUNK_SIZE": "1.2"},
            {"DOCUMENT_INGEST_WORKER_POOL_SIZE": "0"},
        ]:
            old = exercise(args.baseline, args.redis_image, settings=settings)
            new = exercise(
                args.image, args.redis_image, rust=True, minimal=True, settings=settings
            )
            require(
                old == new,
                f"Document settings parity: {settings}\nexpected={old}\nactual={new}",
            )
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(
            {
                "status": "passed" if args.image else "baseline-capture-only",
                "profiles": 4 if args.image else 1,
                "operator_profiles": 6 if args.image else 0,
                "calls_per_profile": len(results),
                "images": {
                    image: run(
                        "docker",
                        "image",
                        "inspect",
                        image,
                        "--format",
                        "{{.Id}}",
                        capture_output=True,
                        text=True,
                    ).stdout.strip()
                    for image in images
                },
                "fixture_sha256": hashlib.sha256(
                    (ROOT / "runtime/tests/fixtures/documents.json").read_bytes()
                ).hexdigest(),
                "results": results,
            },
            ensure_ascii=True,
            indent=2,
        )
        + "\n"
    )
    print(
        f"Documents: {len(results)} HTTP calls/profile; "
        + ("four image profiles passed." if args.image else "baseline capture only.")
    )
