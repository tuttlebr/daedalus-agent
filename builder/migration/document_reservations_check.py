#!/usr/bin/env python3
"""Compare document reservations against real TLS Redis, races and lost replies.

The native adapter remains staged. This tests actual ledger I/O, not registered
tool calls; a built-image tool gate is still required before native activation.
"""

import argparse
import concurrent.futures
import contextlib
import hashlib
import json
import queue
import socket
import socketserver
import ssl
import subprocess  # nosec B404 - fixed argv, disposable synthetic fixtures
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlsplit

from document_runner_check import redis_fixture
from image_check import require, run

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "533fece18dd3605840a767d23c9e6fb2bbb8f0a33de6c247b28a0a8bb1b5b04a"


class Worker:
    def __init__(self, command):
        self.process = subprocess.Popen(  # nosec B603 - fixed fixture argv
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.lines = queue.Queue()
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        for line in self.process.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def call(self, request):
        self.process.stdin.write(json.dumps(request) + "\n")
        self.process.stdin.flush()
        while True:
            line = self.lines.get(timeout=20)
            require(line is not None, "Reservation worker exited before replying")
            if line.startswith("RESERVATION_SOURCE "):
                require(line.split()[1] == SOURCE, "Retained helper source changed")
            if line.startswith("RESERVATION_RESULT "):
                return json.loads(line.partition(" ")[2])

    def close(self):
        self.process.stdin.close()
        try:
            require(self.process.wait(timeout=15) == 0, "Reservation worker failed")
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait()
            self.process.stdout.close()
            self.process.stderr.close()


def frame(stream):
    line = stream.readline()
    if not line:
        raise EOFError
    prefix, value = line[:1], line[1:-2]
    if prefix == b"*":
        children = [frame(stream) for _ in range(int(value))]
        return line + b"".join(raw for raw, _ in children), [v for _, v in children]
    if prefix == b"$" and int(value) >= 0:
        body = stream.read(int(value) + 2)
        return line + body, body[:-2]
    return line, value


@contextlib.contextmanager
def fault_proxy(admin, url, ca, mode, key):
    """Forward real Redis commands; inject faults after confirmed server replies."""
    target = urlsplit(url)
    calls = []
    accepted = threading.Event()
    release = threading.Event()
    context = ssl.create_default_context(cafile=ca)

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            try:
                with socket.create_connection((target.hostname, target.port)) as raw:
                    with context.wrap_socket(raw, server_hostname="localhost") as conn:
                        with conn.makefile("rb") as upstream:
                            while True:
                                request, arguments = frame(self.rfile)
                                name = arguments[0].decode().upper()
                                calls.append(name)
                                if mode == "empty" and name == "SET":
                                    admin.set(key, "")
                                if mode == "expire" and name == "GET":
                                    admin.delete(key)
                                conn.sendall(request)
                                response, _ = frame(upstream)
                                if name == mode or mode == "cancel" and name == "SET":
                                    accepted.set()
                                    if mode == "cancel":
                                        release.wait(15)
                                    return
                                self.wfile.write(response)
                                self.wfile.flush()
            except (EOFError, OSError):
                return

    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield {
            "url": f"redis://ledger:synthetic-ledger@127.0.0.1:{server.server_address[1]}",
            "calls": calls,
            "accepted": accepted,
        }
    finally:
        release.set()
        server.shutdown()
        server.server_close()


def certificates(root):
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
        "/CN=Reservation fixture CA",
        "-keyout",
        str(root / "ca.key"),
        "-out",
        str(root / "ca.crt"),
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
        **quiet,
    )
    # The disposable Redis image runs without root; these are synthetic keys.
    for path in root.iterdir():
        path.chmod(0o644)


def executable():
    result = run(
        "cargo",
        "test",
        "--locked",
        "--manifest-path",
        str(ROOT / "runtime/Cargo.toml"),
        "--no-run",
        "--message-format=json",
        capture_output=True,
        text=True,
    )
    return next(
        item["executable"]
        for item in map(json.loads, result.stdout.splitlines())
        if item.get("executable") and item["profile"]["test"]
    )


