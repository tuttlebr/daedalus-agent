#!/usr/bin/env python3
"""Collection metadata parity through real backend images and Milvus gRPC."""

import argparse
import contextlib
import copy
import hashlib
import json
import subprocess  # nosec B404 - fixed disposable fixture commands
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from image_check import environment, require, run
from runtime_http_check import free_port

ROOT = Path(__file__).resolve().parents[1]


@contextlib.contextmanager
def milvus_fixture(image, *, mutual_tls=False):
    with tempfile.TemporaryDirectory(prefix="daedalus-milvus-") as directory:
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
            "/CN=Milvus fixture CA",
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
        for path in root.iterdir():
            path.chmod(0o644)
        port, tls_port, control_port = free_port(), free_port(), free_port()
        mtls_port = free_port() if mutual_tls else None
        name = "daedalus-milvus-peer-" + uuid.uuid4().hex[:10]
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
            "-e",
            "PYTHONPATH=/workspace",
            "-v",
            f"{root}:/fixture",
            "-v",
            f"{ROOT / 'migration'}:/migration:ro",
            "--entrypoint",
            "/workspace/.venv/bin/python",
            image,
            "/migration/milvus_peer.py",
            "--port",
            str(port),
            "--tls-port",
            str(tls_port),
            "--control-port",
            str(control_port),
            "--certificate",
            "/fixture/server.crt",
            "--key",
            "/fixture/server.key",
            "--socket",
            "/fixture/milvus.sock",
        ]  # nosec B108 - private container tmpfs
        if mtls_port is not None:
            command.extend(
                ["--mtls-port", str(mtls_port), "--client-ca", "/fixture/ca.crt"]
            )
        with (root / "peer.log").open("w+") as log:
            process = subprocess.Popen(command, stdout=log, stderr=log)  # nosec B603
            try:
                with httpx.Client(
                    base_url=f"http://127.0.0.1:{control_port}",
                    timeout=10,
                    trust_env=False,
                ) as control:
                    until = time.monotonic() + 60
                    while True:
                        if process.poll() is not None:
                            raise RuntimeError(
                                "Milvus peer exited: "
                                + (root / "peer.log").read_text()[-2000:]
                            )
                        try:
                            if control.get("/health").is_success:
                                break
                        except httpx.TransportError:
                            pass
                        require(time.monotonic() < until, "Milvus peer did not start")
                        time.sleep(0.1)
                    yield {
                        "control": control,
                        "port": port,
                        "tls_port": tls_port,
                        "mtls_port": mtls_port,
                        "root": root,
                    }
            finally:
                run("docker", "stop", "-t", "1", name, check=False, **quiet)
                process.wait(timeout=10)


def normalize(calls, native):
    calls = copy.deepcopy(calls)
    for call in calls:
        if native:
            require(call["deadline"], "Native RPC omitted its deadline")
        call.pop("deadline")
        call.pop("cancelled")
        info = call["body"].get("client_info")
        if info is not None:
            require(
                info["sdk_type"] == ("Rust" if native else "Python"),
                "Wrong SDK performed the call",
            )
            require(
                bool(info["sdk_version"])
                and bool(info["host"])
                and bool(info["local_time"]),
                "Incomplete client registration",
            )
            for key in ["sdk_type", "sdk_version", "host", "local_time"]:
                info[key] = "<client>"
        metadata = call["metadata"]
        if "identifier" in metadata:
            require(metadata["identifier"].isdigit(), "Missing session identifier")
            metadata["identifier"] = "<session>"
        if "client-request-unixmsec" in metadata:
            require(
                metadata["client-request-unixmsec"].isdigit(),
                "Missing request timestamp",
            )
            metadata["client-request-unixmsec"] = "<timestamp>"
    return calls


