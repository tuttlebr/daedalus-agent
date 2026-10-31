#!/usr/bin/env python3
"""P2 release-image contracts with two users, two runtimes and TLS/ACL Redis.

Every identity, grant, argument and remote side effect in this harness is
synthetic. Failures after a remote commit must never trigger another dispatch.
"""

import argparse
import base64
import concurrent.futures
import contextlib
import hashlib
import json
import re
import socket
import subprocess  # nosec B404 - fixed argv for disposable fixture containers
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

import httpx
from image_check import MemoryPeers, environment, require, run
from runtime_http_check import free_port


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def grant_key(user, service="gmail"):
    bucket = {
        "gmail": "gmail-mcp-oauth-ro",
        "calendar": "calendar-mcp-oauth-rw",
        "docs": "docs-mcp-oauth-drive",
    }[service]
    namespace = uuid.uuid5(uuid.NAMESPACE_DNS, "nemo-agent-toolkit")
    legacy = uuid.uuid5(namespace, f"daedalus-user-{digest(user)[:32]}")
    return f"nat/object_store/{bucket}/tokens/{digest(str(legacy))}"


class AuthPeers(MemoryPeers):
    def __init__(self):
        super().__init__()
        self.mcp_calls = []
        self.token_calls = []
        self.initializations = []
        self.token_waiting = threading.Event()
        self.release_token = threading.Event()
        self.call_waiting = threading.Event()
        self.call_disconnected = threading.Event()

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def do_GET(self):
                if self.path.startswith("/mcp/"):
                    return self.reply({}, 405)
                return super().do_GET()

            def do_DELETE(self):
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_POST(self):
                if self.path == "/oauth/token":
                    fields = parse_qs(
                        self.rfile.read(int(self.headers["Content-Length"])).decode()
                    )
                    fields = {k: v[0] for k, v in fields.items()}
                    peers.token_calls.append(fields)
                    refresh = fields.get("refresh_token", "")
                    if refresh == "hold":
                        peers.token_waiting.set()
                        peers.release_token.wait(20)
                    if refresh == "invalid":
                        return self.reply({"error": "invalid_grant"}, 400)
                    if refresh == "transient":
                        return self.reply({"error": "temporarily_unavailable"}, 503)
                    response = {
                        "access_token": "synthetic-access-"
                        + (refresh or fields.get("code", "new")),
                        "expires_in": 3600,
                        "token_type": "Bearer",
                    }
                    if (
                        refresh == "rotate"
                        or fields.get("grant_type") == "authorization_code"
                    ):
                        response["refresh_token"] = "synthetic-rotated-refresh"  # nosec B105 - scripted synthetic peer
                    return self.reply(response)
                if self.path.startswith("/mcp/"):
                    request = json.loads(
                        self.rfile.read(int(self.headers["Content-Length"]))
                    )
                    if "id" not in request:
                        return self.reply({}, 202)
                    method = request["method"]
                    if method == "initialize":
                        peers.initializations.append(
                            [self.path, self.headers.get("Authorization")]
                        )
                        result = {
                            "protocolVersion": "2025-11-25",
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": "synthetic", "version": "1"},
                        }
                    elif method == "tools/list":
                        result = {
                            "tools": [
                                {
                                    "name": name,
                                    "description": "Synthetic " + name,
                                    "inputSchema": {
                                        "type": "object",
                                        "properties": {
                                            "name": {"type": "string"},
                                            "fault": {"type": "string"},
                                        },
                                        "required": ["name"],
                                        "additionalProperties": False,
                                    },
                                }
                                for name in ("read_item", "write_item", "auto_item")
                            ]
                        }
                    elif method == "tools/call":
                        params = request["params"]
                        peers.mcp_calls.append(
                            {
                                "path": self.path,
                                "authorization": self.headers.get("Authorization"),
                                "tool": params["name"],
                                "args": params["arguments"],
                            }
                        )
                        fault = params["arguments"].get("fault")
                        if fault == "expired":
                            return self.reply({}, 404)
                        if fault == "lost":
                            self.connection.shutdown(socket.SHUT_RDWR)
                            self.connection.close()
                            return
                        if fault == "wait":
                            peers.call_waiting.set()
                            self.wait_for_disconnect(peers.call_disconnected)
                            return
                        result = {
                            "content": [
                                {"type": "text", "text": "Synthetic result 雪🌲"}
                            ],
                            "isError": fault == "error",
                        }
                        if fault == "null_error":
                            result["isError"] = None
                        if fault == "missing_content":
                            result.pop("content")
                    else:
                        raise AssertionError("Unexpected MCP fixture method")
                    payload = json.dumps(
                        {"jsonrpc": "2.0", "id": request["id"], "result": result}
                    ).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    if method == "initialize":
                        self.send_header("Mcp-Session-Id", uuid.uuid4().hex)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                if self.path == "/v1/chat/completions":
                    request = json.loads(
                        self.rfile.read(int(self.headers["Content-Length"]))
                    )
                    peers.requests.append(request)
                    command = json.loads(
                        next(
                            m["content"]
                            for m in reversed(request["messages"])
                            if m["role"] == "user"
                        )
                    )
                    tool_result = any(m["role"] == "tool" for m in request["messages"])
                    self.gateway = False
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.close_connection = True
                    delta = (
                        {"content": "Synthetic completion"}
                        if tool_result
                        else {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "fixture-call",
                                    "type": "function",
                                    "function": {
                                        "name": command["tool"],
                                        "arguments": json.dumps(
                                            command["args"], ensure_ascii=False
                                        ),
                                    },
                                }
                            ]
                        }
                    )
                    self.event(
                        {
                            "id": "fixture",
                            "object": "chat.completion.chunk",
                            "model": "fixture",
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": delta,
                                    "finish_reason": "stop"
                                    if tool_result
                                    else "tool_calls",
                                }
                            ],
                        }
                    )
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                    return
                return super().do_POST()

        return Handler


