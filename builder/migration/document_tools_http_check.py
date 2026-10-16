#!/usr/bin/env python3
"""Compare document tool registration and chat SSE against real backend images."""

import argparse
import concurrent.futures
import copy
import hashlib
import json
import threading
import time
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path

from collections_check import milvus_fixture
from document_runner_check import KEY
from document_search_check import scenarios
from document_tool_ingestion_check import cases as ingestion_cases
from document_tool_ingestion_check import tool_milvus_calls
from document_tool_receipts_check import ReceiptPeers, normalized
from embeddings_check import Peers
from image_check import environment, require, run
from leaf_check import measure
from profile_import_check import expand

ROOT = Path(__file__).resolve().parents[1]


def document_io(env, milvus, peers, search_case):
    oracle = expand(
        json.loads((ROOT / "runtime/tests/fixtures/milvus-index.json").read_text())
    )
    case = next(c for c in ingestion_cases(oracle) if c["name"] == "success")
    observed = []
    for filename in ["fixture.txt", "fixture.pdf"]:
        record = {**case["record"], "filename": filename}
        env["redis"].execute_command("JSON.SET", KEY, "$", json.dumps(record))
        peers.reset_documents()
        peers.document_reply = case["reply"]
        milvus["control"].post("/reset", json={"script": []}).raise_for_status()
        peers.plan = [
            {
                "name": "documents_io",
                "arguments": {
                    "operation": "extract",
                    "documentRef": case["input"]["documentRef"],
                },
            }
        ]
        result = normalized(measure(env))
        require(
            result["done"] and not result["errors"] and len(result["ends"]) == 1,
            "Extraction did not produce a tool result",
        )
        require(
            result["ends"][0]["payload"].startswith("<<<DAEDALUS_EXTRACT_JSON>>>"),
            "Extraction lost its frontend envelope",
        )
        require(
            not milvus["control"].get("/calls").json(), "Extraction contacted the index"
        )
        observed.append({"result": result, "nv_calls": len(peers.document_calls)})
    env["redis"].execute_command("JSON.SET", KEY, "$", json.dumps(case["record"]))
    peers.reset_documents()
    peers.document_reply = case["reply"]
    collection = case["settings"]["rename_collections"]["private_collection"]
    settings = {
        **case["settings"],
        "mutation_timestamps": {"meta": 9999, collection: 1234},
    }
    milvus["control"].post("/reset", json=settings).raise_for_status()
    peers.plan = [{"name": "documents_io", "arguments": case["input"]}]
    counts = []
    for _ in range(2):
        result = normalized(
            measure(
                env,
                extra_headers={
                    "x-daedalus-execution-scope": "autonomy",
                    "x-daedalus-execution-id": "synthetic-native-document-io",
                },
            )
        )
        require(
            result["done"] and not result["errors"] and len(result["ends"]) == 1,
            "Ingestion did not produce a tool result",
        )
        observed.append({"result": result})
        counts.append(len(peers.document_calls))
    require(
        counts[0] > 0 and counts[0] == counts[1], "Receipt replay repeated ingestion"
    )
    require(
        milvus["control"].get("/script").json() == {"remaining": 0, "errors": []},
        "Ingestion changed its Milvus write sequence",
    )
    receipts = list(env["redis"].scan_iter("daedalus:idempotency:v1:*"))
    require(len(receipts) == 1, "Wrong document reservation count")
    receipt = json.loads(env["redis"].get(receipts[0]))
    require(
        receipt["state"] == "completed"
        and receipt["result"] == result["ends"][0]["payload"],
        "Completed document receipt differs from the tool result",
    )
    milvus["control"].post("/reset", json=search_case["settings"]).raise_for_status()
    peers.plan = [
        {"name": "documents_0", "arguments": search_case["invocations"][0]["input"]}
    ]
    result = normalized(measure(env))
    requests = [
        c for c in milvus["control"].get("/calls").json() if c["method"] == "Search"
    ]
    require(
        len(requests) == 1 and requests[0]["body"]["guarantee_timestamp"] == "1234",
        "Search lost the acknowledged write timestamp",
    )
    observed.append({"result": result})
    return observed


