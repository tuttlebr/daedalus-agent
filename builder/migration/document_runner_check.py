#!/usr/bin/env python3
"""Compare complete processors using TLS/ACL RedisJSON and HTTP/gRPC peers."""

import argparse
import base64
import contextlib
import copy
import hashlib
import hmac
import json
import os
import subprocess  # nosec B404 - disposable fixture containers
import threading
import time
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path

import redis
from collections_check import milvus_fixture
from documents_check import DocumentPeers
from image_check import require, run
from profile_import_check import expand
from runtime_http_check import free_port

ROOT = Path(__file__).resolve().parents[1]
KEY = "document:synthetic-session:synthetic-document"
USER = "synthetic-alice"
COLLECTION = "user_uploads_synthetic_alice_" + hashlib.sha256(USER.encode()).hexdigest()


def normalized_nv(calls):
    calls = copy.deepcopy(calls)
    for call in calls:
        if "/fetch_job/" in call["path"]:
            call["path"] = call["path"].rsplit("/", 1)[0] + "/JOB"
    return calls


class RunnerPeers(DocumentPeers):
    def __init__(self, admin):
        super().__init__()
        self.admin = admin
        self.object_calls = []

    def reset(self, case):
        self.reset_documents()
        self.document_reply = case["reply"]
        self.object_calls.clear()
        self.admin.delete(KEY)
        if not case.get("missing"):
            self.admin.execute_command("JSON.SET", KEY, "$", json.dumps(case["record"]))

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def do_POST(self):
                if self.path == "/__runner/reset":
                    body = json.loads(
                        self.rfile.read(int(self.headers["Content-Length"]))
                    )
                    peers.reset(body)
                    return self.reply({"ok": True})
                return super().do_POST()

            def do_GET(self):
                if self.path.startswith("/synthetic-documents/"):
                    auth = self.headers.get("Authorization", "")
                    fields = dict(
                        part.strip().split("=", 1)
                        for part in auth.removeprefix("AWS4-HMAC-SHA256 ").split(",")
                        if "=" in part
                    )
                    credential = fields.get("Credential", "").split("/")
                    names = fields.get("SignedHeaders", "")
                    canonical = (
                        "GET\n"
                        + self.path
                        + "\n\n"
                        + "".join(
                            name + ":" + self.headers.get(name, "").strip() + "\n"
                            for name in names.split(";")
                        )
                        + "\n"
                        + names
                        + "\n"
                        + self.headers.get("x-amz-content-sha256", "")
                    )
                    scope = "/".join(credential[1:])
                    signed = (
                        "AWS4-HMAC-SHA256\n"
                        + self.headers.get("x-amz-date", "")
                        + "\n"
                        + scope
                        + "\n"
                        + hashlib.sha256(canonical.encode()).hexdigest()
                    )
                    key = b"AWS4synthetic-object-secret"
                    for item in credential[1:]:
                        key = hmac.digest(key, item.encode(), "sha256")
                    valid = (
                        len(credential) == 5
                        and credential[0] == "synthetic-object-access"
                        and credential[2:] == ["us-east-1", "s3", "aws4_request"]
                        and hmac.compare_digest(
                            fields.get("Signature", ""),
                            hmac.new(key, signed.encode(), "sha256").hexdigest(),
                        )
                    )
                    peers.object_calls.append(
                        {"method": "GET", "path": self.path, "signature_valid": valid}
                    )
                    content = b"Synthetic document"
                    self.send_response(200 if valid else 403)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)
                    return
                if self.path == "/__runner/calls":
                    return self.reply(
                        {
                            "nv_calls": normalized_nv(peers.document_calls),
                            "object_calls": peers.object_calls,
                        }
                    )
                return super().do_GET()

        return Handler


