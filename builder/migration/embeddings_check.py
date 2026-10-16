#!/usr/bin/env python3
"""Compare staged embeddings against the retained provider over HTTP and TLS."""

import argparse
import base64
import copy
import gzip
import hashlib
import json
import os
import socket
import ssl
import subprocess  # nosec B404 - fixed disposable fixture commands
import tempfile
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from image_check import run
from profile_import_check import expand

ROOT = Path(__file__).resolve().parents[1]


class Peers:
    def __init__(self):
        self.lock = threading.Lock()
        self.calls = []
        self.case = {}
        self.connections = {}
        self.barrier = None

    def handler(self):
        peers = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def reply(self, payload):
                body = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path not in ["/calls", "/__calls"]:
                    return self.respond(b"")
                with peers.lock:
                    calls = copy.deepcopy(peers.calls)
                    parallel = peers.case.get("parallel")
                if parallel:
                    # Concurrent arrival order is unspecified. Preserve the
                    # connection assignment while naming sockets by query order.
                    calls.sort(
                        key=lambda call: call["body"]["messages"][0]["content"][0][
                            "text"
                        ]
                    )
                    connections = {}
                    for call in calls:
                        call["connection"] = connections.setdefault(
                            call["connection"], len(connections) + 1
                        )
                self.reply(calls)

            def do_POST(self):
                if self.path != "/__reset":
                    with peers.lock:
                        stall = peers.case.get("stall_upload")
                    if stall:
                        # Prevent buffering the request in the receiving kernel;
                        # the caller must time out while sending its body.
                        self.connection.setsockopt(
                            socket.SOL_SOCKET, socket.SO_RCVBUF, 1024
                        )
                        return self.respond(b"")
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if self.path == "/__reset":
                    with peers.lock:
                        peers.case = json.loads(body)
                        peers.calls = []
                        peers.connections = {}
                        peers.barrier = (
                            threading.Barrier(len(peers.case["queries"]), timeout=5)
                            if peers.case.get("parallel")
                            else None
                        )
                    return self.reply({"ok": True})
                return self.respond(body)

            def respond(self, body):
                with peers.lock:
                    case = copy.deepcopy(peers.case)
                    connection = peers.connections.setdefault(
                        self.client_address, len(peers.connections) + 1
                    )
                    peers.calls.append(
                        {
                            "method": self.command,
                            "path": self.path,
                            "body": json.loads(body) if body else None,
                            "headers": {
                                k: self.headers[k]
                                for k in [
                                    "Accept",
                                    "Content-Type",
                                    "Authorization",
                                    "Accept-Encoding",
                                ]
                                if k in self.headers
                            },
                            "connection": connection,
                        }
                    )
                    attempt = len(peers.calls)
                    barrier = peers.barrier
                if case.get("stall_upload"):
                    time.sleep(case["stall_upload"])
                    self.close_connection = True
                    return
                if barrier is not None:
                    try:
                        barrier.wait()
                    except threading.BrokenBarrierError:
                        self.close_connection = True
                        return
                if case.get("lost") and attempt == 1:
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.close_connection = True
                    return
                response = (
                    base64.b64decode(case["body"])
                    if "body" in case
                    else json.dumps(
                        {"data": [{"embedding": [0.1, -0.0, True, "١.٢"]}]}
                    ).encode()
                )
                encoding = case.get("encoding")
                if encoding == "gzip":
                    response = gzip.compress(response)
                elif encoding == "multi-gzip":
                    middle = len(response) // 2
                    response = gzip.compress(response[:middle]) + gzip.compress(
                        response[middle:]
                    )
                elif encoding == "truncated-gzip":
                    response = gzip.compress(response)[:-8]
                elif encoding == "trailing-gzip":
                    response = gzip.compress(response) + b"invalid trailing member"
                elif encoding == "deflate":
                    response = zlib.compress(response)
                elif encoding == "raw-deflate":
                    response = zlib.compress(response)[2:-4]
                elif encoding == "broken-gzip":
                    response = b"not gzip"
                time.sleep(case.get("header_delay", 0))
                try:
                    redirect = case.get("redirect") and (
                        not case.get("redirect_once") or self.path.startswith("/rerank")
                    )
                    status = (
                        200
                        if case.get("redirect_once") and not redirect
                        else case.get("status", 200)
                    )
                    self.send_response(status)
                    self.send_header("Content-Length", str(len(response)))
                    content_type = case.get("content_type", "application/json")
                    if content_type is not None:
                        self.send_header("Content-Type", content_type)
                    if encoding:
                        self.send_header(
                            "Content-Encoding",
                            "deflate"
                            if encoding == "raw-deflate"
                            else "gzip"
                            if encoding
                            in [
                                "broken-gzip",
                                "multi-gzip",
                                "truncated-gzip",
                                "trailing-gzip",
                            ]
                            else encoding,
                        )
                    if redirect:
                        self.send_header(
                            "Location",
                            case["redirect"]
                            if isinstance(case["redirect"], str)
                            else "/unexpected-redirect",
                        )
                    self.end_headers()
                    chunk = case.get("chunk_size", len(response))
                    for at in range(0, len(response), chunk):
                        time.sleep(case.get("body_delay", 0))
                        self.wfile.write(response[at : at + chunk])
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass

        return Handler


