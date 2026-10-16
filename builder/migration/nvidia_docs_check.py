#!/usr/bin/env python3
"""Compare NVIDIA docs against real Python/Rust MCP clients and scripted HTTP."""

import argparse
import contextlib
import copy
import hashlib
import json
import os
import select
import socket
import ssl
import subprocess  # nosec B404 - fixed openssl argv for ephemeral fixture certificates
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from image_check import require, run

ROOT = Path(__file__).resolve().parents[1]


@contextlib.contextmanager
def secure_peer(peer):
    """Serve verified TLS, including fixed public URLs through a local CONNECT proxy."""
    with tempfile.TemporaryDirectory(prefix="daedalus-docs-tls-") as directory:
        root = Path(directory)
        root.chmod(0o755)
        run(
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=Docs fixture CA",
            "-keyout",
            str(root / "ca.key"),
            "-out",
            str(root / "ca.pem"),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        run(
            "openssl",
            "req",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-subj",
            "/CN=docs.nvidia.com",
            "-addext",
            "subjectAltName=DNS:docs.nvidia.com,DNS:localhost",
            "-keyout",
            str(root / "server.key"),
            "-out",
            str(root / "server.csr"),
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
            str(root / "ca.pem"),
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
        (root / "ca.pem").chmod(0o644)
        secure = ThreadingHTTPServer(("127.0.0.1", 0), peer.handler())
        secure.daemon_threads = True
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(root / "server.crt", root / "server.key")
        secure.socket = context.wrap_socket(secure.socket, server_side=True)

        class Proxy(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_CONNECT(self):
                if self.path != "docs.nvidia.com:443":
                    peer.failures.append("Unexpected proxy target: " + self.path)
                    self.send_error(403)
                    return
                with socket.create_connection(
                    ("127.0.0.1", secure.server_port), timeout=5
                ) as upstream:
                    self.send_response(200)
                    self.end_headers()
                    sockets = [self.connection, upstream]
                    try:
                        while True:
                            readable, _, _ = select.select(sockets, [], [], 5)
                            if not readable:
                                return
                            for source in readable:
                                data = source.recv(65536)
                                if not data:
                                    return
                                (
                                    upstream
                                    if source is self.connection
                                    else self.connection
                                ).sendall(data)
                    except (ConnectionError, OSError):
                        pass

        proxy = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
        proxy.daemon_threads = True
        for server in [secure, proxy]:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            yield {
                "root": root,
                "endpoint": f"https://localhost:{secure.server_port}",
                "bad_endpoint": f"https://127.0.0.1:{secure.server_port}",
                "environment": {
                    "SSL_CERT_FILE": str(root / "ca.pem"),
                    "HTTPS_PROXY": f"http://127.0.0.1:{proxy.server_port}",
                    "NO_PROXY": "localhost,127.0.0.1",
                },
            }
        finally:
            for server in [proxy, secure]:
                server.shutdown()
                server.server_close()


def fixtures():
    return json.loads(
        (ROOT / "runtime/tests/fixtures/nvidia-docs.json").read_text(),
        object_hook=lambda obj: "".join(obj["$string_parts"])
        if list(obj) == ["$string_parts"]
        else obj,
    )


class DocsPeer:
    def __init__(self):
        self.settings = {}
        self.calls = []
        self.failures = []
        self.hold_started = threading.Event()
        self.hold_disconnected = threading.Event()
        self.hold_release = threading.Event()
        self.hold_finished = threading.Event()
        self.background_started = threading.Event()

    def reset(self, settings):
        self.settings, self.calls = copy.deepcopy(settings), []
        self.background_started.clear()

    def handler(self):
        peer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def reply(
                self,
                value,
                status=200,
                *,
                headers=None,
                raw=None,
                kind="application/json",
            ):
                body = raw if raw is not None else json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                try:
                    self.wfile.write(body)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
                    pass

            def record(self, body=None):
                if any(
                    self.headers.get(name)
                    for name in [
                        "Authorization",
                        "Cookie",
                        "x-user-id",
                        "x-daedalus-internal-token",
                    ]
                ):
                    peer.failures.append("Private headers reached public docs")
                peer.calls.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "body": body,
                        "session": self.headers.get("mcp-session-id"),
                        "protocol": self.headers.get("mcp-protocol-version"),
                    }
                )

            def do_GET(self):
                if self.path == "/__calls":
                    return self.reply(peer.calls)
                self.record()
                peer.background_started.set()
                return self.reply({}, 405)

            def do_DELETE(self):
                self.record()
                time.sleep(peer.settings.get("delete_delay", 0))
                return self.reply({}, peer.settings.get("delete_status", 200))

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path == "/__reset":
                    peer.reset(body)
                    return self.reply({"ok": True})
                self.record(body)
                method = body["method"]
                settings = copy.deepcopy(peer.settings)
                if settings.get("hold_method") == method:
                    peer.hold_started.set()
                    self.connection.settimeout(0.1)
                    try:
                        while not peer.hold_release.is_set():
                            try:
                                if not self.connection.recv(1):
                                    peer.hold_disconnected.set()
                                    break
                            except TimeoutError:
                                continue
                            except (ConnectionError, OSError):
                                peer.hold_disconnected.set()
                                break
                    finally:
                        self.close_connection = True
                        peer.hold_finished.set()
                    return
                if settings.get("delay_method") == method:
                    time.sleep(settings["delay"])
                if settings.get("fault_method") == method:
                    # Inject post-initialization faults after both independent
                    # transport tasks have reached the service. Otherwise an
                    # immediate disconnect can cancel the optional GET before
                    # it is observable, depending on scheduler timing.
                    if method != "initialize" and not peer.background_started.wait(5):
                        peer.failures.append("Background MCP connection did not start")
                    fault = settings["fault"]
                    if fault == "disconnect":
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.close_connection = True
                        return
                    if fault == "json":
                        return self.reply(None, raw=b"invalid JSON")
                    if fault == "type":
                        return self.reply({}, kind="text/plain")
                    if fault == "rpc":
                        return self.reply(
                            {
                                "jsonrpc": "2.0",
                                "id": body["id"],
                                "error": {
                                    "code": -32603,
                                    "message": "Synthetic failure",
                                },
                            }
                        )
                    return self.reply(
                        {},
                        fault,
                        headers={"Location": "/redirected"} if fault == 307 else None,
                    )
                if "id" not in body:
                    return self.reply({}, 202)
                if method == "initialize":
                    result = {
                        "protocolVersion": "2025-11-25",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "synthetic", "version": "1"},
                    }
                elif method == "tools/call":
                    result = settings.get(
                        "result",
                        {"content": [{"type": "text", "text": "Synthetic 雪🌲"}]},
                    )
                elif method == "tools/list":
                    tool = {"name": "searchDocs", "inputSchema": {"type": "object"}}
                    if "output_schema" in settings:
                        tool["outputSchema"] = settings["output_schema"]
                    result = {"tools": [] if settings.get("empty_tools") else [tool]}
                else:
                    peer.failures.append(method)
                    raise AssertionError(f"Unexpected NVIDIA docs method: {method}")
                response = {"jsonrpc": "2.0", "id": body["id"], "result": result}
                headers = (
                    {"mcp-session-id": "synthetic-session"}
                    if method == "initialize"
                    else {}
                )
                if settings.get("sse") and method == "tools/call":
                    return self.reply(
                        None,
                        headers=headers,
                        kind="text/event-stream",
                        raw=(
                            "event: message\ndata: " + json.dumps(response) + "\n\n"
                        ).encode(),
                    )
                return self.reply(response, headers=headers)

        return Handler