@contextlib.contextmanager
def redis_fixture(root, image):
    port = free_port()
    name = "daedalus-ingest-redis-" + uuid.uuid4().hex[:10]
    (root / "users.acl").write_text(
        "user default off\n"
        "user fixture-admin on >synthetic-admin ~* &* +@all\n"
        "user backend on >synthetic-backend ~document:* +@connection +json.get\n"
    )
    quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    admin = redis.Redis(  # nosec B106 - disposable fixture credentials
        host="localhost",
        port=port,
        username="fixture-admin",
        password="synthetic-admin",
        ssl=True,
        ssl_ca_certs=str(root / "ca.crt"),
    )
    try:
        run(
            "docker",
            "run",
            "-d",
            "--rm",
            "--name",
            name,
            "--network",
            "host",
            "-v",
            f"{root}:/fixture:ro",
            "--entrypoint",
            "redis-server",
            image,
            "--bind",
            "127.0.0.1",
            "--port",
            "0",
            "--tls-port",
            str(port),
            "--tls-cert-file",
            "/fixture/server.crt",
            "--tls-key-file",
            "/fixture/server.key",
            "--tls-ca-cert-file",
            "/fixture/ca.crt",
            "--tls-auth-clients",
            "no",
            "--aclfile",
            "/fixture/users.acl",
            "--save",
            "",
            "--appendonly",
            "no",
            "--loadmodule",
            "/opt/redis-stack/lib/rejson.so",
            **quiet,
        )
        until = time.monotonic() + 30
        while True:
            try:
                if admin.ping():
                    break
            except redis.ConnectionError:
                require(time.monotonic() < until, "Redis runner fixture did not start")
                time.sleep(0.1)
        yield (
            admin,
            f"rediss://backend:synthetic-backend@localhost:{port}?ssl_ca_certs={root / 'ca.crt'}",
        )
    finally:
        admin.close()
        run("docker", "stop", "-t", "1", name, check=False, **quiet)


def scenarios(oracle, *, tool_options=False):
    normal = oracle["cases"][0]
    stored = {
        "userId": USER,
        "filename": "fixture.txt",
        "data": base64.b64encode(b"Synthetic document").decode(),
    }
    request = {
        "documentRef": {
            "documentId": "synthetic-document",
            "sessionId": "synthetic-session",
            "filename": "Upload.txt",
        },
        "username": USER,
    }
    cases = []

    def add(
        name,
        *,
        index=normal,
        request_changes=None,
        record_changes=None,
        record=stored,
        missing=False,
        writes=True,
        probe=False,
        failed=False,
        tool_config=None,
    ):
        script = [call for call in index["calls"] if call["method"] != "Connect"]
        if not writes:
            script = script[:1] if probe else []
        cases.append(
            {
                "name": name,
                "request": {**request, **(request_changes or {})},
                "record": {**record, **record_changes} if record_changes else record,
                "missing": missing,
                "reply": {"status": "failed"}
                if failed
                else {
                    "status": "success",
                    "data": index["records"][0] if index["records"] else [],
                },
                "settings": {
                    "script": script,
                    "rename_collections": {"private_collection": COLLECTION},
                },
            }
        )
        if tool_config is not None:
            cases[-1]["tool_config"] = tool_config

    add("success")
    add("unicode-filename", record_changes={"filename": "Synthetic 雪🌲.txt"})
    add("binary", record_changes={"filename": "fixture.pdf"})
    object_record = {
        "userId": USER,
        "filename": "fixture.txt",
        "storage": "object-v1",
        "objectBucket": "synthetic-documents",
        "size": len(b"Synthetic document"),
        "objectKey": f"daedalus-documents/{hashlib.sha256(USER.encode()).hexdigest()[:32]}/synthetic-session/synthetic-document",
        "expiresAt": int(time.time() * 1000) + 3600000,
    }
    add("object", record=object_record)
    add(
        "object-foreign",
        record={**object_record, "userId": "another-user"},
        writes=False,
    )
    add(
        "object-wrong-key",
        record={**object_record, "objectKey": "foreign/key"},
        writes=False,
    )
    add("object-expired", record={**object_record, "expiresAt": 1}, writes=False)
    add("missing", missing=True, writes=False)
    add("foreign-owner", record_changes={"userId": "another-user"}, writes=False)
    add("unowned", record_changes={"userId": ""}, writes=False)
    add("empty-data", record_changes={"data": ""}, writes=False)
    add("invalid-data", record_changes={"data": "invalid"}, writes=False)
    add("null-record", record=None, writes=False)
    add("shared-scope", request_changes={"collection_name": "nvidia"}, writes=False)
    add("bad-chunks", request_changes={"chunk_overlap": 1024}, writes=False, probe=True)
    add("nv-failed", writes=False, probe=True, failed=True)
    for mode in ["empty", "no-embedding", "reject-Insert:private_collection"]:
        add(mode, index=next(case for case in oracle["cases"] if case["mode"] == mode))
    add(
        "dimension-mismatch",
        index=next(case for case in oracle["cases"] if case["dimension"] == 3),
    )
    if not tool_options:
        return cases
    add("tool-defaults", tool_config={})
    add(
        "tool-caption",
        tool_config={
            "enable_captioning": True,
            "caption_endpoint_url": "https://synthetic.invalid/v1/chat/completions",
            "caption_model_name": "synthetic-caption-model",
            "caption_api_key": "synthetic-caption-key",
            "enable_image_filter": False,
        },
    )
    add(
        "tool-recreate",
        tool_config={"recreate_collection": True},
        index=next(case for case in oracle["cases"] if case["recreate"]),
    )
    add(
        "tool-bucket-mismatch",
        tool_config={"minio_bucket": "different-bucket"},
        writes=False,
        probe=True,
    )
    add("api-empty-bucket")
    add("api-whitespace-bucket")
    return cases


