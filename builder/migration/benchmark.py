#!/usr/bin/env python3
"""Frozen P0/P1 synthetic workloads. Retain every measurement and failure.

No live providers or production Redis are contacted. Run after image builds and
other CPU-intensive checks have finished. The release soak belongs to P4.
"""

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import threading
import time
import uuid
from pathlib import Path

from image_check import environment, require, run

FIXTURES = Path(__file__).resolve().parents[1] / "runtime/tests/fixtures"


def percentile(values):
    return sorted(values)[max(0, math.ceil(len(values) * 0.95) - 1)]


def resources(container, stop, samples):
    pid = run(
        "docker",
        "inspect",
        "--format",
        "{{.State.Pid}}",
        container,
        capture_output=True,
        text=True,
    ).stdout.strip()
    while not stop.wait(0.1):
        pending, rss, fds, threads, cpu_ticks = [pid], 0, 0, 0, 0
        try:
            while pending:
                current = Path("/proc") / pending.pop()
                for line in (current / "status").read_text().splitlines():
                    if line.startswith("VmRSS:"):
                        rss += int(line.split()[1]) * 1024
                    elif line.startswith("Threads:"):
                        threads += int(line.split()[1])
                # Field 3 starts after the parenthesized process name; fields
                # 14/15 are user/system CPU ticks for this process.
                stat = (current / "stat").read_text().rsplit(")", 1)[1].split()
                cpu_ticks += int(stat[11]) + int(stat[12])
                fds += len(list((current / "fd").iterdir()))
                pending += (
                    (current / "task" / current.name / "children").read_text().split()
                )
            samples.append(
                {
                    "rss_bytes": rss,
                    "file_descriptors": fds,
                    "threads": threads,
                    "cpu_seconds": cpu_ticks / os.sysconf("SC_CLK_TCK"),
                }
            )
        except (FileNotFoundError, PermissionError):
            # Docker's process namespace can be inaccessible on a remote daemon.
            samples.append({"unavailable": True})
            return


