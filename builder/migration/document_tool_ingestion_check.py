#!/usr/bin/env python3
"""Exercise the staged named-tool coordinator against retained Python services."""

import argparse
import copy
import hashlib
import inspect
import json
import os
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

from collections_check import milvus_fixture
from document_runner_baseline import text_observation
from document_runner_check import (
    KEY,
    USER,
    RunnerPeers,
    normalized_nv,
    redis_fixture,
    scenarios,
)
from image_check import require, run
from profile_import_check import expand

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "daedalus:idempotency:v1:"


class ToolPeers(RunnerPeers):
    def __init__(self, admin):
        super().__init__(admin)
        self.case = {}
        self.held = threading.Event()
        self.release = threading.Event()
        self.fetch_finished = threading.Event()

    def reset(self, case):
        self.case = case
        self.held.clear()
        self.release.clear()
        self.fetch_finished.clear()
        self.admin.execute_command("ACL", "SETUSER", "ledger", "+eval")
        for key in self.admin.scan_iter(PREFIX + "*"):
            self.admin.delete(key)
        super().reset(case)
        if "reply_json" in case:
            self.document_reply = json.loads(case["reply_json"])
        if "record_key" in case and not case.get("missing"):
            self.admin.delete(KEY)
            self.admin.execute_command(
                "JSON.SET", case["record_key"], "$", json.dumps(case["record"])
            )
        if "existing" in case or "existing_json" in case:
            self.admin.set(
                case["reservation_key"],
                case.get("existing_json") or json.dumps(case["existing"]),
                ex=6000,
            )

    def receipts(self):
        records = {}
        for key in self.admin.scan_iter(PREFIX + "*"):
            require(5950 <= self.admin.ttl(key) <= 6000, "Wrong tool receipt TTL")
            raw = self.admin.get(key)
            record = json.loads(raw)
            if "owner" in record:
                require(bool(record["owner"]), "Missing receipt owner")
                if record["owner"] != "different-owner":
                    record["owner"] = "acquired-owner"
            observed = {k: text_observation(v) for k, v in record.items()}
            if self.case.get("receipt_ascii"):
                require(raw.isascii(), "Receipt must preserve Python ASCII JSON")
                observed = {"record": observed, "ascii": raw.decode("ascii")}
            records[key.decode()] = observed
        return records

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def do_POST(self):
                if self.path == "/__tool/release":
                    peers.release.set()
                    return self.reply({"ok": True})
                return super().do_POST()

            def do_GET(self):
                if self.path == "/__tool/held":
                    return self.reply(
                        {
                            "held": peers.held.is_set(),
                            "finished": peers.fetch_finished.is_set(),
                        }
                    )
                if self.path == "/__tool/receipts":
                    return self.reply(peers.receipts())
                if self.path.startswith(("/v1/fetch_job/", "/v2/fetch_job/")):
                    if peers.case.get("cancel"):
                        peers.held.set()
                        require(
                            peers.release.wait(25),
                            "Cancelled tool did not release its worker",
                        )
                        try:
                            return super().do_GET()
                        except (BrokenPipeError, ConnectionResetError):
                            # Native extraction drops the HTTP request when
                            # cancelled; the retained Python worker survives.
                            return None
                        finally:
                            peers.fetch_finished.set()
                    if peers.case.get("completion_fault") == "owner":
                        for key in peers.admin.scan_iter(PREFIX + "*"):
                            record = json.loads(peers.admin.get(key))
                            record["owner"] = "different-owner"
                            peers.admin.set(key, json.dumps(record), ex=6000)
                    if peers.case.get("completion_fault") == "eval":
                        peers.admin.execute_command("ACL", "SETUSER", "ledger", "-eval")
                return super().do_GET()

        return Handler