def exercise(
    image,
    redis_image,
    peer,
    *,
    native=False,
    minimal=False,
    settings=None,
    transport="http",
):
    env = {
        "DAEDALUS_PREPARATION": "rust" if native else "python",
        "DAEDALUS_AUTHORIZATION": "rust" if native else "python",
        "MILVUS_URI": f"http://127.0.0.1:{peer['port']}",
        "MILVUS_USERNAME": "synthetic-user",
        "MILVUS_PASSWORD": "synthetic-password",
        "MILVUS_DATABASE": "synthetic-database",
        "MILVUS_METADATA_TIMEOUT_SECONDS": "0.5",
    }
    if transport == "tls":
        env["MILVUS_URI"] = f"https://localhost:{peer['tls_port']}"
        env["GRPC_DEFAULT_SSL_ROOTS_FILE_PATH"] = "/milvus-fixture/ca.crt"
    elif transport == "unix":
        env["MILVUS_URI"] = "unix:/milvus-fixture/milvus.sock"
    env.update(settings or {})
    records = []
    with environment(
        image,
        redis_image,
        memory=False,
        minimal=minimal,
        extra_env=lambda _: env,
        fixture_mounts=[(peer["root"], "/milvus-fixture")],
    ) as fixture:

        def request(
            label,
            scenario,
            *,
            headers=None,
            path="/v1/metadata/collections",
            method="GET",
        ):
            peer["control"].post("/reset", json=scenario).raise_for_status()
            response = fixture["client"].request(
                method,
                fixture["base"] + path,
                headers=fixture["headers"] if headers is None else headers,
            )
            calls = peer["control"].get("/calls").json()
            record = {
                "case": label,
                "status": response.status_code,
                "body": response.json()
                if response.content
                and "application/json" in response.headers.get("content-type", "")
                else response.text,
                "calls": normalize(calls, native),
                "headers": {
                    k: response.headers[k].replace(fixture["base"], "")
                    for k in ["content-type", "allow", "location"]
                    if k in response.headers
                },
            }
            records.append(record)
            if "location" in record["headers"]:
                # Python exposes its ephemeral loopback adapter origin; Axum
                # keeps the same route and query on the caller's public origin.
                redirect = urlsplit(record["headers"]["location"])
                require(
                    redirect.hostname in (None, "127.0.0.1"),
                    "Unexpected redirect origin",
                )
                record["headers"]["location"] = redirect.path + (
                    "?" + redirect.query if redirect.query else ""
                )
            return record

        if settings is not None or transport != "http":
            result = request("operator", {"collections": ["nvidia", "foreign_private"]})
            invalid_timeout = not env["MILVUS_METADATA_TIMEOUT_SECONDS"].strip()
            require(
                result["status"] == (503 if invalid_timeout else 200)
                and len(result["calls"]) == (0 if invalid_timeout else 3),
                "Operator configuration did not produce the intended service exchange",
            )
            return records
        for label, headers in [
            ("no-auth", {}),
            (
                "wrong-token",
                {**fixture["headers"], "x-daedalus-internal-token": "wrong"},
            ),
            (
                "no-user",
                {
                    "x-daedalus-internal-token": fixture["headers"][
                        "x-daedalus-internal-token"
                    ]
                },
            ),
        ]:
            result = request(label, {}, headers=headers)
            require(
                result["status"] == 401 and not result["calls"],
                "Unauthenticated metadata dispatched",
            )
        for names in [
            [],
            ["nvidia", "another_private"],
            ["nvidia", "vetpartner", "nvidia"],
        ]:
            result = request("inventory-" + str(len(names)), {"collections": names})
            require(
                result["status"] == 200 and len(result["calls"]) == 3,
                "Metadata did not perform its permission probe",
            )
            require(
                "another_private" not in json.dumps(result["body"]),
                "Private inventory leaked",
            )
        request(
            "second-user",
            {"collections": []},
            headers={**fixture["headers"], "x-user-id": "synthetic-bob"},
        )
        request("gzip", {"gzip": True, "collections": ["nvidia"]})
        for method in ["POST", "PUT", "DELETE", "HEAD"]:
            request("method-" + method, {}, method=method)
            request(
                "method-no-user-" + method,
                {},
                method=method,
                headers={
                    "x-daedalus-internal-token": fixture["headers"][
                        "x-daedalus-internal-token"
                    ]
                },
            )
        request(
            "slash-no-user",
            {},
            path="/v1/metadata/collections/",
            headers={
                "x-daedalus-internal-token": fixture["headers"][
                    "x-daedalus-internal-token"
                ]
            },
        )
        request("slash", {}, path="/v1/metadata/collections/?ignored=yes")
        request("query-ignored", {}, path="/v1/metadata/collections?user=forged")
        for method in ["Connect", "ShowCollections", "DescribeCollection"]:
            for code in [
                "UNAUTHENTICATED",
                "PERMISSION_DENIED",
                "UNIMPLEMENTED",
                "INVALID_ARGUMENT",
                "ALREADY_EXISTS",
                "RESOURCE_EXHAUSTED",
                "DEADLINE_EXCEEDED",
                "UNAVAILABLE",
                "INTERNAL",
                "UNKNOWN",
                "CANCELLED",
                "NOT_FOUND",
                "ABORTED",
                "OUT_OF_RANGE",
                "DATA_LOSS",
                "FAILED_PRECONDITION",
            ]:
                request(f"rpc-{method}-{code}", {"faults": {method: {"grpc": code}}})
            for status in [
                {"error_code": 1},
                {"code": 100},
                {"error_code": 4},
                {"error_code": 1, "reason": "can't find collection"},
                {"code": 8},
                {"error_code": 49},
                {"code": 7, "retriable": True},
            ]:
                request(
                    f"status-{method}-{status}",
                    {"faults": {method: {"application": status}}},
                )
        # The outer deadline must bound every RPC, including SDK registration.
        # Native requests cancel upstream work; the retained Connect omits a
        # gRPC deadline, so release it explicitly after recording the response.
        for method in ["Connect", "ShowCollections", "DescribeCollection"]:
            started = time.monotonic()
            result = request("timeout-" + method, {"delay": {method: 5}})
            require(result["status"] == 503, "Unbounded or successful timed-out RPC")
            require(time.monotonic() - started < 2, "Metadata exceeded its deadline")
            if native:
                until = time.monotonic() + 1
                while True:
                    calls = peer["control"].get("/calls").json()
                    if any(c["method"] == method and c["cancelled"] for c in calls):
                        break
                    require(time.monotonic() < until, "Timed-out RPC was not cancelled")
                    time.sleep(0.01)
            peer["control"].post("/release").raise_for_status()
            time.sleep(0.1)

        # A slow request's cleanup must never close another request's channel.
        peer["control"].post(
            "/reset", json={"delay": {"ShowCollections": [5, 0.35]}}
        ).raise_for_status()
        with ThreadPoolExecutor(max_workers=1) as pool:
            slow = pool.submit(
                fixture["client"].get,
                fixture["base"] + "/v1/metadata/collections",
                headers=fixture["headers"],
            )
            until = time.monotonic() + 2
            while not any(
                c["method"] == "ShowCollections"
                for c in peer["control"].get("/calls").json()
            ):
                require(time.monotonic() < until, "Slow request did not dispatch")
                time.sleep(0.01)
            time.sleep(0.25)
            fast = fixture["client"].get(
                fixture["base"] + "/v1/metadata/collections",
                headers={**fixture["headers"], "x-user-id": "synthetic-bob"},
            )
            require(fast.status_code == 200, "Owned Milvus requests interfered")
            require(
                slow.result(timeout=2).status_code == 503,
                "Slow request escaped deadline",
            )
        peer["control"].post("/release").raise_for_status()
        time.sleep(0.1)
        calls = peer["control"].get("/calls").json()
        sessions = {
            c["metadata"]["identifier"]
            for c in calls
            if c["method"] == "ShowCollections"
        }
        require(len(sessions) == 2, "Concurrent requests shared a Milvus session")
        records.append({"case": "owned-concurrent-requests", "slow": 503, "fast": 200})
        if minimal:
            run(
                "docker",
                "exec",
                fixture["container"],
                "sh",
                "-c",
                "! command -v python && ! command -v python3",
            )
    return records


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["baseline", "image", "full-image", "redis-image"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    with milvus_fixture(args.baseline) as peer:
        baseline = exercise(args.baseline, args.redis_image, peer)
        for image, native, minimal in [
            (args.full_image, False, False),
            (args.image, True, True),
            (args.full_image, True, False),
        ]:
            actual = exercise(
                image, args.redis_image, peer, native=native, minimal=minimal
            )
            for old, new in zip(baseline, actual, strict=True):
                require(old == new, f"Collection parity:\nexpected={old}\nactual={new}")
            print(
                f"Metadata profile passed: native={native}, minimal={minimal}, cases={len(actual)}",
                flush=True,
            )
        operators = []
        for options in [
            {"transport": "tls"},
            {"settings": {"MILVUS_TOKEN": " synthetic-token ", "MILVUS_DATABASE": ""}},
            {
                "settings": {
                    "MILVUS_USERNAME": "",
                    "MILVUS_USER": " fallback ",
                    "MILVUS_DATABASE": " default ",
                }
            },
            {"settings": {"MILVUS_USERNAME": " ", "MILVUS_USER": "fallback"}},
            {"settings": {"MILVUS_METADATA_TIMEOUT_SECONDS": ""}},
            {"settings": {"MILVUS_METADATA_TIMEOUT_SECONDS": "NaN"}},
            {
                "settings": {
                    "MILVUS_URI": f"http://uri-user:uri-pass@127.0.0.1:{peer['port']}/uri-db",
                    "MILVUS_DATABASE": "",
                }
            },
            {
                "settings": {
                    "MILVUS_URI": f"grpc://127.0.0.1:{peer['port']}?x=/ignored",
                    "MILVUS_DATABASE": "default",
                }
            },
        ]:
            old = exercise(args.baseline, args.redis_image, peer, **options)
            new = exercise(
                args.image, args.redis_image, peer, native=True, minimal=True, **options
            )
            require(
                old == new,
                f"Metadata operator parity {options}:\nexpected={old}\nactual={new}",
            )
            operators.append({"options": options, "results": old})
        # PyMilvus accepts explicit Unix connection arguments, but its global
        # MILVUS_URI import parser rejects this form before the baseline starts.
        # Exercise this capability only in the Python-free native profile.
        unix = exercise(
            args.image,
            args.redis_image,
            peer,
            native=True,
            minimal=True,
            transport="unix",
        )
        require(
            unix[0]["status"] == 200 and len(unix[0]["calls"]) == 3,
            "Native Unix socket metadata failed",
        )
    report = {
        "status": "passed",
        "profiles": 4,
        "calls_per_profile": len(baseline),
        "operator_profiles": len(operators) * 2,
        "results": baseline,
        "operators": operators,
        "native_unix": unix,
        "fixture_sha256": hashlib.sha256(
            (ROOT / "runtime/tests/fixtures/collections.json").read_bytes()
        ).hexdigest(),
        "images": {
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
            for image in [args.baseline, args.image, args.full_image, args.redis_image]
        },
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(
        f"Collection metadata: {len(baseline)} HTTP cases/profile; four profiles and {len(operators) * 2} operator profiles passed."
    )
