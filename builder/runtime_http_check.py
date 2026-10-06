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

            def do_POST(self):
                body = json.loads(
                    self.rfile.read(int(self.headers.get("Content-Length", 0)))
                )
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
                                        "properties": {},
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
                            peers.release_tool.wait(15)
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
                    self.reply({"error": {"message": "fixture busy"}}, 503)
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
                            "INCOMPLETE",
                        )
                        if name in serialized
                    ),
                    "BASIC",
                )
                outputs = []
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
                elif not has_result:
                    names = (
                        ["agent_skills_tool"]
                        if scenario == "SKILL_ROUTE"
                        else ["fixture_mcp__write_item", "fixture_second__slow_read"]
                        if scenario == "APPROVAL"
                        else ["fixture_mcp__slow_read", "fixture_mcp__next_read"]
                        if scenario == "TOOL_STEER"
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
                    text = "The real datetime tool completed"
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
                "api_key": "fixture",
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
                    f'{root / "skills"}:/fixture-skills:ro',
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

                def chat(scenario, run, props=None):
                    response = client.post(
                        base + "/v1/chat/completions",
                        headers={
                            **headers,
                            "x-daedalus-request-id": run,
                            "x-conversation-id": run,
                        },
                        json={
                            "stream": True,
                            "additional_props": props or {},
                            "messages": [{"role": "user", "content": scenario}],
                        },
                    )
                    assert response.status_code == 200, response.status_code  # nosec B101 - executable contract check
                    return response.text

                answer = chat("BASIC", "basic-run")
                assert "The real datetime tool completed" in answer, answer  # nosec B101 - executable contract check
                assert "Function Complete: current_datetime_tool" in answer  # nosec B101 - executable contract check
                assert not peers.calls  # nosec B101 - executable contract check
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
                print(
                    "HTTP contract passed: streaming, native tools, bounded provider retry, incomplete rejection, user isolation, idempotent steering during model/MCP calls, retained results, skipped queued calls, and cancellation."
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
