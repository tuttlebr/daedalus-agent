#!/usr/bin/env python3
"""Verify native domain registration and frontend streams through built images."""

import argparse
import copy
import hashlib
import json
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

from collections_check import milvus_fixture
from document_tool_ingestion_check import tool_milvus_calls
from document_tool_receipts_check import normalized
from document_tools_http_check import cancel_search
from domain_retriever_check import scenarios
from embeddings_check import Peers
from image_check import environment, require, run
from leaf_check import LeafPeers, measure

ROOT = Path(__file__).resolve().parents[1]


def configuration_checks(image):
    """Check the real startup parser against captured bounded integer cases."""
    fixture = json.loads(
        (ROOT / "runtime/tests/fixtures/domain-retriever.json").read_text(),
        object_hook=lambda obj: int("".join(obj["$integer_parts"]))
        if list(obj) == ["$integer_parts"]
        else obj,
    )
    results = []
    with tempfile.TemporaryDirectory(prefix="daedalus-domain-config-") as directory:
        root = Path(directory)
        root.chmod(0o755)
        for index, case in enumerate(fixture["configuration"]):
            raw = case["input"]
            bounded = [key for key in ["top_k", "reranker_top_n"] if key in raw]
            if len(raw) != 3 or len(bounded) != 1:
                continue
            value = raw[bounded[0]]
            if type(value) is not int or not (value == 1 or abs(value) >= 20):
                continue
            config = {
                "functions": {"domain": {"_type": "domain_retriever", **raw}},
                "llms": {
                    "main": {
                        "_type": "openai",
                        "api_type": "responses",
                        "api_key": "synthetic",
                        "base_url": "http://127.0.0.1:1/v1",
                        "model_name": "fixture",
                    }
                },
                "workflow": {
                    "_type": "daedalus_rust_agent",
                    "llm_name": "main",
                    "tools": ["domain"],
                },
            }
            (root / "config.json").write_text(json.dumps(config))
            process = run(
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "-v",
                f"{root}:/fixture:ro",
                "-e",
                "DAEDALUS_CONFIG_FILE=/fixture/config.json",
                "-e",
                "DAEDALUS_INTERNAL_API_TOKEN=synthetic-internal",
                "-e",
                "DAEDALUS_PREPARATION=rust",
                "-e",
                "DAEDALUS_AUTHORIZATION=rust",
                "-e",
                "DAEDALUS_TOOL_EXECUTOR=disabled",
                "--entrypoint",
                "/workspace/daedalus-runtime",
                image,
                "--check-config",
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
            accepted = "ok" in case["expected"]
            require(
                (process.returncode == 0) == accepted,
                f"Domain startup configuration mismatch: fixture {index}",
            )
            if accepted:
                require(
                    "python_executor_required=false" in process.stdout,
                    "Domain configuration still requires Python",
                )
            results.append({"fixture_index": index, "accepted": accepted})
    require(len(results) == 12, "Missing domain startup configuration cases")
    return results


def main(args):
    peers = [Peers(), Peers()]
    servers = [ThreadingHTTPServer(("127.0.0.1", 0), peer.handler()) for peer in peers]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    profiles = []
    baseline = None
    cancellation_baseline = None
    try:
        with milvus_fixture(args.python_image, mutual_tls=True) as milvus:
            endpoints = [f"http://127.0.0.1:{server.server_port}" for server in servers]
            cases = scenarios(f"http://127.0.0.1:{milvus['port']}", *endpoints, milvus)
            if args.case:
                selected = set(args.case)
                cases = [case for case in cases if case["name"] in selected]
                require(
                    {case["name"] for case in cases} == selected,
                    "Unknown domain HTTP scenario",
                )

            def configure(config, *_):
                config["functions"], config["embedders"] = {}, {}
                for index, case in enumerate(cases):
                    raw = copy.deepcopy(case["configuration"]["functions"]["documents"])
                    name, embedder = f"domain_{index}", f"domain_embedding_{index}"
                    raw["embedding_model"] = embedder
                    config["functions"][name] = raw
                    old = case["configuration"].get("embedders", {})
                    if old:
                        config["embedders"][embedder] = next(iter(old.values()))
                config["workflow"]["tools"] = list(config["functions"])

            for label, image, minimal, preparation, authorization in [
                ("retained", args.python_image, False, "python", "python"),
                ("native-full", args.image, False, "rust", "rust"),
                ("native-python-auth", args.image, False, "rust", "python"),
                ("native-minimal", args.minimal_image, True, "rust", "rust"),
            ]:
                model = LeafPeers()
                observed = []
                with environment(
                    image,
                    args.redis_image,
                    minimal=minimal,
                    memory=False,
                    peers=model,
                    configure=configure,
                    fixture_mounts=[(milvus["root"], milvus["root"])],
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
                        for endpoint, key in zip(
                            endpoints, ["embedding", "reranking"], strict=True
                        ):
                            env["client"].post(
                                endpoint + "/__reset", json=case[key]
                            ).raise_for_status()
                        results = []
                        for invocation in case["invocations"]:
                            requests_before, outputs_before = (
                                len(model.requests),
                                len(model.results),
                            )
                            model.plan = [
                                {
                                    "name": f"domain_{index}",
                                    "arguments": invocation["input"],
                                }
                            ]
                            result = normalized(measure(env))
                            result["model_outputs"] = copy.deepcopy(
                                model.results[outputs_before:]
                            )
                            schemas = [
                                entry.get("function", entry)
                                for entry in model.requests[requests_before]["tools"]
                            ]
                            schema = next(
                                entry
                                for entry in schemas
                                if entry.get("name") == f"domain_{index}"
                            )
                            result["schema"] = {
                                key: schema[key]
                                for key in ["name", "description", "parameters"]
                            }
                            require(
                                result["done"] and not result["errors"],
                                f"Domain chat failed: {label}/{case['name']}",
                            )
                            top = invocation["input"].get("top_k")
                            guarded = case["name"] == "argument-bounds" and not (
                                top is None
                                or isinstance(top, (int, float))
                                and not isinstance(top, bool)
                                and 1 <= top <= 50
                                and int(top) == top
                            )
                            require(
                                len(result["ends"]) == (0 if guarded else 1),
                                f"Missing domain result: {label}/{case['name']}",
                            )
                            results.append(result)
                            if invocation.get("settle"):
                                time.sleep(invocation["settle"])
                        calls = milvus["control"].get("/calls").json()
                        for call in calls:
                            if info := call["body"].get("client_info"):
                                require(
                                    info["sdk_type"]
                                    == ("Python" if label == "retained" else "Rust"),
                                    "Wrong domain executor",
                                )
                                info["sdk_type"] = "Python"
                        item = {
                            "name": case["name"],
                            "results": results,
                            "milvus": tool_milvus_calls(calls),
                            "embedding": copy.deepcopy(peers[0].calls),
                            "reranking": copy.deepcopy(peers[1].calls),
                        }
                        observed.append(item)
                        if baseline is not None:
                            require(
                                item == baseline[index],
                                f"Domain API mismatch: {label}/{case['name']}\n{item}\n{baseline[index]}",
                            )
                        print(f"Domain HTTP: {label}/{case['name']}", flush=True)
                    cancellation = cancel_search(
                        env,
                        milvus,
                        model,
                        cases[0],
                        name="domain_0",
                        arguments={
                            "query": "Synthetic cancelled domain search",
                            "domain": "nvidia",
                        },
                    )
                    if cancellation_baseline is None:
                        cancellation_baseline = cancellation
                    else:
                        require(
                            cancellation == cancellation_baseline,
                            f"Domain cancellation mismatch: {label}",
                        )
                if baseline is None:
                    baseline = observed
                profiles.append(
                    {
                        "name": label,
                        "cases": observed,
                        "cancellation": cancellation,
                        "configuration": configuration_checks(image)
                        if label != "retained"
                        else [],
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
                "status": "passed-native-domain-retriever-http",
                "profiles": profiles,
                "source_sha256": {
                    str(path.relative_to(ROOT)): hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                    for path in [
                        Path(__file__),
                        ROOT / "migration/domain_retriever_check.py",
                        ROOT / "runtime/tests/fixtures/domain-retriever.json",
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
    parser.add_argument("--case", action="append", default=[])
    main(parser.parse_args())
