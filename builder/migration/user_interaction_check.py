#!/usr/bin/env python3
"""Compare memory deletion against actual TLS Redis and scripted Hindsight."""

import argparse
import copy
import hashlib
import json
import os
import select
import time
from pathlib import Path

from image_check import environment, require, run
from memory_api_check import MemoryApiPeers, bank, digest
from nvidia_docs_check import secure_peer

ROOT = Path(__file__).resolve().parents[1]
USER = "synthetic-alice"
OTHER = "synthetic-bob"
TOKEN = "synthetic-approval"  # nosec B105 - disposable fixture approval


def approval_key(user=USER):
    return "approval:" + hashlib.sha256(user.encode()).hexdigest()[:16] + ":" + TOKEN


def cache_keys(user):
    return [
        "daedalus:memory:bootstrap:" + digest("v1", bank(user)),
        "daedalus:memory:session:v1:" + digest(bank(user)) + ":synthetic-session",
        "daedalus:memory:session-lock:v1:" + digest(bank(user)) + ":synthetic-session",
    ]


class InteractionPeers(MemoryApiPeers):
    def __init__(self):
        super().__init__()
        self.redis = None

    def reset(self, case):
        self.calls = []
        self.banks = {}
        self.fault = case.get("fault")
        self.fail_path = case.get("fail_path")
        self.paused = bool(case.get("pause_ms"))
        for user in [USER, OTHER]:
            self.state(bank(user))["pages"] = [
                {"id": "page-one", "kind": "folder"},
                {"id": "page/雪", "kind": "page"},
            ]
            for key in cache_keys(user):
                self.redis.setex(key, 300, "synthetic-cache")
            self.redis.delete(approval_key(user))
        payload = {
            "user_id": USER,
            "action_type": "delete_memory",
            "target": USER,
            "server_name": "",
            "tool_name": "",
            "arguments_sha256": "",
            "canonical_arguments": "",
            "created_at": 1,
            **case.get("binding", {}),
        }
        if not case.get("missing"):
            raw = case.get("raw", json.dumps(payload))
            if case.get("wrong_type"):
                self.redis.rpush(approval_key(), "synthetic-list")
            else:
                self.redis.setex(
                    approval_key(), 300, b"\xff" if case.get("invalid_utf8") else raw
                )
        if case.get("pause_ms"):
            self.redis.execute_command("CLIENT", "PAUSE", case["pause_ms"], "WRITE")

    def snapshot(self):
        if self.paused:
            # An acknowledged write waits for CLIENT PAUSE to end. Observe
            # whether a timed-out GETDEL committed later, not just its state
            # while the server still has writes paused.
            self.redis.setex("daedalus:interaction:barrier", 60, "complete")
            self.paused = False
        return {
            "calls": copy.deepcopy(self.calls),
            "banks": copy.deepcopy(self.banks),
            "token_exists": bool(self.redis.exists(approval_key())),
            "caches": {
                user: [bool(self.redis.exists(key)) for key in cache_keys(user)]
                for user in [USER, OTHER]
            },
        }

    def handler(self):
        peer = self

        class Handler(super().handler()):
            def wait_for_disconnect(self, closed, release=None):
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if release and release.is_set():
                        return False
                    readable, _, _ = select.select([self.connection], [], [], 0.05)
                    if readable:
                        try:
                            disconnected = not self.connection.recv(1)
                        except ConnectionError:
                            disconnected = True
                        if disconnected:
                            closed.set()
                            self.close_connection = True
                            return True
                return False

            def do_DELETE(self):
                if peer.fault == "lost" and self.path.endswith("/memories"):
                    # The provider committed the mutation but lost its reply.
                    peer.state(bank(USER))["memories"] = []
                return super().do_DELETE()

            def do_POST(self):
                if self.path == "/__reset":
                    peer.reset(
                        json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    )
                    return self.reply({})
                return super().do_POST()

            def do_GET(self):
                if self.path == "/__state":
                    return self.reply(peer.snapshot())
                return super().do_GET()

        return Handler


