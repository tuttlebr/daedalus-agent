#!/usr/bin/env python3
"""Built-image Python verifier/scrape scheduling, state and cancellation contracts.

Only external source/model transports are fixtures. Registry, critic, tool
service and Rust lifecycle execute from the image. Native retrieval is covered
by document_tools_http_check and domain_retriever_http_check against gRPC peers.
"""

import argparse
import concurrent.futures
import hashlib
import json
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
from image_check import environment, require
from runtime_http_check import Peers

PRIVATE_COLLECTIONS = {
    user: "user_uploads_"
    + user.replace("-", "_")
    + "_"
    + hashlib.sha256(user.encode()).hexdigest()
    for user in ["synthetic-alice", "synthetic-bob"]
}


def verification_calls(batch=6, verdict="mixed", mode="normal"):
    calls = []
    for index in range(batch):
        supported = verdict == "supported" or (verdict == "mixed" and index % 2 == 0)
        calls.append(
            {
                "name": "source_verifier_tool",
                "arguments": {
                    "operation": "verify_claim",
                    "claim": f"Fixture station {index} measured {index + (10 if supported else 90)} units.",
                    "source_url": f"https://sources.test/{mode}/{index}",
                },
                "verdict": "supported" if supported else "unsupported",
            }
        )
    return calls