def cancel_search(env, milvus, peers, case, *, name="documents_0", arguments=None):
    settings = copy.deepcopy(case["settings"])
    settings.update(delay={"Search": 30}, observe_wait_completion=True)
    milvus["control"].post("/reset", json=settings).raise_for_status()
    peers.plan = [
        {
            "name": name,
            "arguments": arguments
            or {
                "operation": "search",
                "query": "Synthetic cancelled retrieval",
            },
        }
    ]
    request_id = str(uuid.uuid4())
    with concurrent.futures.ThreadPoolExecutor() as pool:
        task = pool.submit(measure, env, request_id=request_id)
        try:
            until = time.monotonic() + 10
            while not any(
                c["method"] == "Search" for c in milvus["control"].get("/calls").json()
            ):
                require(
                    time.monotonic() < until, "Cancelled search never reached Milvus"
                )
                time.sleep(0.01)
            env["client"].post(
                env["base"] + f"/v1/runs/{request_id}/control",
                headers=env["headers"],
                json={"type": "cancel", "command_id": str(uuid.uuid4())},
            ).raise_for_status()
            result = normalized(task.result(timeout=5))
            require(
                result["done"]
                and result["terminal"] == "error"
                and result["errors"]
                == [{"error": {"message": "Run cancelled by user"}}],
                "Stop did not terminate document search",
            )
        finally:
            milvus["control"].post("/release").raise_for_status()
            until = time.monotonic() + 5
            while any(
                not c.get("wait_completed")
                for c in milvus["control"].get("/calls").json()
            ):
                require(
                    time.monotonic() < until, "Search did not leave the service barrier"
                )
                time.sleep(0.01)
    milvus["control"].post("/reset", json=case["settings"]).raise_for_status()
    recovered = normalized(measure(env))
    require(
        recovered["done"] and not recovered["errors"] and len(recovered["ends"]) == 1,
        "Document search did not recover after Stop",
    )
    return {"stopped": result, "recovered": recovered}


