#!/usr/bin/env python3
"""Paired, real-model multi-source research and steering with frozen acceptance."""

import argparse
import concurrent.futures
import html
import json
import subprocess  # nosec B404 - explicit Docker image identity read
import sys
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
from image_check import require
from leaf_check import measure
from research_check import LiveResearchPeers, fixture

sys.path.insert(
    0, str(Path(__file__).resolve().parents[2] / "evaluation/tool-correctness")
)
from experiment import (
    digest,
    require_stable_route,
    route_bytes,
    route_digest,
    target_metadata,
)
from research import BUDGETS, EXPECTED, SOURCES, WORKLOADS, article, assess, prompt


class WorkflowPeers(LiveResearchPeers):
    def __init__(self, base_url, model):
        super().__init__(base_url, model)
        self.steer_waiting = threading.Event()
        self.steer_disconnected = threading.Event()
        self.reset("comparison")

    def reset(self, workload):
        self.workload = workload
        self.steer_waiting.clear()
        self.steer_disconnected.clear()
        self.requests.clear()
        self.round_sizes.clear()
        self.results.clear()
        self.usage.clear()
        self.model_calls.clear()
        self.fetches = []

    def before_forward(self, handler, body):
        outputs = [
            item for item in body["input"] if item.get("type") == "function_call_output"
        ]
        if (
            self.workload == "steering"
            and outputs
            and "RESEARCH_UPDATE" not in json.dumps(body["input"])
        ):
            # Stop before forwarding stale work to the paid provider. The runtime
            # must cancel this pending request and retain its completed tool receipt.
            self.steer_waiting.set()
            handler.wait_for_disconnect(self.steer_disconnected)
            return True
        return False

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def do_GET(self):
                url = parse_qs(urlsplit(self.path).query).get("url", [""])[0]
                peers.fetches.append(url)
                if url not in SOURCES:
                    return self.reply({"error": "source unavailable"}, 404)
                data = (
                    "<html><head><meta charset='utf-8'><title>Synthetic source</title></head><body><p>"
                    + html.escape(article(url))
                    + "</p></body></html>"
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        return Handler


def attempt(env, peers, mode, workload):
    peers.reset(workload)
    run_id = str(uuid.uuid4())
    if workload == "comparison":
        return measure(env, message=prompt(mode, workload), request_id=run_id)
    with concurrent.futures.ThreadPoolExecutor() as pool:
        future = pool.submit(
            measure, env, message=prompt(mode, workload), request_id=run_id
        )
        deadline = time.monotonic() + 60
        while not peers.steer_waiting.wait(0.1):
            if future.done():
                result = future.result()
                result["steering_accepted"] = False
                return result
            require(time.monotonic() < deadline, "Steering barrier timed out")
        response = httpx.post(
            env["base"] + f"/v1/runs/{run_id}/control",
            headers=env["headers"] | {"x-user-id": "synthetic-alice"},
            json={
                "type": "steer",
                "command_id": str(uuid.uuid4()),
                "instruction": prompt(mode, workload, steered=True),
            },
            trust_env=False,
            timeout=10,
        )
        result = future.result(timeout=90)
        result["steering_accepted"] = (
            response.status_code == 200 and peers.steer_disconnected.wait(2)
        )
        return result


def main(args):
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    routing = route_digest(None, args.route_configmap)
    prompts = {
        mode: {workload: prompt(mode, workload) for workload in WORKLOADS}
        | {"steering_update": prompt(mode, "steering", steered=True)}
        for mode in ("full", "research")
    }
    manifest = {
        "version": 1,
        "model_alias": args.model,
        "image_digest": subprocess.check_output(  # nosec B603 B607 - explicit image identity read
            ["docker", "image", "inspect", args.image, "--format", "{{.Id}}"],
            text=True,
            timeout=15,
        ).strip(),
        "source_revision": args.source_revision,
        "route_config_digest": routing,
        "workloads": list(WORKLOADS),
        "source_digest": digest({url: article(url) for url in SOURCES}),
        "prompts": prompts,
        "prompt_digest": digest(prompts),
        "expected": EXPECTED,
        "budgets": BUDGETS,
        "repetitions": 3,
        "max_attempts": 12,
        "acceptance": "Every exact answer, citation, tool receipt, omitted fact recovery, missing-source interpretation and steering assertion must pass; research recurring context must be <= 50% of full within each pair. No latency improvement claim.",
        "cache": "as found; alternating modes; same image and synthetic user; memory disabled",
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    peers = WorkflowPeers(args.base_url, args.model)
    peers.targets = target_metadata(route_bytes(None, args.route_configmap))
    attempts = []
    try:
        with fixture(args.image, args.redis_image, peers) as env:
            for repetition in range(1, 4):
                for workload in WORKLOADS:
                    for mode in (
                        ("full", "research") if repetition % 2 else ("research", "full")
                    ):
                        require_stable_route(None, routing, args.route_configmap)
                        try:
                            result = attempt(env, peers, mode, workload)
                            verdict = assess(result, mode)
                            verdict["checks"]["context_budget"] = (
                                bool(peers.round_sizes)
                                and max(peers.round_sizes)
                                <= BUDGETS[f"{mode}_context_chars"]
                                and len(peers.model_calls) <= BUDGETS["max_model_calls"]
                            )
                            verdict["checks"]["steering"] = (
                                workload != "steering"
                                or result.get("steering_accepted", False)
                            )
                            verdict["passed"] = all(verdict["checks"].values())
                        except Exception as error:
                            result, verdict = (
                                {},
                                {"passed": False, "error_class": type(error).__name__},
                            )
                        row = {
                            "repetition": repetition,
                            "workload": workload,
                            "mode": mode,
                            **verdict,
                            "result": result,
                            "model_calls": peers.model_calls.copy(),
                            "recurring_input_chars": peers.round_sizes[1:],
                            "http_fetches": peers.fetches.copy(),
                        }
                        attempts.append(row)
                        with (args.output / "attempts.jsonl").open("a") as log:
                            log.write(json.dumps(row, ensure_ascii=False) + "\n")
                        require_stable_route(None, routing, args.route_configmap)
                        print(
                            f"{workload} {mode} r{repetition}: {'pass' if row['passed'] else 'FAIL'}",
                            flush=True,
                        )
                        if not row["passed"]:
                            raise RuntimeError(
                                "Frozen research workflow gate failed; attempts preserved"
                            )
    finally:
        (args.output / "results.json").write_text(
            json.dumps(
                {"manifest": manifest, "attempts": attempts},
                indent=2,
                ensure_ascii=False,
            )
            + "\n"
        )
    ratios = []
    for repetition in range(1, 4):
        for workload in WORKLOADS:
            pair = {
                a["mode"]: a
                for a in attempts
                if a["repetition"] == repetition and a["workload"] == workload
            }
            ratio = max(pair["research"]["recurring_input_chars"]) / max(
                pair["full"]["recurring_input_chars"]
            )
            ratios.append(ratio)
    summary = {
        "passed": len(attempts) == 12
        and all(r <= BUDGETS["research_context_ratio"] for r in ratios),
        "attempts": len(attempts),
        "max_recurring_context_ratio": max(ratios),
        "latency_ms": {
            mode: [a["result"]["latency_ms"] for a in attempts if a["mode"] == mode]
            for mode in ("full", "research")
        },
    }
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    require(
        summary["passed"],
        "Context comparison failed; preserve disabled production mode",
    )
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", default="daedalus/high")
    parser.add_argument(
        "--route-configmap", nargs=3, metavar=("CONTEXT", "NAMESPACE", "NAME")
    )
    parser.add_argument("--output", type=Path, required=True)
    main(parser.parse_args())
