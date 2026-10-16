#!/usr/bin/env python3
"""Compare routed domain retrieval with the retained tool and real service peers."""

import argparse
import copy
import hashlib
import json
import os
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

from collections_check import milvus_fixture
from document_search_check import scenarios as document_scenarios
from document_tool_ingestion_check import tool_milvus_calls
from embeddings_check import Peers
from image_check import run

ROOT = Path(__file__).resolve().parents[1]


def scenarios(uri, embedding, reranking, peer):
    retained = document_scenarios(uri, embedding, reranking)
    selected = {
        "cached-search",
        "options",
        "cutoff",
        "empty-cutoff",
        "missing-embedder",
        "invalid-embedder",
        "embedding-failure",
        "collection-missing",
        "Search-application",
        "DescribeCollection-application",
        "rerank-ranked",
        "rerank-top-1",
        "rerank-disabled",
        "rerank-token",
        "rerank-duplicate",
        "rerank-invalid-json",
        "rerank-nan-order",
    }
    cases = []
    for original in retained:
        if original["name"] not in selected:
            continue
        case = copy.deepcopy(original)
        old = case["configuration"]["functions"]["documents"]
        private = retained[0]["settings"]["replies"]["ShowCollections"][
            "collection_names"
        ][0]
        raw = {
            key: value
            for key, value in old.items()
            if key
            in {
                "content_field",
                "vector_field",
                "top_k",
                "output_fields",
                "search_params",
                "distance_cutoff",
                "use_reranker",
                "reranker_endpoint",
                "reranker_model",
                "reranker_top_n",
                "reranker_min_score",
                "reranker_api_key",
            }
        }
        raw.update(
            _type="domain_retriever",
            uri=old["milvus_uri"],
            embedding_model=old["embedder_name"],
            connection_args={},
            domain_collections={"nvidia": private},
        )
        case["configuration"]["functions"]["documents"] = raw
        for invocation in case["invocations"]:
            invocation["input"].pop("operation", None)
            invocation["input"].pop("collection_name", None)
            invocation["input"]["domain"] = "nvidia"
        cases.append(case)
    if {case["name"] for case in cases} != selected:
        raise ValueError("A shared domain scenario is missing")
    base = cases[0]

    def add(name, config=None, inputs=None, **settings):
        case = copy.deepcopy(base)
        case["name"] = name
        case["configuration"]["functions"]["documents"].update(config or {})
        case["settings"].update(settings)
        if inputs is not None:
            case["invocations"] = [{"input": value} for value in inputs]
        cases.append(case)
        return case

    add(
        "domain-routing",
        inputs=[
            {"query": "Synthetic query", "domain": value}
            for value in ["  NVIDIA\u001c", "unknown", "", "nvidia"]
        ],
    )
    add(
        "empty-query",
        inputs=[{"query": "", "domain": "nvidia"}, {"query": " ", "domain": "nvidia"}],
    )
    add(
        "argument-bounds",
        inputs=[
            {"query": "Synthetic query", "domain": "nvidia", "top_k": value}
            for value in [1, 50, 0, 51, True, "1", 1.0, None]
        ],
    )
    add("default-result-count", config={"top_k": 7})
    for cutoff in ["NaN", "inf", "-inf"]:
        add("cutoff-" + cutoff, config={"distance_cutoff": cutoff})
    ranked = next(case for case in cases if case["name"] == "rerank-ranked")
    for minimum in [0.8, 1.0, "inf"]:
        case = copy.deepcopy(ranked)
        case["name"] = "rerank-minimum-" + str(minimum)
        case["configuration"]["functions"]["documents"]["reranker_min_score"] = minimum
        cases.append(case)
    add("unbounded-search", config={"search_timeout": None})
    for phase in ["embedding", "reranking"]:
        case = copy.deepcopy(ranked if phase == "reranking" else base)
        case["name"] = "timeout-" + phase
        case["configuration"]["functions"]["documents"]["search_timeout"] = 0.5
        case[phase]["header_delay"] = 1.2
        case["invocations"] = [
            {
                "input": base["invocations"][0]["input"],
                "duration_range": [0.45, 2],
                "settle": 1.3,
            }
        ]
        cases.append(case)
    for timeout in [0, -1]:
        add(f"immediate-timeout-{timeout}", config={"search_timeout": timeout})
    for method in ["ShowCollections", "DescribeCollection", "Search"]:
        case = add(
            f"timeout-{method}",
            config={"search_timeout": 0.5},
            delay={method: {"seconds": 1.2, "count": 1}},
        )
        case["invocations"] = [
            {
                "input": base["invocations"][0]["input"],
                "duration_range": [0.45, 2],
                "settle": 1.3,
            },
            base["invocations"][0],
        ]
    for name, values in [
        ("password", {"user": "synthetic-user", "password": "synthetic-password"}),
        ("token", {"token": "synthetic-token"}),
        ("database", {"db_name": "synthetic-db"}),
        ("connection-timeout", {"timeout": 1.0}),
        ("connection-timeout-zero", {"timeout": 0}),
        ("connection-timeout-negative", {"timeout": -1}),
        ("ignored-option", {"unused-option": "synthetic"}),
        (
            "grpc-options",
            {
                "grpc_options": {
                    "grpc.max_send_message_length": 1000000,
                    "grpc.max_receive_message_length": 1000000,
                }
            },
        ),
        (
            "grpc-send-limit",
            {"grpc_options": {"grpc.max_send_message_length": 1}, "timeout": 0.2},
        ),
        (
            "grpc-receive-limit",
            {"grpc_options": {"grpc.max_receive_message_length": 1}, "timeout": 0.2},
        ),
        ("grpc-options-pairs", {"grpc_options": [["grpc.max_send_message_length", 1]]}),
        ("grpc-options-null", {"grpc_options": None}),
        ("grpc-options-invalid-pair", {"grpc_options": [["key"]]}),
    ]:
        add(name, config={"connection_args": values})
    add(
        "uri-auth",
        config={"uri": uri.replace("://", "://synthetic-user:synthetic-password@")},
    )
    add("uri-database", config={"uri": uri + "/synthetic-db"})
    add(
        "address-override",
        config={
            "uri": "http://127.0.0.1:1",
            "connection_args": {"address": uri.removeprefix("http://")},
        },
    )
    ca = str(peer["root"] / "ca.crt")
    for name, values in [
        ("tls-server-pem", {"server_pem_path": ca}),
        (
            "tls-client-cert",
            {
                "ca_pem_path": ca,
                "client_pem_path": str(peer["root"] / "server.crt"),
                "client_key_path": str(peer["root"] / "server.key"),
            },
        ),
        ("tls-server-name", {"server_pem_path": ca, "server_name": "localhost"}),
    ]:
        port = peer["mtls_port"] if name == "tls-client-cert" else peer["tls_port"]
        add(
            name, config={"uri": f"https://127.0.0.1:{port}", "connection_args": values}
        )
    add(
        "mtls-missing-identity",
        config={
            "uri": f"https://127.0.0.1:{peer['mtls_port']}",
            "connection_args": {"server_pem_path": ca, "timeout": 0.2},
        },
    )
    add(
        "secure-http",
        config={
            "uri": f"http://127.0.0.1:{peer['tls_port']}",
            "connection_args": {"secure": True, "server_pem_path": ca},
        },
    )
    add(
        "tls-bad-server-name",
        config={
            "uri": f"https://127.0.0.1:{peer['tls_port']}",
            "connection_args": {
                "server_pem_path": ca,
                "server_name": "wrong.invalid",
                "timeout": 0.2,
            },
        },
    )
    add(
        "tls-grpc-server-name",
        config={
            "uri": f"https://127.0.0.1:{peer['tls_port']}",
            "connection_args": {
                "server_pem_path": ca,
                "grpc_options": {"grpc.ssl_target_name_override": "wrong.invalid"},
                "timeout": 0.2,
            },
        },
    )
    add(
        "tls-missing-ca",
        config={
            "uri": f"https://127.0.0.1:{peer['tls_port']}",
            "connection_args": {"server_pem_path": str(peer["root"] / "missing.crt")},
        },
    )
    add("slow-connect", config={"search_timeout": 0.5}, delay={"Connect": 0.7})
    return cases