def main(args):
    embedding, reranking = Peers(), Peers()
    servers = [
        ThreadingHTTPServer(("127.0.0.1", 0), peer.handler())
        for peer in [embedding, reranking]
    ]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    selected = {
        "cached-search",
        "options",
        "zero-limit",
        "negative-limit",
        "cutoff",
        "empty-cutoff",
        "nonfinite-cutoff-NaN",
        "nonfinite-cutoff-inf",
        "nonfinite-cutoff--inf",
        "list-then-search",
        "different-users",
        "missing-embedder",
        "invalid-embedder",
        "embedding-failure",
        "collection-missing",
        "Search-application",
        "DescribeCollection-application",
        "invalid-uri",
        "rerank-ranked",
        "rerank-top-1",
        "rerank-disabled",
        "rerank-token",
        "rerank-invalid-json",
        "rerank-duplicate",
        "rerank-nan-order",
    }
    profiles = []
    try:
        with milvus_fixture(args.python_image) as milvus:
            cases = [
                case
                for case in scenarios(
                    f"http://127.0.0.1:{milvus['port']}",
                    f"http://127.0.0.1:{servers[0].server_port}",
                    f"http://127.0.0.1:{servers[1].server_port}",
                )
                if case["name"] in selected
            ]
            require(
                {case["name"] for case in cases} == selected,
                "Unknown HTTP fixture case",
            )

            def configure(config, *_):
                config["functions"], config["embedders"] = {}, {}
                for index, case in enumerate(cases):
                    name, provider = f"documents_{index}", f"embedding_{index}"
                    raw = copy.deepcopy(case["configuration"]["functions"]["documents"])
                    raw["embedder_name"] = provider
                    config["functions"][name] = raw
                    old = case["configuration"].get("embedders", {})
                    if old:
                        config["embedders"][provider] = next(iter(old.values()))
                config["workflow"]["tools"] = list(config["functions"])

            def configure_with_io(config, port, runtime_port):
                configure(config, port, runtime_port)
                config["functions"]["documents_io"] = {
                    "_type": "nat_nv_ingest",
                    "redis_url": "${REDIS_URL}",
                    "nv_ingest_host": "127.0.0.1",
                    "nv_ingest_port": port,
                    "milvus_uri": f"http://127.0.0.1:{milvus['port']}",
                    "milvus_username": "synthetic-user",
                    "milvus_password": "synthetic-password",
                    "embedder_dim": 2,
                    "ingest_max_retries": 0,
                    "ingest_timeout_seconds": 30,
                }
                config["workflow"]["tools"].append("documents_io")

            baseline = cancellation_baseline = io_baseline = None
            for label, image, minimal, preparation, authorization in [
                ("retained", args.python_image, False, "python", "python"),
                ("native-full", args.image, False, "rust", "rust"),
                ("native-python-auth", args.image, False, "rust", "python"),
                ("native-minimal", args.minimal_image, True, "rust", "rust"),
            ]:
                peers = ReceiptPeers()
                observed = []
                with environment(
                    image,
                    args.redis_image,
                    minimal=minimal,
                    memory=False,
                    peers=peers,
                    configure=configure_with_io,
                    redis_json=True,
                    extra_env=lambda _, p=preparation, a=authorization: {
                        "DAEDALUS_PREPARATION": p,
                        "DAEDALUS_AUTHORIZATION": a,
                        "DAEDALUS_TOOL_EXECUTOR": "disabled"
                        if p == a == "rust"
                        else "python",
                        "NVIDIA_API_KEY": "",
                    },
                ) as env:
                    for index, case in enumerate(cases):
                        milvus["control"].post(
                            "/reset", json=case["settings"]
                        ).raise_for_status()
                        for server, settings in zip(
                            servers, [case["embedding"], case["reranking"]], strict=True
                        ):
                            env["client"].post(
                                f"http://127.0.0.1:{server.server_port}/__reset",
                                json=settings,
                            ).raise_for_status()
                        results = []
                        for invocation in case["invocations"]:
                            peers.plan = [
                                {
                                    "name": f"documents_{index}",
                                    "arguments": invocation["input"],
                                }
                            ]
                            result = normalized(
                                measure(env, extra_headers=invocation.get("headers"))
                            )
                            require(
                                result["done"] and not result["errors"],
                                f"Chat failed: {label}/{case['name']}",
                            )
                            require(
                                len(result["ends"])
                                == (
                                    0
                                    if case["name"] in {"zero-limit", "negative-limit"}
                                    else 1
                                ),
                                f"Missing document result: {label}/{case['name']}",
                            )
                            results.append(result)
                        calls = milvus["control"].get("/calls").json()
                        for call in calls:
                            info = call["body"].get("client_info")
                            if info is not None:
                                require(
                                    info["sdk_type"]
                                    == ("Python" if label == "retained" else "Rust"),
                                    "Wrong document executor",
                                )
                                info["sdk_type"] = "Python"
                        item = {
                            "name": case["name"],
                            "results": results,
                            "milvus": tool_milvus_calls(calls),
                            "embedding": copy.deepcopy(embedding.calls),
                            "reranking": copy.deepcopy(reranking.calls),
                        }
                        observed.append(item)
                        if baseline is not None:
                            require(
                                item == baseline[index],
                                f"Document API mismatch: {label}/{case['name']}\n{item}\n{baseline[index]}",
                            )
                        print(f"Document HTTP: {label}/{case['name']}", flush=True)
                    cancellation = cancel_search(env, milvus, peers, cases[0])
                    if cancellation_baseline is not None:
                        require(
                            cancellation == cancellation_baseline,
                            f"Cancellation mismatch: {label}",
                        )
                    else:
                        cancellation_baseline = cancellation
                    io = document_io(env, milvus, peers, cases[0])
                    if io_baseline is not None:
                        require(io == io_baseline, f"Document IO mismatch: {label}")
                    else:
                        io_baseline = io
                if baseline is None:
                    baseline = observed
                profiles.append(
                    {
                        "name": label,
                        "cancellation": cancellation,
                        "document_io": io,
                        "cases": observed,
                        "image": run(
                            "docker",
                            "image",
                            "inspect",
                            image,
                            "--format",
                            "{{.Id}}",
                            capture_output=True,
                            text=True,
                        ).stdout.strip(),
                    }
                )
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(
            {
                "status": "passed-native-document-tools-http",
                "profiles": profiles,
                "source_sha256": {
                    str(path.relative_to(ROOT)): hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                    for path in [
                        Path(__file__),
                        *sorted((ROOT / "runtime/src").glob("*.rs")),
                    ]
                },
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["python-image", "image", "minimal-image", "redis-image"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--report", type=Path, required=True)
    main(parser.parse_args())