def check(workers, admin, environment, root, binary):
    arguments = {
        "collection": "synthetic-collection",
        "documents": [
            {
                "documentId": "synthetic-document",
                "sessionId": "synthetic-session",
                "content_sha256": "a" * 64,
                "size": 18,
            }
        ],
        "chunkSize": 512,
        "chunkOverlap": 50,
    }

    def digest(text):
        return hashlib.sha256(text.encode()).hexdigest()

    argument_hash = digest(json.dumps(arguments, sort_keys=True, separators=(",", ":")))
    evidence = []

    def request(name, **extra):
        execution = "synthetic-reservation-" + name
        return {
            "operation": "reserve",
            "environment": environment,
            "user": "synthetic-user",
            "execution": execution,
            "arguments": arguments,
            "digest": argument_hash,
            "key": "daedalus:idempotency:v1:"
            + ":".join(
                [
                    digest("synthetic-user"),
                    digest(execution),
                    digest("ingest_user_documents"),
                    argument_hash,
                ]
            ),
            **extra,
        }

    def complete(worker, req, receipt, result="Synthetic receipt 雪 🌲"):
        return worker.call(
            {
                **req,
                "operation": "complete",
                "reservation": receipt["reservation"],
                "result": result,
            }
        )

    for first, second in [("python", "rust"), ("rust", "python")]:
        owner, reader = workers[first], workers[second]
        for label, result in [
            ("success", "Synthetic receipt 雪 🌲"),
            ("failure", "Error: synthetic document processing failed."),
        ]:
            req = request(first + "-" + label)
            acquired = owner.call(req)
            require(acquired["acquired"], "Fresh reservation was not acquired")
            require(604795 <= admin.ttl(req["key"]) <= 604800, "Wrong reservation TTL")
            require(not reader.call(req)["acquired"], "Cross-language duplicate owner")
            require(
                complete(reader, req, acquired, result) == {"completed": True},
                "Cross-language completion failed",
            )
            replay = owner.call(req)
            require(
                not replay["acquired"]
                and replay["reservation"]["stored_result"] == result,
                "Cross-language receipt replay differs",
            )
            require(
                complete(owner, req, acquired) == {"completed": False},
                "Completed receipt overwritten",
            )
            evidence.append(first + "-to-" + second + "-" + label)

    for language, worker in workers.items():
        for index, raw in enumerate(
            [
                b"broken",
                b"null",
                b"[]",
                b'"text"',
                b"123",
                b"\xff",
                b"",
                b"{}",
                b'{"state":null}',
                b'{"state":false}',
                b'{"state":12}',
                b'{"state":["pending"]}',
                b'{"state":"completed","result":null}',
                b'{"state":"completed","result":""}',
                b'{"state":"completed","result":42}',
            ]
        ):
            req = request("stored-" + str(index))
            admin.set(req["key"], raw)
            result = worker.call(req)
            if language == "python":
                evidence.append({"stored": index, "result": result})
            else:
                expected = next(
                    e["result"]
                    for e in evidence
                    if isinstance(e, dict) and e.get("stored") == index
                )
                require(result == expected, f"Stored receipt differs: {index}")
            require(admin.get(req["key"]) == raw, "Existing receipt changed")

        for value, ttl in [
            ("0", 3600),
            ("-9999999999999999999999", 3600),
            ("６_０_０_０", 6000),
            (" 7200 ", 7200),
            ("", None),
            ("1.0", None),
            ("9" * 30, None),
        ]:
            req = request(
                language + "-ttl-" + value,
                environment={**environment, "AUTONOMY_IDEMPOTENCY_TTL_SECONDS": value},
            )
            result = worker.call(req)
            if ttl is None:
                require(
                    result == {"error": True} and not admin.exists(req["key"]),
                    "Invalid TTL caused a write",
                )
            else:
                require(
                    result["acquired"] and ttl - 5 <= admin.ttl(req["key"]) <= ttl,
                    "TTL differs",
                )
            evidence.append(language + "-ttl-" + value)

        for name, url in [
            ("invalid-url", "invalid-redis-url"),
            ("missing-ca", environment["REDIS_URL"].replace("ca.crt", "missing.crt")),
            (
                "bad-password",
                environment["REDIS_URL"].replace("synthetic-ledger", "wrong-password"),
            ),
        ]:
            req = request(language + "-" + name, environment={"REDIS_URL": url})
            require(
                worker.call(req) == {"error": True} and not admin.exists(req["key"]),
                "Invalid Redis settings did not fail closed",
            )
            # No acquired owner means no completion I/O, even with bad settings.
            receipt = {
                "reservation": {
                    "key": req["key"],
                    "owner_token": None,
                    "state": "in_progress",
                    "stored_result": None,
                }
            }
            require(
                complete(worker, req, receipt) == {"completed": False},
                "Unowned completion unexpectedly opened Redis",
            )
            evidence.append(language + "-" + name)

        for denied in ["set", "get", "eval"]:
            req = request(language + "-denied-" + denied)
            receipt = worker.call(req) if denied == "eval" else None
            if denied == "get":
                admin.set(req["key"], '{"state":"in_progress"}')
            before = admin.get(req["key"])
            admin.execute_command("ACL", "SETUSER", "ledger", "-" + denied)
            try:
                result = complete(worker, req, receipt) if receipt else worker.call(req)
                require(
                    result == {"error": True},
                    "Denied Redis command did not fail closed",
                )
                require(
                    admin.get(req["key"]) == before,
                    "Denied command damaged the receipt",
                )
            finally:
                admin.execute_command("ACL", "SETUSER", "ledger", "+" + denied)
            evidence.append(language + "-denied-" + denied)

        for mutation in ["delete", "owner", "completed", "malformed"]:
            req = request(language + "-" + mutation)
            receipt = worker.call(req)
            if mutation == "delete":
                admin.delete(req["key"])
            else:
                admin.set(
                    req["key"],
                    {
                        "owner": '{"state":"in_progress","owner":"other-owner"}',
                        "completed": '{"state":"completed","result":"Earlier receipt"}',
                        "malformed": "broken",
                    }[mutation],
                )
            before = admin.get(req["key"])
            require(
                complete(worker, req, receipt)
                == (
                    {"error": True} if mutation == "malformed" else {"completed": False}
                ),
                "Completion fencing differs",
            )
            require(
                admin.get(req["key"]) == before,
                "Completion overwrote a lost reservation",
            )
            evidence.append(language + "-fence-" + mutation)

        for mode in ["SET", "EVAL", "expire", "empty"]:
            req = request(language + "-fault-" + mode)
            receipt = worker.call(req) if mode == "EVAL" else None
            if mode == "expire":
                admin.set(req["key"], '{"state":"in_progress"}')
            with fault_proxy(
                admin, environment["REDIS_URL"], str(root / "ca.crt"), mode, req["key"]
            ) as proxy:
                faulty = {**req, "environment": {"REDIS_URL": proxy["url"]}}
                result = (
                    complete(worker, faulty, receipt)
                    if receipt
                    else worker.call(faulty)
                )
                if mode in {"SET", "EVAL"}:
                    require(
                        proxy["accepted"].is_set() and result == {"error": True},
                        "Lost write reply was retried or accepted",
                    )
                    require(
                        proxy["calls"].count(mode) == 1, "Ambiguous mutation replayed"
                    )
                elif mode == "expire":
                    require(
                        result["acquired"] and proxy["calls"].count("SET") == 2,
                        "Expired reservation was not rechecked",
                    )
                else:
                    require(
                        not result["acquired"]
                        and result["reservation"]["state"] == "in_progress"
                        and proxy["calls"].count("SET") == 2,
                        "Empty record retry was not bounded",
                    )
            if mode in {"SET", "EVAL"}:
                replay = worker.call(req)
                require(
                    not replay["acquired"], "Lost reply allowed duplicate ownership"
                )
                require(
                    replay["reservation"]["state"]
                    == ("completed" if mode == "EVAL" else "in_progress"),
                    "Lost reply damaged stored state",
                )
            evidence.append(language + "-fault-" + mode)

    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        for iteration in range(8):
            req = request("race-" + str(iteration))
            barrier = threading.Barrier(2)

            def compete(worker):
                barrier.wait(timeout=10)
                return worker.call(req)

            results = list(pool.map(compete, workers.values()))
            require(
                sum(r["acquired"] for r in results) == 1,
                "Race produced multiple owners",
            )
            winner = next(r for r in results if r["acquired"])
            require(
                complete(workers["rust"], req, winner) == {"completed": True},
                "Race winner could not complete",
            )
            evidence.append("cross-language-race-" + str(iteration))

        req = request("cancelled-owner")
        with fault_proxy(
            admin, environment["REDIS_URL"], str(root / "ca.crt"), "cancel", req["key"]
        ) as proxy:
            abandoned = Worker(native_command(binary))
            pending = pool.submit(
                abandoned.call, {**req, "environment": {"REDIS_URL": proxy["url"]}}
            )
            try:
                require(
                    proxy["accepted"].wait(10),
                    "Cancelled reservation never reached Redis",
                )
                abandoned.process.kill()
                abandoned.process.wait()
                with contextlib.suppress(Exception):
                    pending.result(timeout=10)
            finally:
                for stream in [
                    abandoned.process.stdin,
                    abandoned.process.stdout,
                    abandoned.process.stderr,
                ]:
                    stream.close()
        require(
            not workers["python"].call(req)["acquired"],
            "Dead owner reservation was deleted",
        )
        evidence.append("process-death-after-set")
    return evidence