def cases(oracle):
    originals = {case["name"]: case for case in scenarios(oracle)}
    results = []

    def add(name, source="success", **changes):
        case = copy.deepcopy(originals[source])
        request = {
            key: value for key, value in case["request"].items() if key != "username"
        }
        case.update(
            {
                "name": name,
                "input": {"operation": "ingest", **request},
                "tool_call": True,
                "invocations": 2,
                "tool_config": {},
                **changes,
            }
        )
        case["settings"]["live_receipt_clock"] = True
        case["settings"]["allow_cached_schema_reads"] = True
        case["headers"] = {
            "x-user-id": USER,
            "x-daedalus-internal-token": "synthetic-internal",
            "x-daedalus-execution-scope": case.pop("scope", "autonomy"),
            "x-daedalus-execution-id": case.pop(
                "execution", "synthetic-tool-execution"
            ),
        }
        results.append(case)
        return case

    for name in [
        "success",
        "object",
        "foreign-owner",
        "object-wrong-key",
        "object-expired",
        "missing",
        "invalid-data",
        "shared-scope",
        "nv-failed",
        "empty",
        "reject-Insert:private_collection",
    ]:
        add(name, name)
    for name, extra in [
        ("interactive", {"scope": "interactive"}),
        ("no-execution", {"execution": ""}),
    ]:
        case = add(name, **extra)
        case["settings"]["script"] *= 2
        case["invalid_global_redis"] = True
    for name, duplicate in [("batch", False), ("duplicate-batch", True)]:
        case = add(name)
        reference = case["input"].pop("documentRef")
        case["input"]["documentRefs"] = [reference] * (2 if duplicate else 1)
        case["input"]["provenance"] = {"source": "synthetic-coordinator-check"}
    for name, stored in [
        ("existing-pending", {"state": "in_progress", "owner": "different-owner"}),
        (
            "existing-completed",
            {"state": "completed", "result": "Earlier receipt 雪🌲"},
        ),
        ("existing-empty", {"state": "completed", "result": ""}),
    ]:
        case = add(name, existing=stored)
        case["settings"]["script"] = []
    add("lost-owner", completion_fault="owner")
    add("completion-error", completion_fault="eval")
    add("cancelled-owner", cancel=True, cancel_phase="extraction")
    for name, content in [
        ("surrogate", "A\ud800B"),
        ("surrogate-low", "A\udfffB"),
        ("surrogate-private-use", "\U000f0000 A\ud800B \\ud800 雪🌲"),
        ("surrogate-html-removed", '<span title="\ud800">Visible</span>'),
        ("surrogate-empty-fallback", '<span title="\ud800"></span>'),
        ("surrogate-joined-pair", "A\ud800<span></span>\udc00B"),
        ("surrogate-batch", "A\ud800B"),
    ]:
        case = add(name, "no-embedding", receipt_ascii=True)
        reply = case.pop("reply")
        reply["data"][0]["metadata"]["content"] = content
        case["reply_json"] = json.dumps(reply)
        case["reply"] = None
        case["stream_errors"] = [
            name in {"surrogate", "surrogate-low", "surrogate-private-use"}
        ] * 2
        if name == "surrogate-joined-pair":
            # Cleanup joins two previously isolated code units. ASCII receipt
            # decoding combines that pair on replay, so only the first call
            # fails to encode its result as UTF-8.
            case["stream_errors"] = [True, False]
        if name == "surrogate-empty-fallback":
            case["record"]["filename"] = "\U000f0000.txt"
        if name == "surrogate-batch":
            case["input"]["documentRefs"] = [case["input"].pop("documentRef")]
    case = add(
        "existing-surrogate",
        existing_json=json.dumps(
            {"state": "completed", "result": "Earlier \ud800 雪🌲"}
        ),
        receipt_ascii=True,
        stream_errors=[True, True],
    )
    case["settings"]["script"] = []
    case = add("missing-reference", input={"operation": "ingest"})
    case["settings"]["script"] = []
    return results


def reservation_key(case):
    def digest(text):
        return hashlib.sha256(text.encode()).hexdigest()

    record = case["record"]
    identity = {
        "documentId": "synthetic-document",
        "sessionId": "synthetic-session",
        "size": record.get("size"),
        "storage": "legacy-base64",
        "payloadSha256": digest(record["data"]),
    }
    collection = case["settings"]["rename_collections"]["private_collection"]
    arguments = {
        "collection": collection,
        "documents": [identity],
        "chunkSize": 1024,
        "chunkOverlap": 150,
    }
    return PREFIX + ":".join(
        [
            digest(USER),
            digest(case["headers"]["x-daedalus-execution-id"]),
            digest("ingest_user_documents"),
            digest(
                json.dumps(
                    arguments, sort_keys=True, ensure_ascii=False, separators=(",", ":")
                )
            ),
        ]
    )


def tool_milvus_calls(calls):
    calls = copy.deepcopy(calls)
    for call in calls:
        info = call["body"].get("client_info")
        if info is not None:
            require(info["sdk_type"] == "Python", "Wrong retained Milvus SDK")
            call["body"]["client_info"] = {k: v for k, v in info.items() if k == "user"}
        for key, replacement in [
            ("identifier", "<session>"),
            ("client-request-unixmsec", "<timestamp>"),
        ]:
            if key in call["metadata"]:
                require(call["metadata"][key].isdigit(), "Invalid Milvus context")
                call["metadata"][key] = replacement
    return calls