def scenarios(headers, redis_url):
    cases = []

    def add(name, **fields):
        cases.append(
            {
                "name": name,
                "input": {
                    "operation": "delete_memory_guarded",
                    "approval_token": TOKEN,
                },
                "headers": headers,
                **fields,
            }
        )

    add("delete-and-replay", count=2)
    add("parallel-single-use", count=8, parallel=True)
    add(
        "confirm",
        input={
            "operation": "confirm_action",
            "action": "Remove synthetic memories",
            "reason": "Synthetic user request",
            "risks": "Synthetic consequence",
            "alternatives": "export|retain",
        },
    )
    add(
        "confirm-without-redis",
        input={
            "operation": "confirm_action",
            "action": "Synthetic action",
            "reason": "Synthetic reason",
        },
        config={"redis_url": "invalid"},
    )
    add(
        "blank-control",
        input={
            "operation": "confirm_action",
            "action": " \u001c",
            "reason": "Synthetic reason",
        },
    )
    add("missing-token", missing=True)
    add(
        "missing-user",
        headers={key: value for key, value in headers.items() if key != "x-user-id"},
    )
    add(
        "wrong-internal-token",
        headers={**headers, "x-daedalus-internal-token": "wrong"},
    )
    add("other-user", headers={**headers, "x-user-id": OTHER})
    add("disabled-operation", config={"enabled_operations": ["confirm_action"]})
    add("disabled-memory", env={"DAEDALUS_MEMORY_MODE": "disabled"}, count=2)
    for field in [
        "user_id",
        "action_type",
        "target",
        "server_name",
        "tool_name",
        "arguments_sha256",
    ]:
        add("binding-" + field, binding={field: "wrong"}, count=2)
    add("wildcard-target", binding={"target": "*"})
    for name, raw in [
        ("invalid-record", "invalid JSON"),
        ("empty-record", ""),
        ("list-record", "[]"),
        ("null-record", "null"),
    ]:
        add(name, raw=raw)
    add("typed-binding", binding={"target": [1]})
    add("invalid-utf8", invalid_utf8=True)
    add("wrong-redis-type", wrong_type=True)
    for name, fault, phase in [
        ("tree-failure", 503, "knowledge-base/tree"),
        ("invalid-tree", "bad_tree", "knowledge-base/tree"),
        ("delete-failure", 500, "memories"),
        ("node-failure", 500, "knowledge-base/nodes/page-one"),
        ("second-node-failure", 500, "knowledge-base/nodes/page%2F%E9%9B%AA"),
        ("lost-delete-reply", "lost", "memories"),
        ("redirect", 307, "memories"),
    ]:
        add(name, fault=fault, fail_path=phase, count=2)
    add("missing-hindsight-key", env={"HINDSIGHT_API_KEY": ""})
    add("invalid-redis-url", config={"redis_url": "redis://localhost:invalid"})
    add(
        "wrong-redis-password",
        config={
            "redis_url": redis_url.replace("synthetic-backend", "incorrect-password")
        },
    )
    add(
        "denied-consumption",
        config={
            "redis_url": redis_url.replace(
                "backend:synthetic-backend", "fixture-reader:synthetic-reader"
            )
        },
    )
    add(
        "cache-failure",
        config={"redis_url": redis_url},
        env={
            "REDIS_URL": redis_url.replace(
                "backend:synthetic-backend", "fixture-reader:synthetic-reader"
            )
        },
    )
    for name, query, pause_ms in [
        ("redis-timeout-default", "", 1600),
        ("redis-timeout-invalid", "socket_timeout=bad", 0),
        ("redis-timeout-negative", "socket_timeout=-1", 0),
        ("redis-timeout-zero", "socket_timeout=0", 0),
        ("redis-timeout-nan", "socket_timeout=nan", 0),
        ("redis-timeout-infinity", "socket_timeout=inf", 0),
        ("redis-timeout-read", "socket_timeout=1&socket_connect_timeout=5", 1600),
        (
            "redis-timeout-retry",
            "socket_timeout=1&socket_connect_timeout=5&retry_on_timeout=true",
            1600,
        ),
        ("redis-timeout-first-value", "socket_timeout=1&socket_timeout=bad", 0),
    ]:
        add(name, config={"redis_url": redis_url + "&" + query}, pause_ms=pause_ms)
    return cases


def main(args):
    peer = InteractionPeers()
    with secure_peer(peer) as secure, environment(
        args.fixture_image, args.redis_image, minimal=True, memory=False, peers=peer
    ) as fixture:
        peer.redis = fixture["redis"]
        peer.redis.execute_command(
            "ACL",
            "SETUSER",
            "fixture-reader",
            "on",
            ">synthetic-reader",
            "~daedalus:*",
            "~approval:*",
            "+@read",
            "+client",
            "+ping",
        )
        root = fixture["root"]
        env = {**fixture["environment"], "DAEDALUS_MEMORY_MODE": "hindsight"}
        control = env["HINDSIGHT_API_URL"]
        env["HINDSIGHT_API_URL"] = secure["endpoint"]
        env["SSL_CERT_FILE"] = str(secure["root"] / "ca.pem")
        env["REDIS_URL"] = env["REDIS_URL"].replace(
            "/fixture/ca.crt", str(root / "ca.crt")
        )
        cases = scenarios(fixture["headers"], env["REDIS_URL"])
        cases.append(
            {
                **cases[0],
                "name": "hindsight-tls-identity",
                "env": {"HINDSIGHT_API_URL": secure["bad_endpoint"]},
            }
        )
        document = {"environment": env, "control": control, "cases": cases}
        (root / "interaction-input.json").write_text(json.dumps(document))
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
            "-e",
            "PYTHONHASHSEED=0",
            "-v",
            f"{ROOT / 'migration'}:/migration:ro",
            "-v",
            f"{root}:{root}",
            "-v",
            f"{secure['root']}:{secure['root']}:ro",
            "--entrypoint",
            "/workspace/.venv/bin/python",
            args.python_image,
            "/migration/user_interaction_baseline.py",
            "--input",
            str(root / "interaction-input.json"),
            "--output",
            str(root / "interaction-python.json"),
        )
        expected = json.loads((root / "interaction-python.json").read_text())
        report = {
            "status": "captured-user-interaction-services",
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
                    ROOT / "runtime/src/user_interaction.rs",
                    ROOT / "runtime/src/hindsight.rs",
                    ROOT / "runtime/src/storage.rs",
                    Path(__file__),
                    Path(__file__).with_name("user_interaction_baseline.py"),
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
                "user_interaction::actual_service",
                "--",
                "--ignored",
                "--nocapture",
                cwd=ROOT / "runtime",
                env={
                    **os.environ,
                    "DAEDALUS_INTERACTION_INPUT": str(root / "interaction-input.json"),
                    "DAEDALUS_INTERACTION_OUTPUT": str(root / "interaction-rust.json"),
                },
            )
            actual = json.loads((root / "interaction-rust.json").read_text())
            report["native"] = actual
            args.report.write_text(json.dumps(report, indent=2) + "\n")
            require(
                len(expected) == len(actual), "Missing memory-deletion observations"
            )
            for python, rust in zip(expected, actual, strict=True):
                require(
                    python == rust,
                    f"Memory deletion mismatch: {python['name']}\n{python}\n{rust}",
                )
            report["status"] = "passed-user-interaction-services"
            args.report.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["python-image", "fixture-image", "redis-image"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--capture-only", action="store_true")
    main(parser.parse_args())