def native_command(binary):
    return [
        binary,
        "document_reservations::tests::actual_redis_reservations",
        "--exact",
        "--ignored",
        "--nocapture",
    ]


def main(args):
    binary = executable()
    with tempfile.TemporaryDirectory(prefix="daedalus-reservations-") as directory:
        root = Path(directory)
        root.chmod(0o755)
        certificates(root)
        with redis_fixture(root, args.redis_image) as (
            admin,
            url,
        ), contextlib.ExitStack() as stack:
            admin.execute_command(
                "ACL",
                "SETUSER",
                "ledger",
                "on",
                ">synthetic-ledger",
                "~daedalus:idempotency:v1:*",
                "+@connection",
                "+get",
                "+set",
                "+eval",
            )
            url = url.replace("backend:synthetic-backend", "ledger:synthetic-ledger")
            baseline = Worker(
                [
                    "docker",
                    "run",
                    "--rm",
                    "-i",
                    "--network",
                    "host",
                    "-v",
                    f"{root}:{root}:ro",
                    "-v",
                    f"{ROOT / 'migration'}:/migration:ro",
                    "--entrypoint",
                    "python",
                    args.python_image,
                    "/migration/document_reservations_baseline.py",
                ]
            )
            stack.callback(baseline.close)
            native = Worker(native_command(binary))
            stack.callback(native.close)
            evidence = check(
                {"python": baseline, "rust": native},
                admin,
                {"REDIS_URL": url},
                root,
                binary,
            )
    paths = [
        Path(__file__),
        ROOT / "migration/document_reservations_baseline.py",
        ROOT / "runtime/src/document_reservations.rs",
        ROOT / "runtime/src/storage.rs",
    ]
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(
            {
                "status": "passed-staged-ledger",
                "registered_tool_gate": "pending",
                "cases": evidence,
                "retained_helper_sha256": SOURCE,
                "source_sha256": {
                    str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in paths
                },
                "native_test_binary_sha256": hashlib.sha256(
                    Path(binary).read_bytes()
                ).hexdigest(),
                "image_ids": {
                    image: run(
                        "docker",
                        "image",
                        "inspect",
                        image,
                        "--format",
                        "{{.Id}}",
                        capture_output=True,
                        text=True,
                    ).stdout.strip()
                    for image in [args.python_image, args.redis_image]
                },
            },
            indent=2,
        )
        + "\n"
    )
    print(f"Document reservation ledger passed: {len(evidence)} cases")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-image", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    main(parser.parse_args())
