#!/usr/bin/env python3
"""Compare native search with real retained-SDK gRPC wire captures."""

import argparse
import hashlib
import json
import os
from pathlib import Path

from collections_check import milvus_fixture
from image_check import run
from profile_import_check import expand

ROOT = Path(__file__).resolve().parents[1]


def main(args):
    path = ROOT / "runtime/tests/fixtures/milvus-search.json"
    oracle = expand(json.loads(path.read_text()))
    retry_path = ROOT / "runtime/tests/fixtures/milvus-search-retries.json"
    retry_oracle = expand(json.loads(retry_path.read_text()))
    document_path = ROOT / "runtime/tests/fixtures/document-search-results.json"
    document_oracle = expand(json.loads(document_path.read_text()))
    profiles = []
    with milvus_fixture(args.sdk_image) as peer:
        control = str(peer["control"].base_url).rstrip("/")
        for name, uri, all_cases, gzip in [
            ("plain", f"http://127.0.0.1:{peer['port']}", True, False),
            ("tls", f"https://localhost:{peer['tls_port']}", False, False),
            ("unix", "unix:" + str(peer["root"] / "milvus.sock"), False, False),
            (
                "uri-database",
                f"http://127.0.0.1:{peer['port']}/synthetic-db",
                False,
                False,
            ),
            ("gzip", f"http://127.0.0.1:{peer['port']}", False, True),
        ]:
            environment = {
                **os.environ,
                "DAEDALUS_SEARCH_PEER_CONTROL": control,
                "DAEDALUS_SEARCH_PEER_URI": uri,
                "DAEDALUS_SEARCH_PEER_CASES": "all" if all_cases else "0",
                "DAEDALUS_SEARCH_PEER_GZIP": str(gzip).lower(),
                "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH": str(peer["root"] / "ca.crt"),
            }
            run(
                "cargo",
                "test",
                "--locked",
                "--manifest-path",
                str(ROOT / "runtime/Cargo.toml"),
                "milvus_search::tests::actual_grpc_search",
                "--",
                "--exact",
                "--ignored",
                "--nocapture",
                env=environment,
            )
            if all_cases:
                run(
                    "cargo",
                    "test",
                    "--locked",
                    "--manifest-path",
                    str(ROOT / "runtime/Cargo.toml"),
                    "milvus_search::tests::actual_grpc_search_retries",
                    "--",
                    "--exact",
                    "--ignored",
                    "--nocapture",
                    env=environment,
                )
            run(
                "cargo",
                "test",
                "--locked",
                "--manifest-path",
                str(ROOT / "runtime/Cargo.toml"),
                "document_search::tests::actual_document_results",
                "--",
                "--exact",
                "--ignored",
                "--nocapture",
                env=environment,
            )
            cases = oracle["cases"] if all_cases else oracle["cases"][:1]
            document_cases = (
                document_oracle["cases"] if all_cases else document_oracle["cases"][:1]
            )
            profiles.append(
                {
                    "name": name,
                    "cases": len(cases),
                    "search_requests": sum(len(case["calls"]) for case in cases),
                    "retry_cases": len(retry_oracle["cases"]) if all_cases else 0,
                    "retry_search_requests": sum(
                        case["calls"] for case in retry_oracle["cases"]
                    )
                    if all_cases
                    else 0,
                    "recorded_backoffs": sum(
                        len(case["sleep_ms"]) for case in retry_oracle["cases"]
                    )
                    if all_cases
                    else 0,
                    "document_cases": len(document_cases),
                    "document_search_requests": sum(
                        case["search_rpcs"] for case in document_cases
                    ),
                }
            )
    sources = [
        Path(__file__),
        ROOT / "migration/export_milvus_search.py",
        ROOT / "migration/export_milvus_search_retries.py",
        ROOT / "migration/export_document_search_results.py",
        ROOT / "migration/export_milvus_index.py",
        ROOT / "migration/milvus_peer.py",
        ROOT / "runtime/src/milvus.rs",
        ROOT / "runtime/src/milvus_search.rs",
        ROOT / "runtime/src/document_search.rs",
        ROOT / "runtime/src/profile_import.rs",
        ROOT / "runtime/src/output.rs",
        ROOT / "runtime/src/config.rs",
        ROOT / "runtime/src/milvus_index_proto.rs",
        ROOT / "runtime/src/milvus_serialization.rs",
        path,
        retry_path,
        document_path,
    ]
    report = {
        "status": "passed-staged-milvus-search",
        "profiles": profiles,
        "source_sha256": {
            str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sources
        },
        "sdk_image": run(
            "docker",
            "image",
            "inspect",
            args.sdk_image,
            "--format",
            "{{.Id}}",
            capture_output=True,
            text=True,
        ).stdout.strip(),
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    main(parser.parse_args())
