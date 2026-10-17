#!/usr/bin/env python3
"""Built-image research excerpts, exact recovery, failure and isolation contracts."""

import argparse
import html
import json
import os
import time
from pathlib import Path

import httpx
from image_check import environment, require
from leaf_check import measure
from runtime_http_check import Peers

MARKER = "雪🌲MIDDLE7391"
ARTICLE = (
    "# Synthetic report\n\nThe release label appears later under a verification heading.\n"
    + "Ordinary background. " * 1500
    + f"\nVerification code: {MARKER}\n"
    + "Additional context. " * 1500
)


class ResearchPeers(Peers):
    def __init__(self):
        super().__init__()
        self.mode = "research"
        self.research_enabled = True
        self.schemas = []
        self.reference = None
        self.retrieve_only = False
        self.results = []
        self.round_sizes = []

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def do_GET(self):
                data = (
                    "<html><head><meta charset='utf-8'><title>Synthetic report</title></head><body><p>"
                    + html.escape(ARTICLE)
                    + "</p></body></html>"
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                peers.schemas = body.get("tools", [])
                peers.round_sizes.append(
                    len(json.dumps(body["input"], ensure_ascii=False))
                )
                outputs = [
                    item
                    for item in body["input"]
                    if item.get("type") == "function_call_output"
                ]
                if not outputs:
                    name = (
                        "tool_output_retriever_tool"
                        if peers.retrieve_only
                        else "webscrape_tool"
                    )
                    arguments = (
                        {"reference": peers.reference, "query": "Verification code"}
                        if peers.retrieve_only
                        else {
                            "url": "https://sources.test/research",
                            "output_mode": peers.mode,
                        }
                    )
                    if not peers.research_enabled:
                        arguments.pop("output_mode", None)
                    item = self.call(name, arguments, "source")
                else:
                    content = outputs[-1]["output"]
                    peers.results.append(content)
                    value = json.loads(content) if content.startswith("{") else {}
                    compacted = value.get("_daedalus_compacted_tool_output")
                    if compacted and len(outputs) == 1:
                        peers.reference = compacted["reference"]
                        item = self.call(
                            "tool_output_retriever_tool",
                            {
                                "reference": peers.reference,
                                "query": "Verification code",
                            },
                            "retrieve",
                        )
                    else:
                        text = MARKER if MARKER in content else "UNAVAILABLE"
                        item = {
                            "id": "msg_final",
                            "type": "message",
                            "role": "assistant",
                            "status": "completed",
                            "content": [
                                {"type": "output_text", "text": text, "annotations": []}
                            ],
                        }
                self.gateway = False
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                self.event(
                    {
                        "type": "response.output_item.added",
                        "output_index": 0,
                        "item": {**item, "status": "in_progress"},
                    }
                )
                if item["type"] == "message":
                    self.event(
                        {
                            "type": "response.output_text.delta",
                            "output_index": 0,
                            "content_index": 0,
                            "item_id": item["id"],
                            "delta": item["content"][0]["text"],
                        }
                    )
                self.event(
                    {
                        "type": "response.output_item.done",
                        "output_index": 0,
                        "item": item,
                    }
                )
                self.event(
                    {
                        "type": "response.completed",
                        "response": {
                            "id": "resp_fixture",
                            "object": "response",
                            "created_at": 1,
                            "status": "completed",
                            "model": "fixture",
                            "output": [item],
                            "usage": {
                                "input_tokens": 100,
                                "output_tokens": 20,
                                "total_tokens": 120,
                            },
                        },
                    }
                )

            @staticmethod
            def call(name, arguments, label):
                return {
                    "id": "fc_" + label,
                    "call_id": "call_" + label,
                    "type": "function_call",
                    "name": name,
                    "arguments": json.dumps(arguments),
                    "status": "completed",
                }

        return Handler


class LiveResearchPeers(ResearchPeers):
    def __init__(self, base_url, model):
        super().__init__()
        self.base_url, self.model = base_url, model
        self.usage = []
        self.model_calls = []
        self.targets = {}

    def before_forward(self, handler, body):
        """Optional control barrier for isolated workflow/steering experiments."""
        return False

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                body["model"] = peers.model
                peers.requests.append(body)
                if peers.before_forward(self, body):
                    return
                peers.round_sizes.append(
                    len(json.dumps(body["input"], ensure_ascii=False))
                )
                outputs = [
                    item
                    for item in body["input"]
                    if item.get("type") == "function_call_output"
                ]
                if outputs:
                    peers.results.append(outputs[-1]["output"])
                with httpx.Client(timeout=65, trust_env=False) as client:
                    with client.stream(
                        "POST",
                        peers.base_url.rstrip("/") + "/responses",
                        json=body,
                        headers={
                            "Authorization": "Bearer "
                            + os.environ.get(
                                "TOOL_EVAL_API_KEY", "synthetic-gateway-client"
                            )
                        },
                    ) as response:
                        target = response.headers.get("x-model-router-selected-model")
                        metadata = {
                            "selected_target": target,
                            "configured_provider_model": None,
                            "configured_effort": None,
                            "provider_reported_model": None,
                            "usage": None,
                            **peers.targets.get(target, {}),
                        }
                        peers.model_calls.append(metadata)
                        self.send_response(response.status_code)
                        self.send_header(
                            "Content-Type",
                            response.headers.get("Content-Type", "text/event-stream"),
                        )
                        self.send_header("Connection", "close")
                        self.end_headers()
                        self.close_connection = True
                        for line in response.iter_lines():
                            self.wfile.write((line + "\n").encode())
                            self.wfile.flush()
                            if line.startswith("data: ") and line != "data: [DONE]":
                                event = json.loads(line[6:])
                                if event.get("type") == "response.completed":
                                    peers.usage.append(event["response"].get("usage"))
                                    metadata["usage"] = event["response"].get("usage")
                                    metadata["provider_reported_model"] = event[
                                        "response"
                                    ].get("model")

        return Handler


def fixture(image, redis_image, peers, *, preparation="rust"):
    def configure(config, *_args):
        config["functions"] = {
            "webscrape_tool": {
                "_type": "webscrape",
                "respect_robots_txt": False,
                "enable_research_mode": peers.research_enabled,
            },
            "tool_output_retriever_tool": {"_type": "tool_output_retriever"},
        }
        config["workflow"].update(
            tools=list(config["functions"]),
            max_iterations=12,
            tool_output_compaction_enabled=True,
        )

    def extra_env(port):
        values = {
            "PYTHONPATH": "/fixture:/workspace",
            "DAEDALUS_TEST_PEER": f"http://127.0.0.1:{port}",
            "DAEDALUS_PREPARATION": preparation,
            "DAEDALUS_AUTHORIZATION": preparation,
        }
        return values

    return environment(
        image,
        redis_image,
        minimal=True,
        memory=False,
        peers=peers,
        configure=configure,
        fixture_files={
            "sitecustomize.py": "from leaf_fixtures import install\ninstall()\n",
            "leaf_fixtures.py": Path(__file__)
            .with_name("leaf_fixtures.py")
            .read_text(),
        },
        extra_env=extra_env,
    )


def check(image, redis_image):
    report = []
    for preparation in ("rust", "python"):
        peers = ResearchPeers()
        peers.mode, peers.research_enabled = "full", False
        with fixture(image, redis_image, peers, preparation=preparation) as env:
            result = measure(env)
            require(
                result["done"] and result["answer"] == MARKER,
                "Default scrape regressed",
            )
            schema = next(t for t in peers.schemas if t.get("name") == "webscrape_tool")
            require(
                set(schema["parameters"]["properties"]) == {"url"},
                "Experimental schema exposed by default",
            )
        peers = ResearchPeers()
        with fixture(image, redis_image, peers, preparation=preparation) as env:
            samples = {}
            for mode in ("full", "research"):
                peers.mode = mode
                peers.results.clear()
                peers.round_sizes.clear()
                started = time.monotonic()
                result = measure(
                    env,
                    message="Summarize the synthetic report, then look up its release label. Read each source once and preserve exact Unicode labels.",
                )
                require(
                    result["terminal"] == "stop" and not result["errors"],
                    "Research run failed",
                )
                require(
                    result["done"] and result["answer"] == MARKER,
                    "Research answer or stream terminal lost",
                )
                require(
                    MARKER in peers.results[-1], "Omitted evidence was not recovered"
                )
                samples[mode] = {
                    "recurring_input_chars": peers.round_sizes[1:],
                    "rounds": len(peers.round_sizes),
                    "elapsed_ms": round(1000 * (time.monotonic() - started)),
                }
                if mode == "research":
                    require(
                        len(peers.results) == 2 and MARKER not in peers.results[0],
                        "Required evidence was not omitted before retrieval",
                    )
                    require(
                        "https://sources.test/research" in peers.results[0],
                        "Lost source attribution",
                    )
            require(
                max(samples["research"]["recurring_input_chars"])
                < min(samples["full"]["recurring_input_chars"]) / 2,
                "Research evidence did not reduce recurring context",
            )
            peers.retrieve_only = True
            peers.results.clear()
            isolated = measure(env, user="synthetic-bob")
            require(
                isolated["terminal"] == "stop" and MARKER not in peers.results[-1],
                "Cross-user source disclosure",
            )
            for key in env["redis"].scan_iter(
                match="daedalus:tool-output:v1:*:" + peers.reference
            ):
                env["redis"].expire(key, 1)
            time.sleep(1.1)
            peers.results.clear()
            expired = measure(env)
            require(
                expired["answer"] == "UNAVAILABLE" and MARKER not in peers.results[-1],
                "Expired evidence was invented",
            )
            report.append(
                {
                    "preparation": preparation,
                    "samples": samples,
                    "cross_user_retrieval": "denied",
                }
            )
        peers = ResearchPeers()
        with fixture(image, redis_image, peers, preparation=preparation) as env:
            env["redis"].execute_command("ACL", "SETUSER", "backend", "-set")
            result = measure(env)
            require(
                result["terminal"] == "stop"
                and len(peers.results) == 1
                and MARKER in peers.results[0],
                "Archive failure discarded evidence",
            )
            report[-1]["archive_failure"] = "full_source_preserved"
    return report


def live_check(image, redis_image, base_url, model, output):
    peers = LiveResearchPeers(base_url, model)
    attempts = []
    with fixture(image, redis_image, peers) as env:
        for repetition in range(1, 4):
            for mode in (
                ("full", "research") if repetition % 2 else ("research", "full")
            ):
                peers.results.clear()
                peers.round_sizes.clear()
                peers.usage.clear()
                result = measure(
                    env,
                    message=f"Use webscrape_tool on https://sources.test/research with output_mode {mode}. Find the release label. Return only that label, preserving its characters, without commentary. Retrieve omitted source material if needed.",
                )
                expected_call = {
                    "url": "https://sources.test/research",
                    "output_mode": mode,
                }
                starts = result["starts"]
                passed = (
                    result["done"]
                    and result["terminal"] == "stop"
                    and not result["errors"]
                    and result["answer"].strip() == MARKER
                    and bool(starts)
                    and starts[0]["payload"] == expected_call
                    and all(
                        e["name"]
                        in (
                            "Function Start: webscrape_tool",
                            "Function Start: tool_output_retriever_tool",
                        )
                        for e in starts
                    )
                )
                if mode == "research":
                    passed = (
                        passed
                        and len(starts) > 1
                        and bool(peers.results)
                        and MARKER not in peers.results[0]
                    )
                attempts.append(
                    {
                        "repetition": repetition,
                        "mode": mode,
                        "passed": passed,
                        "answer": result["answer"],
                        "terminal": result["terminal"],
                        "done": result["done"],
                        "calls": starts,
                        "tool_results": result["ends"],
                        "latency_ms": result["latency_ms"],
                        "rounds": len(peers.round_sizes),
                        "recurring_input_chars": peers.round_sizes[1:],
                        "reported_usage": peers.usage,
                        "tool_names": [e["name"] for e in starts],
                    }
                )
                output.write_text(
                    json.dumps({"model_alias": model, "attempts": attempts}, indent=2)
                    + "\n"
                )
                print(
                    f"{mode} r{repetition}: {'pass' if passed else 'FAIL'} {result['latency_ms']:.0f}ms",
                    flush=True,
                )
    require(
        all(a["passed"] for a in attempts),
        "Live research correctness gate failed; attempts preserved",
    )
    for repetition in range(1, 4):
        pair = {a["mode"]: a for a in attempts if a["repetition"] == repetition}
        require(
            max(pair["research"]["recurring_input_chars"])
            < min(pair["full"]["recurring_input_chars"]),
            "Live research did not reduce recurring context",
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--live-base-url")
    parser.add_argument("--model", default="daedalus/high")
    args = parser.parse_args()
    if args.live_base_url:
        live_check(
            args.image, args.redis_image, args.live_base_url, args.model, args.report
        )
        raise SystemExit(0)
    result = check(args.image, args.redis_image)
    args.report.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