def main(args):
    servers = [
        ThreadingHTTPServer(("127.0.0.1", 0), Peers().handler()) for _ in range(2)
    ]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with milvus_fixture(args.python_image, mutual_tls=True) as peer:
            root = peer["root"]
            endpoints = [f"http://127.0.0.1:{server.server_port}" for server in servers]
            cases = scenarios(f"http://127.0.0.1:{peer['port']}", *endpoints, peer)
            if args.case:
                selected = set(args.case)
                cases = [case for case in cases if case["name"] in selected]
                if {case["name"] for case in cases} != selected:
                    raise ValueError("Unknown domain scenario")
            fixture = {
                "control": str(peer["control"].base_url).rstrip("/"),
                "embedding_control": endpoints[0],
                "reranking_control": endpoints[1],
                "cases": cases,
            }
            (root / "input.json").write_text(json.dumps(fixture))
            run(
                "docker",
                "run",
                "--rm",
                "--network",
                "host",
                "--user",
                f"{os.getuid()}:{os.getgid()}",
                "-e",
                "PYTHONPATH=/workspace",
                "--entrypoint",
                "/workspace/.venv/bin/python",
                "-v",
                f"{ROOT / 'migration'}:/migration:ro",
                "-v",
                f"{root}:/fixture",
                "-v",
                f"{root}:{root}:ro",
                args.python_image,
                "/migration/document_search_baseline.py",
                "--input",
                "/fixture/input.json",
                "--output",
                "/fixture/output.json",
            )
            observed = json.loads((root / "output.json").read_text())
            for case, result in zip(cases, observed, strict=True):
                case.update(
                    expected=result["expected"],
                    expected_milvus=tool_milvus_calls(result["milvus"]),
                    expected_embedding=result["embedding"],
                    expected_reranking=result["reranking"],
                )
            path = root / "domain-search.json"
            path.write_text(json.dumps(fixture))
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.with_suffix(".retained.json").write_text(
                json.dumps({"status": "retained-capture", "cases": cases}, indent=2)
                + "\n"
            )
            if not args.capture_only:
                run(
                    "cargo",
                    "test",
                    "--locked",
                    "--manifest-path",
                    str(ROOT / "runtime/Cargo.toml"),
                    "document_tools::tests::actual_search_adapter",
                    "--",
                    "--exact",
                    "--ignored",
                    "--nocapture",
                    env={**os.environ, "DAEDALUS_DOCUMENT_SEARCH_FIXTURE": str(path)},
                )
            args.report.write_text(
                json.dumps(
                    {
                        "status": "retained-capture"
                        if args.capture_only
                        else "passed-domain-retriever-services",
                        "cases": cases,
                        "python_image": run(
                            "docker",
                            "image",
                            "inspect",
                            args.python_image,
                            "--format",
                            "{{.Id}}",
                            capture_output=True,
                            text=True,
                        ).stdout.strip(),
                        "source_sha256": {
                            str(path.relative_to(ROOT)): hashlib.sha256(
                                path.read_bytes()
                            ).hexdigest()
                            for path in [
                                Path(__file__),
                                ROOT / "migration/document_search_baseline.py",
                                *sorted((ROOT / "runtime/src").glob("*.rs")),
                            ]
                        },
                    },
                    indent=2,
                )
                + "\n"
            )
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--case", action="append", default=[])
    parser.add_argument("--capture-only", action="store_true")
    main(parser.parse_args())
