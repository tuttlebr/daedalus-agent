"""Compare real public DNS/TLS transport in a disposable, networkless namespace."""

import argparse
import base64
import hashlib
import json
import os
import shutil
import subprocess  # nosec B404
import tempfile
import time
import uuid
from pathlib import Path

from image_check import require, run

ROOT = Path(__file__).resolve().parents[1]
PYTHON = "/workspace/.venv/bin/python"


def certificate(root):
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
        "/CN=Synthetic public fixture CA",
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
        "/CN=api.weather.gov",
        "-addext",
        "subjectAltName=DNS:api.weather.gov",
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
        str(root / "server.crt"),
        **quiet,
    )
    (root / "roots.pem").write_bytes(
        (ROOT / "runtime/resources/public-ca.pem").read_bytes()
        + (root / "ca.pem").read_bytes()
    )


def scenarios():
    base = "https://api.weather.gov"
    headers = {
        "User-Agent": "daedalus-public-fixture/1.0",
        "Accept": "application/geo+json",
        "Cookie": "synthetic=must-not-leak",
        "Authorization": "Bearer synthetic-must-not-leak",
    }
    cases = []

    def case(name, urls=None, **values):
        cases.append(
            {"name": name, "headers": headers, "urls": urls or [base + "/ok"], **values}
        )

    case(
        "verified_tls_anonymous_pool",
        [base + "/ok", base + "/second"],
        responses={"/ok": {"headers": {"Set-Cookie": "ambient=must-not-leak; Path=/"}}},
    )
    case("plain_public_http", ["http://api.weather.gov/ok"])
    case("ignore_proxy_and_ca_environment")
    case("untrusted_certificate_ignores_ambient_ca", trusted=False)
    case("mixed_private_answers", dns=[["8.8.8.8", "127.0.0.1"]])
    case("private_answers", dns=[["127.0.0.1"]])
    case("link_local_answers", dns=[["169.254.169.254"]])
    case("shared_carrier_answers", dns=[["100.64.0.1"]])
    case("mixed_ipv6_answers", dns=[["8.8.8.8", "::1"]])
    case("unresolved_hostname", dns=[[]])
    case("dns_rebinding", dns=[["8.8.8.8"], ["127.0.0.1"]])
    case(
        "pool_rebinding",
        [base + "/ok", base + "/second"],
        dns=[["8.8.8.8"], ["8.8.8.8"], ["127.0.0.1"]],
    )
    case("tls_hostname_mismatch", ["https://other.weather.test/ok"])
    case("literal_loopback", ["http://127.0.0.1/ok"])
    case("literal_link_local", ["http://169.254.169.254/ok"])
    case("literal_ipv6_loopback", ["http://[::1]/ok"])
    case("url_credentials", ["https://user:synthetic@api.weather.gov/ok"])
    case(
        "redirect_not_automatic",
        responses={
            "/ok": {"status": 302, "headers": {"Location": "http://127.0.0.1/secret"}}
        },
    )
    case("error_status_returned", responses={"/ok": {"status": 503}})
    case(
        "invalid_redirect_relative_path",
        [base + "/ok", base + "/ok"],
        responses={"/ok": {"status": 302, "headers": {"Location": "https:relative"}}},
    )
    for encoding in ["gzip", "br", "identity, identity"]:
        case(
            "encoding_" + encoding,
            responses={"/ok": {"headers": {"Content-Encoding": encoding}}},
        )
    case(
        "declared_oversize",
        responses={"/ok": {"headers": {"Content-Length": "4096"}, "close": True}},
    )
    for size in [0, 1024, 1025, 4096]:
        case(
            f"chunked_{size}",
            responses={
                "/ok": {"chunked": True, "body": base64.b64encode(b"x" * size).decode()}
            },
        )
    case(
        "truncated_response",
        responses={"/ok": {"headers": {"Content-Length": "100"}, "close": True}},
    )
    case("read_timeout", responses={"/ok": {"delay": 1.2}}, timeout=0.2)
    return cases