def configure(config, peer_port, runtime_port):
    config["function_groups"] = {}
    config["authentication"] = {}
    for service in ("plain", "gmail", "calendar"):
        group = {
            "_type": "per_user_mcp_client",
            "server": {"url": f"http://127.0.0.1:{peer_port}/mcp/{service}"},
            "tool_overrides": {
                "read_item": {"approval_policy": "read_only"},
                "auto_item": {"approval_policy": "auto_approve"},
            },
        }
        if service != "plain":
            group["server"]["auth_provider"] = service
            config["authentication"][service] = {
                "_type": "mcp_oauth2",
                "server_url": f"https://{service}mcp.googleapis.com/mcp",
                "client_id": "synthetic-client",
                "client_secret": "SYNTHETIC_PRIVATE_CLIENT_SECRET",
                "redirect_uri": f"http://127.0.0.1:{runtime_port}/auth/redirect",
                "scopes": ["synthetic.read", "synthetic.write"],
            }
        config["function_groups"][service] = group
    config["workflow"]["tools"] = ["plain", "gmail", "calendar"]


@contextlib.contextmanager
def second_runtime(fixture, image):
    name = "daedalus-p2-second-" + uuid.uuid4().hex[:10]
    fixture["second_container"] = name
    port = free_port()
    env = {**fixture["environment"], "DAEDALUS_PORT": str(port)}
    command = [
        "docker",
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "host",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "-v",
        f"{fixture['root']}:/fixture:ro",
    ]  # nosec B108 - disposable container tmpfs
    for key, value in env.items():
        command += ["-e", f"{key}={value}"]
    with (fixture["root"] / "second.log").open("w+") as log:
        process = subprocess.Popen([*command, image], stdout=log, stderr=log)  # nosec B603
        base = f"http://127.0.0.1:{port}"
        try:
            deadline = time.monotonic() + 30
            while True:
                try:
                    if fixture["client"].get(base + "/health/ready").is_success:
                        break
                except httpx.TransportError:
                    pass
                require(
                    process.poll() is None and time.monotonic() < deadline,
                    "Second runtime did not start",
                )
                time.sleep(0.1)
            yield base
        finally:
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
            process.wait(timeout=15)


