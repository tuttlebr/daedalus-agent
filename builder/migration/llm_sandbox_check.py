#!/usr/bin/env python3
"""Compare sandbox discovery, execution and publication over actual HTTP/TLS."""

import argparse
import base64
import copy
import gzip
import hashlib
import json
import os
import select
import socket
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath

from export_llm_sandbox import artifact, capabilities, execution
from image_check import require, run
from nvidia_docs_check import secure_peer

ROOT = Path(__file__).resolve().parents[1]
PUBLISH = "/api/internal/sandboxArtifacts"


class SandboxPeer:
    def __init__(self):
        self.failures = []
        self.reset({})

    def reset(self, settings):
        self.settings = copy.deepcopy(settings)
        self.calls, self.counts, self.mutations = [], {}, []
        self.held = self.disconnected = False

    def handler(self):
        peer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def reply(self, body, status=200, headers=None):
                self.send_response(status)
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                    self.wfile.flush()
                except (ConnectionError, OSError):
                    pass

            def do_GET(self):
                if self.path == "/__state":
                    return self.reply(
                        json.dumps(
                            {
                                "calls": peer.calls,
                                "mutations": peer.mutations,
                                "held": peer.held,
                                "disconnected": peer.disconnected,
                            }
                        ).encode()
                    )
                return self.service(b"")

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if self.path == "/__reset":
                    peer.reset(json.loads(body))
                    return self.reply(b"{}")
                return self.service(body)

            def service(self, raw):
                expected = {
                    "/readyz": "GET",
                    "/v1/commands": "GET",
                    "/v1/execute": "POST",
                    PUBLISH: "POST",
                }
                if expected.get(self.path) != self.command:
                    peer.failures.append(
                        f"Unexpected request: {self.command} {self.path}"
                    )
                    return self.reply(b"{}", 404)
                call = {
                    "method": self.command,
                    "path": self.path,
                    "headers": {
                        name: self.headers.get(name)
                        for name in [
                            "authorization",
                            "content-type",
                            "content-length",
                            "cookie",
                            "x-daedalus-internal-token",
                            "x-daedalus-owner-id-b64",
                            "x-daedalus-conversation-id-b64",
                            "x-daedalus-artifact-path-b64",
                        ]
                    },
                }
                # Cookie jars may order distinct names differently. Preserve
                # exact values and duplicate-name order (path precedence), but
                # compare a unique-name Cookie header as the same set of pairs.
                cookie = call["headers"]["cookie"]
                if cookie:
                    pairs = cookie.split("; ")
                    if len({pair.split("=", 1)[0] for pair in pairs}) == len(pairs):
                        call["headers"]["cookie"] = "; ".join(sorted(pairs))
                if self.path == "/v1/execute":
                    call["body"] = json.loads(raw)
                    peer.mutations.append({"execution": copy.deepcopy(call["body"])})
                elif self.path == PUBLISH:
                    call["bytes"] = base64.b64encode(raw).decode()
                    peer.mutations.append({"publication": call["bytes"]})
                peer.calls.append(call)
                index = peer.counts.get(self.path, 0)
                peer.counts[self.path] = index + 1
                responses = peer.settings.get("responses", {}).get(self.path, [{}])
                response = responses[min(index, len(responses) - 1)]
                if response.get("hold"):
                    peer.held = True
                    deadline = time.monotonic() + 15
                    try:
                        while time.monotonic() < deadline:
                            readable, _, _ = select.select(
                                [self.connection], [], [], 0.05
                            )
                            if readable and not self.connection.recv(1):
                                peer.disconnected = True
                                break
                    except (ConnectionError, OSError):
                        peer.disconnected = True
                    self.close_connection = True
                    return
                if response.get("disconnect"):
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.close_connection = True
                    return
                if response.get("delay"):
                    time.sleep(response["delay"])
                if self.path == "/readyz":
                    payload = {"status": "ready"}
                elif self.path == "/v1/commands":
                    payload = capabilities()
                elif self.path == "/v1/execute":
                    payload = execution()
                else:
                    payload = artifact()
                    encoded = self.headers.get("x-daedalus-artifact-path-b64", "")
                    path = base64.urlsafe_b64decode(
                        encoded + "=" * (-len(encoded) % 4)
                    ).decode()
                    payload["artifact"].update(
                        filename=PurePosixPath(path).name, size=len(raw)
                    )
                payload = response.get("body", payload)
                body = response.get("raw", json.dumps(payload)).encode(
                    response.get("encoding", "utf-8")
                )
                if "raw_b64" in response:
                    body = base64.b64decode(response["raw_b64"])
                headers = response.get("headers", {}).copy()
                if response.get("gzip"):
                    body = gzip.compress(body)
                    headers["Content-Encoding"] = "gzip"
                self.reply(body, response.get("status", 200), headers)

        return Handler