def main(
    args,
    cases=None,
    python_runner="public_http_baseline.py",
    rust_runner="public_http::tests::actual_public_http",
    sources=(),
    success="passed-native-public-http-services",
    prepare=None,
    prepare_case=None,
):
    compiled = run(
        "cargo",
        "test",
        "--locked",
        "--no-run",
        "--message-format=json",
        cwd=ROOT / "runtime",
        capture_output=True,
        text=True,
    )
    artifacts = [
        json.loads(line)
        for line in compiled.stdout.splitlines()
        if line.startswith("{")
    ]
    executable = next(
        item["executable"]
        for item in artifacts
        if item.get("executable") and item.get("profile", {}).get("test")
    )
    name = "daedalus-public-http-" + uuid.uuid4().hex[:12]
    cases = scenarios() if cases is None else cases
    if args.case:
        cases = [case for case in cases if case["name"] in args.case]
        require(len(cases) == len(set(args.case)), "Unknown public HTTP scenario")
    report = {"status": "running", "cases": []}
    with tempfile.TemporaryDirectory(prefix="daedalus-public-http-") as directory:
        root = Path(directory)
        root.chmod(0o755)
        certificate(root)
        if prepare:
            prepare(root)
        (root / "resolv.conf").write_text(
            "nameserver 127.0.0.1\noptions timeout:1 attempts:1\n"
        )
        (root / "ignored-ca.pem").write_text("This ambient CA file must not be read.\n")
        # Cargo may relink or remove its executable during another check. Keep
        # this fixture's runner independent of subsequent build-directory writes.
        snapshot = root / "runner"
        shutil.copy2(executable, snapshot)
        report["native_runner_sha256"] = hashlib.sha256(
            snapshot.read_bytes()
        ).hexdigest()
        try:
            run(
                "docker",
                "run",
                "--detach",
                "--name",
                name,
                "--network",
                "none",
                "--cap-add",
                "NET_ADMIN",
                "--user",
                "0",
                "-v",
                f"{ROOT / 'migration'}:/migration:ro",
                "-v",
                f"{root}:/fixture",
                "--mount",
                f"type=bind,src={snapshot},dst=/native/runner,readonly",
                "-v",
                f"{root / 'roots.pem'}:/native/runtime-public-ca.pem:ro",
                "-v",
                f"{root / 'roots.pem'}:/workspace/.venv/lib/python3.12/site-packages/certifi/cacert.pem:ro",
                "-v",
                f"{root / 'resolv.conf'}:/etc/resolv.conf:ro",
                "--entrypoint",
                PYTHON,
                args.python_image,
                "/migration/public_http_peer.py",
                "--root",
                "/fixture",
                capture_output=True,
            )

            def control(path, data=None):
                code = "import json,sys,urllib.request; data=None if len(sys.argv)<3 else sys.argv[2].encode(); print(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:9090'+sys.argv[1], data=data), timeout=5).read().decode())"
                result = run(
                    "docker",
                    "exec",
                    name,
                    PYTHON,
                    "-c",
                    code,
                    path,
                    *([] if data is None else [json.dumps(data)]),
                    capture_output=True,
                    text=True,
                )
                return json.loads(result.stdout)

            for _ in range(50):
                try:
                    control("/state")
                    break
                except subprocess.CalledProcessError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("Disposable public peer failed to start")
            common = [
                "docker",
                "exec",
                "--user",
                f"{os.getuid()}:{os.getgid()}",
                "-e",
                "PYTHONPATH=/workspace",
                "-e",
                "SSL_CERT_FILE=/fixture/ignored-ca.pem",
                "-e",
                "SSL_CERT_DIR=/fixture/missing-ca-directory",
                "-e",
                "HTTPS_PROXY=http://127.0.0.1:9",
                "-e",
                "HTTP_PROXY=http://127.0.0.1:9",
                "-e",
                "NO_PROXY=",
                "-e",
                "DAEDALUS_PUBLIC_HTTP_CASE=/fixture/input.json",
                "-e",
                "DAEDALUS_PUBLIC_HTTP_OUTPUT=/fixture/rust.json",
                name,
            ]
            for case in cases:
                roots = (ROOT / "runtime/resources/public-ca.pem").read_bytes()
                if case.get("trusted", True):
                    roots += (root / "ca.pem").read_bytes()
                (root / "roots.pem").write_bytes(roots)
                (root / "input.json").write_text(json.dumps(case))
                observations = {}
                for language, command in [
                    (
                        "python",
                        [
                            PYTHON,
                            "/migration/" + python_runner,
                            "--input",
                            "/fixture/input.json",
                            "--output",
                            "/fixture/python.json",
                        ],
                    ),
                    (
                        "rust",
                        [
                            "/native/runner",
                            rust_runner,
                            "--ignored",
                            "--exact",
                        ],
                    ),
                ]:
                    if prepare_case:
                        prepare_case(root, case)
                    control("/reset", case)
                    invocation = (
                        common
                        if case.get("trusted", True)
                        else [
                            *common[:-1],
                            "-e",
                            "SSL_CERT_FILE=/fixture/ca.pem",
                            name,
                        ]
                    )
                    if case.get("ambient_ca"):
                        invocation = [
                            *invocation[:-1],
                            "-e",
                            "SSL_CERT_FILE=" + case["ambient_ca"],
                            name,
                        ]
                    if case.get("environment"):
                        invocation = [
                            *invocation[:-1],
                            *[
                                argument
                                for key, value in case["environment"].items()
                                for argument in ("-e", key + "=" + value)
                            ],
                            name,
                        ]
                    result = run(
                        *invocation,
                        *command,
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    require(
                        result.returncode == 0,
                        f"{language} public HTTP runner failed: {result.stdout}\n{result.stderr}",
                    )
                    state = control("/state")
                    if version := case.get("expected_tls_version"):
                        require(
                            state["calls"]
                            and all(
                                call["tls_version"] == version
                                for call in state["calls"]
                            ),
                            "Certificate scenario did not negotiate the expected TLS version",
                        )
                    for _ in range(100):
                        if state["disconnected"] >= case.get(
                            "expected_disconnected", 0
                        ):
                            break
                        time.sleep(0.02)
                        state = control("/state")
                    require(
                        state["disconnected"] >= case.get("expected_disconnected", 0),
                        "Cancelled public request did not disconnect",
                    )
                    observations[language] = {
                        "results": json.loads((root / f"{language}.json").read_text()),
                        **state,
                    }
                expected, actual = observations["python"], observations["rust"]
                early_header_rejection = case.get("allow_early_header_rejection", False)
                if early_header_rejection:
                    require(
                        expected["results"]
                        == actual["results"]
                        == [{"error": "LocalProtocolError"}]
                        and expected["calls"] == actual["calls"] == [],
                        "Invalid headers must fail identically without sending an HTTP request",
                    )

                # libc can issue A/AAAA in different orders. Preserve full DNS
                # evidence in the report; compare results, requests and TLS SNI.
                def comparable(value):
                    value = {
                        key: value[key]
                        for key in ["results", "calls", "sni", "held", "disconnected"]
                    }
                    if case.get("unordered_calls"):
                        value["calls"] = sorted(
                            value["calls"],
                            key=lambda call: json.dumps(call, sort_keys=True),
                        )
                    # HTTPX connects before h11 rejects malformed headers. The
                    # native client rejects them before connecting. Keep the
                    # DNS/TLS evidence, but require identical errors and no HTTP
                    # requests instead of requiring an unused TLS handshake.
                    if early_header_rejection:
                        value.pop("sni")
                    return value

                matched = comparable(expected) == comparable(actual)
                report["cases"].append(
                    {
                        "name": case["name"],
                        "matched": matched,
                        **(
                            {
                                "allowed_difference": "TLS handshake omitted for invalid request header"
                            }
                            if early_header_rejection
                            else {}
                        ),
                        **observations,
                    }
                )
                print(case["name"], "passed" if matched else "MISMATCH", flush=True)
            report["status"] = (
                success
                if all(case["matched"] for case in report["cases"])
                else "failed"
            )
            report["python_image"] = run(
                "docker",
                "image",
                "inspect",
                args.python_image,
                "--format",
                "{{.Id}}",
                capture_output=True,
                text=True,
            ).stdout.strip()
            report["source_sha256"] = {
                str(path.relative_to(ROOT)): hashlib.sha256(
                    path.read_bytes()
                ).hexdigest()
                for path in [
                    Path(__file__),
                    Path(__file__).with_name("public_http_baseline.py"),
                    Path(__file__).with_name("public_http_peer.py"),
                    ROOT / "runtime/src/public_http.rs",
                    ROOT / "runtime/resources/public-http.json",
                    ROOT / "runtime/resources/public-ca.pem",
                    *sources,
                ]
            }
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, indent=2) + "\n")
            require(
                report["status"] != "failed",
                "Public HTTP compatibility mismatches; see report",
            )
        finally:
            run("docker", "rm", "--force", name, check=False, capture_output=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--case", action="append", default=[])
    main(parser.parse_args())