def check(image, redis_image, rollback_image):
    peers = AuthPeers()
    cases = []
    with environment(
        image,
        redis_image,
        memory=False,
        api_type="chat",
        peers=peers,
        configure=configure,
        extra_env=lambda port: {
            "DAEDALUS_GOOGLE_OAUTH_AUTHORIZE_URL": f"http://127.0.0.1:{port}/oauth/authorize",
            "DAEDALUS_GOOGLE_OAUTH_TOKEN_URL": f"http://127.0.0.1:{port}/oauth/token",
            "RUST_LOG": "trace,rmcp::service=trace,reqwest=trace",
        },
    ) as fixture:
        client, base, headers, db = (
            fixture[k] for k in ("client", "base", "headers", "redis")
        )
        user = headers["x-user-id"]
        bob = {**headers, "x-user-id": "synthetic-bob"}

        def approved(service="plain", tool="write_item", args=None, actor=user):
            canonical = json.dumps(
                args or {"name": "SYNTHETIC_PRIVATE_ARGUMENT_雪🌲"},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            body = {
                "server_name": service,
                "tool_name": tool,
                "canonical_arguments": canonical,
                "arguments_sha256": digest(canonical),
            }
            credential = uuid.uuid4().hex
            db.set(
                f"approval:{digest(actor)[:16]}:{credential}",
                json.dumps({**body, "user_id": actor, "action_type": "mcp_mutation"}),
                ex=120,
            )
            return body, {
                **headers,
                "x-user-id": actor,
                "x-daedalus-approval-token": credential,
            }

        def execute(body, auth, target=base):
            return client.post(
                target + "/v1/mcp-approvals/synthetic-request/execute",
                headers=auth,
                json=body,
                timeout=30,
            )

        def chat(tool, args, auth=headers, run_id=None):
            run_id = run_id or uuid.uuid4().hex
            return client.post(
                base + "/v1/chat/completions",
                headers={**auth, "x-daedalus-request-id": run_id},
                json={
                    "stream": True,
                    "messages": [
                        {
                            "role": "user",
                            "content": json.dumps({"tool": tool, "args": args}),
                        }
                    ],
                },
                timeout=30,
            )

        body, auth = approved()
        require(execute(body, {}).status_code == 401, "Missing internal token accepted")
        require(
            execute(body, {**auth, "x-user-id": "synthetic-bob"}).status_code == 409,
            "Cross-user credential accepted",
        )
        require(
            execute({**body, "canonical_arguments": "{}"}, auth).status_code == 409,
            "Changed arguments accepted",
        )
        require(
            execute({**body, "server_name": "plain__redirect"}, auth).status_code
            == 409,
            "Ambiguous server accepted",
        )
        require(not peers.mcp_calls, "Invalid request reached a peer")
        for malformed in (
            {**body, "unexpected": "SYNTHETIC_PRIVATE_ARGUMENT"},
            {**body, "server_name": "x" * 129},
            {**body, "canonical_arguments": "x" * 4_000_001},
        ):
            response = execute(malformed, auth)
            require(
                response.status_code == 422
                and "SYNTHETIC_PRIVATE_ARGUMENT" not in response.text,
                "Malformed execution request was accepted or echoed",
            )
        response = client.delete(
            base + "/v1/google-workspace/connections/unknown", headers=headers
        )
        require(
            response.status_code == 404
            and response.json() == {"detail": "Unknown Google Workspace service"},
            "Unknown connection reset contract changed",
        )
        require(
            client.post(
                base + "/runtime/tools/call", headers=headers, json={}
            ).status_code
            == 404,
            "Internal migration endpoint exposed",
        )
        cases.append("C05 identity, body binding and internal-route isolation")

        pending = chat("plain__write_item", {"name": "synthetic pending"})
        match = re.search(
            r"<!--daedalus-mcp-approval:([A-Za-z0-9_-]+)-->", pending.text
        )
        require(match is not None, "Chat mutation did not stop at approval")
        marker = json.loads(
            base64.urlsafe_b64decode(match[1] + "=" * (-len(match[1]) % 4))
        )
        key = f"approval-pending:{digest(user)[:16]}:{marker['requestId']}"
        record = json.loads(db.get(key))
        require(
            record["user_id"] == user and 604700 < db.ttl(key) <= 604800,
            "Pending ownership or TTL changed",
        )
        require(not peers.mcp_calls, "Unapproved mutation dispatched")
        cases.append("C08 pending marker and durable record")

        def baseline_store(mode, data):
            source = Path(__file__).with_name("authorization_store_contract.py")
            (fixture["root"] / "store-contract.py").write_text(source.read_text())
            (fixture["root"] / "store-record.json").write_text(json.dumps(data))
            result = run(
                "docker",
                "run",
                "--rm",
                "--network",
                "host",
                "-v",
                f"{fixture['root']}:/fixture:ro",
                "-e",
                f"REDIS_URL={fixture['environment']['REDIS_URL']}",
                "-e",
                "PYTHONPATH=/workspace",
                "--entrypoint",
                "python",
                rollback_image,
                "/fixture/store-contract.py",
                mode,
                "/fixture/store-record.json",
                capture_output=True,
                text=True,
            )
            return json.loads(result.stdout) if result.stdout.strip() else None

        legacy_credential = baseline_store("write", record)["token"]
        legacy_body = {
            field: record[field]
            for field in (
                "server_name",
                "tool_name",
                "canonical_arguments",
                "arguments_sha256",
            )
        }
        require(
            execute(
                legacy_body, {**headers, "x-daedalus-approval-token": legacy_credential}
            ).status_code
            == 200,
            "Rust could not consume the baseline approval",
        )
        require(
            execute(*approved("gmail", args={"name": "baseline grant"})).status_code
            == 200,
            "Rust could not use the baseline-written grant",
        )
        require(
            peers.mcp_calls[-1]["authorization"] == "Bearer synthetic-baseline-access",
            "Rust did not use the exact baseline token",
        )

        def cancel_wait(tool, args, actor, barrier):
            run_id = uuid.uuid4().hex
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(chat, tool, args, actor, run_id)
                require(barrier(), "Cancellation barrier not reached")
                started = time.monotonic()
                response = client.post(
                    base + f"/v1/runs/{run_id}/control",
                    headers=actor,
                    json={"type": "cancel", "command_id": uuid.uuid4().hex},
                )
                require(response.is_success, "Stop command was rejected")
                result = future.result(timeout=5)
                require(
                    "cancelled" in result.text and time.monotonic() - started < 3,
                    "Stop did not terminate the cancellable wait",
                )
                return result.text

        peers.call_waiting.clear()
        cancel_wait(
            "plain__read_item",
            {"name": "synthetic wait", "fault": "wait"},
            headers,
            lambda: peers.call_waiting.wait(5),
        )
        require(
            peers.call_disconnected.wait(5),
            "Stop did not close the active MCP HTTP transport",
        )
        before = len(peers.initializations)
        # A missing OAuth grant emits a UI event before waiting. A second client
        # polls the cancellation barrier through the active run's streamed bytes.
        run_id = uuid.uuid4().hex
        oauth_event = threading.Event()
        captured = []

        def oauth_stream():
            with httpx.Client(timeout=15, trust_env=False) as streaming:
                with streaming.stream(
                    "POST",
                    base + "/v1/chat/completions",
                    headers={**bob, "x-daedalus-request-id": run_id},
                    json={
                        "stream": True,
                        "messages": [
                            {
                                "role": "user",
                                "content": json.dumps(
                                    {"tool": "gmail__connect", "args": {}}
                                ),
                            }
                        ],
                    },
                ) as response:
                    for line in response.iter_lines():
                        captured.append(line)
                        if line.startswith("data: ") and '"oauth_state"' in line:
                            oauth_event.set()

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(oauth_stream)
            require(oauth_event.wait(8), "OAuth UI event was not delivered")
            require(
                client.post(
                    base + f"/v1/runs/{run_id}/control",
                    headers=bob,
                    json={"type": "cancel", "command_id": uuid.uuid4().hex},
                ).is_success,
                "OAuth Stop rejected",
            )
            future.result(timeout=5)
        state = next(
            json.loads(line[6:])["oauth_state"]
            for line in captured
            if line.startswith("data: ") and '"oauth_state"' in line
        )
        require(
            client.get(
                base + "/auth/redirect", params={"state": state, "code": "late-code"}
            ).status_code
            == 400,
            "Cancelled OAuth state accepted a late callback",
        )
        require(
            not db.exists(grant_key("synthetic-bob")), "Cancelled OAuth stored a grant"
        )
        require(
            not any(path == "/mcp/gmail" for path, _ in peers.initializations[before:]),
            "Cancelled OAuth connected to the peer",
        )
        cases.append("C04/C06/C07 Stop closes MCP and removes pending OAuth state")

        with second_runtime(
            fixture, image
        ) as second, concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for tool in ("write_item", "auto_item"):
                body, auth = approved(tool=tool)
                before = len(peers.mcp_calls)
                barrier = threading.Barrier(2)

                def race(target):
                    barrier.wait(5)
                    return execute(body, auth, target)

                results = list(pool.map(race, (base, second)))
                require(
                    sum(r.status_code == 200 for r in results) == 1,
                    "Concurrent approval did not have one winner",
                )
                require(
                    all(r.status_code in (200, 409, 422) for r in results),
                    "Unexpected approval failure status",
                )
                require(
                    len(peers.mcp_calls) == before + 1,
                    "Approval dispatched more than once",
                )
                winner = next(r for r in results if r.status_code == 200)
                require(
                    "Synthetic result 雪🌲" in winner.json()["result"]["content"],
                    "Approved execution discarded the tool output",
                )
                owner_base = str(winner.request.url).split("/v1/")[0]
                status_url = owner_base + "/executions/" + winner.json()["executionId"]
                require(
                    client.get(status_url, headers=auth).json()["result"]
                    == winner.json()["result"],
                    "Execution polling lost the approved result",
                )
                require(
                    client.get(status_url, headers=bob).status_code == 404,
                    "Execution status crossed users",
                )
                require(
                    execute(body, auth).status_code == 409, "Consumed credential reused"
                )
            cases.append(
                "C08 atomic approval races across two runtimes, including auto-approved operations"
            )

            for fault in ("lost", "expired", "error", "null_error", "missing_content"):
                body, auth = approved(
                    args={"name": "synthetic mutation", "fault": fault}
                )
                before = len(peers.mcp_calls)
                result = execute(body, auth)
                require(
                    result.status_code == 422,
                    "Unconfirmed/error result reported success",
                )
                require(
                    len(peers.mcp_calls) == before + 1, "Uncertain mutation replayed"
                )
                require(
                    execute(body, auth).status_code == 409,
                    "Uncertain mutation approval reused",
                )
            cases.append(
                "C06/C08 lost response, expired session, malformed results and remote errors never replay"
            )

            # Legacy input, cross-process refresh coalescing and a v2 compatible write.
            saved = {
                "credentials": [{"token": "legacy-access"}],
                "raw": {
                    "refresh_token": "rotate",
                    "scope": "synthetic.read synthetic.write",
                },
                "token_expires_at": (
                    datetime.now(ZoneInfo("America/New_York")) + timedelta(hours=1)
                )
                .replace(tzinfo=None)
                .isoformat(),
            }
            db.set(
                grant_key(user),
                json.dumps(
                    {
                        "data": base64.urlsafe_b64encode(
                            json.dumps(saved).encode()
                        ).decode()
                    }
                ),
            )
            before = len(peers.token_calls)
            require(
                execute(*approved("gmail")).status_code == 200,
                "Legacy local-time grant could not execute",
            )
            require(
                len(peers.token_calls) == before
                and peers.mcp_calls[-1]["authorization"] == "Bearer legacy-access",
                "Legacy local-time expiry caused unnecessary reauthorization/refresh",
            )
            saved["token_expires_at"] = datetime(2000, 1, 1, tzinfo=UTC).isoformat()
            db.set(
                grant_key(user),
                json.dumps(
                    {
                        "data": base64.urlsafe_b64encode(
                            json.dumps(saved).encode()
                        ).decode()
                    }
                ),
            )
            before = len(peers.token_calls)
            first = approved("gmail", args={"name": "first"})
            other = approved("gmail", args={"name": "second"})
            futures = [
                pool.submit(execute, *first, base),
                pool.submit(execute, *other, second),
            ]
            require(
                all(f.result().status_code == 200 for f in futures),
                "Concurrent OAuth operations failed",
            )
            require(
                len(peers.token_calls) == before + 1,
                "Concurrent refresh rotated the same grant twice",
            )
            grant = json.loads(db.get(grant_key(user)))
            require(
                grant["version"] == 2
                and grant["refresh_token"] == "synthetic-rotated-refresh"
                and grant["scope"] == saved["raw"]["scope"]
                and db.ttl(grant_key(user)) == -1,
                "Grant persistence/rotation mismatch",
            )
            require(
                all(
                    c["authorization"] == "Bearer synthetic-access-rotate"
                    for c in peers.mcp_calls[-2:]
                ),
                "Refreshed access token not bound to calls",
            )
            # The second process reuses grants, even if the first process owns a session.
            require(
                execute(*approved("gmail"), second).status_code == 200,
                "Grant not usable from another runtime",
            )
            cases.append(
                "C07 legacy grants/local-time expiry, refresh rotation, concurrent refresh and restart"
            )

            for refresh in ("transient", "invalid"):
                key = grant_key("synthetic-bob")
                previous = {
                    "version": 2,
                    "access_token": "old",
                    "refresh_token": refresh,
                    "scope": "synthetic.read",
                    "expires_at": 0,
                }
                db.set(key, json.dumps(previous))
                before = len(peers.mcp_calls)
                response = execute(*approved("gmail", actor="synthetic-bob"))
                require(
                    len(peers.mcp_calls) == before,
                    "Unavailable authorization reached MCP",
                )
                if refresh == "transient":
                    require(
                        response.status_code == 422
                        and json.loads(db.get(key)) == previous,
                        "Transient refresh destroyed grant",
                    )
                else:
                    require(
                        response.status_code == 202
                        and response.json()["status"] == "oauth_required"
                        and not db.exists(key),
                        "Invalid grant did not request new consent",
                    )
                    state = response.json()["oauthState"]
                    require(
                        client.get(
                            base + "/auth/redirect",
                            params={"state": state, "error": "access_denied"},
                        ).status_code
                        == 200,
                        "Denied consent callback rejected",
                    )
            cases.append(
                "C07 transient refresh retains grant; invalid grant and denied consent fail closed"
            )

            # New consent is scoped to the user and service, with PKCE validated by the peer.
            body, auth = approved("calendar", actor="synthetic-bob")
            response = execute(body, auth)
            require(
                response.status_code == 202,
                "Missing grant did not defer execution for OAuth",
            )
            result = response.json()
            url = parse_qs(urlparse(result["authUrl"]).query)
            require(
                url["resource"] == ["https://calendarmcp.googleapis.com/mcp"]
                and url["scope"] == ["synthetic.read synthetic.write"]
                and url["access_type"] == ["offline"]
                and url["code_challenge_method"] == ["S256"],
                "OAuth request scope or PKCE changed",
            )
            require(
                client.get(
                    base + "/auth/redirect",
                    params={"state": "wrong", "code": "synthetic"},
                ).status_code
                == 400,
                "Unknown OAuth state accepted",
            )
            callback = {"state": result["oauthState"], "code": "synthetic-code"}
            require(
                client.get(base + "/auth/redirect", params=callback).status_code == 200,
                "Valid OAuth callback failed",
            )
            require(
                client.get(base + "/auth/redirect", params=callback).status_code == 400,
                "OAuth state reused",
            )
            deadline = time.monotonic() + 10
            while True:
                status = client.get(
                    base + "/executions/" + result["executionId"], headers=bob
                ).json()
                if status["status"] in ("completed", "failed"):
                    break
                require(time.monotonic() < deadline, "OAuth execution stuck")
                time.sleep(0.05)
            require(
                status["status"] == "completed", "OAuth operation failed after callback"
            )
            require(
                "Synthetic result 雪🌲" in status["result"]["content"],
                "OAuth completion discarded the approved result",
            )
            token_call = next(
                c
                for c in reversed(peers.token_calls)
                if c["grant_type"] == "authorization_code"
            )
            challenge = (
                base64.urlsafe_b64encode(
                    hashlib.sha256(token_call["code_verifier"].encode()).digest()
                )
                .decode()
                .rstrip("=")
            )
            require(url["code_challenge"] == [challenge], "PKCE verifier mismatch")
            require(
                not db.exists(grant_key(user, "calendar"))
                and db.exists(grant_key("synthetic-bob", "calendar")),
                "OAuth grant crossed users",
            )
            require(
                client.delete(
                    base + "/v1/google-workspace/connections/calendar", headers=bob
                ).json()["savedTokenDeleted"],
                "Connection reset did not delete grant",
            )
            require(
                db.exists(grant_key(user)),
                "Reset deleted a different user/service grant",
            )
            cases.append(
                "C07 callback single-use, PKCE, scopes, owner isolation and reset"
            )

            # A stale refresh owner cannot overwrite or release a successor's lease.
            key = grant_key(user, "calendar")
            db.set(
                key,
                json.dumps(
                    {
                        "version": 2,
                        "access_token": "old",
                        "refresh_token": "hold",
                        "expires_at": 0,
                    }
                ),
            )
            future = pool.submit(execute, *approved("calendar"))
            require(peers.token_waiting.wait(5), "Refresh barrier not reached")
            db.set(key + "/refresh-lock", "successor", ex=40)
            successor = {
                "version": 2,
                "access_token": "successor-access",
                "refresh_token": "successor-refresh",
                "expires_at": time.time() + 3600,
            }
            db.set(key, json.dumps(successor))
            peers.release_token.set()
            require(
                future.result().status_code == 422,
                "Stale refresh owner was allowed to write",
            )
            require(
                json.loads(db.get(key)) == successor
                and db.get(key + "/refresh-lock") == b"successor",
                "Stale refresh owner overwrote successor state",
            )
            db.delete(key + "/refresh-lock")
            cases.append("C07 refresh lease ownership fences writes and release")

            peers.call_waiting.clear()
            peers.call_disconnected.clear()
            body, auth = approved(args={"name": "synthetic shutdown", "fault": "wait"})
            future = pool.submit(execute, body, auth, second)
            require(peers.call_waiting.wait(5), "Shutdown barrier not reached")
            run(
                "docker",
                "stop",
                "-t",
                "5",
                fixture["second_container"],
                stdout=subprocess.DEVNULL,
            )
            response = future.result(timeout=5)
            require(
                response.status_code == 422 and response.json()["status"] == "failed",
                "Shutdown left an approved execution running",
            )
            require(
                peers.call_disconnected.wait(5), "Shutdown did not close MCP transport"
            )
            cases.append(
                "C04/C08/C15 SIGTERM terminates direct execution and preserves uncertainty"
            )

        # Fail closed when Redis rejects authorization reads; no tool side effect.
        body, auth = approved()
        before = len(peers.mcp_calls)
        db.execute_command("ACL", "SETUSER", "backend", "-@all")
        try:
            require(
                execute(body, auth).status_code == 500,
                "Redis outage did not reject approval",
            )
            require(len(peers.mcp_calls) == before, "Redis outage dispatched mutation")
        finally:
            db.execute_command(
                "ACL", "SETUSER", "backend", "+@all", "-@dangerous", "+info"
            )
        cases.append("C08 Redis authorization failures fail closed")

        baseline_store("read", {**record, "token": legacy_credential})
        cases.append(
            "C07/C08/C16 baseline writes grants and approvals; rollback reads Rust grants"
        )
        logs = (fixture["root"] / "backend.log").read_text() + (
            fixture["root"] / "second.log"
        ).read_text()
        for secret in (
            "SYNTHETIC_PRIVATE_CLIENT_SECRET",
            "SYNTHETIC_PRIVATE_ARGUMENT",
            "synthetic-access-",
            "synthetic-rotated-refresh",
            "synthetic-alice",
            "synthetic-bob",
        ):
            require(secret not in logs, "Content leaked to application telemetry")
        cases.append("C14 content-free logs despite trace directives for dependencies")
        return {
            "image": image,
            "image_id": run(
                "docker",
                "image",
                "inspect",
                image,
                "--format",
                "{{.Id}}",
                capture_output=True,
                text=True,
            ).stdout.strip(),
            "rollback_image": rollback_image,
            "config_sha256": hashlib.sha256(
                (fixture["root"] / "config.yaml").read_bytes()
            ).hexdigest(),
            "cases": cases,
            "mcp_dispatches": len(peers.mcp_calls),
            "token_exchanges": len(peers.token_calls),
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--rollback-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    result = check(args.image, args.redis_image, args.rollback_image)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, indent=2) + "\n")
    print(
        f"P2 authorization image contracts passed: {len(result['cases'])} case groups"
    )


if __name__ == "__main__":
    main()
