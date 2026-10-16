#!/usr/bin/env python3
"""Compare real Python/Rust Perplexity clients against a local HTTP/TLS provider."""

import argparse
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
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from image_check import require, run
from nvidia_docs_check import secure_peer

ROOT = Path(__file__).resolve().parents[1]
RESULT = {
    "id": "synthetic-search",
    "results": [
        {
            "title": "Synthetic search source 雪",
            "url": "https://www.example.test/search-source",
            "snippet": "Synthetic source evidence.",
            "date": "2026-10-14",
            "last_updated": "2026-10-15",
        },
        {"title": "Second source", "link": "https://example.test/second"},
    ],
}


class SearchPeer:
    def __init__(self):
        self.failures = []
        self.hold_started = threading.Event()
        self.hold_disconnected = threading.Event()
        self.hold_release = threading.Event()
        self.hold_finished = threading.Event()
        self.reset({})

    def reset(self, settings):
        self.settings = copy.deepcopy(settings)
        self.calls = []

    def handler(self):
        peer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def reply(self, body, status=200, headers=None):
                self.send_response(status)
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                    self.wfile.flush()
                except (ConnectionError, OSError):
                    pass

            def do_GET(self):
                if self.path == "/__calls":
                    return self.reply(json.dumps(peer.calls).encode())
                peer.failures.append("Unexpected GET " + self.path)
                self.reply(b"{}", 404)

            def do_POST(self):
                raw = self.rfile.read(int(self.headers["Content-Length"]))
                body = json.loads(raw)
                if self.path == "/__reset":
                    peer.reset(body)
                    return self.reply(b"{}")
                if self.path != "/search":
                    peer.failures.append("Unexpected POST " + self.path)
                    return self.reply(b"{}", 404)
                peer.calls.append(
                    {
                        "path": self.path,
                        "body": body,
                        "authorization": self.headers.get("Authorization"),
                        "content_type": self.headers.get("Content-Type"),
                        "cookie": self.headers.get("Cookie"),
                    }
                )
                responses = peer.settings.get("responses", [{}])
                response = responses[min(len(peer.calls) - 1, len(responses) - 1)]
                if response.get("hold"):
                    peer.hold_started.set()
                    try:
                        while not peer.hold_release.is_set():
                            ready, _, _ = select.select([self.connection], [], [], 0.05)
                            if ready and not self.connection.recv(1):
                                peer.hold_disconnected.set()
                                break
                    except (ConnectionError, OSError):
                        peer.hold_disconnected.set()
                    finally:
                        peer.hold_finished.set()
                    self.close_connection = True
                    return
                if response.get("disconnect"):
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.close_connection = True
                    return
                data = response.get(
                    "raw", json.dumps(response.get("body", RESULT), ensure_ascii=False)
                )
                data = data.encode(response.get("charset", "utf-8"))
                headers = {
                    "Content-Type": "application/json",
                    **response.get("headers", {}),
                }
                encoding = response.get("encoding")
                if encoding:
                    headers["Content-Encoding"] = encoding
                    if encoding == "gzip":
                        data = gzip.compress(data)
                    elif encoding == "deflate":
                        data = zlib.compress(data)
                    elif encoding == "zstd":
                        import zstandard

                        data = zstandard.ZstdCompressor().compress(data)
                    elif encoding == "corrupt":
                        headers["Content-Encoding"] = "gzip"
                if response.get("delay"):
                    time.sleep(response["delay"])
                if response.get("chunks"):
                    self.send_response(response.get("status", 200))
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    size = max(1, len(data) // response["chunks"])
                    try:
                        for offset in range(0, len(data), size):
                            self.wfile.write(data[offset : offset + size])
                            self.wfile.flush()
                            time.sleep(response["chunk_delay"])
                    except (ConnectionError, OSError):
                        pass
                    return
                self.reply(data, response.get("status", 200), headers)

        return Handler


def scenarios(endpoint, control):
    cases = []

    def add(name, *, arguments=None, config=None, responses=None, **extra):
        cases.append(
            {
                "name": name,
                "input": {"query": "Synthetic 雪", **(arguments or {})},
                "config": config or {},
                "peer": {"responses": responses or [{}]},
                "endpoint": endpoint,
                "control": control,
                **extra,
            }
        )

    add("single-query")
    add(
        "multi-query-filters",
        arguments={
            "query": [" Synthetic one ", "Synthetic two"],
            "country": " us ",
            "search_context_size": "high",
            "search_language_filter": "EN, FR, ΟΣ, İ",
            "search_domain_filter": "example.test, -blocked.test",
            "search_recency_filter": "week",
        },
    )
    add(
        "exact-dates",
        arguments={
            "search_recency_filter": "day",
            "search_after_date_filter": "2026-10-01",
            "last_updated_before_filter": "10/2/2026",
            "max_results": 20,
        },
    )
    for name, arguments in [
        ("blank", {"query": " \u001c\u0085"}),
        ("duplicate", {"query": ["Straße", "STRASSE"]}),
        ("bad-country", {"country": "USA"}),
        ("bad-date", {"search_after_date_filter": "2025-02-29"}),
        ("empty-query", {"query": ""}),
        ("bad-argument", {"max_results": "2"}),
        ("lower-clamp", {"max_results": -1}),
        ("upper-clamp", {"max_results": 10**30}),
    ]:
        add(name, arguments=arguments)
    add("missing-key", config={"api_key": ""})
    add(
        "default-results",
        config={"default_max_results": 1, "default_search_context_size": "low"},
    )
    for status in [301, 400, 401, 403, 404, 429, 500]:
        add(
            f"status-{status}",
            responses=[
                {
                    "status": status,
                    "body": {"error": {"message": "Synthetic provider failure"}},
                    "headers": {"Location": "/redirect-must-not-run"},
                }
            ],
        )
    add(
        "quota",
        responses=[{"status": 429, "body": {"error": {"code": "insufficient_quota"}}}],
    )
    add("retry-success", responses=[{"status": 429}, {}])
    add(
        "retry-bound-zero",
        config={"rate_limit_max_retries": 0},
        responses=[{"status": 429}, {}],
    )
    add(
        "retry-bound-five",
        config={"rate_limit_max_retries": 5},
        responses=[{"status": 429}],
    )
    add(
        "retry-cookie",
        responses=[
            {
                "status": 429,
                "headers": {"Set-Cookie": "synthetic_session=one; Path=/; HttpOnly"},
            },
            {},
        ],
    )
    add(
        "retry-delay",
        config={"rate_limit_backoff_seconds": 0.1},
        responses=[{"status": 429}, {"status": 429}, {}],
        duration=[0.29, 2.5],
    )
    for encoding in ["gzip", "deflate", "zstd", "corrupt"]:
        add(encoding, responses=[{"encoding": encoding}])
    add("invalid-json", responses=[{"raw": "not JSON"}])
    add("wrong-root", responses=[{"body": []}])
    add("wrong-results", responses=[{"body": {"results": None}}])
    add("disconnect", responses=[{"disconnect": True}])
    add("read-timeout", config={"timeout": 0.2}, responses=[{"delay": 0.5}])
    add(
        "read-idle-timeout",
        config={"timeout": 0.3},
        responses=[{"chunks": 5, "chunk_delay": 0.1}],
        duration=[0.4, 3],
    )
    for timeout in [0, -1, "NaN", "inf"]:
        add("timeout-" + str(timeout), config={"timeout": timeout})
    for charset in ["utf-8-sig", "utf-16", "utf-32"]:
        add(charset, responses=[{"charset": charset}])
    return cases


def main(args):
    peer = SearchPeer()
    server = ThreadingHTTPServer(("127.0.0.1", 0), peer.handler())
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    endpoint = f"http://127.0.0.1:{server.server_port}"
    try:
        with tempfile.TemporaryDirectory(
            prefix="daedalus-perplexity-"
        ) as directory, secure_peer(peer) as secure:
            root = Path(directory)
            root.chmod(0o777)
            cases = scenarios(endpoint, endpoint)
            cases.extend(
                [
                    {**cases[0], "name": "tls", "endpoint": secure["endpoint"]},
                    {
                        **cases[0],
                        "name": "tls-identity",
                        "endpoint": secure["bad_endpoint"],
                    },
                ]
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
                "/migration/perplexity_search_baseline.py",
                "--input",
                "/fixture/input.json",
                "--output",
                "/fixture/python.json",
            )
            expected = json.loads((root / "python.json").read_text())
            report = {
                "status": "captured-perplexity-services",
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
                "source_sha256": {
                    str(path.relative_to(ROOT)): hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                    for path in [
                        Path(__file__),
                        ROOT / "migration/perplexity_search_baseline.py",
                        ROOT / "runtime/src/perplexity_search.rs",
                        ROOT / "runtime/resources/perplexity-search.json",
                        ROOT / "runtime/tests/fixtures/perplexity-search.json",
                    ]
                },
            }
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, indent=2) + "\n")
            if not args.capture_only:
                run(
                    "cargo",
                    "test",
                    "--locked",
                    "perplexity_search::actual_service",
                    "--",
                    "--ignored",
                    "--nocapture",
                    cwd=ROOT / "runtime",
                    env={
                        **os.environ,
                        **secure["environment"],
                        "DAEDALUS_SEARCH_INPUT": str(root / "input.json"),
                        "DAEDALUS_SEARCH_OUTPUT": str(root / "rust.json"),
                    },
                )
                actual = json.loads((root / "rust.json").read_text())
                report["native"] = actual
                args.report.write_text(json.dumps(report, indent=2) + "\n")
                require(len(expected) == len(actual), "Missing Perplexity observations")
                for python, rust in zip(expected, actual, strict=True):
                    require(
                        python == rust,
                        f"Perplexity mismatch: {python['name']}\n{python}\n{rust}",
                    )
                require(
                    not peer.failures, f"Unexpected search requests: {peer.failures}"
                )
                report["status"] = "passed-perplexity-services"
                args.report.write_text(json.dumps(report, indent=2) + "\n")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--capture-only", action="store_true")
    main(parser.parse_args())