class LeafPeers(Peers):
    def __init__(self):
        super().__init__()
        self.plan = []
        self.active = self.peak = self.critic_calls = 0
        self.lock = threading.Lock()
        self.started = threading.Event()
        self.disconnected = 0
        self.results = []
        self.spans = []
        self.live_critic = None

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def do_GET(self):
                url = parse_qs(urlparse(self.path).query)["url"][0]
                index = int(urlparse(url).path.rsplit("/", 1)[-1])
                if "/scrape/" in url:
                    with peers.lock:
                        peers.active += 1
                        peers.peak = max(peers.peak, peers.active)
                    peers.started.set()
                    try:
                        if "/block/" in url and self.wait_for_disconnect(
                            threading.Event(), peers.release_tool
                        ):
                            with peers.lock:
                                peers.disconnected += 1
                            return
                        time.sleep([0.30, 0.08, 0.15][index % 3])
                        data = (
                            f"<html><head><title>Fixture {index}</title></head>"
                            f"<body><h1>Fixture {index}</h1><p>Station {index} "
                            f"measured {index + 10} units in this synthetic report. "
                            "This is a controlled source for scheduling tests.</p>"
                            "</body></html>"
                        ).encode()
                        self.send_response(200)
                        self.send_header("Content-Type", "text/html")
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data)
                    finally:
                        with peers.lock:
                            peers.active -= 1
                    return
                data = f"Synthetic measurement report. Fixture station {index} measured {index + 10} units. All values are exact.".encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                if self.path == "/v1/traces":
                    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
                        ExportTraceServiceRequest,
                    )

                    export = ExportTraceServiceRequest.FromString(
                        self.rfile.read(int(self.headers["Content-Length"]))
                    )
                    for resource in export.resource_spans:
                        for scope in resource.scope_spans:
                            peers.spans.extend(scope.spans)
                    self.send_response(200)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path == "/critic/v1/responses":
                    return self.critic(body)
                if self.path != "/v1/responses":
                    return self.reply({"error": "unknown fixture path"}, 404)
                peers.requests.append(body)
                outputs = [
                    item
                    for item in body["input"]
                    if item.get("type") == "function_call_output"
                ]
                if outputs or "REDIRECT" in json.dumps(body["input"]):
                    peers.results.append(outputs)
                    items = [
                        {
                            "id": "msg_done",
                            "type": "message",
                            "role": "assistant",
                            "status": "completed",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "Fixture complete",
                                    "annotations": [],
                                }
                            ],
                        }
                    ]
                else:
                    items = [
                        {
                            "id": f"fc_{i}",
                            "call_id": f"call_{i}",
                            "name": call["name"],
                            "type": "function_call",
                            "arguments": json.dumps(call["arguments"]),
                            "status": "completed",
                        }
                        for i, call in enumerate(peers.plan)
                    ]
                self.gateway = False
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                for i, item in enumerate(items):
                    self.event(
                        {
                            "type": "response.output_item.added",
                            "sequence_number": i * 3,
                            "output_index": i,
                            "item": {
                                **item,
                                "status": "in_progress",
                                **(
                                    {"arguments": ""}
                                    if item["type"] == "function_call"
                                    else {"content": []}
                                ),
                            },
                        }
                    )
                    if item["type"] == "function_call":
                        self.event(
                            {
                                "type": "response.function_call_arguments.delta",
                                "sequence_number": i * 3 + 1,
                                "output_index": i,
                                "item_id": item["id"],
                                "delta": item["arguments"],
                            }
                        )
                    else:
                        self.event(
                            {
                                "type": "response.output_text.delta",
                                "sequence_number": i * 3 + 1,
                                "output_index": i,
                                "content_index": 0,
                                "item_id": item["id"],
                                "delta": "Fixture complete",
                            }
                        )
                    self.event(
                        {
                            "type": "response.output_item.done",
                            "sequence_number": i * 3 + 2,
                            "output_index": i,
                            "item": item,
                        }
                    )
                self.event(
                    {
                        "type": "response.completed",
                        "sequence_number": len(items) * 3,
                        "response": {
                            "id": "resp_fixture",
                            "object": "response",
                            "created_at": 1,
                            "model": "fixture",
                            "status": "completed",
                            "output": items,
                            "usage": {
                                "input_tokens": 100,
                                "output_tokens": 20,
                                "total_tokens": 120,
                            },
                        },
                    }
                )

            def critic(self, body):
                with peers.lock:
                    peers.active += 1
                    peers.peak = max(peers.peak, peers.active)
                    peers.critic_calls += 1
                peers.started.set()
                try:
                    if peers.live_critic:
                        return self.reply(peers.live_critic(body))
                    text = json.dumps(body["input"])
                    if "/block/" in text:
                        if self.wait_for_disconnect(
                            threading.Event(), peers.release_tool
                        ):
                            with peers.lock:
                                peers.disconnected += 1
                            return
                    request_text = next(
                        item for item in body["input"] if item["role"] == "user"
                    )["content"]
                    if isinstance(request_text, list):
                        request_text = request_text[0]["text"]
                    request = json.loads(request_text.splitlines()[1])
                    index = int(request["source_url"].rsplit("/", 1)[-1])
                    time.sleep([0.24, 0.02, 0.08][index % 3])
                    expected = f"Fixture station {index} measured {index + 10} units."
                    verdict = {
                        "verdict": "supported"
                        if request["claim"] == expected
                        else "unsupported",
                        "confidence": 1.0,
                        "evidence": expected,
                        "reasoning": "The exact source measurement determines the verdict.",
                        "claim_issues": [],
                    }
                    self.reply(
                        {
                            "id": "resp_critic",
                            "object": "response",
                            "created_at": 1,
                            "model": "fixture",
                            "status": "completed",
                            "output": [
                                {
                                    "id": "msg_critic",
                                    "type": "message",
                                    "role": "assistant",
                                    "status": "completed",
                                    "content": [
                                        {
                                            "type": "output_text",
                                            "text": json.dumps(verdict),
                                            "annotations": [],
                                        }
                                    ],
                                }
                            ],
                            "usage": {
                                "input_tokens": 100,
                                "output_tokens": 20,
                                "total_tokens": 120,
                            },
                        }
                    )
                finally:
                    with peers.lock:
                        peers.active -= 1

        return Handler


