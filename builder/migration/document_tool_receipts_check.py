#!/usr/bin/env python3
"""Freeze retained-tool receipt and frontend SSE behavior at the UTF-8 boundary."""

import argparse
import copy
import hashlib
import json
from pathlib import Path

from collections_check import milvus_fixture
from document_runner_check import KEY
from document_tool_ingestion_check import PREFIX, ROOT, cases, reservation_key
from documents_check import DocumentPeers
from image_check import environment, require, run
from leaf_check import LeafPeers, measure
from profile_import_check import expand


class ReceiptPeers(DocumentPeers, LeafPeers):
    """Use the real document SDK alongside a deterministic model tool plan."""


def normalized(result):
    result = copy.deepcopy(result)
    result.pop("latency_ms")
    # Per-run wall-clock observations are reported by measure(), not part of
    # the deterministic tool/SSE compatibility contract.
    result.pop("first_answer_ms", None)
    for event in [*result["starts"], *result["ends"]]:
        event.pop("parent_id", None)
    return result


def main(args):
    oracle = expand(
        json.loads((ROOT / "runtime/tests/fixtures/milvus-index.json").read_text())
    )
    selected = [case for case in cases(oracle) if case.get("receipt_ascii")]
    profiles = []
    with milvus_fixture(args.image) as fixture:

        def configure(config, port, runtime_port):
            config["functions"] = {
                "user_documents": {
                    "_type": "nat_nv_ingest",
                    "redis_url": "${REDIS_URL}",
                    "nv_ingest_host": "127.0.0.1",
                    "nv_ingest_port": port,
                    "milvus_uri": f"http://127.0.0.1:{fixture['port']}",
                    "milvus_username": "synthetic-user",
                    "milvus_password": "synthetic-password",
                    "embedder_dim": 2,
                    "ingest_max_retries": 0,
                    "ingest_timeout_seconds": 30,
                }
            }
            config["workflow"]["tools"] = ["user_documents"]

        for preparation in ["python", "rust"]:
            peers = ReceiptPeers()
            observations = []
            with environment(
                args.image,
                args.redis_image,
                minimal=False,
                memory=False,
                peers=peers,
                configure=configure,
                redis_json=True,
                extra_env=lambda _, mode=preparation: {
                    "DAEDALUS_PREPARATION": mode,
                    "DAEDALUS_AUTHORIZATION": mode,
                    "AUTONOMY_IDEMPOTENCY_TTL_SECONDS": "6000",
                },
            ) as env:
                for case in selected:
                    for key in env["redis"].scan_iter(PREFIX + "*"):
                        env["redis"].delete(key)
                    env["redis"].execute_command(
                        "JSON.SET", KEY, "$", json.dumps(case["record"])
                    )
                    if "existing_json" in case:
                        env["redis"].set(
                            reservation_key(case), case["existing_json"], ex=6000
                        )
                    peers.reset_documents()
                    peers.document_reply = json.loads(
                        case.get("reply_json") or json.dumps(case["reply"])
                    )
                    peers.plan = [
                        {"name": "user_documents", "arguments": case["input"]}
                    ]
                    fixture["control"].post(
                        "/reset", json=case["settings"]
                    ).raise_for_status()
                    results = []
                    receipts = []
                    nv_counts = []
                    for failed in case["stream_errors"]:
                        result = normalized(
                            measure(
                                env,
                                extra_headers={
                                    k: v
                                    for k, v in case["headers"].items()
                                    if k.startswith("x-daedalus-execution-")
                                },
                            )
                        )
                        require(result["done"], "Missing terminal SSE sentinel")
                        require(len(result["starts"]) == 1, "Wrong tool dispatch")
                        if failed:
                            require(
                                not result["ends"], "Invalid UTF-8 leaked a completion"
                            )
                            require(
                                result["terminal"] == "error", "Missing stream failure"
                            )
                            require(
                                result["errors"]
                                == [
                                    {
                                        "error": {
                                            "message": "Agent execution failed; completed output has been preserved"
                                        }
                                    }
                                ],
                                "Changed caller-visible encoding failure",
                            )
                        else:
                            require(
                                len(result["ends"]) == 1,
                                "Valid result did not complete",
                            )
                            require(not result["errors"], "Valid result failed")
                            require(result["terminal"] == "stop", "Missing completion")
                        results.append(result)
                        keys = list(env["redis"].scan_iter(PREFIX + "*"))
                        require(
                            len(keys) == 1, "Missing or duplicate ingestion receipt"
                        )
                        raw = env["redis"].get(keys[0])
                        require(raw.isascii(), "Receipt lost ASCII JSON encoding")
                        record = json.loads(raw)
                        require(
                            record["state"] == "completed",
                            "Accepted write left pending",
                        )
                        require(
                            5950 <= env["redis"].ttl(keys[0]) <= 6000,
                            "Wrong receipt TTL",
                        )
                        require(
                            any(0xD800 <= ord(c) <= 0xDFFF for c in record["result"])
                            == case["stream_errors"][-1],
                            "Receipt lost or introduced a surrogate",
                        )
                        if not failed:
                            require(
                                result["ends"][0]["payload"] == record["result"],
                                "Tool completion differs from its durable receipt",
                            )
                        receipts.append(raw.decode("ascii"))
                        nv_counts.append(len(peers.document_calls))
                        require(
                            fixture["control"].get("/script").json()
                            == {"remaining": 0, "errors": []},
                            "Wrong Milvus write sequence",
                        )
                    require(receipts[0] == receipts[1], "Replay rewrote the receipt")
                    if case["stream_errors"][0] == case["stream_errors"][1]:
                        require(
                            results[0] == results[1], "Replay changed the SSE result"
                        )
                    expected_calls = 0 if "existing_json" in case else 2
                    require(
                        nv_counts == [expected_calls] * 2, "Replay repeated ingestion"
                    )
                    observations.append(
                        {
                            "name": case["name"],
                            "results": results,
                            "receipt": receipts[0],
                            "nv_calls": nv_counts,
                        }
                    )
                    print(f"Receipt stream: {preparation}/{case['name']}", flush=True)
            profiles.append({"preparation": preparation, "cases": observations})
        require(
            profiles[0]["cases"] == profiles[1]["cases"],
            "Preparation changed tool semantics",
        )
    sources = [Path(__file__), ROOT / "migration/document_tool_ingestion_check.py"]
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(
            {
                "status": "passed-retained-wire-contract",
                "profiles": profiles,
                "source_sha256": {
                    str(path.relative_to(ROOT)): hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                    for path in sources
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
                    for image in [args.image, args.redis_image]
                },
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    main(parser.parse_args())