def scenarios(endpoint, control, bad_endpoint):
    cases = []
    execute = {"operation": "execute", "argv": ["printf", "Synthetic 雪🌲"]}
    publish = {"operation": "publish_file", "file_path": "reports/report.txt"}

    def add(name, input=None, *, steps=None, config=None, responses=None, **extra):
        cases.append(
            {
                "name": name,
                "control": control,
                "peer": {"responses": responses or {}},
                "config": {
                    "_type": "llm_sandbox",
                    "base_url": endpoint,
                    "api_key": "synthetic-sandbox-key",
                    "retry_backoff_seconds": 0,
                    "artifact_publish_url": endpoint + PUBLISH,
                    "internal_api_token": "synthetic-internal-token",
                    **(config or {}),
                },
                "steps": steps if steps is not None else [{"input": input or execute}],
                **extra,
            }
        )

    add("missing-key", config={"api_key": ""})
    add("list", {"operation": "list_commands"})
    add("argv")
    add("shell", {"operation": "execute", "command": " \u001cprintf synthetic "})
    add(
        "environment",
        {
            **execute,
            "env_json": '{"SYNTHETIC":"雪🌲","A":""}',
            "working_directory": "./reports//work/",
        },
    )
    add("without-context", steps=[{"input": execute, "headers": {}}])
    add(
        "identity-isolation",
        steps=[
            {
                "input": execute,
                "headers": {"x-user-id": user, "x-conversation-id": conversation},
            }
            for user, conversation in [
                ("alice", "one"),
                ("bob", "one"),
                ("alice", "two"),
                ("雪🌲", "α/β"),
            ]
        ],
    )
    add("cache", steps=[{"input": execute}] * 2)
    add(
        "cache-expiry",
        config={"capability_cache_seconds": 1},
        steps=[{"input": execute}, {"input": execute, "sleep": 1.1}],
    )
    add(
        "force-refresh",
        steps=[
            {"input": execute},
            {"input": {"operation": "list_commands"}},
            {"input": execute},
        ],
    )
    add(
        "force-refresh-failure",
        steps=[
            {"input": execute},
            {"input": {"operation": "list_commands"}},
            {"input": execute},
        ],
        responses={"/readyz": [{}, {"status": 400}]},
    )
    for status in [400, 500]:
        add(
            f"cache-http-{status}",
            steps=[{"input": execute}] * 2,
            responses={
                "/v1/execute": [
                    {
                        "status": status,
                        "body": {
                            "requestId": "rejected",
                            "error": "Synthetic rejection",
                        },
                    },
                    {},
                ]
            },
        )
    add(
        "cookie-scope",
        steps=[{"input": execute}, {"input": execute}, {"input": publish}],
        responses={
            "/readyz": [{"headers": {"Set-Cookie": "ready=synthetic; Path=/"}}],
            "/v1/commands": [{"headers": {"Set-Cookie": "commands=synthetic; Path=/"}}],
        },
    )
    add(
        "write",
        {
            "operation": "write_file",
            "file_path": "./reports//report.txt",
            "file_content": "Synthetic file 雪🌲\n",
        },
    )
    add(
        "append",
        {
            "operation": "write_file",
            "file_path": "reports/report.txt",
            "file_content": "Synthetic appended 雪🌲\n",
            "append": True,
        },
    )
    add("read", {"operation": "read_file", "file_path": "reports/report.txt"})
    add("publish", publish)
    add(
        "publish-unicode-scope",
        steps=[
            {
                "input": publish,
                "headers": {"x-user-id": " 雪🌲 ", "x-conversation-id": " α/β "},
            }
        ],
    )
    binary = execution()
    binary["files"][0].update(contentBase64="AP+A", size=3)
    add(
        "read-binary",
        {"operation": "read_file", "file_path": "reports/report.txt"},
        responses={"/v1/execute": [{"body": binary}]},
    )
    add("publish-binary", publish, responses={"/v1/execute": [{"body": binary}]})
    for field, value in [
        ("truncated", True),
        ("missingFiles", ["reports/report.txt"]),
        ("files", []),
        ("files", [execution()["files"][0]] * 2),
    ]:
        data = execution()
        data[field] = value
        add(
            "publish-invalid-" + field + str(len(cases)),
            publish,
            responses={"/v1/execute": [{"body": data}]},
        )
    for field, value in [
        ("path", "unexpected.txt"),
        ("truncated", True),
        ("size", 1),
        ("contentBase64", "!!!!"),
    ]:
        data = execution()
        data["files"][0][field] = value
        add(
            "publish-invalid-file-" + field,
            publish,
            responses={"/v1/execute": [{"body": data}]},
        )
    add("publish-unconfigured", publish, config={"artifact_publish_url": ""})
    add("publish-no-token", publish, config={"internal_api_token": ""})
    add("file-no-context", steps=[{"input": publish, "headers": {}}])
    for name, change in [
        ("workspace-disabled", {"workspacePersistence": {"supported": False}}),
        ("true-missing", {"commands": ["printf"]}),
    ]:
        add(
            name,
            publish,
            responses={"/v1/commands": [{"body": {**capabilities(), **change}}]},
        )
    cap = capabilities()
    cap["limits"]["inputBytes"] = 3
    add(
        "write-byte-limit",
        {"operation": "write_file", "file_path": "a", "file_content": "🌲"},
        responses={"/v1/commands": [{"body": cap}]},
    )
    add("unknown-command", {"operation": "execute", "argv": ["unknown"]})
    add(
        "shell-disabled",
        {"operation": "execute", "command": "true"},
        responses={
            "/v1/commands": [{"body": {**capabilities(), "shellEnabled": False}}]
        },
    )
    add("command-byte-limit", config={"max_command_bytes": 3})
    add("timeout-limit", {**execute, "timeout_seconds": 61})
    add(
        "default-timeout-cap",
        config={"default_timeout_seconds": 40, "max_timeout_seconds": 20},
    )
    add("environment-hook", {**execute, "env_json": '{"LD_PRELOAD":"synthetic"}'})
    add("environment-json-error", {**execute, "env_json": '{"a":}'})
    for name, value in [
        ("surrogate-value", '{"SYNTHETIC":"\\ud800"}'),
        ("surrogate-pair", '{"SYNTHETIC":"\\ud800\\udfff"}'),
        ("surrogate-name", '{"\\ud800":"synthetic"}'),
        ("nonfinite", '{"SYNTHETIC":NaN}'),
        ("deep", '{"SYNTHETIC":' + "[" * 1100 + "0" + "]" * 1100 + "}"),
    ]:
        add("environment-" + name, {**execute, "env_json": value})
    for name, value in [
        ("unicode", "synthetic-雪🌲"),
        ("newline", "synthetic\nkey"),
        ("trailing-space", "synthetic "),
    ]:
        add("authorization-" + name, config={"api_key": value})
        add(
            "publisher-authorization-" + name,
            publish,
            config={"internal_api_token": value},
        )
    for path, field in [
        ("/v1/commands", "workspacePersistence"),
        ("/v1/execute", "workspacePersisted"),
    ]:
        data = capabilities() if path == "/v1/commands" else execution()
        data[field] = "NONFINITE"
        add(
            "nonfinite-" + field,
            responses={path: [{"raw": json.dumps(data).replace('"NONFINITE"', "NaN")}]},
        )
    for name, raw in [
        ("utf8-invalid", b'{"x":"\xff"}'),
        ("utf8-truncated", b'{"x":"\xe2\x98'),
        ("utf8-bom-invalid", b"\xef\xbb\xbf\xff"),
    ]:
        add(
            name,
            responses={"/v1/execute": [{"raw_b64": base64.b64encode(raw).decode()}]},
        )
    data = execution()
    data["stdout"] = "SURROGATE"
    add(
        "escaped-surrogate-response",
        responses={
            "/v1/execute": [
                {"raw": json.dumps(data).replace('"SURROGATE"', '"\\ud800"')}
            ]
        },
    )
    for field in ["files", "missingFiles"]:
        data = execution()
        del data[field]
        add(
            "publish-missing-" + field,
            publish,
            responses={"/v1/execute": [{"body": data}]},
        )
    for name, url in [
        ("absolute", "https://synthetic.invalid/download"),
        (
            "duplicate",
            "/api/session/documentStorage?documentId=synthetic-document&documentId=other&sessionId=synthetic-session",
        ),
    ]:
        data = artifact()
        data["artifact"].update(downloadUrl=url, size=27)
        add("publish-url-" + name, publish, responses={PUBLISH: [{"body": data}]})
    add("working-directory-escape", {**execute, "working_directory": "../outside"})
    add("file-path-escape", {"operation": "read_file", "file_path": "../outside"})
    add("schema-error", {"operation": "execute", "argv": [], "unexpected": True})
    for path in ["/readyz", "/v1/commands", "/v1/execute", PUBLISH]:
        for fault in ["gateway", "disconnect", "invalid-json", "redirect"]:
            response = {
                "gateway": {"status": 503},
                "disconnect": {"disconnect": True},
                "invalid-json": {"raw": '{"a":}'},
                "redirect": {
                    "status": 307,
                    "headers": {"Location": "/must-not-follow"},
                },
            }[fault]
            add(
                path.strip("/").replace("/", "-") + "-" + fault,
                publish if path == PUBLISH else execute,
                responses={path: [response, {}]},
            )
    for path in ["/v1/commands", "/v1/execute", PUBLISH]:
        add(
            "json-type-" + path.strip("/").replace("/", "-"),
            publish if path == PUBLISH else execute,
            responses={path: [{"body": []}]},
        )
    add("utf16-execution", responses={"/v1/execute": [{"encoding": "utf-16"}]})
    add("gzip-execution", responses={"/v1/execute": [{"gzip": True}]})
    add("bad-tls-host", config={"base_url": bad_endpoint})
    add(
        "discovery-timeout",
        config={"discovery_timeout_seconds": 1},
        responses={"/readyz": [{"hold": True}]},
    )
    add(
        "publisher-timeout",
        publish,
        config={"artifact_publish_timeout_seconds": 1},
        responses={PUBLISH: [{"hold": True}]},
    )
    add(
        "execution-timeout",
        {**execute, "timeout_seconds": 1},
        config={"request_timeout": 1},
        responses={"/v1/execute": [{"hold": True}]},
    )
    add(
        "cancel-discovery",
        steps=[{"input": execute, "cancel": True}, {"input": execute}],
        responses={"/readyz": [{"hold": True}, {}]},
    )
    add(
        "cancel-execution",
        steps=[{"input": execute, "cancel": True}, {"input": execute}],
        responses={"/v1/execute": [{"hold": True}, {}]},
    )
    add(
        "cancel-publication",
        steps=[{"input": publish, "cancel": True}, {"input": execute}],
        responses={PUBLISH: [{"hold": True}]},
    )
    return cases


