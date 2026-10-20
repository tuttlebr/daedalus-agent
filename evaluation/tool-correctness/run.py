#!/usr/bin/env python3
"""Paired image evaluation through a real model gateway and isolated MCP reads.

Only synthetic content leaves this harness. Native clock and skill calls use
actual image implementations. No production data/tool service is connected.
The output contains synthetic prompts/results; the model API key is never saved.
"""

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess  # nosec B404 - explicit Docker argv, no shell
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import yaml
from experiment import (
    digest,
    distractors,
    overlay,
    require_stable_route,
    route_bytes,
    route_digest,
    target_metadata,
    workflow_cases,
)
from gateway import handler as gateway_handler
from gateway import response_lines

RECORDS = {"alpha": ("rec-a913", "COPPER"), "bravo": ("rec-b726", "SILVER")}
SCHEMAS = [
    {
        "name": "find_record",
        "description": "Find one synthetic record by name. Returns its opaque record_id. Pass that exact ID to read_record in a later call to obtain its value.",
        "inputSchema": {
            "type": "object",
            "properties": {"name": {"type": "string", "enum": list(RECORDS)}},
            "required": ["name"],
            "additionalProperties": False,
        },
    },
    {
        "name": "read_record",
        "description": "Read the value of one synthetic record by exact record_id returned by find_record. Unknown IDs return an error, never a value.",
        "inputSchema": {
            "type": "object",
            "properties": {"record_id": {"type": "string", "minLength": 1}},
            "required": ["record_id"],
            "additionalProperties": False,
        },
    },
]


def cases():
    result = []
    for i, (expression, answer) in enumerate(
        (("17 + 26", "43"), ("9 * 7", "63"), ("100 - 37", "63"), ("144 / 12", "12"))
    ):
        result.append(
            {
                "id": f"arithmetic-{i}",
                "stratum": "no-tool",
                "prompt": f"Compute {expression}. Reply with only the integer. Do not use tools.",
                "answer": answer,
                "calls": [],
            }
        )
    for i in range(4):
        result.append(
            {
                "id": f"clock-{i}",
                "stratum": "clock",
                "prompt": f"Synthetic clock validation {i}. Call current_datetime_tool exactly once with no arguments and return only its exact timestamp verbatim. No other tools.",
                "calls": [["current_datetime_tool", {}]],
            }
        )
    for i in range(4):
        marker = f"FROZEN_{i}_73519"
        history = []
        for j in range(10):
            history += [
                {
                    "role": "user",
                    "content": f"Synthetic record {j}: code is "
                    + (marker if j == i else f"DECOY_{j}_11827")
                    + ". "
                    + "Neutral filler for this invented record. " * 70,
                },
                {"role": "assistant", "content": f"Record {j} acknowledged."},
            ]
        result.append(
            {
                "id": f"history-{i}",
                "stratum": "long-history",
                "history": history,
                "prompt": f"Return only the exact code from synthetic record {i}. All needed data is in this conversation. Do not use tools.",
                "answer": marker,
                "calls": [],
            }
        )
    for i in range(2):
        skill = f"zz-synthetic-missing-skill-{i}"
        result.append(
            {
                "id": f"missing-{i}",
                "stratum": "tool-error",
                "prompt": f"Call agent_skills_tool once with operation load_skill and skill_name {skill}. This skill intentionally does not exist. If unavailable, reply exactly UNAVAILABLE. Do not retry, list other skills, use other tools, or create anything.",
                "answer": "UNAVAILABLE",
                "calls": [
                    [
                        "agent_skills_tool",
                        {"operation": "load_skill", "skill_name": skill},
                    ]
                ],
            }
        )
    for name, (record_id, value) in RECORDS.items():
        result.append(
            {
                "id": f"dependent-{name}",
                "stratum": "dependent-read",
                "prompt": f"Use fixture__find_record for name {name}, then fixture__read_record with the returned record_id. Return only the exact value from that read. Do not guess identifiers or use other tools.",
                "answer": value,
                "calls": [
                    ["fixture__find_record", {"name": name}],
                    ["fixture__read_record", {"record_id": record_id}],
                ],
            }
        )
    for i in range(2):
        result.append(
            {
                "id": f"parallel-{i}",
                "stratum": "independent-reads",
                "prompt": "Call fixture__find_record for alpha and bravo. The two reads are independent. Reply only with a JSON array of their record_id values, in alpha, bravo order. No other tools.",
                "answer": [row[0] for row in RECORDS.values()],
                "unordered": True,
                "calls": [["fixture__find_record", {"name": name}] for name in RECORDS],
            }
        )
    for i in range(2):
        record_id = f"missing-{i}"
        result.append(
            {
                "id": f"error-{i}",
                "stratum": "tool-error",
                "prompt": f"Call fixture__read_record once with record_id {record_id}. This is an intentional missing record. If it fails, reply exactly UNAVAILABLE. Do not retry, guess a value, or use other tools.",
                "answer": "UNAVAILABLE",
                "calls": [["fixture__read_record", {"record_id": record_id}]],
            }
        )
    return result