def cases(plain, secure):
    results = []

    def add(name, *, config=None, **extra):
        results.append(
            {
                "name": name,
                "config": {
                    "base_url": plain,
                    "model_name": "synthetic-model",
                    "timeout_seconds": 2,
                    **(config or {}),
                },
                "queries": ["Synthetic 雪🌲 query", "Second query"],
                **extra,
            }
        )

    add("plain")
    add("explicit-v1", config={"base_url": plain + "/v1/"})
    add("explicit-endpoint", config={"base_url": plain + "/custom/embeddings"})
    add("query-suffix", config={"base_url": plain + "/custom?x=1"})
    add("truncate", config={"truncate_prompt_tokens": 5})
    add("token", config={"api_key": "synthetic-token"})
    add("token-whitespace", config={"api_key": " synthetic-token "})
    add("token-newline", config={"api_key": "synthetic\nvalue"})
    add("token-unicode", config={"api_key": "雪"})
    add("blank-model", config={"model_name": " "})
    add("validation", config={"max_concurrency": 0, "verify_ssl": "invalid"})
    add("invalid-url", config={"base_url": "invalid"})
    add("malformed-url", config={"base_url": "http://[invalid"})
    add("infinite-timeout", config={"timeout_seconds": "inf"})
    add("large-timeout", config={"timeout_seconds": 1e10})
    add("extreme-timeout", config={"timeout_seconds": 1e300})
    add("supported-large-timeout", config={"timeout_seconds": 9e9})
    add(
        "parallel-queries",
        config={"max_concurrency": 1},
        parallel=True,
        queries=[f"Parallel synthetic query {index}" for index in range(8)],
    )
    add("tls", config={"base_url": secure})
    add("tls-unverified", config={"base_url": secure, "verify_ssl": False})
    for encoding in ["gzip", "deflate", "raw-deflate"]:
        add(encoding, encoding=encoding)
    add("broken-gzip", encoding="broken-gzip")
    add("redirect", status=307, redirect=True)
    add("unauthorized", status=401)
    add("unavailable", status=503)
    add("invalid-json", body=base64.b64encode(b"not json").decode())
    add(
        "numeric-overflow",
        body=base64.b64encode(
            json.dumps({"data": [{"embedding": [10**400]}]}).encode()
        ).decode(),
    )
    add("lost-reply", lost=True)
    add("header-timeout", config={"timeout_seconds": 0.1}, header_delay=0.3)
    add("body-timeout", config={"timeout_seconds": 0.1}, body_delay=0.3)
    add(
        "chunked-read-budget",
        config={"timeout_seconds": 0.12},
        body_delay=0.04,
        chunk_size=5,
    )
    oracle = expand(
        json.loads((ROOT / "runtime/tests/fixtures/embeddings.json").read_text())
    )
    for item in oracle["compression"]:
        add(item["name"], encoding=item["encoding"], body=item["body"])
    return results