def measure(image, redis_image, candidate, budgets):
    installed = json.loads(
        run("docker", "image", "inspect", image, capture_output=True, text=True).stdout
    )[0]
    result = {
        "image": image,
        "image_id": installed["Id"],
        "image_digests": installed["RepoDigests"],
        "architecture": installed["Architecture"],
        "image_bytes": installed["Size"],
        "harness_sha256": {
            str(path.relative_to(FIXTURES.parents[3])): hashlib.sha256(
                path.read_bytes()
            ).hexdigest()
            for path in [
                Path(__file__),
                Path(__file__).with_name("image_check.py"),
                FIXTURES / "budgets.json",
                FIXTURES.parents[2] / "runtime_http_check.py",
            ]
        },
        "runs": [],
        "control": [],
        "resources": [],
    }
    for memory in [False, True]:
        with environment(
            image, redis_image, minimal=candidate, memory=memory, resource_limits=True
        ) as fixture:
            result["resources"].append(
                {
                    "memory": memory,
                    "readiness_ms": fixture["readiness_ms"],
                    "samples": [],
                }
            )
            stop = threading.Event()
            sampler = threading.Thread(
                target=resources,
                args=(fixture["container"], stop, result["resources"][-1]["samples"]),
                daemon=True,
            )
            sampler.start()
            client, peers = fixture["client"], fixture["peers"]
            base, headers = fixture["base"], fixture["headers"]
            log = fixture["root"] / "backend.log"

            def chat(workload, index):
                query = "BASIC" if workload == "clock" else "TEXT_ONLY"
                if memory:
                    query += " What do you remember about the project?"
                messages = []
                if workload == "history_unicode":
                    messages = [
                        {
                            "role": "user" if n % 2 == 0 else "assistant",
                            "content": "Synthetic 雪🌲é " * (n + 1),
                        }
                        for n in range(20)
                    ]
                messages.append({"role": "user", "content": query})
                start = time.monotonic()
                row = {"sample": index}
                try:
                    response = client.post(
                        base + "/v1/chat/completions",
                        headers=headers | {"x-daedalus-request-id": uuid.uuid4().hex},
                        json={"stream": False, "messages": messages},
                    )
                    require(response.is_success, "HTTP failure")
                    require(
                        (
                            "The real datetime tool completed"
                            if workload == "clock"
                            else "Synthetic text response"
                        )
                        in response.text,
                        "Incorrect answer",
                    )
                    row["success"] = True
                except Exception as error:
                    row.update(success=False, error=type(error).__name__)
                row["elapsed_ms"] = (time.monotonic() - start) * 1000
                return row

            try:
                for workload in (
                    ["memory_context"]
                    if memory
                    else ["text", "clock", "history_unicode"]
                ):
                    for concurrency in budgets["overhead"]["concurrency"]:
                        for repetition in range(budgets["overhead"]["repetitions"]):
                            peers.requests.clear()
                            with concurrent.futures.ThreadPoolExecutor(
                                max_workers=concurrency
                            ) as pool:
                                warmup = list(
                                    pool.map(
                                        lambda i: chat(workload, i),
                                        range(budgets["overhead"]["warmup"]),
                                    )
                                )
                                offset = log.stat().st_size
                                samples = list(
                                    pool.map(
                                        lambda i: chat(workload, i),
                                        range(budgets["overhead"]["measured_runs"]),
                                    )
                                )
                            events = []
                            with log.open("rb") as handle:
                                handle.seek(offset)
                                for line in handle:
                                    try:
                                        record = json.loads(line)
                                    except ValueError:
                                        continue
                                    fields = record.get("fields", record)
                                    if fields.get("event") in [
                                        "prepare_finished",
                                        "tool_call_finished",
                                    ]:
                                        events.append(
                                            {
                                                k: fields[k]
                                                for k in ["event", "elapsed_ms"]
                                            }
                                        )
                            if memory:
                                require(
                                    any(
                                        "[MEMORY_CONTEXT]" in json.dumps(r)
                                        for r in peers.requests
                                    ),
                                    "Missing memory context",
                                )
                            result["runs"].append(
                                {
                                    "workload": workload,
                                    "concurrency": concurrency,
                                    "repetition": repetition,
                                    "warmup": warmup,
                                    "samples": samples,
                                    "events": events,
                                }
                            )
                            print(
                                f"{image}: {workload} c={concurrency} repeat={repetition + 1}",
                                flush=True,
                            )
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    phases = (
                        ["stop_preparation"]
                        if memory
                        else ["steer_model_wait", "stop_model_wait"]
                    )
                    for phase in phases:
                        for sample in range(budgets["control"]["samples_per_phase"]):
                            peers.requests.clear()
                            peers.model_waiting.clear()
                            peers.release_model.clear()
                            peers.memory_waiting.clear()
                            peers.memory_disconnected.clear()
                            peers.block_memory = memory
                            run_id = uuid.uuid4().hex
                            request_headers = headers | {
                                "x-daedalus-request-id": run_id,
                                "x-user-id": "synthetic-" + run_id,
                            }
                            future = pool.submit(
                                client.post,
                                base + "/v1/chat/completions",
                                headers=request_headers,
                                json={
                                    "stream": True,
                                    "messages": [
                                        {
                                            "role": "user",
                                            "content": "BASIC"
                                            if memory
                                            else "MODEL_STEER",
                                        }
                                    ],
                                },
                            )
                            require(
                                (
                                    peers.memory_waiting
                                    if memory
                                    else peers.model_waiting
                                ).wait(10),
                                "Control barrier not reached",
                            )
                            command = {
                                "type": "steer"
                                if phase.startswith("steer")
                                else "cancel",
                                "command_id": uuid.uuid4().hex,
                            }
                            if command["type"] == "steer":
                                command["instruction"] = "NEW_DIRECTION: answer now"
                            start = time.monotonic()
                            response = client.post(
                                base + f"/v1/runs/{run_id}/control",
                                headers=request_headers,
                                json=command,
                            )
                            answer = future.result(timeout=5)
                            success = (
                                response.is_success
                                and (
                                    "Directed answer"
                                    if command["type"] == "steer"
                                    else "Run cancelled by user"
                                )
                                in answer.text
                            )
                            elapsed = (time.monotonic() - start) * 1000
                            peers.release_model.set()
                            if memory:
                                success = success and peers.memory_disconnected.wait(3)
                            result["control"].append(
                                {
                                    "phase": phase,
                                    "sample": sample,
                                    "success": success,
                                    "elapsed_ms": elapsed,
                                }
                            )
                peers.block_memory = False
            finally:
                stop.set()
                sampler.join(5)
    return result


