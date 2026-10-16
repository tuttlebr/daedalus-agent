#!/usr/bin/env python3
"""Measure native cached-output retrieval against Python in the same full image.

Uses disposable Redis and a scripted model. All tool payloads must match; this
measures application overhead, not live model generation or external services.
"""

import argparse
import hashlib
import json
import statistics
from pathlib import Path

from benchmark import percentile
from image_check import environment, require, run
from leaf_check import LeafPeers, measure, verify
from output_retriever_check import TOOL, baseline_write, configure, reference


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    image_id = run(
        "docker",
        "image",
        "inspect",
        args.image,
        "--format",
        "{{.Id}}",
        capture_output=True,
        text=True,
    ).stdout.strip()
    content = "Synthetic cached evidence 雪🌲. " * 32768
    workloads = {
        "chunk": {"reference": reference(content), "offset": 500000, "max_chars": 1000},
        "search": {"reference": reference(content), "query": "cached evidence"},
    }
    report = {
        "image_id": image_id,
        "content_bytes": len(content.encode()),
        "content_sha256": hashlib.sha256(content.encode()).hexdigest(),
        "limits": {"cpus": 2, "memory": "2g"},
        "warmup": 10,
        "samples": 100,
        "concurrency": 1,
        "profiles": [],
    }
    expected = {}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    # Alternate modes to make drift observable; preserve every repetition.
    for mode in ["python", "rust", "python", "rust"]:
        peers = LeafPeers()
        with environment(
            image_id,
            args.redis_image,
            minimal=mode == "rust",
            memory=False,
            peers=peers,
            configure=configure,
            resource_limits=True,
        ) as env:
            baseline_write(env, image_id, [content])
            profile = {"mode": mode, "workloads": {}}
            for workload, arguments in workloads.items():
                peers.plan = [{"name": TOOL, "arguments": arguments}]
                samples = []
                for index in range(report["warmup"] + report["samples"]):
                    peers.results.clear()
                    result = measure(env)
                    verify(result, peers.plan)
                    payload = result["ends"][0]["payload"]
                    data = json.loads(payload)
                    require("error" not in data, "Retrieval returned an error")
                    if workload == "chunk":
                        require(
                            data["content"] == content[500000:501000],
                            "Retrieved chunk differs from the stored Unicode text",
                        )
                    else:
                        require(bool(data["matches"]), "Search returned no matches")
                    require(
                        payload == expected.setdefault(workload, payload),
                        f"{mode} {workload} changed the tool payload",
                    )
                    if index >= report["warmup"]:
                        samples.append(result["latency_ms"])
                profile["workloads"][workload] = {
                    "samples_ms": samples,
                    "p50_ms": statistics.median(samples),
                    "p95_ms": percentile(samples),
                    "payload_sha256": hashlib.sha256(payload.encode()).hexdigest(),
                }
                print(
                    f"{mode} {workload}: p95 {percentile(samples):.2f} ms", flush=True
                )
            report["profiles"].append(profile)
            args.report.write_text(json.dumps(report, indent=2) + "\n")
    report["status"] = "passed-payload-parity"
    args.report.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