def main(args):
    class Server(ThreadingHTTPServer):
        request_queue_size = 128

    with tempfile.TemporaryDirectory(prefix="daedalus-embeddings-") as directory:
        root = Path(directory)
        root.chmod(0o755)
        quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
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
            "/CN=Embedding fixture CA",
            "-keyout",
            str(root / "ca.key"),
            "-out",
            str(root / "ca.pem"),
            **quiet,
        )
        run(
            "openssl",
            "req",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost,IP:127.0.0.1",
            "-keyout",
            str(root / "server.key"),
            "-out",
            str(root / "server.csr"),
            **quiet,
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
            str(root / "server.pem"),
            **quiet,
        )
        for path in root.iterdir():
            path.chmod(0o644)
        peers = Peers()
        plain = Server(("127.0.0.1", 0), peers.handler())
        secure = Server(("127.0.0.1", 0), peers.handler())
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(root / "server.pem", root / "server.key")
        secure.socket = context.wrap_socket(secure.socket, server_side=True)
        servers = [plain, secure]
        for server in servers:
            server.daemon_threads = True
            threading.Thread(target=server.serve_forever, daemon=True).start()
        control = f"http://127.0.0.1:{plain.server_port}"
        fixture = {
            "control": control,
            "cases": cases(control, f"https://localhost:{secure.server_port}"),
        }
        path = root / "fixture.json"
        path.write_text(json.dumps(fixture))
        try:
            run(
                "docker",
                "run",
                "--rm",
                "--network",
                "host",
                "-e",
                "PYTHONPATH=/workspace",
                "-e",
                f'SSL_CERT_FILE={root / "ca.pem"}',
                "-e",
                "NO_PROXY=localhost,127.0.0.1",
                "-v",
                f"{root}:{root}",
                "-v",
                f'{ROOT / "migration"}:/migration:ro',
                "--entrypoint",
                "/workspace/.venv/bin/python",
                args.python_image,
                "/migration/embeddings_baseline.py",
                "--input",
                str(path),
                "--output",
                str(root / "observed.json"),
            )
            expected = json.loads((root / "observed.json").read_text())
            for case, observation in zip(fixture["cases"], expected, strict=True):
                case["expected"] = observation
            path.write_text(json.dumps(fixture))
            args.report.parent.mkdir(parents=True, exist_ok=True)
            evidence = args.report.with_name(args.report.stem + "-cases.json")
            evidence.write_text(path.read_text())
            run(
                "cargo",
                "test",
                "--locked",
                "--manifest-path",
                str(ROOT / "runtime/Cargo.toml"),
                "embeddings::tests::actual_embedding_provider",
                "--",
                "--ignored",
                "--nocapture",
                env={
                    **os.environ,
                    "DAEDALUS_EMBEDDINGS_FIXTURE": str(path),
                    "SSL_CERT_FILE": str(root / "ca.pem"),
                    "NO_PROXY": "localhost,127.0.0.1",
                },
            )
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()
    sources = [
        Path(__file__),
        ROOT / "migration/embeddings_baseline.py",
        ROOT / "migration/export_embeddings.py",
        ROOT / "runtime/src/embeddings.rs",
        ROOT / "runtime/src/document_tools.rs",
        ROOT / "runtime/src/document_store.rs",
        ROOT / "runtime/src/document_codecs.rs",
        ROOT / "runtime/src/document_json.rs",
        ROOT / "runtime/src/memory_tools.rs",
        ROOT / "runtime/Cargo.toml",
        ROOT / "runtime/Cargo.lock",
        ROOT / "runtime/tests/fixtures/embeddings.json",
    ]
    args.report.write_text(
        json.dumps(
            {
                "status": "passed-staged-embeddings",
                "cases": len(fixture["cases"]),
                "query_results": sum(
                    len(case["expected"]["results"]) for case in fixture["cases"]
                ),
                "http_requests": sum(
                    len(case["expected"]["calls"]) for case in fixture["cases"]
                ),
                "evidence": str(evidence),
                "evidence_sha256": hashlib.sha256(evidence.read_bytes()).hexdigest(),
                "source_sha256": {
                    str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in sources
                },
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
                "native_registration": "pending",
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    main(parser.parse_args())