def compare(baseline, candidate, budgets):
    gates = []
    for old, new in zip(baseline["runs"], candidate["runs"], strict=True):
        for event in ["prepare_finished", "tool_call_finished"]:
            before = [r["elapsed_ms"] for r in old["events"] if r["event"] == event]
            after = [r["elapsed_ms"] for r in new["events"] if r["event"] == event]
            expected = (
                budgets["overhead"]["measured_runs"]
                if event == "prepare_finished" or old["workload"] == "clock"
                else 0
            )
            require(
                len(before) == len(after) == expected, "Missing overhead observations"
            )
            if expected:
                limit = percentile(before) + max(
                    budgets["overhead"]["p95_allowance_ms"],
                    percentile(before)
                    * budgets["overhead"]["p95_max_regression_fraction"],
                )
                gates.append(
                    {
                        "workload": old["workload"],
                        "concurrency": old["concurrency"],
                        "repetition": old["repetition"],
                        "event": event,
                        "baseline_p95_ms": percentile(before),
                        "candidate_p95_ms": percentile(after),
                        "limit_ms": limit,
                        "pass": percentile(after) <= limit,
                    }
                )
    for phase in budgets["workloads"][-3:]:
        values = [r["elapsed_ms"] for r in candidate["control"] if r["phase"] == phase]
        gates.append(
            {
                "phase": phase,
                "p95_ms": percentile(values),
                "max_ms": max(values),
                "pass": percentile(values)
                <= budgets["control"]["p95_cancellable_wait_ms"],
            }
        )
    for old, new in zip(baseline["resources"], candidate["resources"], strict=True):
        for metric, before, after in [
            ("cold_readiness_ms", old["readiness_ms"], new["readiness_ms"]),
            (
                "peak_rss_bytes",
                max(r.get("rss_bytes", 0) for r in old["samples"]),
                max(r.get("rss_bytes", 0) for r in new["samples"]),
            ),
        ]:
            gates.append(
                {
                    "memory": old["memory"],
                    "metric": metric,
                    "baseline": before,
                    "candidate": after,
                    "pass": bool(before and after) and after <= before * 1.1,
                }
            )
    success = all(
        r["success"]
        for result in [baseline, candidate]
        for group in result["runs"]
        for r in group["samples"] + group["warmup"]
    ) and all(
        r["success"] for result in [baseline, candidate] for r in result["control"]
    )
    gates.append({"functional_correctness": success, "pass": success})
    return gates


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    budgets = json.loads((FIXTURES / "budgets.json").read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    results = []
    for name, image, candidate in [
        ("baseline", args.baseline, False),
        ("candidate", args.candidate, True),
    ]:
        result = measure(image, args.redis_image, candidate, budgets)
        (args.output / f"{name}.json").write_text(json.dumps(result, indent=2) + "\n")
        results.append(result)
    gates = compare(*results, budgets)
    (args.output / "gates.json").write_text(json.dumps(gates, indent=2) + "\n")
    require(
        all(gate["pass"] for gate in gates),
        "A frozen performance gate failed; see gates.json",
    )
    print("All frozen P1 synthetic performance gates passed")


if __name__ == "__main__":
    main()