def main(args):
    oracle = expand(
        json.loads((ROOT / "runtime/tests/fixtures/milvus-index.json").read_text())
    )
    profiles = []
    with milvus_fixture(args.sdk_image) as fixture, redis_fixture(
        fixture["root"], args.redis_image
    ) as (admin, redis_url):
        root = fixture["root"]
        peers = RunnerPeers(admin)
        server = ThreadingHTTPServer(("127.0.0.1", 0), peers.handler())
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            for profile, uri in [
                ("plain", f"http://127.0.0.1:{fixture['port']}"),
                ("tls", f"https://localhost:{fixture['tls_port']}"),
                ("uri-database", f"http://127.0.0.1:{fixture['port']}/synthetic-db"),
            ]:
                cases = scenarios(oracle, tool_options=True)
                if profile != "plain":
                    cases = [
                        cases[0],
                        next(case for case in cases if case["name"] == "tool-defaults"),
                    ]
                environment = {
                    "REDIS_URL": redis_url,
                    "NV_INGEST_HOST": "127.0.0.1",
                    "NV_INGEST_PORT": str(server.server_port),
                    "MILVUS_URI": uri,
                    "MILVUS_USERNAME": "synthetic-user",
                    "MILVUS_PASSWORD": "synthetic-password",
                    "EMBEDDING_DENSE_DIM": "2",
                    "DOCUMENT_INGEST_MAX_RETRIES": "0",
                    "DOCUMENT_INGEST_RETRY_DELAY": "0",
                    "DOCUMENT_INGEST_TIMEOUT_SECONDS": "30",
                    "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH": str(root / "ca.crt"),
                    "DOCUMENT_OBJECT_ENDPOINT": f"http://127.0.0.1:{server.server_port}",
                    "DOCUMENT_OBJECT_ACCESS_KEY": "synthetic-object-access",
                    "DOCUMENT_OBJECT_SECRET_KEY": "synthetic-object-secret",
                    "DOCUMENT_OBJECT_BUCKET": "synthetic-documents",
                }
                for case in cases:
                    case["environment"] = environment.copy()
                    if case["name"] in {"api-empty-bucket", "api-whitespace-bucket"}:
                        case["environment"]["MINIO_BUCKET"] = (
                            "" if case["name"] == "api-empty-bucket" else " nv-ingest "
                        )
                    if "tool_config" in case:
                        case["tool_config"] = {
                            "redis_url": redis_url,
                            "nv_ingest_host": "127.0.0.1",
                            "nv_ingest_port": server.server_port,
                            "milvus_uri": uri,
                            "milvus_username": "synthetic-user",
                            "milvus_password": "synthetic-password",
                            "milvus_token": None,
                            "embedder_dim": 2,
                            "ingest_max_retries": 0,
                            "ingest_retry_delay": 0,
                            "ingest_timeout_seconds": 30,
                            **case["tool_config"],
                        }
                        case["environment"].update(
                            {
                                "REDIS_URL": "invalid-global-url",
                                "REDIS_PORT": "invalid-global-port",
                                "REDIS_TLS_CA_FILE": "unavailable-global-ca",
                                "DOCUMENT_INGEST_CHUNK_SIZE": "invalid-global-chunk-size",
                            }
                        )
                    case["settings"]["uri"] = uri
                    peers.reset(case)
                    fixture["control"].post(
                        "/reset", json=case["settings"]
                    ).raise_for_status()
                    (root / "input.json").write_text(json.dumps(case))
                    with (root / "baseline.log").open("w+") as log:
                        result = run(
                            "docker",
                            "run",
                            "--rm",
                            "--network",
                            "host",
                            "-e",
                            "PYTHONPATH=/workspace",
                            "-v",
                            f"{root}:{root}",
                            "-v",
                            f"{ROOT / 'migration'}:/migration:ro",
                            "--entrypoint",
                            "/workspace/.venv/bin/python",
                            args.sdk_image,
                            "/migration/document_runner_baseline.py",
                            "--input",
                            str(root / "input.json"),
                            "--output",
                            str(root / "output.json"),
                            stdout=log,
                            stderr=log,
                            check=False,
                        )
                        require(
                            result.returncode == 0,
                            "Baseline runner failed: "
                            + (root / "baseline.log").read_text()[-3000:],
                        )
                    case["expected"] = json.loads((root / "output.json").read_text())
                    case["expected"]["nv_calls"] = normalized_nv(peers.document_calls)
                    case["expected"]["object_calls"] = copy.deepcopy(peers.object_calls)
                    require(
                        len(peers.object_calls) == int(case["name"] == "object"),
                        "Unexpected object storage request",
                    )
                    require(
                        all(call["signature_valid"] for call in peers.object_calls),
                        "Invalid S3 request signature",
                    )
                    state = fixture["control"].get("/script").json()
                    require(
                        state == {"remaining": 0, "errors": []},
                        f"Baseline {case['name']}: {state}; {case['expected']['result']}",
                    )
                    print(f"Retained runner: {profile}/{case['name']}", flush=True)
                path = root / "runner.json"
                path.write_text(
                    json.dumps(
                        {
                            "cases": cases,
                            "control": str(fixture["control"].base_url).rstrip("/"),
                            "nv_control": f"http://127.0.0.1:{server.server_port}",
                        }
                    )
                )
                args.report.parent.mkdir(parents=True, exist_ok=True)
                evidence = args.report.with_name(
                    args.report.stem + "-" + profile + "-cases.json"
                )
                evidence.write_text(
                    json.dumps(
                        [
                            {
                                key: case[key]
                                for key in [
                                    "name",
                                    "request",
                                    "record",
                                    "tool_config",
                                    "environment",
                                    "expected",
                                ]
                                if key in case
                            }
                            for case in cases
                        ],
                        indent=2,
                    )
                    + "\n"
                )
                run(
                    "cargo",
                    "test",
                    "--locked",
                    "--manifest-path",
                    str(ROOT / "runtime/Cargo.toml"),
                    "document_pipeline::tests::actual_stored_document_runner",
                    "--",
                    "--ignored",
                    "--nocapture",
                    env={**os.environ, "DAEDALUS_DOCUMENT_RUNNER_FIXTURE": str(path)},
                )
                profiles.append(
                    {
                        "name": profile,
                        "cases": len(cases),
                        "evidence": str(evidence),
                        "evidence_sha256": hashlib.sha256(
                            evidence.read_bytes()
                        ).hexdigest(),
                    }
                )
        finally:
            server.shutdown()
            server.server_close()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(
            {
                "status": "passed",
                "profiles": profiles,
                "sdk_image": args.sdk_image,
                "redis_image": args.redis_image,
                "source_sha256": {
                    str(path.relative_to(ROOT)): hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                    for path in [
                        ROOT / "migration/document_runner_check.py",
                        ROOT / "migration/document_runner_baseline.py",
                        ROOT / "migration/milvus_peer.py",
                        *sorted((ROOT / "runtime/src").glob("document*.rs")),
                        *sorted((ROOT / "runtime/src").glob("milvus*.rs")),
                        ROOT / "runtime/src/nv_ingest.rs",
                        ROOT / "runtime/src/storage.rs",
                        ROOT / "runtime/src/main.rs",
                        ROOT / "runtime/tests/fixtures/milvus-index.json",
                        ROOT / "runtime/tests/fixtures/document-tool-pipeline.json",
                        ROOT / "runtime/resources/document-tools.json",
                    ]
                },
                "image_ids": {
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
                    for image in [args.sdk_image, args.redis_image]
                },
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-image", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    main(parser.parse_args())
