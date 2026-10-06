#!/usr/bin/env python3
"""Exercise the actual runtime over HTTP against deterministic model/MCP peers.

Use --image for the deployable artifact, or --binary for a local Rust build.
No external model, credential, cluster, or user data is accessed.
"""

import argparse
import base64
import concurrent.futures
import hashlib
import json
import os
import re
import select
import shutil
import socket
import subprocess  # nosec B404 - disposable local fixture, explicit argv
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import yaml


class Peers:
    def __init__(self):
        self.requests = []
        self.calls = []
        self.model_waiting = threading.Event()
        self.tool_waiting = threading.Event()
        self.release_model = threading.Event()
        self.release_tool = threading.Event()
        self.tool_disconnected = threading.Event()
        self.image_waiting = threading.Event()
        self.image_disconnected = threading.Event()

    def handler(self):
        peers = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def reply(self, value, status=200):
                data = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def event(self, value):
                if self.gateway:
                    # Match Switchyard's live Responses envelope: content and
                    # output indices are present, bookkeeping may be omitted.
                    value = json.loads(json.dumps(value))
                    value.pop("sequence_number", None)
                    value.pop("item_id", None)
                    response = value.get("response", {})
                    response.pop("created_at", None)
                    items = response.get("output", [])
                    if value["type"] == "response.output_item.done":
                        items = [*items, value["item"]]
                    for item in items:
                        if item["type"] == "message":
                            item.pop("id", None)
                self.wfile.write(("data: " + json.dumps(value) + "\n\n").encode())
                self.wfile.flush()

            def wait_for_disconnect(self, closed, release=None):
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if release and release.is_set():
                        return False
                    readable, _, _ = select.select([self.connection], [], [], 0.05)
                    if readable:
                        try:
                            disconnected = not self.connection.recv(1, socket.MSG_PEEK)
                        except ConnectionResetError:
                            disconnected = True
                        if disconnected:
                            closed.set()
                            self.close_connection = True
                            return True
                return False

            def do_POST(self):
                body = json.loads(
                    self.rfile.read(int(self.headers.get("Content-Length", 0)))
                )
                if self.path == "/v1/images/generations":
                    if body.get("stream"):
                        self.send_response(200)
                        self.send_header("Content-Type", "text/event-stream")
                        self.end_headers()
                        self.wfile.write(b": image provider waiting\n\n")
                        self.wfile.flush()
                    peers.image_waiting.set()
                    self.wait_for_disconnect(peers.image_disconnected)
                    return
                if self.path == "/mcp":
                    method = body["method"]
                    if "id" not in body:
                        self.reply({}, 202)
                        return
                    if method == "initialize":
                        result = {
                            "protocolVersion": body["params"]["protocolVersion"],
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": "fixture", "version": "1"},
                        }
                    elif method == "tools/list":
                        result = {
                            "tools": [
                                {
                                    "name": name,
                                    "description": name,
                                    "inputSchema": {
                                        "type": "object",
                                        "properties": {"private": {"type": "string"}},
                                        "additionalProperties": False,
                                    },
                                }
                                for name in ("slow_read", "next_read", "write_item")
                            ]
                        }
                    elif method == "tools/call":
                        name = body["params"]["name"]
                        peers.calls.append(name)
                        if name == "slow_read":
                            peers.tool_waiting.set()
                            if self.wait_for_disconnect(
                                peers.tool_disconnected, peers.release_tool
                            ):
                                return
                        result = {
                            "content": [{"type": "text", "text": "RETAINED_EVIDENCE"}],
                            "isError": False,
                        }
                    else:
                        self.reply(
                            {
                                "jsonrpc": "2.0",
                                "id": body["id"],
                                "error": {"code": -32601, "message": "Unknown method"},
                            }
                        )
                        return
                    self.reply({"jsonrpc": "2.0", "id": body["id"], "result": result})
                    return
                if self.path != "/v1/responses":
                    self.reply({"error": "unexpected endpoint"}, 404)
                    return
                peers.requests.append(body)
                self.gateway = "GATEWAY" in json.dumps(body)
                if (
                    "RETRY_MODEL" in json.dumps(body)
                    and sum("RETRY_MODEL" in json.dumps(old) for old in peers.requests)
                    == 1
                ):
                    self.reply({"error": {"message": "PRIVATE_PROVIDER_ERROR"}}, 503)
                    return
                if "PROVIDER_FAILURE" in json.dumps(body):
                    self.reply({"error": {"message": "PRIVATE_PROVIDER_ERROR"}}, 400)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                try:
                    self.model_response(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def model_response(self, body):
                if self.gateway:
                    self.event(
                        {
                            "type": "response.created",
                            "response": {
                                "id": "resp_fixture",
                                "object": "response",
                                "model": "fixture",
                                "status": "in_progress",
                                "output": [],
                            },
                        }
                    )
                serialized = json.dumps(body.get("input", []))
                redirected = "NEW_DIRECTION" in serialized
                has_result = "function_call_output" in serialized
                scenario = next(
                    (
                        name
                        for name in (
                            "MODEL_STEER",
                            "TOOL_STEER",
                            "APPROVAL",
                            "SKILL_ROUTE",
                            "DEFERRED_DISCOVERY",
                            "INCOMPLETE",
                            "STREAM_RECOVER",
                            "STREAM_TRUNCATED",
                            "STREAM_TOOL_CUT",
                            "STREAM_ALWAYS_FAIL",
                            "STREAM_PERMANENT",
                        )
                        if name in serialized
                    ),
                    "BASIC",
                )
                outputs = []
                attempt = sum(
                    scenario in json.dumps(old.get("input", []))
                    and ("function_call_output" in json.dumps(old.get("input", [])))
                    == has_result
                    for old in peers.requests
                )
                if redirected:
                    if scenario == "TOOL_STEER":
                        assert "RETAINED_EVIDENCE" in serialized  # nosec B101 - executable contract check
                        assert "Not executed:" in serialized  # nosec B101 - executable contract check
                    text = (
                        "Directed answer with retained evidence"
                        if has_result
                        else "Directed answer"
                    )
                elif scenario == "MODEL_STEER":
                    item = {
                        "type": "function_call",
                        "id": "fc_partial",
                        "call_id": "partial",
                        "name": "fixture_mcp__next_read",
                        "arguments": "",
                        "status": "in_progress",
                    }
                    self.event(
                        {
                            "type": "response.output_item.added",
                            "output_index": 0,
                            "sequence_number": 1,
                            "item": item,
                        }
                    )
                    self.event(
                        {
                            "type": "response.function_call_arguments.delta",
                            "output_index": 0,
                            "item_id": "fc_partial",
                            "sequence_number": 2,
                            "delta": "{",
                        }
                    )
                    peers.model_waiting.set()
                    peers.release_model.wait(15)
                    return
                elif not has_result or (
                    scenario == "DEFERRED_DISCOVERY"
                    and "RETAINED_EVIDENCE" not in serialized
                ):
                    names = (
                        [
                            "fixture_deferred__next_read"
                            if has_result
                            else "fixture_deferred__connect"
                        ]
                        if scenario == "DEFERRED_DISCOVERY"
                        else ["agent_skills_tool"]
                        if scenario == "SKILL_ROUTE"
                        else ["fixture_mcp__write_item", "fixture_second__slow_read"]
                        if scenario == "APPROVAL"
                        else ["fixture_mcp__slow_read", "fixture_mcp__next_read"]
                        if scenario == "TOOL_STEER"
                        else ["fixture_mcp__next_read"]
                        if scenario == "STREAM_TOOL_CUT" and attempt == 1
                        else ["current_datetime_tool"]
                    )
                    for index, name in enumerate(names):
                        item = {
                            "type": "function_call",
                            "id": f"fc_{index}",
                            "call_id": f"call_{index}",
                            "name": name,
                            "arguments": "",
                            "status": "in_progress",
                        }
                        self.event(
                            {
                                "type": "response.output_item.added",
                                "output_index": index,
                                "sequence_number": index * 4,
                                "item": item,
                            }
                        )
                        self.event(
                            {
                                "type": "response.function_call_arguments.delta",
                                "output_index": index,
                                "item_id": item["id"],
                                "sequence_number": index * 4 + 1,
                                "delta": json.dumps(
                                    {
                                        "operation": "load_skill",
                                        "skill_name": "fixture-skill",
                                    }
                                )
                                if name == "agent_skills_tool"
                                else json.dumps({"private": "PRIVATE_TOOL_ARGUMENT"})
                                if name.endswith("slow_read")
                                else "{}",
                            }
                        )
                        item = {
                            **item,
                            "arguments": json.dumps(
                                {
                                    "operation": "load_skill",
                                    "skill_name": "fixture-skill",
                                }
                            )
                            if name == "agent_skills_tool"
                            else json.dumps({"private": "PRIVATE_TOOL_ARGUMENT"})
                            if name.endswith("slow_read")
                            else "{}",
                            "status": "completed",
                        }
                        self.event(
                            {
                                "type": "response.output_item.done",
                                "output_index": index,
                                "sequence_number": index * 4 + 2,
                                "item": item,
                            }
                        )
                        outputs.append(item)
                    text = None
                else:
                    text = (
                        ("First part. " if attempt == 1 else "Recovered final answer.")
                        if scenario in ("STREAM_RECOVER", "STREAM_TRUNCATED")
                        else ("The real datetime tool completed")
                    )
                if text:
                    item = {
                        "type": "message",
                        "id": "msg_fixture",
                        "status": "in_progress",
                        "role": "assistant",
                        "content": [],
                    }
                    self.event(
                        {
                            "type": "response.output_item.added",
                            "output_index": 0,
                            "sequence_number": 0,
                            "item": item,
                        }
                    )
                    self.event(
                        {
                            "type": "response.output_text.delta",
                            "output_index": 0,
                            "content_index": 0,
                            "item_id": item["id"],
                            "sequence_number": 1,
                            "delta": text,
                        }
                    )
                    if self.gateway:
                        self.event(
                            {
                                "type": "response.content_part.done",
                                "output_index": 0,
                                "content_index": 0,
                                "part": {"type": "output_text", "text": text},
                            }
                        )
                    item = {
                        **item,
                        "status": "completed",
                        "content": [
                            {"type": "output_text", "text": text, "annotations": []}
                        ],
                    }
                    self.event(
                        {
                            "type": "response.output_item.done",
                            "output_index": 0,
                            "sequence_number": 2,
                            "item": item,
                        }
                    )
                    outputs = [item]
                if (
                    (
                        scenario in ("STREAM_RECOVER", "STREAM_TRUNCATED")
                        and has_result
                        and attempt == 1
                    )
                    or (
                        scenario == "STREAM_TOOL_CUT"
                        and not has_result
                        and attempt == 1
                    )
                    or scenario in ("STREAM_ALWAYS_FAIL", "STREAM_PERMANENT")
                ):
                    if scenario != "STREAM_TRUNCATED":
                        # Exact Switchyard SSE failure shape. A completed item
                        # is not a completed response and must never run tools.
                        self.event(
                            {
                                "type": "error",
                                "error": {
                                    "type": "SwitchyardError",
                                    "message": (
                                        "upstream transport error: error decoding response body"
                                        if scenario != "STREAM_PERMANENT"
                                        else "failed to translate invalid request PRIVATE_PROVIDER_ERROR"
                                    ),
                                },
                            }
                        )
                    return
                incomplete = scenario == "INCOMPLETE"
                response = {
                    "id": "resp_fixture",
                    "object": "response",
                    "created_at": 1,
                    "status": "incomplete" if incomplete else "completed",
                    "error": None,
                    "incomplete_details": {"reason": "max_output_tokens"}
                    if incomplete
                    else None,
                    "instructions": None,
                    "max_output_tokens": None,
                    "model": "fixture",
                    "output": outputs,
                    "tools": [],
                    "usage": {
                        "input_tokens": 1,
                        "output_tokens": 1,
                        "total_tokens": 2,
                        "input_tokens_details": {"cached_tokens": 0},
                        "output_tokens_details": {"reasoning_tokens": 0},
                    },
                }
                self.event(
                    {
                        "type": "response.incomplete"
                        if incomplete
                        else "response.completed",
                        "response": response,
                        "sequence_number": 20,
                    }
                )

        return Handler


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def check(image=None, binary=None, redis_image=None):
    if os.sys.flags.optimize:
        raise RuntimeError("Run runtime contracts without Python optimization")
    docker = shutil.which("docker")
    if (image or redis_image) and not docker:
        raise RuntimeError("Docker is required for image contract checks")
    peers = Peers()
    peer_server = ThreadingHTTPServer(("127.0.0.1", 0), peers.handler())
    peer_server.daemon_threads = True
    threading.Thread(target=peer_server.serve_forever, daemon=True).start()
    model_port = peer_server.server_port
    runtime_port, tools_port = free_port(), free_port()
    token = uuid.uuid4().hex
    headers = {"x-daedalus-internal-token": token, "x-user-id": "alice"}
    config = {
        "functions": {"current_datetime_tool": {"_type": "current_datetime"}},
        "function_groups": {
            "fixture_mcp": {
                "_type": "mcp_client",
                "server": {
                    "transport": "streamable-http",
                    "url": f"http://127.0.0.1:{model_port}/mcp",
                },
                "tool_overrides": {
                    name: {"approval_policy": "read_only"}
                    for name in ("slow_read", "next_read")
                },
            }
        },
        "llms": {
            "main": {
                "_type": "openai",
                "api_type": "responses",
                "api_key": "PRIVATE_MODEL_CREDENTIAL",
                "base_url": f"http://127.0.0.1:{model_port}/v1",
                "model_name": "fixture",
                # Existing deployments configure a one-hour model timeout.
                # Exercise actual service startup with that configuration.
                "request_timeout": 3600,
            }
        },
        "workflow": {
            "_type": "daedalus_rust_agent",
            "llm_name": "main",
            "tools": ["current_datetime_tool", "fixture_mcp"],
            "max_iterations": 8,
            "parallel_tool_calls": True,
            "tool_output_compaction_enabled": False,
            "instructions": "Follow user directions and retain completed tool results.",
        },
    }
    config["function_groups"]["fixture_second"] = config["function_groups"][
        "fixture_mcp"
    ]
    config["workflow"]["tools"].append("fixture_second")
    config["function_groups"]["fixture_deferred"] = {
        **config["function_groups"]["fixture_mcp"],
        "defer_discovery": True,
        "discovery_description": "Read fixture evidence after discovering its tools.",
        "initial_tools": ["slow_read"],
        "include": ["slow_read", "next_read"],
    }
    config["workflow"]["tools"].append("fixture_deferred")
    container = None
    redis_container = None
    process = None
    with tempfile.TemporaryDirectory(prefix="daedalus-runtime-http-") as directory:
        root = Path(directory)
        root.chmod(0o755)
        fixture_skills = root / "skills" / "fixture-skill"
        fixture_skills.mkdir(parents=True)
        (fixture_skills / "SKILL.md").write_text(
            "---\nname: fixture-skill\ndescription: Routing fixture\n---\nUse retained evidence and answer.\n"
        )
        config["functions"]["agent_skills_tool"] = {
            "_type": "agent_skills",
            "skills_directory": "/fixture-skills" if image else str(root / "skills"),
            "enabled_operations": ["list_skills", "load_skill"],
        }
        config["workflow"]["tools"].append("agent_skills_tool")
        config["workflow"]["model_routes"] = {
            "deep": "fixture/deep",
            "deep_max": "fixture/max",
        }
        config["workflow"]["skill_model_profiles"] = {"fixture-skill": "deep"}
        path = root / "config.yaml"
        path.write_text(yaml.safe_dump(config))
        path.chmod(0o644)
        env = {
            "DAEDALUS_INTERNAL_API_TOKEN": f"  {token}  ",
            "DAEDALUS_MEMORY_MODE": "disabled",
            "DAEDALUS_PORT": str(runtime_port),
            "DAEDALUS_TOOLS_PORT": str(tools_port),
            "REDIS_URL": "redis://127.0.0.1:1",
            "IMAGE_GENERATION_API_KEY": "PRIVATE_IMAGE_CREDENTIAL",
            "IMAGE_GENERATION_MODEL": "gpt-image-2.5-sunburst",
            "IMAGE_GENERATION_BASE_URL": f"http://127.0.0.1:{model_port}/v1",
            "C2PA_SIGNING_MODE": "off",
        }
        log = (root / "runtime.log").open("w+")
        try:
            if redis_image:
                redis_container = "daedalus-runtime-redis-" + uuid.uuid4().hex[:10]
                redis_port = free_port()
                subprocess.run(  # nosec B603 - fixed fixture argv, no shell
                    [
                        docker,
                        "run",
                        "-d",
                        "--rm",
                        "--name",
                        redis_container,
                        "--network",
                        "host",
                        "--entrypoint",
                        "redis-server",
                        redis_image,
                        "--bind",
                        "127.0.0.1",
                        "--port",
                        str(redis_port),
                        "--save",
                        "",
                        "--appendonly",
                        "no",
                    ],
                    stdout=subprocess.DEVNULL,
                    check=True,
                )

                def redis_command(*arguments):
                    return subprocess.check_output(  # nosec B603 - fixed fixture argv, no shell
                        [
                            docker,
                            "exec",
                            redis_container,
                            "redis-cli",
                            "--raw",
                            "-p",
                            str(redis_port),
                            *arguments,
                        ],
                        text=True,
                        timeout=5,
                    ).strip()

                for _ in range(50):
                    if redis_command("PING") == "PONG":
                        break
                    time.sleep(0.1)
                else:
                    raise RuntimeError("Disposable Redis did not start")
                env["REDIS_URL"] = f"redis://127.0.0.1:{redis_port}"
            if image:
                container = "daedalus-runtime-check-" + uuid.uuid4().hex[:10]
                command = [
                    docker,
                    "run",
                    "--rm",
                    "--name",
                    container,
                    "--network",
                    "host",
                    "--read-only",
                    "--tmpfs",
                    "/tmp",  # nosec B108 - isolated container tmpfs, no host file
                    "-v",
                    f"{path}:/workspace/config.yaml:ro",
                    "-v",
                    f"{root / 'skills'}:/fixture-skills:ro",
                ]
                for key, value in env.items():
                    command += ["-e", f"{key}={value}"]
                command.append(image)
            else:
                command = [
                    os.sys.executable,
                    str(Path(__file__).with_name("entrypoint.py")),
                ]
                env.update(
                    DAEDALUS_CONFIG_FILE=str(path),
                    DAEDALUS_RUNTIME_BINARY=str(Path(binary).resolve()),
                )
            process = subprocess.Popen(  # nosec B603 - fixed fixture argv, no shell
                command,
                stdout=log,
                stderr=log,
                env={
                    **os.environ,
                    **env,
                    "PYTHONPATH": str(Path(__file__).parent.resolve()),
                },
            )
            base = f"http://127.0.0.1:{runtime_port}"
            with httpx.Client(timeout=30, trust_env=False) as client:
                deadline = time.monotonic() + 120
                while True:
                    if process.poll() is not None:
                        raise RuntimeError("Runtime exited during startup")
                    try:
                        if client.get(base + "/health").is_success:
                            break
                    except httpx.TransportError:
                        pass
                    if time.monotonic() > deadline:
                        raise RuntimeError("Runtime startup timed out")
                    time.sleep(0.1)
                assert (  # nosec B101 - executable contract check
                    client.post(
                        base + "/v1/chat/completions", json={"messages": []}
                    ).status_code
                    == 401
                )
                assert (  # nosec B101 - executable contract check
                    client.post(
                        base + "/runtime/prepare", headers=headers, json={}
                    ).status_code
                    == 404
                )

                def chat(scenario, run, props=None, conversation=None):
                    response = client.post(
                        base + "/v1/chat/completions",
                        headers={
                            **headers,
                            "x-daedalus-request-id": run,
                            "x-conversation-id": conversation or run,
                        },
                        json={
                            "stream": True,
                            "additional_props": props or {},
                            "messages": [{"role": "user", "content": scenario}],
                        },
                    )
                    assert response.status_code == 200, response.status_code  # nosec B101 - executable contract check
                    return response.text

                answer = chat("BASIC PRIVATE_PROMPT", "basic-run")
                assert "The real datetime tool completed" in answer, answer  # nosec B101 - executable contract check
                assert "Function Complete: current_datetime_tool" in answer  # nosec B101 - executable contract check
                assert not peers.calls  # nosec B101 - executable contract check
                affinity = peers.requests[0]["user"]
                assert re.fullmatch(r"[0-9a-f]{64}", affinity)  # nosec B101 - executable contract check
                assert all(request["user"] == affinity for request in peers.requests)  # nosec B101 - executable contract check
                before = len(peers.requests)
                chat("BASIC PRIVATE_PROMPT", "basic-followup", conversation="basic-run")
                assert all(
                    request["user"] == affinity for request in peers.requests[before:]
                )  # nosec B101 - executable contract check
                before = len(peers.requests)
                deferred = chat("DEFERRED_DISCOVERY", "discovery-run")
                requests = peers.requests[before:]
                assert requests[0]["user"] != affinity  # nosec B101 - executable contract check
                assert all(
                    request["user"] == requests[0]["user"] for request in requests
                )  # nosec B101 - executable contract check
                assert "The real datetime tool completed" in deferred  # nosec B101 - executable contract check
                assert "Function Complete: fixture_deferred__connect" in deferred  # nosec B101 - executable contract check
                assert "Function Complete: fixture_deferred__next_read" in deferred  # nosec B101 - executable contract check
                initial_names = {tool["name"] for tool in requests[0]["tools"]}
                connected_names = {tool["name"] for tool in requests[1]["tools"]}
                discovery = next(
                    tool
                    for tool in requests[0]["tools"]
                    if tool["name"] == "fixture_deferred__connect"
                )
                assert "fixture_deferred__next_read" in discovery["description"]  # nosec B101 - executable contract check
                assert "fixture_deferred__write_item" not in discovery["description"]  # nosec B101 - executable contract check
                assert "fixture_deferred__connect" in initial_names  # nosec B101 - executable contract check
                assert "fixture_deferred__slow_read" in initial_names  # nosec B101 - executable contract check
                assert "fixture_deferred__next_read" not in initial_names  # nosec B101 - executable contract check
                assert initial_names <= connected_names  # nosec B101 - executable contract check
                assert len(connected_names) == len(requests[1]["tools"])  # nosec B101 - executable contract check
                assert "fixture_deferred__next_read" in connected_names  # nosec B101 - executable contract check
                assert "fixture_deferred__write_item" not in connected_names  # nosec B101 - executable contract check
                assert len(requests) == 3 and peers.calls == ["next_read"]  # nosec B101 - executable contract check
                peers.calls.clear()
                gateway = chat("GATEWAY", "gateway-run")
                assert gateway.count("The real datetime tool completed") == 1, gateway  # nosec B101 - executable contract check
                assert "Function Complete: current_datetime_tool" in gateway  # nosec B101 - executable contract check
                assert '"finish_reason":"stop"' in gateway, gateway  # nosec B101 - executable contract check
                gateway_incomplete = chat(
                    "GATEWAY_INCOMPLETE", "gateway-incomplete-run"
                )
                assert (
                    "Model response did not complete" in gateway_incomplete
                ), gateway_incomplete  # nosec B101 - executable contract check
                assert "Function Start:" not in gateway_incomplete  # nosec B101 - executable contract check
                for profile, expected in [
                    (None, ["fixture", "fixture/deep"]),
                    ("default", ["fixture", "fixture"]),
                    ("deep_max", ["fixture/max", "fixture/max"]),
                ]:
                    before = len(peers.requests)
                    assert "The real datetime tool completed" in chat(  # nosec B101 - executable contract check
                        "SKILL_ROUTE",
                        "route-" + str(profile),
                        {"model_profile": profile} if profile else None,
                    )
                    assert (
                        [  # nosec B101 - executable contract check
                            request["model"] for request in peers.requests[before:]
                        ]
                        == expected
                    )
                retried = chat("RETRY_MODEL", "retry-run")
                assert "The real datetime tool completed" in retried  # nosec B101 - executable contract check
                assert (  # nosec B101 - executable contract check
                    sum("RETRY_MODEL" in json.dumps(old) for old in peers.requests) == 3
                )
                before = len(peers.requests)
                incomplete = chat("INCOMPLETE", "incomplete-run")
                assert "Model response did not complete" in incomplete, incomplete  # nosec B101 - executable contract check
                assert "Function Start:" not in incomplete  # nosec B101 - executable contract check
                assert len(peers.requests) == before + 1  # nosec B101 - executable contract check
                failed = chat("PROVIDER_FAILURE", "provider-failure-run")
                assert "Agent execution failed" in failed  # nosec B101 - executable contract check
                assert "PRIVATE_PROVIDER_ERROR" not in failed  # nosec B101 - executable contract check
                for scenario in ("STREAM_RECOVER", "STREAM_TRUNCATED"):
                    before = len(peers.requests)
                    recovered = chat("GATEWAY_" + scenario, scenario.lower())
                    assert recovered.count("First part. ") == 1, recovered  # nosec B101 - executable contract check
                    assert recovered.count("Recovered final answer.") == 1, recovered  # nosec B101 - executable contract check
                    assert '"finish_reason":"stop"' in recovered, recovered  # nosec B101 - executable contract check
                    assert "event: error" not in recovered, recovered  # nosec B101 - executable contract check
                    assert recovered.count("Function Start: current_datetime_tool") == 1  # nosec B101 - executable contract check
                    attempts = peers.requests[before:]
                    assert len(attempts) == 3, attempts  # nosec B101 - executable contract check

                    # A retry retains the exact completed tool results and the
                    # text already sent to the browser, without replaying tools.
                    def results(request):
                        return [
                            item
                            for item in request["input"]
                            if item.get("type") == "function_call_output"
                        ]

                    assert results(attempts[1]) == results(attempts[2])  # nosec B101 - executable contract check
                    assert "First part. " in json.dumps(attempts[2]["input"])  # nosec B101 - executable contract check
                peers.calls.clear()
                cut = chat("GATEWAY_STREAM_TOOL_CUT", "stream-tool-cut")
                assert not peers.calls, peers.calls  # nosec B101 - executable contract check
                assert "Function Start: fixture_mcp__next_read" not in cut  # nosec B101 - executable contract check
                assert '"finish_reason":"stop"' in cut, cut  # nosec B101 - executable contract check
                for scenario, attempts in (
                    ("STREAM_ALWAYS_FAIL", 4),
                    ("STREAM_PERMANENT", 1),
                ):
                    before = len(peers.requests)
                    failed = chat("GATEWAY_" + scenario, scenario.lower())
                    assert '"finish_reason":"error"' in failed, failed  # nosec B101 - executable contract check
                    assert "Function Start:" not in failed, failed  # nosec B101 - executable contract check
                    assert len(peers.requests) == before + attempts  # nosec B101 - executable contract check
                    if scenario == "STREAM_ALWAYS_FAIL":
                        assert "Model stream interrupted after retry limit" in failed  # nosec B101 - executable contract check
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    for scenario, run, waiting in [
                        ("MODEL_STEER", "model-run", peers.model_waiting),
                        ("TOOL_STEER", "tool-run", peers.tool_waiting),
                    ]:
                        future = pool.submit(chat, scenario, run)
                        assert waiting.wait(15), f"{scenario} did not reach its wait"  # nosec B101 - executable contract check
                        command = {
                            "type": "steer",
                            "command_id": str(uuid.uuid4()),
                            "instruction": "NEW_DIRECTION: use retained results and answer now",
                        }
                        url = base + f"/v1/runs/{run}/control"
                        assert (  # nosec B101 - executable contract check
                            client.post(
                                url,
                                headers={**headers, "x-user-id": "bob"},
                                json=command,
                            ).status_code
                            == 404
                        )
                        accepted = client.post(url, headers=headers, json=command)
                        assert accepted.status_code == 200, accepted.text  # nosec B101 - executable contract check
                        # Tool waits keep the run active for deterministic duplicate checks.
                        if scenario == "TOOL_STEER":
                            duplicate = client.post(url, headers=headers, json=command)
                            assert (  # nosec B101 - executable contract check
                                duplicate.status_code == 200
                                and duplicate.json()["accepted"] is False
                            )
                            assert (  # nosec B101 - executable contract check
                                client.post(
                                    url,
                                    headers=headers,
                                    json={**command, "instruction": "different"},
                                ).status_code
                                == 409
                            )
                            peers.release_tool.set()
                        result = future.result(timeout=20)
                        assert "Directed answer" in result, result  # nosec B101 - executable contract check
                        assert '"status":"applied"' in result, result  # nosec B101 - executable contract check
                        if scenario == "MODEL_STEER":
                            assert not peers.calls, peers.calls  # nosec B101 - executable contract check
                            peers.release_model.set()
                        else:
                            assert peers.calls == ["slow_read"], peers.calls  # nosec B101 - executable contract check
                            assert "RETAINED_EVIDENCE" in result  # nosec B101 - executable contract check
                    # Cancellation interrupts a provider wait and releases the run.
                    peers.model_waiting.clear()
                    peers.release_model.clear()
                    cancelled = pool.submit(chat, "MODEL_STEER", "cancel-run")
                    assert peers.model_waiting.wait(15)  # nosec B101 - executable contract check
                    response = client.post(
                        base + "/v1/runs/cancel-run/control",
                        headers=headers,
                        json={"type": "cancel", "command_id": str(uuid.uuid4())},
                    )
                    assert response.is_success  # nosec B101 - executable contract check
                    assert "Run cancelled by user" in cancelled.result(timeout=10)  # nosec B101 - executable contract check
                    peers.release_model.set()
                    assert "The real datetime tool completed" in chat(  # nosec B101 - executable contract check
                        "BASIC", "cancel-run"
                    )
                    # Stop must cancel the in-flight MCP transport and discard
                    # queued tools, rather than just abandoning the UI stream.
                    peers.release_tool.clear()
                    peers.tool_waiting.clear()
                    peers.tool_disconnected.clear()
                    peers.calls.clear()
                    cancelled = pool.submit(chat, "TOOL_STEER", "cancel-tool-run")
                    assert peers.tool_waiting.wait(15)  # nosec B101 - executable contract check
                    response = client.post(
                        base + "/v1/runs/cancel-tool-run/control",
                        headers=headers,
                        json={"type": "cancel", "command_id": str(uuid.uuid4())},
                    )
                    assert response.is_success  # nosec B101 - executable contract check
                    assert "Run cancelled by user" in cancelled.result(timeout=5)  # nosec B101 - executable contract check
                    assert peers.tool_disconnected.wait(5), "MCP request survived Stop"  # nosec B101 - executable contract check
                    assert peers.calls == ["slow_read"], peers.calls  # nosec B101 - executable contract check
                    peers.release_tool.set()
                    # Create travels through the Rust HTTP proxy to the real
                    # Python route and SDK. Cover silent streams and requests
                    # still waiting for headers (including batches).
                    for stream, count in ((True, 1), (False, 2)):
                        peers.image_waiting.clear()
                        peers.image_disconnected.clear()
                        body = json.dumps(
                            {
                                "prompt": "fixture",
                                "guidance": "exact",
                                "stream": stream,
                                "n": count,
                            }
                        ).encode()
                        with socket.create_connection(
                            ("127.0.0.1", runtime_port), timeout=5
                        ) as connection:
                            raw_headers = {
                                **headers,
                                "Host": f"127.0.0.1:{runtime_port}",
                                "Content-Type": "application/json",
                                "Content-Length": str(len(body)),
                            }
                            request = (
                                "POST /v1/images/generate HTTP/1.1\r\n"
                                + "".join(
                                    f"{name}: {value}\r\n"
                                    for name, value in raw_headers.items()
                                )
                                + "\r\n"
                            )
                            connection.sendall(request.encode() + body)
                            assert peers.image_waiting.wait(
                                10
                            ), "Image provider was not reached"  # nosec B101 - executable contract check
                        assert peers.image_disconnected.wait(
                            5
                        ), f"Image request survived disconnect: stream={stream}"  # nosec B101 - executable contract check
                    if redis_image:
                        peers.release_tool.clear()
                        peers.tool_waiting.clear()
                        approval = pool.submit(chat, "APPROVAL", "approval-run")
                        assert peers.tool_waiting.wait(15)  # nosec B101 - executable contract check
                        # A sibling read must finish before the terminal approval frame.
                        peers.release_tool.set()
                        result = approval.result(timeout=20)
                        assert result.index("RETAINED_EVIDENCE") < result.index(  # nosec B101 - executable contract check
                            "event: mcp_approval_required"
                        )
                        assert "write_item" not in peers.calls  # nosec B101 - executable contract check
                        encoded = re.search(
                            r"<!--daedalus-mcp-approval:([A-Za-z0-9_-]+)-->", result
                        )[1]
                        marker = json.loads(
                            base64.urlsafe_b64decode(
                                encoded + "=" * (-len(encoded) % 4)
                            )
                        )
                        user_hash = hashlib.sha256(b"alice").hexdigest()[:16]
                        intent = json.loads(
                            redis_command(
                                "GET",
                                f"approval-pending:{user_hash}:{marker['requestId']}",
                            )
                        )
                        credential = uuid.uuid4().hex
                        redis_command(
                            "SETEX",
                            f"approval:{user_hash}:{credential}",
                            "120",
                            json.dumps(intent),
                        )
                        body = {
                            key: intent[key]
                            for key in (
                                "server_name",
                                "tool_name",
                                "canonical_arguments",
                                "arguments_sha256",
                            )
                        }
                        url = base + f"/v1/mcp-approvals/{marker['requestId']}/execute"
                        approved_headers = {
                            **headers,
                            "x-daedalus-approval-token": credential,
                        }
                        assert (  # nosec B101 - executable contract check
                            client.post(
                                url,
                                headers={**approved_headers, "x-user-id": "bob"},
                                json=body,
                            ).status_code
                            == 409
                        )
                        assert (  # nosec B101 - executable contract check
                            client.post(
                                url,
                                headers=approved_headers,
                                json={
                                    **body,
                                    "canonical_arguments": '{"changed":true}',
                                },
                            ).status_code
                            == 409
                        )
                        executed = client.post(url, headers=approved_headers, json=body)
                        assert executed.status_code == 200, executed.text  # nosec B101 - executable contract check
                        assert executed.json()["status"] == "completed"  # nosec B101 - executable contract check
                        assert "RETAINED_EVIDENCE" not in executed.text  # nosec B101 - executable contract check
                        assert peers.calls.count("write_item") == 1  # nosec B101 - executable contract check
                        assert (  # nosec B101 - executable contract check
                            client.post(
                                url, headers=approved_headers, json=body
                            ).status_code
                            == 409
                        )
                        receipt_key = (
                            "approval-receipt:"
                            + hashlib.sha256(credential.encode()).hexdigest()
                        )
                        assert (  # nosec B101 - executable contract check
                            json.loads(redis_command("GET", receipt_key))[
                                "arguments_sha256"
                            ]
                            == body["arguments_sha256"]
                        )
                        execution_id = executed.json()["executionId"]
                        assert (  # nosec B101 - executable contract check
                            client.get(
                                base + "/executions/" + execution_id,
                                headers={**headers, "x-user-id": "bob"},
                            ).status_code
                            == 404
                        )
                # Read through a separate descriptor: seeking the child's shared
                # stdout file would move its write position while it is logging.
                records = []
                for _ in range(50):
                    raw_logs = Path(log.name).read_text()
                    records = [
                        json.loads(line)
                        for line in raw_logs.splitlines()
                        if line.startswith("{")
                    ]
                    if any(
                        record.get("fields", {}).get("event") == "run_finished"
                        and record.get("span", {}).get("run_id") == "cancel-run"
                        for record in records
                    ):
                        break
                    time.sleep(0.02)
                events = [record.get("fields", {}) for record in records]
                required_events = {
                    "run_started",
                    "prepare_finished",
                    "model_call_started",
                    "model_first_event",
                    "model_call_finished",
                    "model_retry_scheduled",
                    "tool_call_started",
                    "tool_call_finished",
                    "steering_received",
                    "steering_applied",
                    "tool_call_skipped",
                    "cancellation_received",
                    "run_finished",
                    "run_failed",
                    "tool_prepare_finished",
                    "tool_execution_started",
                    "tool_execution_finished",
                    "tool_run_released",
                    "child_ready",
                }
                assert required_events <= {
                    event.get("event") for event in events
                }, events  # nosec B101 - executable contract check
                for name in (
                    "run_started",
                    "prepare_finished",
                    "model_call_finished",
                    "tool_call_finished",
                    "run_finished",
                ):
                    assert any(
                        record.get("fields", {}).get("event") == name  # nosec B101 - executable contract check
                        and record.get("span", {}).get("run_id") == "basic-run"
                        for record in records
                    ), name
                assert any(
                    event.get("event") == "tool_execution_finished"  # nosec B101 - executable contract check
                    and event.get("run_id") == "basic-run"
                    for event in events
                )
                assert any(
                    event.get("event") == "model_retry_scheduled"  # nosec B101 - executable contract check
                    and event.get("http_status") == 503
                    for event in events
                )
                assert any(
                    event.get("event") == "model_retry_scheduled"
                    and event.get("error_kind") == "upstream_transport"
                    and event.get("resuming") is True
                    and event.get("output_bytes") == len("First part. ")
                    for event in events
                )  # nosec B101 - executable contract check
                assert any(
                    event.get("event") == "run_failed"
                    and event.get("phase") == "model_stream"  # nosec B101 - executable contract check
                    and event.get("http_status") == 400
                    and event.get("error_kind") == "provider_response"
                    for event in events
                )
                assert any(
                    event.get("event") == "run_finished"
                    and event.get("outcome") == "cancelled"
                    for event in events
                )  # nosec B101 - executable contract check
                for private in (
                    token,
                    "PRIVATE_PROMPT",
                    "PRIVATE_PROVIDER_ERROR",
                    "PRIVATE_MODEL_CREDENTIAL",
                    "PRIVATE_TOOL_ARGUMENT",
                    "RETAINED_EVIDENCE",
                    "The real datetime tool completed",
                    "First part. ",
                    "Recovered final answer.",
                    "NEW_DIRECTION: use retained results and answer now",
                ):
                    assert (
                        private not in raw_logs
                    ), "Private content appeared in runtime logs"  # nosec B101 - executable contract check
                print(
                    "HTTP contract passed: streaming, native tools, bounded provider retry, incomplete rejection, user isolation, idempotent steering during model/MCP calls, retained results, skipped queued calls, and cancellation."
                    " Structured lifecycle logs, failure diagnostics, run correlation, and private-data exclusion passed."
                    + (
                        " Exact approvals and non-replay passed against real Redis."
                        if redis_image
                        else ""
                    )
                )
        except BaseException:
            log.flush()
            log.seek(0)
            print(log.read()[-6000:])
            raise
        finally:
            peers.release_model.set()
            peers.release_tool.set()
            if redis_container:
                subprocess.run(  # nosec B603 - fixed fixture argv, no shell
                    [docker, "stop", "-t", "1", redis_container],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
            if container:
                subprocess.run(  # nosec B603 - fixed fixture argv, no shell
                    [docker, "stop", "-t", "5", container],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            log.close()
            peer_server.shutdown()
            peer_server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--image")
    target.add_argument("--binary")
    parser.add_argument(
        "--redis-image",
        help="Disposable Redis image for exact approval integration checks",
    )
    args = parser.parse_args()
    check(args.image, args.binary, args.redis_image)