def scenarios(endpoint):
    cases = []

    def add(
        name,
        *,
        peer=None,
        product="dynamo",
        query=" \tSynthetic 雪🌲\u001c ",
        timeout=1,
    ):
        cases.append(
            {
                "name": name,
                "endpoint": endpoint,
                "timeout": timeout,
                "input": {"product": product, "query": query},
                "peer": peer or {},
            }
        )

    for product in ["dynamo", "openshell", "aistore", "aiperf", "nvcf", "dsx"]:
        add(product, product=product)
    add("blank-query", query=" \t\n\u001c\u0085\u2000")
    add("unicode-limit", query="雪" * 2000)
    add("empty-query", query="")
    add("invalid-product", product="Dynamo")
    for index, result in enumerate(fixtures()["results"]):
        add(f"result-{index}", peer={"result": result["input"]})
    add("sse", peer={"sse": True})
    for method in ["initialize", "tools/call", "tools/list"]:
        for fault in [307, 401, 404, 503, "json", "type", "rpc", "disconnect"]:
            add(f"{method}-{fault}", peer={"fault_method": method, "fault": fault})
        add(
            f"timeout-{method}",
            peer={"delay_method": method, "delay": 1.2},
            timeout=0.5,
        )
        cases[-1]["settle"] = 1.3
    add("delete-failure", peer={"delete_status": 503})
    add("timeout-delete", peer={"delete_delay": 1.2}, timeout=0.5)
    cases[-1]["settle"] = 1.3
    add("empty-catalogue", peer={"empty_tools": True})
    for name, schema, result in [
        (
            "valid",
            {"type": "object"},
            {"content": [], "structuredContent": {"ok": True}},
        ),
        ("missing", {"type": "object"}, {"content": []}),
        ("invalid", {"type": "object"}, {"content": [], "structuredContent": []}),
        ("schema-error", {"type": "invalid"}, {"content": [], "structuredContent": {}}),
        ("error-result", {"type": "object"}, {"content": [], "isError": True}),
    ]:
        add("output-" + name, peer={"output_schema": schema, "result": result})
    return cases


