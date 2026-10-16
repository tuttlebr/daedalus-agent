#!/usr/bin/env python3
"""Compare complete document search calls against the retained tool registry."""

import argparse
import base64
import copy
import hashlib
import json
import os
import ssl
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

from collections_check import milvus_fixture
from document_search_writes import scenarios as mutation_scenarios
from document_tool_ingestion_check import tool_milvus_calls
from embeddings_check import Peers
from export_milvus_search import response
from image_check import run
from leaf_check import PRIVATE_COLLECTIONS

ROOT = Path(__file__).resolve().parents[1]


def scenarios(uri, embedding, reranking=None):
    collection = PRIVATE_COLLECTIONS["synthetic-alice"]
    schema = {
        "schema": {
            "name": collection,
            "fields": [
                {"name": "id", "data_type": 5, "is_primary_key": True},
                {"name": "content", "data_type": 21},
                {"name": "source", "data_type": 21},
                {
                    "name": "vector",
                    "data_type": 101,
                    "type_params": [{"key": "dim", "value": "4"}],
                },
            ],
        }
    }
    base = {
        "environment": {
            "DAEDALUS_INTERNAL_API_TOKEN": "synthetic-internal",
            "NVIDIA_API_KEY": "",
            "REQUESTS_CA_BUNDLE": "",
            "CURL_CA_BUNDLE": "",
        },
        "headers": {
            "x-user-id": "synthetic-alice",
            "x-daedalus-internal-token": "synthetic-internal",
        },
        "configuration": {
            "functions": {
                "documents": {
                    "_type": "nat_nv_ingest",
                    "redis_url": "invalid-unused-redis",
                    "worker_pool_size": 0,
                    "milvus_uri": uri,
                    "milvus_username": None,
                    "milvus_password": None,
                    "milvus_token": None,
                    "content_field": "content",
                    "embedder_name": "synthetic_embeddings",
                }
            },
            "embedders": {
                "synthetic_embeddings": {
                    "_type": "vllm",
                    "base_url": embedding,
                    "model_name": "synthetic-model",
                    "timeout_seconds": 2,
                }
            },
        },
        "settings": {
            "uri": uri,
            "replies": {
                "ShowCollections": {
                    "collection_names": [
                        collection,
                        PRIVATE_COLLECTIONS["synthetic-bob"],
                        "nvidia",
                    ]
                },
                "DescribeCollection": schema,
                "Search": response(),
            },
        },
        "embedding": {},
        "reranking": {},
        "invocations": [
            {"input": {"operation": "search", "query": "  Synthetic 雪🌲 query  "}}
        ]
        * 2,
    }
    cases = []

    def add(name, *, tool=None, **changes):
        case = copy.deepcopy(base)
        case.update(name=name, **changes)
        case["configuration"]["functions"]["documents"].update(tool or {})
        cases.append(case)
        return case

    add("cached-search")
    add(
        "blank-query",
        invocations=[{"input": {"operation": "search", "query": " \t\n"}}] * 2,
    )
    add(
        "options",
        tool={
            "output_fields": ["source"],
            "search_params": {"metric_type": "IP", "params": {"ef": 8}},
        },
        invocations=[
            {"input": {"operation": "search", "top_k": 3, "filters": "page == 1"}}
        ]
        * 2,
    )
    add("zero-limit", invocations=[{"input": {"operation": "search", "top_k": 0}}] * 2)
    add(
        "negative-limit",
        invocations=[{"input": {"operation": "search", "top_k": -1}}] * 2,
    )
    add("cutoff", tool={"distance_cutoff": 0.125})
    add("empty-cutoff", tool={"distance_cutoff": 0})
    for cutoff in ["NaN", "inf", "-inf"]:
        add("nonfinite-cutoff-" + cutoff, tool={"distance_cutoff": cutoff})
    add(
        "missing-user",
        invocations=[
            {"headers": {"x-user-id": ""}, "input": {"operation": "search"}},
            base["invocations"][0],
        ],
    )
    add(
        "list-then-search",
        invocations=[
            {"input": {"operation": "list_collections"}},
            *base["invocations"],
        ],
    )
    add(
        "different-users",
        invocations=[
            base["invocations"][0],
            {
                "headers": {"x-user-id": "synthetic-bob"},
                "input": {"operation": "search"},
            },
            base["invocations"][0],
        ],
    )
    case = add("missing-embedder")
    case["configuration"]["embedders"] = {}
    case = add("invalid-embedder")
    case["configuration"]["embedders"]["synthetic_embeddings"]["model_name"] = " "
    add("embedding-failure", embedding={"status": 503})
    case = add("collection-missing")
    case["settings"]["replies"]["ShowCollections"]["collection_names"] = []
    for name in ["content", "vector"]:
        case = add(f"missing-{name}-field")
        fields = case["settings"]["replies"]["DescribeCollection"]["schema"]["fields"]
        fields[:] = [field for field in fields if field["name"] != name]
    case = add("prefixed-collection", tool={"database_name": "synthetic-db"})
    case["settings"]["replies"]["ShowCollections"]["collection_names"] = [
        f"synthetic-db.{collection}",
        collection,
    ]
    case = add("search-failure-invalidates-cache")
    case["settings"]["faults"] = {"Search": {"application": {"code": 1800}, "count": 1}}
    case = add("format-failure-retains-cache")
    invalid = copy.deepcopy(response())
    invalid["results"]["fields_data"][0] = {
        "field_name": "content",
        "type": 5,
        "scalars": {"long_data": {"data": ["1", "2"]}},
    }
    case["settings"]["replies"]["Search"] = [invalid, response()]
    case = add("lazy-json-failure-retains-cache")
    invalid = copy.deepcopy(response())
    invalid["results"]["fields_data"][3]["scalars"]["json_data"]["data"] = [
        "eA==",
        "eA==",
    ]
    case["settings"]["replies"]["Search"] = [invalid, response()]
    case = add("schema-failure-invalidates-cache")
    invalid = copy.deepcopy(schema)
    invalid["schema"]["fields"][0]["data_type"] = 9999
    case["settings"]["replies"]["DescribeCollection"] = [invalid, schema]

    # Each invalid schema is followed by a valid response. The observed trace
    # proves whether the real retriever clears both metadata caches on failure.
    def field_case(name, **changes):
        case = add("schema-" + name)
        changed = copy.deepcopy(schema)
        changed["schema"]["fields"][3].update(changes)
        case["settings"]["replies"]["DescribeCollection"] = [changed, schema]

    for label, value in [
        ("unicode-integer", " \u2003+١_٢\u00a0 "),
        ("negative-integer", "-4"),
        ("fractional-integer", "4.0"),
        ("integer-separator", "4__0"),
        ("integer-control", "\x1c4"),
        ("integer-limit", "0" * 4300),
        ("integer-over-limit", "0" * 4301),
    ]:
        field_case(label, type_params=[{"key": "dim", "value": value}])
    for kind, key in [
        (21, "max_length"),
        (22, "max_length"),
        (22, "max_capacity"),
        (106, "max_capacity"),
        (101, "max_length"),
        (101, "max_capacity"),
    ]:
        field_case(
            f"parameter-{kind}-{key}",
            data_type=kind,
            type_params=[{"key": key, "value": "invalid"}],
        )
    for label, value in [
        ("object", '{"ef": 8, "nested": [true, null]}'),
        ("scalar", "null"),
        ("invalid", "not-json"),
        ("nonfinite", "NaN"),
        ("overflow", "1e400"),
        ("large-integer", str(2**100)),
        ("large-integer-overflow", "9" * 400),
        ("surrogate", '"\\ud800"'),
        ("deep", "[" * 129 + "0" + "]" * 129),
        ("depth-limit", "[" * 1024 + "0" + "]" * 1024),
        ("over-depth-limit", "[" * 1025 + "0" + "]" * 1025),
    ]:
        field_case("json-" + label, type_params=[{"key": "params", "value": value}])
    field_case("index-json", index_params=[{"key": "params", "value": "invalid"}])
    field_case("unknown-type", data_type=999)
    field_case("invalid-element", element_type=9999)
    for nested in [False, True]:
        case = add(f"schema-struct-invalid-{nested}")
        changed = copy.deepcopy(schema)
        changed["schema"]["struct_array_fields"] = [
            {
                "name": "nested",
                "fields": [{"name": "item", "data_type": 9999 if nested else 21}],
                "type_params": [{"key": "params", "value": "invalid"}],
            }
        ]
        case["settings"]["replies"]["DescribeCollection"] = [changed, schema]
    for kind in [0, 4, 9999]:
        case = add(f"schema-function-{kind}")
        changed = copy.deepcopy(schema)
        changed["schema"]["functions"] = [{"name": "synthetic", "type": kind}]
        case["settings"]["replies"]["DescribeCollection"] = [changed, schema]
    for method in ["Connect", "ShowCollections", "DescribeCollection", "Search"]:
        for kind, fault in [
            ("application", {"application": {"code": 1800}, "count": 1}),
            ("permission", {"grpc": "PERMISSION_DENIED", "count": 1}),
        ]:
            case = add(f"{method}-{kind}")
            case["settings"]["faults"] = {method: fault}
    add("invalid-uri", tool={"milvus_uri": "invalid"})
    case = add("shared-embedder-registry")
    case["configuration"]["functions"]["other_documents"] = copy.deepcopy(
        case["configuration"]["functions"]["documents"]
    )
    case["invocations"] = [
        base["invocations"][0],
        {
            "tool": "other_documents",
            "input": {"operation": "search", "query": "Second tool query"},
        },
        base["invocations"][0],
    ]
    case = add("metadata-expiry")
    changed = copy.deepcopy(schema)
    changed["schema"]["fields"] = [
        field for field in changed["schema"]["fields"] if field["name"] != "content"
    ]
    case["settings"]["replies"]["DescribeCollection"] = [schema, changed]
    case["invocations"] = [
        base["invocations"][0],
        {"sleep": 20, "input": base["invocations"][0]["input"]},
        {"sleep": 11.2, "input": base["invocations"][0]["input"]},
    ]
    case = add("metadata-lru")
    users = [f"synthetic-cache-{index}" for index in range(129)]
    case["settings"]["replies"]["ShowCollections"]["collection_names"] = [
        f"user_uploads_{user.replace('-', '_')}_{hashlib.sha256(user.encode()).hexdigest()}"
        for user in users
    ]
    case["invocations"] = [
        {
            "headers": {"x-user-id": user},
            "input": {"operation": "search", "query": "Cache query"},
        }
        for user in users[:128] + [users[0], users[128], users[0], users[1]]
    ]
    case = add("parallel-search", parallel=True)
    queries = [f"Concurrent query {index:02}" for index in range(10)]
    case["invocations"] = [
        {"input": {"operation": "search", "query": query}} for query in queries
    ]
    case["embedding"] = {"parallel": True, "queries": queries}
    case["settings"]["delay"] = {"Search": 15}

    def rerank(name, *, tool=None, payload=None, peer=None):
        payload = (
            payload
            if payload is not None
            else {
                "results": [
                    {"index": 0, "relevance_score": 0.1},
                    {"index": 1, "relevance_score": 0.9},
                ]
            }
        )
        return add(
            "rerank-" + name,
            tool={
                "reranker_endpoint": (reranking or embedding) + "/rerank",
                "reranker_model": "synthetic-reranker",
                **(tool or {}),
            },
            reranking={
                "body": base64.b64encode(json.dumps(payload).encode()).decode(),
                **(peer or {}),
            },
        )

    rerank("ranked")
    for top in [0, 1, -1, 3]:
        rerank(f"top-{top}", tool={"reranker_top_n": top})
    rerank("disabled", tool={"use_reranker": False})
    rerank("null-model", tool={"reranker_model": None})
    rerank("invalid-url", tool={"reranker_endpoint": "invalid"})
    for label, key in [
        ("token", "synthetic-reranker-key"),
        ("latin1", "synthetic-é"),
        ("unicode", "雪"),
        ("newline", "synthetic\nkey"),
    ]:
        rerank(label, tool={"reranker_api_key": key})
    case = rerank("environment-key")
    case["environment"]["NVIDIA_API_KEY"] = "synthetic-environment-key"
    case = rerank(
        "configured-key", tool={"reranker_api_key": "synthetic-configured-key"}
    )
    case["environment"]["NVIDIA_API_KEY"] = "synthetic-environment-key"
    for label, payload in [
        ("empty", {"results": []}),
        ("missing-results", {}),
        ("invalid-results", {"results": {}}),
        ("invalid-root", []),
        ("invalid-item", {"results": [None]}),
        ("duplicate", {"results": [{"index": 0, "relevance_score": 1}] * 2}),
        (
            "tie",
            {
                "results": [
                    {"index": 1, "relevance_score": 1},
                    {"index": 0, "relevance_score": 1},
                ]
            },
        ),
    ]:
        rerank(label, payload=payload)
    for label, index in [
        ("bool", True),
        ("float", 0.0),
        ("negative", -1),
        ("range", 2),
        ("string", "0"),
    ]:
        rerank(
            "index-" + label,
            payload={"results": [{"index": index, "relevance_score": 1}]},
        )
    for label, score in [
        ("bool", True),
        ("string", "1"),
        ("null", None),
        ("integer-overflow", 10**400),
        ("nan", float("nan")),
        ("inf", float("inf")),
        ("negative-inf", -float("inf")),
    ]:
        rerank(
            "score-" + label,
            payload={"results": [{"index": 1, "relevance_score": score}]},
        )
    for label, peer in [
        ("error", {"status": 503}),
        ("invalid-json", {"body": base64.b64encode(b"invalid").decode()}),
        ("gzip", {"encoding": "gzip"}),
        ("deflate", {"encoding": "deflate"}),
        ("raw-deflate", {"encoding": "raw-deflate"}),
        ("broken-gzip", {"encoding": "broken-gzip"}),
        ("lost", {"lost": True}),
    ]:
        rerank(label, peer=peer)
    case = rerank("empty-content")
    case["settings"]["replies"]["Search"]["results"]["fields_data"][0]["scalars"][
        "string_data"
    ]["data"] = ["", ""]
    case = rerank("null-content")
    case["settings"]["replies"]["Search"]["results"]["fields_data"][0]["valid_data"] = [
        False,
        True,
    ]
    rerank("no-documents", tool={"distance_cutoff": 0})
    for label, peer in [
        ("header-timeout", {"header_delay": 31}),
        ("body-timeout", {"body_delay": 31}),
    ]:
        case = rerank(label, peer=peer)
        case["invocations"] = [
            {"input": {"operation": "search"}, "duration_range": [29, 38]}
        ]
    slow_body = json.dumps({"results": [{"index": 1, "relevance_score": 0.9}]}).encode()
    case = rerank(
        "chunked-budget",
        peer={
            "body": base64.b64encode(slow_body).decode(),
            "chunk_size": 2,
            "body_delay": 32 / ((len(slow_body) + 1) // 2),
        },
    )
    case["invocations"] = [
        {"input": {"operation": "search"}, "duration_range": [31, 42]}
    ]
    for status in [301, 302, 303, 307, 308]:
        rerank(
            f"redirect-{status}",
            tool={"reranker_api_key": "synthetic-redirect-key"},
            peer={"status": status, "redirect": True, "redirect_once": True},
        )
    rerank("redirect-loop", peer={"status": 307, "redirect": True})
    ranked_body = json.dumps(
        {
            "results": [{"index": 1, "relevance_score": 0.9}],
            "note": "Synthetic 雪 text",
        },
        ensure_ascii=False,
    )
    for label, encoding, content_type in [
        ("utf8-bom", "utf-8-sig", None),
        ("utf8-bom-declared", "utf-8-sig", "application/json"),
        ("utf16", "utf-16", "application/json; charset=utf-16"),
        ("utf16-guess", "utf-16", None),
        ("utf16-default", "utf-16", "application/json"),
        ("utf32", "utf-32", "application/json; charset=utf-32"),
        ("utf32-guess", "utf-32", None),
        ("unknown-charset", "utf-8", "application/json; charset=invalid-synthetic"),
    ]:
        rerank(
            "encoding-" + label,
            peer={
                "body": base64.b64encode(ranked_body.encode(encoding)).decode(),
                "content_type": content_type,
            },
        )
    for encoding in ["multi-gzip", "truncated-gzip", "trailing-gzip"]:
        rerank(encoding, peer={"encoding": encoding})
    rerank(
        "marker-string",
        payload={
            "results": [{"index": 0, "relevance_score": "daedalus-nonfinite-NaN"}]
        },
    )
    for label, scores in [
        ("nan-order", [0, float("nan"), 0, 1]),
        (
            "nan-merge",
            [float("nan") if index % 4 == 0 else index % 7 for index in range(65)],
        ),
    ]:
        size = len(scores)
        case = rerank(
            label,
            tool={"top_k": size},
            payload={
                "results": [
                    {"index": index, "relevance_score": score}
                    for index, score in enumerate(scores)
                ]
            },
        )
        case["settings"]["replies"]["Search"] = {
            "results": {
                "num_queries": "1",
                "top_k": str(size),
                "topks": [str(size)],
                "ids": {"int_id": {"data": [str(index + 1) for index in range(size)]}},
                "scores": [1.0] * size,
                "fields_data": [
                    {
                        "field_name": "content",
                        "type": 21,
                        "scalars": {
                            "string_data": {
                                "data": [
                                    f"Synthetic passage {index}"
                                    for index in range(size)
                                ]
                            }
                        },
                    }
                ],
            }
        }
    stalled = rerank("write-timeout")
    stalled["reranking"]["stall_upload"] = 32
    stalled["invocations"] = [
        {"input": {"operation": "search"}, "duration_range": [29, 38]}
    ]
    stalled["settings"]["replies"]["Search"]["results"]["fields_data"][0]["scalars"][
        "string_data"
    ]["data"][0] = "x" * (3 * 1024 * 1024)
    for case in cases:
        for invocation in case["invocations"]:
            if invocation["input"].get("operation") == "search":
                invocation["input"].setdefault("query", "Synthetic search query")
    return cases


def main(args):
    class Server(ThreadingHTTPServer):
        request_queue_size = 128

    embedding = Peers()
    server = Server(("127.0.0.1", 0), embedding.handler())
    threading.Thread(target=server.serve_forever, daemon=True).start()
    endpoint = f"http://127.0.0.1:{server.server_port}"
    reranker = Peers()
    reranking_server = Server(("127.0.0.1", 0), reranker.handler())
    threading.Thread(target=reranking_server.serve_forever, daemon=True).start()
    reranking_endpoint = f"http://127.0.0.1:{reranking_server.server_port}"
    secure = None
    try:
        with milvus_fixture(args.python_image) as peer:
            root = peer["root"]
            secure = Server(("127.0.0.1", 0), reranker.handler())
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(root / "server.crt", root / "server.key")
            secure.socket = context.wrap_socket(secure.socket, server_side=True)
            threading.Thread(target=secure.serve_forever, daemon=True).start()
            cases = scenarios(
                f"http://127.0.0.1:{peer['port']}", endpoint, reranking_endpoint
            )
            cases.extend(mutation_scenarios(cases[0]))
            ranked = next(case for case in cases if case["name"] == "rerank-ranked")
            ca = str(root / "ca.crt")
            missing = str(root / "missing-ca.crt")
            for label, environment in [
                ("tls", {"REQUESTS_CA_BUNDLE": ca}),
                ("tls-curl", {"CURL_CA_BUNDLE": ca}),
                ("tls-untrusted", {}),
                ("tls-missing-ca", {"REQUESTS_CA_BUNDLE": missing}),
                (
                    "tls-precedence",
                    {"REQUESTS_CA_BUNDLE": missing, "CURL_CA_BUNDLE": ca},
                ),
                ("plain-missing-ca", {"REQUESTS_CA_BUNDLE": missing}),
            ]:
                case = copy.deepcopy(ranked)
                case["name"] = "rerank-" + label
                case["environment"].update(environment)
                if label != "plain-missing-ca":
                    case["configuration"]["functions"]["documents"][
                        "reranker_endpoint"
                    ] = f"https://localhost:{secure.server_port}/rerank"
                cases.append(case)
            for label, initial, target in [
                (
                    "redirect-tls",
                    reranking_endpoint,
                    f"https://localhost:{secure.server_port}",
                ),
                (
                    "redirect-plain",
                    f"https://localhost:{secure.server_port}",
                    reranking_endpoint,
                ),
            ]:
                case = copy.deepcopy(ranked)
                case["name"] = "rerank-" + label
                case["environment"]["REQUESTS_CA_BUNDLE"] = ca
                case["configuration"]["functions"]["documents"].update(
                    reranker_endpoint=initial + "/rerank",
                    reranker_api_key="synthetic-redirect-key",
                )
                case["reranking"].update(
                    status=307,
                    redirect=target + "/unexpected-redirect",
                    redirect_once=True,
                )
                cases.append(case)
            if args.case:
                selected = set(args.case)
                cases = [case for case in cases if case["name"] in selected]
                if {case["name"] for case in cases} != selected:
                    raise ValueError("Unknown document-search scenario")
            fixture = {
                "control": str(peer["control"].base_url).rstrip("/"),
                "embedding_control": endpoint,
                "reranking_control": reranking_endpoint,
                "cases": cases,
            }
            (root / "search-input.json").write_text(json.dumps(fixture))
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
                "/fixture/search-input.json",
                "--output",
                "/fixture/search-output.json",
            )
            observed = json.loads((root / "search-output.json").read_text())
            for case, result in zip(cases, observed, strict=True):
                if "expected_timestamps" in case:
                    timestamps = [
                        int(call["body"].get("guarantee_timestamp", 0))
                        for call in result["milvus"]
                        if call["method"] == "Search"
                    ]
                    if timestamps != case["expected_timestamps"]:
                        raise AssertionError(
                            f"Mutation timestamps {case['name']}: {timestamps}"
                        )
                case["expected"] = result["expected"]
                # Every write was checked against the exact retained RPC script.
                # Compare the independent reader's calls here; SDK writer caches
                # may omit optional schema probes between upload operations.
                case["expected_milvus"] = tool_milvus_calls(
                    [call for call in result["milvus"] if call.get("phase") != "write"]
                )
                case["expected_embedding"] = result["embedding"]
                case["expected_reranking"] = result["reranking"]
            path = root / "document-search.json"
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
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(
                json.dumps(
                    {
                        "status": "retained-capture"
                        if args.capture_only
                        else "passed-staged-search-coordinator",
                        "cases": cases,
                        "source_sha256": {
                            str(p.relative_to(ROOT)): hashlib.sha256(
                                p.read_bytes()
                            ).hexdigest()
                            for p in [
                                Path(__file__),
                                ROOT / "migration/document_search_baseline.py",
                                ROOT / "migration/document_search_writes.py",
                                ROOT / "runtime/tests/fixtures/milvus-index.json",
                                ROOT / "migration/milvus_peer.py",
                                ROOT / "migration/embeddings_check.py",
                                ROOT / "runtime/src/document_retriever.rs",
                                ROOT / "runtime/src/document_reranker.rs",
                                ROOT / "runtime/src/reranker_order.rs",
                                ROOT / "runtime/src/document_search.rs",
                                ROOT / "runtime/src/document_json.rs",
                                ROOT / "runtime/src/document_store.rs",
                                ROOT / "runtime/src/document_tools.rs",
                                ROOT / "runtime/src/embeddings.rs",
                                ROOT / "runtime/src/milvus.rs",
                                ROOT / "runtime/src/milvus_timestamps.rs",
                                ROOT / "runtime/src/milvus_index.rs",
                                ROOT / "runtime/src/milvus_search.rs",
                                ROOT / "runtime/src/milvus_index_transport.rs",
                                ROOT / "runtime/src/milvus_index_proto.rs",
                                ROOT / "runtime/src/milvus_serialization.rs",
                                ROOT / "runtime/resources/document-tools.json",
                            ]
                        },
                        "native_registration": "pending",
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
                    },
                    indent=2,
                )
                + "\n"
            )
    finally:
        server.shutdown()
        server.server_close()
        reranking_server.shutdown()
        reranking_server.server_close()
        if secure is not None:
            secure.shutdown()
            secure.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-image", required=True)
    parser.add_argument("--capture-only", action="store_true")
    parser.add_argument("--case", action="append")
    parser.add_argument("--report", type=Path, required=True)
    main(parser.parse_args())