def main(args, *, scenario_factory=cases, native_test="actual_ingestion_coordinator"):
    oracle = expand(
        json.loads((ROOT / "runtime/tests/fixtures/milvus-index.json").read_text())
    )
    with milvus_fixture(args.python_image) as fixture, redis_fixture(
        fixture["root"], args.redis_image
    ) as (admin, document_url):
        root = fixture["root"]
        admin.execute_command(
            "ACL",
            "SETUSER",
            "ledger",
            "on",
            ">synthetic-ledger",
            "~daedalus:idempotency:v1:*",
            "+@connection",
            "+set",
            "+get",
            "+eval",
        )
        ledger_url = document_url.replace(
            "backend:synthetic-backend", "ledger:synthetic-ledger"
        )
        peers = ToolPeers(admin)
        server = ThreadingHTTPServer(("127.0.0.1", 0), peers.handler())
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        control = str(fixture["control"].base_url).rstrip("/")
        nv_control = f"http://127.0.0.1:{server.server_port}"
        selected = scenario_factory(oracle)
        try:
            for case in selected:
                case["environment"] = {
                    "REDIS_URL": "invalid-global-url"
                    if case.get("invalid_global_redis")
                    else ledger_url,
                    "AUTONOMY_IDEMPOTENCY_TTL_SECONDS": "6000",
                    "DAEDALUS_INTERNAL_API_TOKEN": "synthetic-internal",
                    "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH": str(root / "ca.crt"),
                    "DOCUMENT_OBJECT_ENDPOINT": nv_control,
                    "DOCUMENT_OBJECT_ACCESS_KEY": "synthetic-object-access",
                    "DOCUMENT_OBJECT_SECRET_KEY": "synthetic-object-secret",
                    "DOCUMENT_OBJECT_BUCKET": "synthetic-documents",
                }
                case["tool_config"] = {
                    "redis_url": document_url,
                    "nv_ingest_host": "127.0.0.1",
                    "nv_ingest_port": server.server_port,
                    "milvus_uri": f"http://127.0.0.1:{fixture['port']}",
                    "milvus_username": "synthetic-user",
                    "milvus_password": "synthetic-password",
                    "embedder_dim": 2,
                    "ingest_max_retries": 0,
                    "ingest_retry_delay": 0,
                    "ingest_timeout_seconds": 30,
                    **case["tool_config"],
                }
                transport = case.get("milvus_transport")
                if transport:
                    case["tool_config"]["milvus_uri"] = {
                        "tls": f"https://localhost:{fixture['tls_port']}",
                        "unix": "unix:" + str(root / "milvus.sock"),
                        "database": f"http://127.0.0.1:{fixture['port']}/synthetic-db",
                    }[transport]
                case.update({"nv_control": nv_control, "milvus_control": control})
                if "existing" in case or "existing_json" in case:
                    case["reservation_key"] = reservation_key(case)
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
                        args.python_image,
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
                        "Baseline tool failed: "
                        + (root / "baseline.log").read_text()[-2000:],
                    )
                case["expected"] = {
                    **json.loads((root / "output.json").read_text()),
                    "nv_calls": normalized_nv(peers.document_calls),
                    "object_calls": copy.deepcopy(peers.object_calls),
                    "receipts": peers.receipts(),
                }
                if case.get("capture_milvus"):
                    case["expected"]["milvus_calls"] = tool_milvus_calls(
                        fixture["control"].get("/calls").json()
                    )
                require(
                    fixture["control"].get("/script").json()
                    == {"remaining": 0, "errors": []},
                    f"Baseline did not perform the expected writes: {case['name']}; {case['expected']}",
                )
                print("Retained tool: " + case["name"], flush=True)
            path = root / "tool-ingestion.json"
            path.write_text(
                json.dumps(
                    {"cases": selected, "control": control, "nv_control": nv_control}
                )
            )
            args.report.parent.mkdir(parents=True, exist_ok=True)
            evidence = args.report.with_name(args.report.stem + "-cases.json")
            evidence.write_text(path.read_text())
            run(
                "cargo",
                "test",
                "--locked",
                "--manifest-path",
                str(ROOT / "runtime/Cargo.toml"),
                "document_tools::tests::" + native_test,
                "--",
                "--ignored",
                "--nocapture",
                env={**os.environ, "DAEDALUS_DOCUMENT_TOOL_FIXTURE": str(path)},
            )
        finally:
            peers.release.set()
            server.shutdown()
            server.server_close()
    sources = [
        Path(__file__),
        Path(inspect.getsourcefile(scenario_factory)),
        ROOT / "migration/document_runner_baseline.py",
        ROOT / "runtime/src/document_tools.rs",
        ROOT / "runtime/src/document_reservations.rs",
        ROOT / "runtime/src/document_processor.rs",
        ROOT / "runtime/src/document_json.rs",
        ROOT / "runtime/src/document_process.rs",
        ROOT / "runtime/src/milvus.rs",
        ROOT / "runtime/src/milvus_index_transport.rs",
    ]
    args.report.write_text(
        json.dumps(
            {
                "status": {
                    "actual_ingestion_coordinator": "passed-staged-coordinator",
                    "actual_extraction_adapter": "passed-staged-extraction",
                    "actual_listing_adapter": "passed-staged-listing",
                }[native_test],
                "registered_tool_gate": "pending",
                "cases": len(selected),
                "evidence": str(evidence),
                "evidence_sha256": hashlib.sha256(evidence.read_bytes()).hexdigest(),
                "source_sha256": {
                    str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in sources
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
                    for image in [args.python_image, args.redis_image]
                },
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-image", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    main(parser.parse_args())