def fixture(image, redis_image, peers, limit=3, parallel=True, *, scrape=False):
    def configure(config, port, runtime_port):
        config["functions"] = {
            "current_datetime_tool": {"_type": "current_datetime"},
            "source_verifier_tool": {
                "_type": "source_verifier",
                "llm_name": "critic",
                "max_concurrency": limit,
            },
            "state_a": {"_type": "fixture_stateful"},
            "state_b": {"_type": "fixture_stateful"},
        }
        if limit is None:
            del config["functions"]["source_verifier_tool"]["max_concurrency"]
        if scrape:
            config["functions"]["webscrape_tool"] = {
                "_type": "webscrape",
                "respect_robots_txt": False,
                **({"max_concurrency": limit} if limit is not None else {}),
            }
        config["llms"]["critic"] = {
            **config["llms"]["main"],
            "base_url": f"http://127.0.0.1:{port}/critic/v1",
            "max_retries": 0,
        }
        config["workflow"].update(
            tools=list(config["functions"]),
            parallel_tool_calls=parallel,
            max_iterations=4,
            tool_output_compaction_enabled=False,
        )
        config["telemetry"] = {"endpoint": f"http://127.0.0.1:{port}/v1/traces"}

    files = {
        "sitecustomize.py": "from leaf_fixtures import install\ninstall()\n",
        "leaf_fixtures.py": Path(__file__).with_name("leaf_fixtures.py").read_text(),
    }
    return environment(
        image,
        redis_image,
        minimal=True,
        memory=False,
        peers=peers,
        configure=configure,
        fixture_files=files,
        extra_env=lambda port: {
            "PYTHONPATH": "/fixture:/workspace",
            "DAEDALUS_TEST_PEER": f"http://127.0.0.1:{port}",
        },
    )


def runtime_lines(response):
    """Read the runtime's LF/CRLF framing without splitting Unicode text.

    httpx.iter_lines uses str.splitlines, which also treats NEL and other valid
    JSON string characters as line endings. The frontend only splits on LF.
    """
    pending = b""
    for chunk in response.iter_bytes():
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            yield line.removesuffix(b"\r").decode("utf-8")
    if pending:
        yield pending.removesuffix(b"\r").decode("utf-8")


def measure(
    env,
    control=None,
    user="synthetic-alice",
    *,
    extra_headers=None,
    request_id=None,
    message="Execute the synthetic fixture plan.",
):
    run_id = request_id or str(uuid.uuid4())
    headers = env["headers"] | {
        "x-daedalus-request-id": run_id,
        "x-conversation-id": run_id,
        "x-user-id": user,
    }
    headers.update(extra_headers or {})
    result = {
        "starts": [],
        "ends": [],
        "terminal": None,
        "errors": [],
        "answer": "",
        "done": False,
        "peak_tools": 0,
    }
    active_tools = 0
    started = time.monotonic()
    with httpx.Client(timeout=90, trust_env=False) as client:
        with client.stream(
            "POST",
            env["base"] + "/v1/chat/completions",
            headers=headers,
            json={
                "stream": True,
                "messages": [{"role": "user", "content": message}],
            },
        ) as response:
            response.raise_for_status()
            event_type = None
            for line in runtime_lines(response):
                if time.monotonic() - started > 90:
                    raise TimeoutError("Frozen request limit")
                if line.startswith("event: "):
                    event_type = line[7:]
                if line.startswith("intermediate_data: "):
                    event = json.loads(line.split(": ", 1)[1])
                    active_tools += (
                        -1 if event["name"].startswith("Function Complete:") else 1
                    )
                    result["peak_tools"] = max(result["peak_tools"], active_tools)
                    result[
                        "ends"
                        if event["name"].startswith("Function Complete:")
                        else "starts"
                    ].append(event)
                    if control and len(result["starts"]) == 3:
                        deadline = time.monotonic() + 10
                        while env["peers"].active < 3 and time.monotonic() < deadline:
                            time.sleep(0.02)
                        require(
                            env["peers"].active == 3, "Verifier batch did not start"
                        )
                        command = {"type": control, "command_id": str(uuid.uuid4())}
                        if control == "steer":
                            command["instruction"] = (
                                "REDIRECT and retain completed evidence"
                            )
                        denied = client.post(
                            env["base"] + f"/v1/runs/{run_id}/control",
                            headers=headers | {"x-user-id": "other-owner"},
                            json=command,
                        )
                        require(
                            denied.status_code == 404, "Cross-user control accepted"
                        )
                        accepted = client.post(
                            env["base"] + f"/v1/runs/{run_id}/control",
                            headers=headers,
                            json=command,
                        )
                        require(accepted.status_code == 200, "Control rejected")
                        control = None
                        if command["type"] == "steer":
                            env["peers"].release_tool.set()
                if line == "data: [DONE]":
                    result["done"] = True
                elif line.startswith("data: "):
                    event = json.loads(line[6:])
                    if event_type == "error":
                        result["errors"].append(event)
                    for choice in event.get("choices", []):
                        result["answer"] += choice.get("delta", {}).get("content", "")
                        if choice.get("daedalus_terminal"):
                            result["terminal"] = choice["finish_reason"]
    result["latency_ms"] = (time.monotonic() - started) * 1000
    return result


