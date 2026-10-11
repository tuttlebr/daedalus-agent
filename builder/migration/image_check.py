#!/usr/bin/env python3
"""P1 acceptance against real images, scripted peers and disposable TLS/ACL Redis.

All credentials and data are synthetic. The candidate starts with its direct
binary entrypoint and no tool service; the baseline uses its normal supervisor.
"""

import argparse
import concurrent.futures
import contextlib
import json
import os
import subprocess  # nosec B404 - fixed argv for disposable fixture containers
import sys
import tempfile
import threading
import time
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path

import httpx
import redis
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime_http_check import Peers, free_port

ROOT = Path(__file__).resolve().parents[2]


def run(*args, **kwargs):
    kwargs.setdefault("check", True)
    return subprocess.run(args, **kwargs)  # nosec B603


class MemoryPeers(Peers):
    def __init__(self):
        super().__init__()
        self.memory_requests = []
        self.memory_waiting = threading.Event()
        self.memory_disconnected = threading.Event()
        self.block_memory = False

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def do_GET(self):
                if self.path == "/health":
                    return self.reply({"status": "ok"})
                peers.memory_requests.append(["GET", self.path, None])
                if self.path.endswith("/config"):
                    if peers.block_memory:
                        peers.memory_waiting.set()
                        self.wait_for_disconnect(peers.memory_disconnected)
                        return
                    return self.reply({"overrides": {}})
                if self.path.endswith("/knowledge-base/tree"):
                    return self.reply({"roots": []})
                if "/knowledge-base/search?" in self.path:
                    return self.reply({"results": [{"id": "fixture-page"}]})
                if self.path.endswith("/knowledge-base/pages/fixture-page"):
                    return self.reply(
                        {
                            "name": "Fixture project",
                            "body": "Synthetic project context: 雪🌲.",
                        }
                    )
                self.reply({"error": "unknown memory endpoint"}, 404)

            def memory_write(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                peers.memory_requests.append([self.command, self.path, body])
                if self.path.endswith("/reflect"):
                    self.reply({"text": "Synthetic session brief."})
                elif self.path.endswith("/memories/recall"):
                    self.reply(
                        {
                            "results": [
                                {
                                    "text": "Synthetic retained fact",
                                    "type": "world",
                                    "mentioned_at": "2026-10-01T00:00:00Z",
                                }
                            ]
                        }
                    )
                else:
                    self.reply({})

            def do_PATCH(self):
                self.memory_write()

            def do_POST(self):
                if self.path.startswith("/v1/default/banks/"):
                    return self.memory_write()
                if self.path == "/v1/chat/completions":
                    body = json.loads(
                        self.rfile.read(int(self.headers["Content-Length"]))
                    )
                    peers.requests.append(body)
                    self.gateway = False
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.close_connection = True
                    result = any(m["role"] == "tool" for m in body["messages"])
                    deltas = (
                        [({"content": "The real datetime tool completed"}, "stop")]
                        if result
                        else [
                            (
                                {
                                    "tool_calls": [
                                        {
                                            "index": 0,
                                            "id": "clock-call",
                                            "type": "function",
                                            "function": {
                                                "name": "current_datetime_tool",
                                                "arguments": "{",
                                            },
                                        }
                                    ]
                                },
                                None,
                            ),
                            (
                                {
                                    "tool_calls": [
                                        {"index": 0, "function": {"arguments": "}"}}
                                    ]
                                },
                                None,
                            ),
                            ({}, "tool_calls"),
                        ]
                    )
                    for delta, finish in deltas:
                        self.event(
                            {
                                "id": "fixture-chat",
                                "object": "chat.completion.chunk",
                                "created": 1,
                                "model": "fixture",
                                "choices": [
                                    {
                                        "index": 0,
                                        "delta": delta,
                                        "finish_reason": finish,
                                    }
                                ],
                            }
                        )
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                    return
                return super().do_POST()

        return Handler


@contextlib.contextmanager
def environment(
    image,
    redis_image,
    *,
    minimal=True,
    memory=True,
    port=None,
    token=None,
    api_type="responses",
    resource_limits=False,
    peers=None,
    configure=None,
    extra_env=None,
    fixture_files=None,
):
    peers = peers or MemoryPeers()

    class PeerServer(ThreadingHTTPServer):
        request_queue_size = 128

    server = PeerServer(("127.0.0.1", 0), peers.handler())
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    names = []
    process = None
    with tempfile.TemporaryDirectory(prefix="daedalus-p1-") as directory:
        root = Path(directory)
        root.chmod(0o755)
        for name, content in (fixture_files or {}).items():
            (root / name).write_text(content)
        redis_port, runtime_port = free_port(), port or free_port()
        token = token or uuid.uuid4().hex
        config = {
            "functions": {"current_datetime_tool": {"_type": "current_datetime"}},
            "llms": {
                "main": {
                    "_type": "openai",
                    "api_type": "responses",
                    "api_key": "synthetic",
                    "base_url": f"http://127.0.0.1:{server.server_port}/v1",
                    "model_name": "fixture",
                }
            },
            "workflow": {
                "_type": "daedalus_rust_agent",
                "llm_name": "main",
                "tools": ["current_datetime_tool"],
                "model_routes": {"deep": "fixture/deep", "deep_max": "fixture/max"},
                "max_history": 8,
                "max_history_tokens": 2000,
                "instructions": "Synthetic fixture instructions.",
            },
        }
        config["llms"]["main"]["api_type"] = api_type
        if configure:
            configure(config, server.server_port, runtime_port)
        (root / "config.yaml").write_text(yaml.safe_dump(config))
        run(
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(root / "ca.key"),
            "-out",
            str(root / "ca.crt"),
            "-days",
            "1",
            "-subj",
            "/CN=fixture-ca",
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        run(
            "openssl",
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(root / "server.key"),
            "-out",
            str(root / "server.csr"),
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost,IP:127.0.0.1",
            "-addext",
            "basicConstraints=CA:FALSE",
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        run(
            "openssl",
            "x509",
            "-req",
            "-in",
            str(root / "server.csr"),
            "-CA",
            str(root / "ca.crt"),
            "-CAkey",
            str(root / "ca.key"),
            "-CAcreateserial",
            "-days",
            "1",
            "-copy_extensions",
            "copy",
            "-out",
            str(root / "server.crt"),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # Same key scopes as the shipped backend workload, not an unrestricted client.
        # The authoritative ACL command/key rules live in the Redis image.
        acl = "user default off\nuser fixture-admin on >synthetic-admin ~* &* +@all\nuser backend on >synthetic-backend ~nat:* ~nat/* ~approval:* ~approval-pending:* ~approval-receipt:* ~document:* ~generated:* ~image:* ~user:*:image:* ~rss_feed:* ~daedalus:* +@all -@dangerous +info\n"
        (root / "users.acl").write_text(acl)
        for path in root.iterdir():
            path.chmod(0o644)
        redis_name = "daedalus-p1-redis-" + uuid.uuid4().hex[:10]
        backend_name = "daedalus-p1-backend-" + uuid.uuid4().hex[:10]
        try:
            names.append(redis_name)
            run(
                "docker",
                "run",
                "-d",
                "--rm",
                "--name",
                redis_name,
                "--network",
                "host",
                "-v",
                f"{root}:/fixture:ro",
                "--entrypoint",
                "redis-server",
                redis_image,
                "--bind",
                "127.0.0.1",
                "--port",
                "0",
                "--tls-port",
                str(redis_port),
                "--tls-cert-file",
                "/fixture/server.crt",
                "--tls-key-file",
                "/fixture/server.key",
                "--tls-ca-cert-file",
                "/fixture/ca.crt",
                "--tls-auth-clients",
                "no",
                "--aclfile",
                "/fixture/users.acl",
                "--save",
                "",
                "--appendonly",
                "no",
                stdout=subprocess.DEVNULL,
            )
            admin = redis.Redis(  # nosec B106 - disposable synthetic credential
                host="localhost",
                port=redis_port,
                username="fixture-admin",
                password="synthetic-admin",
                ssl=True,
                ssl_ca_certs=str(root / "ca.crt"),
            )
            deadline = time.monotonic() + 30
            while True:
                try:
                    if admin.ping():
                        break
                except redis.ConnectionError:
                    if time.monotonic() > deadline:
                        raise
                    time.sleep(0.1)
            env = {
                "DAEDALUS_INTERNAL_API_TOKEN": token,
                "DAEDALUS_PORT": str(runtime_port),
                "DAEDALUS_TOOLS_PORT": str(free_port()),
                "DAEDALUS_CONFIG_FILE": "/fixture/config.yaml",
                "DAEDALUS_MEMORY_MODE": "hindsight" if memory else "disabled",
                "HINDSIGHT_API_URL": f"http://127.0.0.1:{server.server_port}",
                "HINDSIGHT_API_KEY": "synthetic-hindsight-key",
                "REDIS_URL": f"rediss://backend:synthetic-backend@localhost:{redis_port}?ssl_ca_certs=/fixture/ca.crt",
                "DAEDALUS_PREPARATION": "rust" if minimal else "python",
                "DAEDALUS_AUTHORIZATION": "rust" if minimal else "python",
            }
            env.update(extra_env(server.server_port) if extra_env else {})
            command = [
                "docker",
                "run",
                "--rm",
                "--name",
                backend_name,
                "--network",
                "host",
                "--read-only",
                "--tmpfs",
                "/tmp",
                "-v",
                f"{root}:/fixture:ro",
            ]  # nosec B108 - container tmpfs
            for key, value in env.items():
                command += ["-e", f"{key}={value}"]
            if resource_limits:
                command += ["--cpus", "2", "--memory", "2g"]
            names.append(backend_name)
            with (root / "backend.log").open("w+") as log:
                started = time.monotonic()
                process = subprocess.Popen([*command, image], stdout=log, stderr=log)  # nosec B603
                base = f"http://127.0.0.1:{runtime_port}"
                with httpx.Client(timeout=30, trust_env=False) as client:
                    deadline = time.monotonic() + 90
                    while True:
                        if process.poll() is not None:
                            raise RuntimeError(
                                "Candidate exited: "
                                + (root / "backend.log").read_text()[-2000:]
                            )
                        try:
                            if client.get(base + "/health/ready").is_success:
                                break
                        except httpx.TransportError:
                            pass
                        if time.monotonic() > deadline:
                            raise RuntimeError(
                                "Candidate readiness failed: "
                                + (root / "backend.log").read_text()[-2000:]
                            )
                        time.sleep(0.1)
                    yield {
                        "base": base,
                        "client": client,
                        "headers": {
                            "x-daedalus-internal-token": token,
                            "x-user-id": "synthetic-alice",
                        },
                        "peers": peers,
                        "redis": admin,
                        "container": backend_name,
                        "process": process,
                        "root": root,
                        "environment": env,
                        "readiness_ms": (time.monotonic() - started) * 1000,
                    }
        finally:
            peers.release_model.set()
            for name in reversed(names):
                run(
                    "docker",
                    "stop",
                    "-t",
                    "5",
                    name,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
            if process:
                process.wait(timeout=15)
            server.shutdown()
            server.server_close()


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def check(image, redis_image, minimal=True, rollback_image=None):
    with environment(image, redis_image, minimal=minimal) as fixture:
        client, base, headers, peers = (
            fixture[key] for key in ("client", "base", "headers", "peers")
        )
        endpoint = base + "/v1/chat/completions"
        require(
            client.post(endpoint, json={"messages": []}).status_code == 401,
            "Missing internal token accepted",
        )
        require(
            client.post(
                base + "/runtime/v1/catalog", headers=headers, json={}
            ).status_code
            == 404,
            "Internal route exposed",
        )
        observations = []
        for profile in (None, "default", "deep", "deep_max"):
            before = len(peers.requests)
            response = client.post(
                endpoint,
                headers={**headers, "x-conversation-id": f"profile-{profile}"},
                json={
                    "stream": False,
                    "messages": [
                        {"role": "assistant", "content": "old"},
                        {
                            "role": "user",
                            "content": "BASIC PRIVATE_PROMPT 雪🌲. Remember what I previously said about my project.",
                        },
                    ],
                    "additional_props": {"model_profile": profile} if profile else {},
                },
            )
            require(response.status_code == 200, f"Chat failed: {response.status_code}")
            require(
                "The real datetime tool completed" in response.text,
                "Clock/chat did not complete",
            )
            request = peers.requests[before]
            require(
                request["model"]
                == {"deep": "fixture/deep", "deep_max": "fixture/max"}.get(
                    profile, "fixture"
                ),
                "Route changed",
            )
            require("[MEMORY_CONTEXT]" in json.dumps(request), "Memory context missing")
            require(
                "Synthetic retained fact" in json.dumps(request),
                "Recall evidence missing",
            )
            observations.append(request)
        # Cancellation while preparation owns an in-flight memory request.
        peers.block_memory = True
        stopped_headers = {
            **headers,
            "x-user-id": "synthetic-stop",
            "x-daedalus-request-id": "stop-prepare",
        }
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(
                client.post,
                endpoint,
                headers=stopped_headers,
                json={
                    "stream": True,
                    "messages": [{"role": "user", "content": "BASIC project context"}],
                },
            )
            require(peers.memory_waiting.wait(10), "Memory barrier not reached")
            control = base + "/v1/runs/stop-prepare/control"
            command = {
                "type": "cancel",
                "command_id": "64fafb45-425d-445e-bc9c-6b9e28335d0f",
            }
            require(
                client.post(
                    control,
                    headers={**headers, "x-user-id": "synthetic-bob"},
                    json=command,
                ).status_code
                == 404,
                "Cross-user control accepted",
            )
            start = time.monotonic()
            require(
                client.post(
                    control,
                    headers=headers | {"x-user-id": "synthetic-stop"},
                    json=command,
                ).is_success,
                "Stop rejected",
            )
            require(
                "Run cancelled by user" in future.result(timeout=3).text,
                "Stop lost terminal event",
            )
            require(time.monotonic() - start < 2, "Stop exceeded control budget")
        require(
            peers.memory_disconnected.wait(3), "Memory transport survived cancellation"
        )
        deadline = time.monotonic() + 3
        while (
            fixture["redis"].keys("daedalus:memory:bootstrap-lock:*")
            and time.monotonic() < deadline
        ):
            time.sleep(0.05)
        require(
            not fixture["redis"].keys("daedalus:memory:bootstrap-lock:*"),
            "Cancelled preparation leaked its lock",
        )
        if minimal:
            require(
                client.get(base + "/v1/memory", headers=headers).status_code == 503,
                "Unavailable capability response missing",
            )
            inspected = run(
                "docker",
                "exec",
                fixture["container"],
                "sh",
                "-c",
                "! command -v python && ! command -v python3 && test ! -e /workspace/.venv && test ! -e /usr/lib/python3",
                capture_output=True,
            )
            require(inspected.returncode == 0, "Python in minimal image")
        if rollback_image:
            content = json.dumps(
                [
                    {"index": i, "text": "Synthetic exact output 雪🌲 " * 25}
                    for i in range(200)
                ],
                ensure_ascii=False,
            )
            output_file = fixture["root"] / "output.json"
            output_file.write_text(content)
            info = fixture["redis"].connection_pool.connection_kwargs
            container_url = f"rediss://backend:synthetic-backend@localhost:{info['port']}?ssl_ca_certs=/fixture/ca.crt"
            script = """
import asyncio, os
from pathlib import Path
from nat_helpers.tool_output_compaction import ToolOutputStore, tool_output_reference
async def main():
    store = ToolOutputStore()
    content = Path('/fixture/output.json').read_text()
    reference = tool_output_reference(content)
    if os.environ['MODE'] == 'write':
        assert await store.put('synthetic-legacy', content, reference)
    else:
        assert await store.get('synthetic-alice', reference) == content
        assert await store.get('synthetic-bob', reference) is None
    await store.close()
asyncio.run(main())
"""

            def baseline_store(mode):
                run(
                    "docker",
                    "run",
                    "--rm",
                    "--network",
                    "host",
                    "-v",
                    f"{fixture['root']}:/fixture:ro",
                    "-e",
                    f"REDIS_URL={container_url}",
                    "-e",
                    f"MODE={mode}",
                    "--entrypoint",
                    "python",
                    rollback_image,
                    "-c",
                    script,
                )

            baseline_store("write")
            test_url = container_url.replace(
                "/fixture/ca.crt", str(fixture["root"] / "ca.crt")
            )
            run(
                "cargo",
                "test",
                "--locked",
                "--manifest-path",
                str(ROOT / "builder/runtime/Cargo.toml"),
                "redis_upgrade_and_atomicity",
                "--",
                "--ignored",
                env={
                    **os.environ,
                    "DAEDALUS_TEST_REDIS_URL": test_url,
                    "DAEDALUS_TEST_OUTPUT_FILE": str(output_file),
                },
            )
            baseline_store("read")
        report = {
            "model_requests": observations,
            "memory_requests": peers.memory_requests,
            "status": "passed",
        }
    with environment(
        image, redis_image, minimal=minimal, memory=False, api_type="chat"
    ) as fixture:
        for streaming in (False, True):
            response = fixture["client"].post(
                fixture["base"] + "/v1/chat/completions",
                headers=fixture["headers"],
                json={
                    "stream": streaming,
                    "messages": [{"role": "user", "content": "BASIC"}],
                },
            )
            require(
                response.is_success
                and "The real datetime tool completed" in response.text,
                "Chat Completions stream/tool contract failed",
            )
    if minimal:
        with environment(image, redis_image, memory=False) as fixture:
            with concurrent.futures.ThreadPoolExecutor() as pool:
                pending = pool.submit(
                    fixture["client"].post,
                    fixture["base"] + "/v1/chat/completions",
                    headers=fixture["headers"],
                    json={
                        "stream": True,
                        "messages": [{"role": "user", "content": "MODEL_STEER"}],
                    },
                )
                require(
                    fixture["peers"].model_waiting.wait(10), "Model barrier missing"
                )
                run(
                    "docker",
                    "kill",
                    "--signal",
                    "TERM",
                    fixture["container"],
                    stdout=subprocess.DEVNULL,
                )
                require(
                    "Run cancelled by user" in pending.result(timeout=5).text,
                    "Shutdown lost the active run terminal event",
                )
                require(
                    fixture["peers"].model_disconnected.wait(3),
                    "Shutdown left a model transport open",
                )
                require(
                    fixture["process"].wait(timeout=8) == 0,
                    "Direct binary did not exit cleanly on SIGTERM",
                )
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--baseline", action="store_true")
    parser.add_argument(
        "--compare-image",
        help="Compare model and memory requests with this baseline image",
    )
    parser.add_argument("--report", type=Path)
    parser.add_argument(
        "--rollback-image",
        help="Test Python/Rust cache compatibility and Redis atomicity",
    )
    args = parser.parse_args()
    result = check(
        args.image,
        args.redis_image,
        minimal=not args.baseline,
        rollback_image=args.rollback_image,
    )
    if args.report:
        args.report.write_text(json.dumps(result, indent=2) + "\n")
    if args.compare_image:
        baseline = check(args.compare_image, args.redis_image, minimal=False)
        if args.report:
            args.report.with_suffix(".baseline.json").write_text(
                json.dumps(baseline, indent=2) + "\n"
            )
        require(
            result == baseline, "Unexplained memory/preparation contract difference"
        )
    print(
        "P1 image contracts passed: chat, clock, profiles, memory, identity, Stop and TLS/ACL Redis."
    )