def main(args):
    peer = SandboxPeer()
    server = ThreadingHTTPServer(("127.0.0.1", 0), peer.handler())
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    control = f"http://127.0.0.1:{server.server_port}"
    try:
        with tempfile.TemporaryDirectory(
            prefix="daedalus-sandbox-"
        ) as directory, secure_peer(peer) as secure:
            root = Path(directory)
            root.chmod(0o755)
            cases = scenarios(secure["endpoint"], control, secure["bad_endpoint"])
            if args.case:
                selected = set(args.case)
                cases = [case for case in cases if case["name"] in selected]
                require(
                    {case["name"] for case in cases} == selected, "Unknown sandbox case"
                )
            (root / "input.json").write_text(json.dumps(cases))
            run(
                "docker",
                "run",
                "--rm",
                "--network",
                "host",
                "--user",
                f"{os.getuid()}:{os.getgid()}",
                "-e",
                "PYTHONPATH=/workspace",
                *[
                    arg
                    for key, value in secure["environment"].items()
                    for arg in ["-e", f"{key}={value}"]
                ],
                "-v",
                f"{ROOT / 'migration'}:/migration:ro",
                "-v",
                f"{root}:/fixture",
                "-v",
                f"{secure['root']}:{secure['root']}:ro",
                "--entrypoint",
                "/workspace/.venv/bin/python",
                args.python_image,
                "/migration/llm_sandbox_baseline.py",
                "--input",
                "/fixture/input.json",
                "--output",
                "/fixture/python.json",
            )
            expected = json.loads((root / "python.json").read_text())
            report = {
                "status": "captured-sandbox-services",
                "cases": expected,
                "python_image": run(
                    "docker",
                    "image",
                    "inspect",
                    args.python_image,
                    "--format",
                    "{{.Id}}",
                    capture_output=True,
                    text=True,
                ).stdout.strip(),
            }
            if not args.capture_only:
                run(
                    "cargo",
                    "test",
                    "--locked",
                    "llm_sandbox::actual_service",
                    "--",
                    "--ignored",
                    "--nocapture",
                    cwd=ROOT / "runtime",
                    env={
                        **os.environ,
                        **secure["environment"],
                        "DAEDALUS_SANDBOX_INPUT": str(root / "input.json"),
                        "DAEDALUS_SANDBOX_OUTPUT": str(root / "rust.json"),
                    },
                )
                actual = json.loads((root / "rust.json").read_text())
                require(len(actual) == len(expected), "Missing sandbox observations")
                mismatches = [
                    {"python": python, "rust": rust}
                    for python, rust in zip(expected, actual, strict=True)
                    if python != rust
                ]
                if mismatches:
                    args.report.parent.mkdir(parents=True, exist_ok=True)
                    args.report.with_suffix(".failed.json").write_text(
                        json.dumps(mismatches, indent=2) + "\n"
                    )
                    require(
                        False,
                        "Sandbox mismatches: "
                        + ", ".join(item["python"]["name"] for item in mismatches),
                    )
                report.update(status="passed-native-sandbox-services", native=actual)
            require(not peer.failures, f"Unexpected sandbox requests: {peer.failures}")
            report["source_sha256"] = {
                str(path.relative_to(ROOT)): hashlib.sha256(
                    path.read_bytes()
                ).hexdigest()
                for path in [
                    Path(__file__),
                    Path(__file__).with_name("llm_sandbox_baseline.py"),
                    ROOT / "runtime/src/llm_sandbox.rs",
                ]
            }
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, indent=2) + "\n")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--capture-only", action="store_true")
    parser.add_argument("--case", action="append", default=[])
    main(parser.parse_args())