class Peer(BaseHTTPRequestHandler):
    schemas = SCHEMAS

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        method = body["method"]
        if "id" not in body:
            self.send_response(202)
            self.end_headers()
            return
        if method == "initialize":
            result = {
                "protocolVersion": body["params"]["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "synthetic-evidence", "version": "1"},
            }
        elif method == "tools/list":
            result = {"tools": self.schemas}
        elif method == "tools/call":
            name, args = body["params"]["name"], body["params"].get("arguments", {})
            if name == "find_record" and args.get("name") in RECORDS:
                payload = {"record_id": RECORDS[args["name"]][0]}
            elif name == "read_record" and args.get("record_id") in {
                row[0] for row in RECORDS.values()
            }:
                payload = {
                    "value": next(
                        value
                        for key, value in RECORDS.values()
                        if key == args["record_id"]
                    )
                }
            else:
                payload = {"error": "record not found"}
            result = {
                "content": [{"type": "text", "text": json.dumps(payload)}],
                "isError": "error" in payload,
            }
        else:
            result = {}
        data = json.dumps(
            {"jsonrpc": "2.0", "id": body["id"], "result": result}
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(client, port, token, user, case, repetition, arm):
    run_id = f"tool-eval-{arm}-{case['id']}-{repetition}-{uuid.uuid4().hex[:8]}"
    started = time.perf_counter()
    calls, results, terminal = [], [], []
    answer, failure, first = "", None, None
    wire = []
    try:
        with client.stream(
            "POST",
            f"http://127.0.0.1:{port}/v1/chat/completions",
            headers={
                "x-daedalus-internal-token": token,
                "x-user-id": user,
                "x-daedalus-request-id": run_id,
                "x-timezone": "UTC",
            },
            json={
                "stream": True,
                "messages": case.get("history", [])
                + [{"role": "user", "content": case["prompt"]}],
            },
        ) as response:
            response.raise_for_status()
            for line in response_lines(response):
                if time.perf_counter() - started > 60:
                    raise TimeoutError("request budget")
                if line.startswith("intermediate_data: "):
                    event = json.loads(line.split(": ", 1)[1])
                    wire.append((event["name"], event["id"]))
                    (
                        calls
                        if event["name"].startswith("Function Start: ")
                        else results
                    ).append(event)
                elif line.startswith("data: ") and line != "data: [DONE]":
                    event = json.loads(line[6:])
                    if event.get("error"):
                        failure = "backend_error"
                    for choice in event.get("choices", []):
                        text = choice.get("delta", {}).get("content", "")
                        answer += text
                        if text and first is None:
                            first = 1000 * (time.perf_counter() - started)
                        if choice.get("daedalus_terminal"):
                            terminal.append(choice.get("finish_reason"))
    except Exception as error:
        failure = type(error).__name__
    observed = [
        [event["name"].removeprefix("Function Start: "), event["payload"]]
        for event in calls
    ]
    expected = case["calls"]
    # Defaults which are irrelevant must be omitted by the model in this workload.
    selected = (
        (sorted(observed, key=str) == sorted(expected, key=str))
        if case.get("unordered")
        else observed == expected
    )
    bound = len(calls) == len(results) and len({event["id"] for event in calls}) == len(
        calls
    )
    bound = bound and all(
        any(
            end["id"] == start["id"]
            and end["parent_id"] == start["parent_id"] == run_id
            for end in results
        )
        for start in calls
    )
    expected_answer = case.get("answer")
    if case["stratum"] == "clock" and len(results) == 1:
        from datetime import datetime, timezone

        expected_answer = results[0]["payload"]
        try:
            bound = (
                bound
                and abs(
                    (
                        datetime.now(timezone.utc)
                        - datetime.fromisoformat(expected_answer)
                    ).total_seconds()
                )
                < 90
            )
        except (ValueError, TypeError):
            bound = False
    if isinstance(expected_answer, list):
        try:
            answer_ok = json.loads(answer) == expected_answer
        except ValueError:
            answer_ok = False
    else:
        answer_ok = answer.strip() == expected_answer
    # Dependency result must actually carry the identifier consumed by the next call.
    if case["stratum"] == "dependent-read":
        bound = (
            bound
            and bool(results)
            and expected[1][1]["record_id"] in str(results[0]["payload"])
        )
    if case["stratum"] == "tool-error":
        bound = (
            bound
            and bool(results)
            and any(
                word in str(results[0]["payload"]).lower()
                for word in ("not found", "unavailable")
            )
        )
    if case["stratum"] == "multi-stage":
        # Every dependent start must follow completion of the preceding call.
        bound = (
            bound
            and len(wire) == 2 * len(expected)
            and all(
                wire[i * 2][0].startswith("Function Start: ")
                and not wire[i * 2 + 1][0].startswith("Function Start: ")
                and wire[i * 2][1] == wire[i * 2 + 1][1]
                for i in range(len(expected))
            )
        )
        bound = (
            bound
            and bool(results)
            and "record not found" in str(results[-1]["payload"])
        )
    unexpected = any(name not in {row[0] for row in expected} for name, _ in observed)
    return {
        "case_id": case["id"],
        "repetition": repetition,
        "stratum": case["stratum"],
        "run_id": run_id,
        "latency_ms": round(1000 * (time.perf_counter() - started), 2),
        "first_answer_ms": first,
        "task_success": not failure
        and terminal == ["stop"]
        and selected
        and bound
        and answer_ok,
        "tool_correct": selected and bound,
        "safety_violation": unexpected,
        "error": failure,
        "answer_correct": answer_ok,
        "answer": answer,
        "terminal": terminal,
        "calls": calls,
        "results": results,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-image", required=True)
    parser.add_argument("--candidate-image", required=True)
    parser.add_argument("--baseline-source-revision", required=True)
    parser.add_argument("--candidate-source-revision", required=True)
    parser.add_argument("--baseline-overlay", type=Path)
    parser.add_argument("--candidate-overlay", type=Path)
    parser.add_argument(
        "--route-config",
        type=Path,
        help="Snapshot of the active gateway route file; checked for local drift before/after every attempt",
    )
    parser.add_argument(
        "--route-configmap",
        nargs=3,
        metavar=("CONTEXT", "NAMESPACE", "NAME"),
        help="Read the live route ConfigMap before/after each attempt to reject remote drift",
    )
    parser.add_argument("--suite", choices=("basic", "workflow"), default="workflow")
    parser.add_argument("--catalog-size", type=int, default=64, choices=range(0, 129))
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", default="daedalus")
    parser.add_argument("--api-key-env", default="TOOL_EVAL_API_KEY")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repetitions", type=int, default=3, choices=range(1, 4))
    args = parser.parse_args()
    docker = shutil.which("docker")
    if not docker:
        raise RuntimeError("Docker is required")
    key = os.environ[args.api_key_env]
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    overlays = {
        arm: overlay(getattr(args, f"{arm}_overlay"))
        for arm in ("baseline", "candidate")
    }
    if args.route_config and args.route_configmap:
        parser.error("Use either --route-config or --route-configmap")
    routing = route_digest(args.route_config, args.route_configmap)
    workload = cases()
    if args.suite == "workflow":
        workload += workflow_cases(RECORDS)
    schemas = SCHEMAS + distractors(args.catalog_size)
    Peer.schemas = schemas
    manifest = {
        "workload_id": hashlib.sha256(
            json.dumps(workload, sort_keys=True).encode()
        ).hexdigest(),
        "measurement": "http_request_to_backend_sse_terminal_ms",
        "conditions_id": f"synthetic-{args.suite}-catalog{args.catalog_size}-60s-v2",
        "repetitions": args.repetitions,
        "max_requests": len(workload) * args.repetitions * 2,
        "suite_seconds": 1800,
        "acceptance": "All candidate calls, arguments, binding, dependencies, error interpretation, and exact answers must pass. No safety violations or per-case correctness regressions. Latency is reported, not traded for correctness.",
        "cache": "as found; paired alternating arm order; no warmup; same synthetic user; no memory",
        "model": args.model,
        "tools": schemas,
        "tool_schema_digest": digest(schemas),
        "route_config_digest": routing,
        "actual_provider_model": None,
        "actual_provider_effort": None,
        "identity_limit": "Per-call gateway target headers are mapped through the frozen route configuration. Provider-reported identity and usage may be absent. A local snapshot alone cannot detect remote drift; use --route-configmap for a live check.",
    }
    (args.output / "frozen-workload.json").write_text(
        json.dumps({"manifest": manifest, "cases": workload}, indent=2) + "\n"
    )
    peer = ThreadingHTTPServer(("127.0.0.1", 0), Peer)
    peer.daemon_threads = True
    threading.Thread(target=peer.serve_forever, daemon=True).start()
    model_calls = []
    gateway = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        gateway_handler(
            args.base_url,
            model_calls,
            target_metadata(route_bytes(args.route_config, args.route_configmap)),
        ),
    )
    gateway.daemon_threads = True
    threading.Thread(target=gateway.serve_forever, daemon=True).start()
    token, user = uuid.uuid4().hex, "synthetic-tool-eval-" + uuid.uuid4().hex
    bundles, ports, containers = {}, {}, []
    try:
        for arm, image in (
            ("baseline", args.baseline_image),
            ("candidate", args.candidate_image),
        ):
            port, tools_port = free_port(), free_port()
            ports[arm] = port
            config = {
                "functions": {
                    "current_datetime_tool": {"_type": "current_datetime"},
                    "agent_skills_tool": {
                        "_type": "agent_skills",
                        "skills_directory": "/skills",
                        "enabled_operations": ["list_skills", "load_skill"],
                    },
                },
                "function_groups": {
                    "fixture": {
                        "_type": "mcp_client",
                        "server": {
                            "transport": "streamable-http",
                            "url": f"http://127.0.0.1:{peer.server_port}/mcp",
                        },
                        "tool_overrides": {
                            tool["name"]: {"approval_policy": "read_only"}
                            for tool in schemas
                        },
                    }
                },
                "llms": {
                    "main": {
                        "_type": "openai",
                        "api_type": "responses",
                        "base_url": f"http://127.0.0.1:{gateway.server_port}/v1",
                        "api_key": "${TOOL_EVAL_API_KEY}",
                        "model_name": args.model,
                        "request_timeout": 60,
                        "max_retries": 1,
                    }
                },
                "workflow": {
                    "_type": "daedalus_rust_agent",
                    "llm_name": "main",
                    "tools": ["current_datetime_tool", "agent_skills_tool", "fixture"],
                    "parallel_tool_calls": True,
                    "instructions": "Follow the user's synthetic test instructions exactly. Use actual tool results. Do not invent facts or perform any other actions.",
                    "max_iterations": 8,
                },
            }
            config["workflow"].update(overlays[arm])
            path = args.output / f"{arm}.yaml"
            path.write_text(yaml.safe_dump(config))
            path.chmod(0o644)
            env = {
                "TOOL_EVAL_API_KEY": key,
                "DAEDALUS_INTERNAL_API_TOKEN": token,
                "DAEDALUS_MEMORY_MODE": "disabled",
                "DAEDALUS_PREPARATION": "rust",
                "DAEDALUS_AUTHORIZATION": "rust",
                "DAEDALUS_PORT": str(port),
                "DAEDALUS_TOOLS_PORT": str(tools_port),
                "REDIS_URL": "redis://127.0.0.1:1",
            }
            name = "daedalus-tool-eval-" + uuid.uuid4().hex[:10]
            command = [
                docker,
                "run",
                "-d",
                "--rm",
                "--name",
                name,
                "--network",
                "host",
                "--read-only",
                "--tmpfs",
                "/tmp",  # nosec B108 - isolated container tmpfs
                "-v",
                f"{path.resolve()}:/workspace/config.yaml:ro",
            ]
            for variable in env:
                command += ["-e", variable]
            command.append(image)
            subprocess.run(  # nosec B603 - explicit Docker argv, operator-selected images
                command,
                env={**os.environ, **env},
                check=True,
                stdout=subprocess.DEVNULL,
            )
            containers.append(name)
            image_digest = subprocess.check_output(  # nosec B603 - explicit Docker argv
                [docker, "image", "inspect", image, "--format", "{{.Id}}"], text=True
            ).strip()
            bundles[arm] = {
                "schema_version": 2,
                "manifest": {
                    **manifest,
                    "arm": arm,
                    "source_revision": getattr(args, f"{arm}_source_revision"),
                    "image_digest": image_digest,
                    "config_digest": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "workflow_digest": digest(config["workflow"]),
                    "overlay_digest": digest(overlays[arm]),
                },
                "runs": [],
            }
        with httpx.Client(timeout=65, trust_env=False) as client:
            for arm, port in ports.items():
                for _ in range(120):
                    try:
                        if client.get(f"http://127.0.0.1:{port}/health").is_success:
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(0.5)
                else:
                    raise RuntimeError("Candidate startup failed")
            started = time.monotonic()
            for rep in range(1, args.repetitions + 1):
                for index, case in enumerate(workload):
                    for arm in (
                        ("baseline", "candidate")
                        if (index + rep) % 2
                        else ("candidate", "baseline")
                    ):
                        if time.monotonic() - started > 1800:
                            raise TimeoutError("suite budget")
                        require_stable_route(
                            args.route_config, routing, args.route_configmap
                        )
                        call_start = len(model_calls)
                        result = request(
                            client, ports[arm], token, user, case, rep, arm
                        )
                        result["evidence"] = (
                            f"{args.output.resolve()}/attempts.jsonl#run_id={result['run_id']}"
                        )
                        result["model_calls"] = model_calls[call_start:]
                        bundles[arm]["runs"].append(result)
                        with (args.output / "attempts.jsonl").open("a") as log:
                            log.write(json.dumps({"arm": arm, **result}) + "\n")
                        require_stable_route(
                            args.route_config, routing, args.route_configmap
                        )
                        print(
                            f"{arm} {case['id']} r{rep}: {'pass' if result['task_success'] else 'FAIL'} {result['latency_ms']}ms",
                            flush=True,
                        )
                        if result["safety_violation"]:
                            raise RuntimeError("Unexpected tool: evaluation stopped")
    finally:
        for arm, bundle in bundles.items():
            (args.output / f"{arm}.json").write_text(
                json.dumps(bundle, indent=2) + "\n"
            )
        for name in containers:
            with (args.output / f"{name}.log").open("w") as log:
                subprocess.run(  # nosec B603 - explicit Docker argv, operator-selected images
                    [docker, "logs", name],
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    check=False,
                )
            subprocess.run(  # nosec B603 - explicit Docker argv, operator-selected images
                [docker, "stop", "-t", "5", name],
                stdout=subprocess.DEVNULL,
                check=False,
            )
        peer.shutdown()
        peer.server_close()
        gateway.shutdown()
        gateway.server_close()
    candidate = bundles["candidate"]["runs"]
    if len(candidate) != len(workload) * args.repetitions or any(
        not run["task_success"] or not run["tool_correct"] or run["safety_violation"]
        for run in candidate
    ):
        raise SystemExit("Candidate failed the frozen correctness gate; see evidence")


if __name__ == "__main__":
    main()
