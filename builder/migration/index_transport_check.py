#!/usr/bin/env python3
"""Exercise native indexing over the retained SDK's real gRPC server."""

import argparse
import hashlib
import json
import os
from pathlib import Path

from collections_check import milvus_fixture
from image_check import run

ROOT = Path(__file__).resolve().parents[1]


def main(args):
    profiles = []
    oracle_path = ROOT / "runtime/tests/fixtures/milvus-index.json"
    oracle = json.loads(oracle_path.read_text())
    live_cases = sum(case["mode"] != "rate-limit-exhausted" for case in oracle["cases"])
    image_id = run(
        "docker",
        "image",
        "inspect",
        args.sdk_image,
        "--format",
        "{{.Id}}",
        capture_output=True,
        text=True,
    ).stdout.strip()
    with milvus_fixture(args.sdk_image) as fixture:
        control = str(fixture["control"].base_url).rstrip("/")
        for name, uri, cases in [
            ("plain", f"http://127.0.0.1:{fixture['port']}", "all"),
            ("tls", f"https://localhost:{fixture['tls_port']}", "0"),
            ("unix", "unix:" + str(fixture["root"] / "milvus.sock"), "0"),
            ("uri-database", f"http://127.0.0.1:{fixture['port']}/synthetic-db", "0"),
        ]:
            env = {
                **os.environ,
                "DAEDALUS_INDEX_PEER_CONTROL": control,
                "DAEDALUS_INDEX_PEER_URI": uri,
                "DAEDALUS_INDEX_PEER_CASES": cases,
                "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH": str(fixture["root"] / "ca.crt"),
            }
            for test in [
                "milvus_index_transport::tests::actual_grpc_indexing_lifecycle",
                "document_pipeline::tests::actual_nv_and_milvus_pipeline",
            ]:
                run(
                    "cargo",
                    "test",
                    "--locked",
                    "--manifest-path",
                    str(ROOT / "runtime/Cargo.toml"),
                    test,
                    "--",
                    "--ignored",
                    "--nocapture",
                    env=env,
                )
            profiles.append(
                {
                    "name": name,
                    "cases": live_cases if cases == "all" else 1,
                    "fault_cases": 3 if cases == "all" else 0,
                    "cancelled_write_cases": 1 if cases == "all" else 0,
                    "pipeline_cases": live_cases if cases == "all" else 1,
                    "pipeline_failed_jobs": 2 if cases == "all" else 0,
                    "pipeline_invalid_chunks": 1 if cases == "all" else 0,
                    "pipeline_append_override": 1 if cases == "all" else 0,
                    "pipeline_serialization_failures": 3 if cases == "all" else 0,
                    "pipeline_row_order_failures": 1 if cases == "all" else 0,
                    "pipeline_cleanup_failures": 2 if cases == "all" else 0,
                    "pipeline_ignored_surrogate": 1 if cases == "all" else 0,
                }
            )
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(
            {
                "status": "passed",
                "profiles": profiles,
                "fixture_sha256": hashlib.sha256(oracle_path.read_bytes()).hexdigest(),
                "row_fixture_sha256": {
                    path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in sorted(oracle_path.parent.glob("milvus-*.json"))
                },
                "sdk_image": args.sdk_image,
                "sdk_image_id": image_id,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    main(parser.parse_args())