def normalized(observation):
    result = copy.deepcopy(observation)
    # The independent server SSE GET can race with the first tools/call POST.
    # Keep its complete request and multiplicity while comparing RPC order.
    background = [call for call in result["calls"] if call["method"] == "GET"]
    result["calls"] = [
        call for call in result["calls"] if call["method"] != "GET"
    ] + background
    for call in result["calls"]:
        if isinstance(call["body"], dict):
            call["body"].pop("id", None)
    return result


def main(args):
    peer = DocsPeer()
    server = ThreadingHTTPServer(("127.0.0.1", 0), peer.handler())
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    endpoint = f"http://127.0.0.1:{server.server_port}"
    try:
        with secure_peer(peer) as secure, tempfile.TemporaryDirectory(
            prefix="daedalus-nvidia-docs-"
        ) as directory:
            root = Path(directory)
            root.chmod(0o777)
            cases = scenarios(endpoint)
            for label, target in [
                ("tls", secure["endpoint"]),
                ("tls-bad-identity", secure["bad_endpoint"]),
            ]:
                cases.append(
                    {
                        **copy.deepcopy(cases[0]),
                        "name": label,
                        "endpoint": target,
                        "control": endpoint,
                    }
                )
            for case in cases[:6]:
                cases.append(
                    {
                        **copy.deepcopy(case),
                        "name": "fixed-url-" + case["name"],
                        "fixed_endpoints": True,
                    }
                )
            if args.case:
                selected = set(args.case)
                cases = [case for case in cases if case["name"] in selected]
                require(
                    {case["name"] for case in cases} == selected,
                    "Unknown NVIDIA docs case",
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
                "-v",
                f"{root}:/fixture",
                "-v",
                f"{ROOT / 'migration'}:/migration:ro",
                "-v",
                f"{secure['root']}:{secure['root']}:ro",
                *[
                    item
                    for key, value in secure["environment"].items()
                    for item in ["-e", f"{key}={value}"]
                ],
                "-e",
                "PYTHONPATH=/workspace",
                "--entrypoint",
                "/workspace/.venv/bin/python",
                args.python_image,
                "/migration/nvidia_docs_baseline.py",
                "--input",
                "/fixture/input.json",
                "--output",
                "/fixture/python.json",
            )
            expected = json.loads((root / "python.json").read_text())
            require(not peer.failures, f"Unexpected docs RPCs: {peer.failures}")
            report = {
                "status": "captured-python-nvidia-docs",
                "cases": expected,
                "image": run(
                    "docker",
                    "image",
                    "inspect",
                    args.python_image,
                    "--format",
                    "{{.Id}}",
                    capture_output=True,
                    text=True,
                ).stdout.strip(),
                "source_sha256": {
                    str(path.relative_to(ROOT)): hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                    for path in [
                        Path(__file__),
                        ROOT / "migration/nvidia_docs_baseline.py",
                        ROOT / "runtime/src/nvidia_docs.rs",
                        ROOT / "runtime/src/mcp_http.rs",
                        ROOT / "runtime/resources/nvidia-docs.json",
                        ROOT / "runtime/tests/fixtures/nvidia-docs.json",
                    ]
                },
            }
            args.report.parent.mkdir(parents=True, exist_ok=True)
            if not args.capture_only:
                run(
                    "cargo",
                    "test",
                    "--locked",
                    "nvidia_docs::actual_docs",
                    "--",
                    "--ignored",
                    "--nocapture",
                    cwd=ROOT / "runtime",
                    env={
                        **os.environ,
                        **secure["environment"],
                        "DAEDALUS_DOCS_INPUT": str(root / "input.json"),
                        "DAEDALUS_DOCS_OUTPUT": str(root / "rust.json"),
                    },
                )
                actual = json.loads((root / "rust.json").read_text())
                report["native"] = actual
                report["status"] = "pending-nvidia-docs-service-comparison"
                args.report.write_text(
                    json.dumps(report, indent=2, ensure_ascii=True) + "\n"
                )
                require(not peer.failures, f"Unexpected docs RPCs: {peer.failures}")
                require(
                    len(actual) == len(expected), "Missing NVIDIA docs observations"
                )
                for python, rust in zip(expected, actual, strict=True):
                    require(
                        normalized(python) == normalized(rust),
                        f"NVIDIA docs mismatch: {python['name']}\n{python}\n{rust}",
                    )
                report["status"] = "passed-nvidia-docs-services"
            args.report.write_text(
                json.dumps(report, indent=2, ensure_ascii=True) + "\n"
            )
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--case", action="append", default=[])
    parser.add_argument("--capture-only", action="store_true")
    main(parser.parse_args())