def verify(result, calls):
    require(
        result["terminal"] == "stop" and result["done"] and not result["errors"],
        "Run did not finish successfully",
    )
    starts = {event["id"]: event for event in result["starts"]}
    ends = {event["id"]: event for event in result["ends"]}
    require(
        len(starts)
        == len(ends)
        == len(calls)
        == len(result["ends"])
        == len(result["starts"]),
        "Missing or duplicate calls/results",
    )
    for i, call in enumerate(calls):
        call_id = f"call_{i}"
        require(starts[call_id]["payload"] == call["arguments"], "Arguments changed")
        require(
            starts[call_id]["name"] == "Function Start: " + call["name"], "Wrong tool"
        )
        require(
            ends[call_id]["name"] == "Function Complete: " + call["name"],
            "Wrong result binding",
        )
        if "verdict" in call:
            payload = json.loads(ends[call_id]["payload"])
            require(payload["verdict"] == call["verdict"], "Incorrect claim verdict")
            require(
                payload["source_url"] == call["arguments"]["source_url"],
                "Wrong claim source",
            )
            require(
                payload["source_reachable"] and payload["evidence"], "Missing evidence"
            )
            index = int(call["arguments"]["source_url"].rsplit("/", 1)[-1])
            expected = f"fixture station {index} measured {index + 10} units"
            require(
                expected in " ".join(payload["evidence"].lower().split()),
                "Evidence does not match the source fact",
            )


def check(image, redis_image):
    report = []
    for limit, parallel in [(3, True), (2, True), (1, True), (None, True), (3, False)]:
        peers = LeafPeers()
        with fixture(image, redis_image, peers, limit, parallel) as env:
            peers.plan = verification_calls()
            result = measure(env)
            verify(result, peers.plan)
            require(
                peers.peak == ((limit or 1) if parallel else 1),
                "Wrong verifier overlap",
            )
            require(
                result["peak_tools"] == ((limit or 1) if parallel else 1),
                "Wrong scheduler concurrency",
            )
            if limit == 3 and parallel:
                require(
                    [e["id"] for e in result["ends"]]
                    != [e["id"] for e in result["starts"]],
                    "Out-of-order results not exercised",
                )
                peers.plan = [
                    {"name": name, "arguments": {"label": str(i)}}
                    for i, name in enumerate(
                        ["state_a", "state_b", "state_a", "state_b"]
                    )
                ]
                state = measure(env)
                verify(state, peers.plan)
                require(
                    [json.loads(e["payload"])["before"] for e in state["ends"]]
                    == [0, 1, 2, 3],
                    "Stateful tool snapshots lost",
                )
                for control in ["cancel", "steer"]:
                    peers.plan = verification_calls(mode="block")
                    peers.started.clear()
                    peers.release_tool.clear()
                    interrupted = measure(env, control)
                    require(
                        len(interrupted["starts"]) == 3,
                        "Queued calls ran after control",
                    )
                    if control == "cancel":
                        require(
                            interrupted["terminal"] == "error"
                            and interrupted["errors"],
                            "Cancellation did not terminate",
                        )
                        deadline = time.monotonic() + 5
                        while peers.active and time.monotonic() < deadline:
                            time.sleep(0.02)
                        require(
                            peers.active == 0 and peers.disconnected == 3,
                            f"Cancellation transports: active={peers.active}, disconnected={peers.disconnected}",
                        )
                    else:
                        require(
                            interrupted["terminal"] == "stop"
                            and len(interrupted["ends"]) == 3,
                            "Steering lost accepted results",
                        )
                peers.plan = verification_calls(batch=3)
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    together = list(
                        pool.map(
                            lambda user: measure(env, user=user),
                            ["synthetic-alice", "synthetic-bob"],
                        )
                    )
                for run in together:
                    verify(run, peers.plan)
                require(
                    peers.peak == 3,
                    "Concurrent runs exceeded the shared verifier bound",
                )
                peers.plan = [{"name": "current_datetime_tool", "arguments": {}}] * 40
                long_run = measure(env)
                verify(long_run, peers.plan)
                run_id = long_run["starts"][0]["parent_id"]
                log = [
                    json.loads(line)
                    for line in (env["root"] / "backend.log").read_text().splitlines()
                    if line.startswith("{")
                ]
                correlation = next(
                    entry
                    for entry in log
                    if entry["fields"].get("event") == "telemetry_started"
                    and entry.get("span", {}).get("run_id") == run_id
                )
                trace_id = correlation["fields"]["trace_id"]
                deadline = time.monotonic() + 5
                spans = []
                while not spans and time.monotonic() < deadline:
                    spans = [
                        span
                        for span in peers.spans
                        if span.name == "daedalus.agent"
                        and span.trace_id.hex() == trace_id
                    ]
                    time.sleep(0.02)
                require(len(spans) == 1, "Missing or uncorrelated long-run trace")
                span = spans[0]
                attributes = {item.key: item.value for item in span.attributes}
                require(
                    span.dropped_attributes_count == 0, "Telemetry attributes dropped"
                )
                require(
                    attributes["tool_calls"].int_value == 40
                    and attributes["model_calls"].int_value == 2,
                    "Long-run counters lost",
                )
                require(
                    attributes["outcome"].string_value == "completed",
                    "Long-run outcome lost",
                )
            report.append(
                {
                    "limit": limit,
                    "parallel": parallel,
                    "peak": peers.peak,
                    "latency_ms": result["latency_ms"],
                    "passed": True,
                }
            )
    for limit, parallel in [(4, True), (3, True), (1, True), (None, True), (4, False)]:
        peers = LeafPeers()
        with fixture(image, redis_image, peers, limit, parallel, scrape=True) as env:
            peers.plan = [
                {
                    "name": "webscrape_tool",
                    "arguments": {
                        "url": f"https://sources.test/scrape/{i}?run={uuid.uuid4()}"
                    },
                }
                for i in range(8)
            ]
            result = measure(env)
            verify(result, peers.plan)
            expected = (limit or 1) if parallel else 1
            require(peers.peak == expected, "Wrong shared scrape overlap")
            require(result["peak_tools"] == expected, "Wrong scrape scheduler bound")
            for event in result["ends"]:
                index = int(event["id"].split("_")[-1])
                require(
                    f"Station {index} measured {index + 10} units" in event["payload"],
                    "Scrape result bound to the wrong call",
                )
            if limit == 3 and parallel:
                peers.peak = 0
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    together = list(
                        pool.map(
                            lambda user: measure(env, user=user),
                            ["synthetic-alice", "synthetic-bob"],
                        )
                    )
                for run in together:
                    verify(run, peers.plan)
                require(
                    peers.peak == 3, "Concurrent runs exceeded the shared scrape bound"
                )
                for control in ["steer", "cancel"]:
                    peers.plan = [
                        {
                            "name": "webscrape_tool",
                            "arguments": {
                                "url": f"https://sources.test/scrape/block/{i}?run={uuid.uuid4()}"
                            },
                        }
                        for i in range(6)
                    ]
                    peers.release_tool.clear()
                    peers.disconnected = 0
                    interrupted = measure(env, control)
                    require(
                        len(interrupted["starts"]) == 3,
                        "Queued scrapes ran after control",
                    )
                    if control == "steer":
                        require(
                            interrupted["terminal"] == "stop"
                            and len(interrupted["ends"]) == 3,
                            "Steering lost accepted scrape results",
                        )
                    else:
                        require(
                            interrupted["terminal"] == "error"
                            and interrupted["errors"],
                            "Scrape cancellation did not terminate",
                        )
                        deadline = time.monotonic() + 5
                        while peers.active and time.monotonic() < deadline:
                            time.sleep(0.02)
                        require(
                            peers.active == 0 and peers.disconnected == 3,
                            "Scrape cancellation did not clean up transports",
                        )
            report.append(
                {
                    "tool": "webscrape",
                    "limit": limit,
                    "parallel": parallel,
                    "peak": peers.peak,
                    "latency_ms": result["latency_ms"],
                    "passed": True,
                }
            )
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    result = check(args.image, args.redis_image)
    if args.report:
        args.report.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
