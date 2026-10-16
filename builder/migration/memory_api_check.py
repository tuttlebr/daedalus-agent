#!/usr/bin/env python3
"""Public memory API parity through real images, Hindsight HTTP and TLS/ACL Redis."""

import argparse
import copy
import hashlib
import json
import socket
import threading
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from image_check import MemoryPeers, environment, require, run

ROOT = Path(__file__).resolve().parents[1]
POLICY = json.loads((ROOT / "runtime/resources/memory-policy.json").read_text())
NAMESPACE = uuid.UUID("21b4c9b7-39a3-4c5e-8e31-66e2223e5040")


def digest(*parts):
    value = hashlib.sha256()
    for part in parts:
        value.update(part.encode())
        value.update(b"\0")
    return value.hexdigest()


def bank(user):
    return "du-" + str(uuid.uuid5(NAMESPACE, user))


class MemoryApiPeers(MemoryPeers):
    def __init__(self):
        super().__init__()
        self.calls = []
        self.banks = {}
        self.fault = None
        self.fail_path = None
        self.started = threading.Event()
        self.disconnected = threading.Event()
        self.release = threading.Event()

    def state(self, key):
        if key not in self.banks:
            self.banks[key] = {
                "overrides": {"retain_extraction_mode": "custom"},
                "pages": [],
                "memories": [
                    {
                        "id": "fact-1",
                        "text": "Synthetic original memory 雪🌲",
                        "fact_type": "world",
                        "document_id": "source-1",
                        "bank_id": key,
                        "nested": {"tenant_id": "private-tenant", "ok": True},
                    }
                ],
                "documents": [
                    {
                        "id": "source-1",
                        "content": "Synthetic source evidence",
                        "bank_id": key,
                    }
                ],
                "operations": {},
            }
        return self.banks[key]

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def send_response(self, code, message=None):
                super().send_response(code, message)
                if code == 307:
                    self.send_header(
                        "Location", "/v1/default/banks/forged-bank/memories"
                    )

            def dispatch(self):
                url = urlparse(self.path)
                if not url.path.startswith("/v1/default/banks/"):
                    return False
                bank_id, _, suffix = url.path.removeprefix(
                    "/v1/default/banks/"
                ).partition("/")
                n = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(n)) if n else None
                query = {
                    k: v[-1]
                    for k, v in parse_qs(url.query, keep_blank_values=True).items()
                }
                peers.calls.append(
                    {
                        "method": self.command,
                        "path": url.path,
                        "query": query,
                        "body": body,
                        "authorization": self.headers.get("Authorization"),
                    }
                )
                state = peers.state(bank_id)
                if peers.fault is not None and (
                    peers.fail_path is None or suffix == peers.fail_path
                ):
                    fault = peers.fault
                    if fault == "lost":
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.close_connection = True
                        return True
                    if fault == "block":
                        peers.started.set()
                        self.wait_for_disconnect(peers.disconnected, peers.release)
                        return True
                    if fault == "bad_tree":
                        self.reply({"roots": None})
                        return True
                    if fault == "invalid":
                        self.reply(["SYNTHETIC_PRIVATE_UPSTREAM"])
                        return True
                    if fault == 204:
                        self.send_response(204)
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return True
                    self.reply({"detail": "SYNTHETIC_PRIVATE_UPSTREAM"}, fault)
                    return True
                result = {}
                if suffix == "config":
                    if self.command == "PATCH":
                        state["overrides"].update(body["updates"])
                    result = {"overrides": state["overrides"]}
                elif suffix == "knowledge-base/tree":
                    result = {"roots": copy.deepcopy(state["pages"])}
                elif suffix == "knowledge-base/pages" and self.command == "POST":
                    page = {
                        "kind": "page",
                        "id": f"page-{len(state['pages'])+1}",
                        "name": body["name"],
                        "description": "Synthetic page",
                        "body": "Synthetic knowledge 雪🌲",
                        "markdown": "Synthetic markdown",
                        "bank_id": bank_id,
                    }
                    state["pages"].append(page)
                    result = page
                elif suffix.startswith("knowledge-base/pages/"):
                    result = next(
                        (
                            p
                            for p in state["pages"]
                            if p["id"] == unquote(suffix.rsplit("/", 1)[1])
                        ),
                        {},
                    )
                elif suffix.startswith("knowledge-base/nodes/"):
                    state["pages"] = [
                        p
                        for p in state["pages"]
                        if p["id"] != unquote(suffix.rsplit("/", 1)[1])
                    ]
                    result = {"deleted": True}
                elif suffix in ["memories/list", "documents"]:
                    items = state[
                        "memories" if suffix == "memories/list" else "documents"
                    ]
                    result = {
                        "items": items,
                        "total": len(items),
                        "limit": int(query["limit"]),
                        "offset": int(query["offset"]),
                        "bank_id": bank_id,
                    }
                elif suffix.startswith("documents/"):
                    key = unquote(suffix.rsplit("/", 1)[1])
                    result = next((d for d in state["documents"] if d["id"] == key), {})
                    if self.command == "DELETE":
                        state["documents"] = [
                            d for d in state["documents"] if d["id"] != key
                        ]
                        result = {"deleted": True, "tenant_id": "hidden"}
                elif suffix == "memories" and self.command == "DELETE":
                    result = {"deleted": len(state["memories"])}
                    state["memories"] = []
                    state["documents"] = []
                elif suffix == "memories" and self.command == "POST":
                    operation = body.get("operation_id")
                    if operation:
                        state["operations"][operation] = {
                            "operation_id": operation,
                            "status": "completed",
                            "result_metadata": {
                                "unit_ids_count": 1,
                                "extraction_errors_count": 0,
                            },
                            "retry_count": 0,
                        }
                    else:
                        peers.retained_memories["/v1/default/banks/" + bank_id] = [
                            {"text": item["content"], "type": "world"}
                            for item in body["items"]
                        ]
                    result = {
                        "status": "pending",
                        "operation_id": operation,
                        "bank_id": bank_id,
                    }
                elif suffix == "memories/recall":
                    result = {
                        "results": peers.retained_memories.get(
                            "/v1/default/banks/" + bank_id,
                            [{"text": "Synthetic retained fact", "type": "world"}],
                        )
                    }
                elif suffix == "reflect":
                    result = {"text": "Synthetic session brief"}
                elif suffix.startswith("memories/") and self.command == "PATCH":
                    key = unquote(suffix.rsplit("/", 1)[1])
                    item = next(
                        (m for m in state["memories"] if m["id"] == key), {"id": key}
                    )
                    item.update(body)
                    result = item
                elif suffix.startswith("operations/"):
                    operation = unquote(suffix.split("/")[1])
                    result = state["operations"].get(
                        operation, {"operation_id": operation, "status": "not_found"}
                    )
                    if suffix.endswith("/retry"):
                        result = {"success": True}
                self.reply(result)
                return True

            def do_GET(self):
                if not self.dispatch():
                    return super().do_GET()

            def do_POST(self):
                if not self.dispatch():
                    return super().do_POST()

            def do_PATCH(self):
                if not self.dispatch():
                    return super().do_PATCH()

            def do_DELETE(self):
                if not self.dispatch():
                    self.reply({}, 404)

        return Handler


def normalized_calls(calls):
    calls = copy.deepcopy(calls)
    for call in calls:
        for item in (call["body"] or {}).get("items", []):
            if "timestamp" in item:
                stamp = datetime.fromisoformat(item["timestamp"])
                require(
                    stamp.utcoffset().total_seconds() == 0,
                    "Retained timestamp is not UTC",
                )
                item["timestamp"] = "<UTC timestamp>"
    return calls


def exercise(image, redis_image, *, rust, minimal, disabled=False):
    print(
        f"Public memory: rust={rust}, minimal={minimal}, disabled={disabled}",
        flush=True,
    )
    peers = MemoryApiPeers()
    records = []
    with environment(
        image,
        redis_image,
        minimal=minimal,
        memory=not disabled,
        peers=peers,
        extra_env=lambda _: {
            "DAEDALUS_PREPARATION": "rust" if rust else "python",
            "DAEDALUS_AUTHORIZATION": "rust" if rust else "python",
            "HINDSIGHT_API_KEY": "synthetic-hindsight",
        },
    ) as env:

        def request(method, path, *, headers=None, record=True, **kwargs):
            before = len(peers.calls)
            reply = env["client"].request(
                method,
                env["base"] + path,
                headers=env["headers"] if headers is None else headers,
                **kwargs,
            )
            try:
                body = reply.json()
            except ValueError:
                body = reply.text
            result = {
                "status": reply.status_code,
                "body": body,
                "calls": normalized_calls(peers.calls[before:]),
            }
            if reply.headers.get("allow"):
                result["allow"] = sorted(
                    s.strip() for s in reply.headers["allow"].split(",")
                )
            if "location" in reply.headers:
                result["redirect_path"] = urlparse(reply.headers["location"]).path
            if record:
                records.append(result)
            if reply.status_code == 500 and not rust:
                # Uncaught FastAPI errors close its pooled proxy connection.
                # Probe readiness before the next independent case so the old
                # proxy's close-notification race cannot mask that case. Never
                # repeat the API request or an uncertain mutation.
                for _ in range(3):
                    if env["client"].get(env["base"] + "/health/ready").is_success:
                        break
                else:
                    raise AssertionError("Python API did not recover readiness")
            return result

        peers.calls.clear()
        for headers in [
            {},
            {"x-user-id": "synthetic-alice"},
            env["headers"] | {"x-user-id": ""},
            env["headers"] | {"x-daedalus-internal-token": "wrong"},
        ]:
            request("GET", "/v1/memories", headers=headers)
        for method, path, kwargs in [
            ("GET", "/v1/memories", {}),
            ("GET", "/v1/memory-sources", {}),
            ("GET", "/v1/memory-pages", {}),
            (
                "POST",
                "/v1/memory/retain-turn",
                {"json": {"request_id": "turn-1", "content": "Synthetic durable fact"}},
            ),
            ("PATCH", "/v1/memories/fact-1", {"json": {"text": "Synthetic changed"}}),
            (
                "POST",
                "/v1/memories/clear",
                {"json": {"confirmation": "DELETE ALL MY MEMORIES"}},
            ),
        ]:
            request(method, path, **kwargs)
        if disabled:
            require(not peers.calls, "Disabled API contacted Hindsight")
            return records
        # Start a fresh actor after the deletion lifecycle above.
        env["headers"]["x-user-id"] = "synthetic-bob"
        state = peers.state(bank("synthetic-bob"))
        request("GET", "/v1/memory-pages")
        request("GET", "/v1/memory-pages/page-1")
        for path in [
            "/v1/memories?q=%20Snow+%E9%9B%AA%20&memory_type=world&limit=3&offset=2",
            "/v1/memory-sources?q=%20source%20&limit=100&offset=7",
            "/v1/memories?bank_id=forged&user_id=forged&memory_type=invalid",
            "/v1/memories?limit=1&limit=2.0&offset=0",
            "/v1/memories?limit=0&offset=-1",
            "/v1/memories?limit=101",
            "/v1/memories?limit=no",
            "/v1/memories?limit=1e1",
            "/v1/memories?limit=1_0",
            "/v1/memories?offset=1000000000000000000000000000000",
            "/v1/memories?offset=1.5",
            "/v1/memory-sources/source-1",
            "/v1/memory-sources/id:with-colon",
            "/v1/memory-pages/bad%20id",
        ]:
            request("GET", path)
        request(
            "PATCH",
            "/v1/memories/fact-1",
            json={"text": "  Corrected preference 雪🌲 \u001c"},
        )
        request("GET", "/v1/memories")
        for reason in [{}, {"reason": ""}, {"reason": "   "}]:
            request("POST", "/v1/memories/fact-1/invalidate", json=reason)
        request("DELETE", "/v1/memory-sources/source-1")
        request("GET", "/v1/memory-sources")
        for value in [
            {
                "request_id": "retained-1",
                "user_content": "Snow 雪🌲",
                "assistant_content": "Verified preference",
                "conversation_id": "convo",
                "assistant_message_id": "reply",
            },
            {
                "request_id": "retained-1",
                "user_content": "Snow 雪🌲",
                "assistant_content": "Verified preference",
                "conversation_id": "convo",
                "assistant_message_id": "reply",
            },
            {"request_id": "old-1", "content": "Legacy turn"},
            {
                "request_id": "controls",
                "user_content": "[IDENTITY] private\n[USER] Snow data:image/png;base64,abc redis://private/key",
                "assistant_content": "[MEMORY_CONTEXT] hidden",
            },
        ]:
            reply = request("POST", "/v1/memory/retain-turn", json=value)
            operation = reply["body"]["operation_id"]
            request("GET", "/v1/memory/operations/" + operation)
            request("POST", "/v1/memory/operations/" + operation + "/retry")
        for status, count in [
            ("completed", 0),
            ("completed", 4),
            ("failed", 0),
            ("unknown", "invalid"),
            ("processing", 0),
        ]:
            state["operations"]["status"] = {
                "operation_id": "status",
                "status": status,
                "result_metadata": {
                    "unit_ids_count": count,
                    "extraction_errors_count": 2,
                    "extraction_errors_sample": ["private"],
                },
                "retry_count": "1",
            }
            request("GET", "/v1/memory/operations/status")
        for method, path, values in [
            (
                "PATCH",
                "/v1/memories/fact-1",
                [
                    {},
                    None,
                    [],
                    42,
                    {"text": ""},
                    {"text": 3},
                    {"text": " "},
                    {"text": "x", "bank_id": "forged"},
                    {"text": "雪" * 12001},
                ],
            ),
            (
                "POST",
                "/v1/memory/retain-turn",
                [
                    {},
                    {"request_id": "x"},
                    {"request_id": "x", "content": "[MEMORY_CONTEXT] hidden"},
                    {"request_id": "bad/id", "content": "x"},
                ],
            ),
            (
                "POST",
                "/v1/memories/fact-1/invalidate",
                [{"reason": None}, {"reason": "x" * 501}],
            ),
            ("POST", "/v1/memories/clear", [{}, {"confirmation": "wrong"}]),
        ]:
            for value in values:
                request(
                    method,
                    path,
                    content=json.dumps(value),
                    headers=env["headers"] | {"Content-Type": "application/json"},
                )
        for path in ["/v1/memories", "/v1/memory-pages", "/v1/memory-sources"]:
            request("PUT", path)
            request("HEAD", path)
        for path in ["/v1/memories/", "/v1/memory-pages/"]:
            request("GET", path)
        for raw in ["{", '{"text":}', "{} trailing", "[1,]"]:
            result = request(
                "PATCH",
                "/v1/memories/fact-1",
                record=False,
                content=raw,
                headers=env["headers"] | {"Content-Type": "application/json"},
            )
            require(
                result["status"] == 422
                and result["body"]["detail"][0]["type"] == "json_invalid"
                and not result["calls"],
                "Malformed JSON reached Hindsight",
            )
        request(
            "PATCH",
            "/v1/memories/fact-1",
            content='{"text":"synthetic"}',
            headers=env["headers"] | {"Content-Type": "text/plain"},
        )
        for fault in [307, 400, 404, 401, 403, 500, "invalid", 204, "lost"]:
            peers.fault = fault
            peers.fail_path = "memories/fact-1"
            request(
                "PATCH",
                "/v1/memories/fact-1",
                json={"text": "Synthetic rejected change"},
            )
        peers.fault = None

        peers.fault = "bad_tree"
        peers.fail_path = "knowledge-base/tree"
        request("GET", "/v1/memory-pages")
        invalid = request(
            "POST",
            "/v1/memories/clear",
            json={"confirmation": "DELETE ALL MY MEMORIES"},
        )
        require(
            invalid["status"] == 503
            and all(call["method"] != "DELETE" for call in invalid["calls"]),
            "Invalid knowledge tree dispatched deletion",
        )
        peers.fault = None

        # Clear affects this actor's bank and caches only, after derived nodes.
        def seed(user):
            user_bank = bank(user)
            bootstrap = "daedalus:memory:bootstrap:" + digest("v1", user_bank)
            session = (
                "daedalus:memory:session:v1:"
                + digest(user_bank)
                + ":"
                + digest("convo")
            )
            lock = session.replace(":session:", ":session-lock:")
            for key in [bootstrap, session, lock]:
                env["redis"].set(key, "synthetic-cache", ex=90)
            return [bootstrap, session, lock]

        mine = seed("synthetic-bob")
        other = seed("synthetic-alice")
        peers.fault = 503
        peers.fail_path = "knowledge-base/nodes/page-1"
        failed = request(
            "POST",
            "/v1/memories/clear",
            json={"confirmation": "DELETE ALL MY MEMORIES"},
        )
        require(
            failed["status"] == 503 and all(env["redis"].exists(k) for k in mine),
            "Partial clear acknowledged or deleted caches early",
        )
        peers.fault = None
        success = request(
            "POST",
            "/v1/memories/clear",
            json={"confirmation": "DELETE ALL MY MEMORIES"},
        )
        require(success["status"] == 200, "Clear failed")
        require(
            all(not env["redis"].exists(k) for k in mine[1:]),
            "Clear retained session caches",
        )
        require(all(env["redis"].exists(k) for k in other), "Clear crossed user caches")
        require(
            len(peers.state(bank("synthetic-bob"))["pages"])
            == len(POLICY["knowledge_pages"]),
            "Clear did not recreate managed pages",
        )
        # A failed cache deletion must also fail the API, never report cleared.
        env["redis"].execute_command("ACL", "SETUSER", "backend", "-scan")
        failed = request(
            "POST",
            "/v1/memories/clear",
            json={"confirmation": "DELETE ALL MY MEMORIES"},
        )
        require(failed["status"] == 503, "Redis cache cleanup failure acknowledged")
        env["redis"].execute_command("ACL", "SETUSER", "backend", "+scan")
        logs = (env["root"] / "backend.log").read_text()
        require(
            "SYNTHETIC_PRIVATE_UPSTREAM" not in logs
            and "synthetic-hindsight" not in logs,
            "Private upstream content leaked",
        )
        if minimal:
            run(
                "docker",
                "exec",
                env["container"],
                "sh",
                "-c",
                "! command -v python && ! command -v python3",
            )
    return records


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["image", "full-image", "baseline", "redis-image"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    baseline = exercise(args.baseline, args.redis_image, rust=False, minimal=False)
    for image, rust, minimal in [
        (args.full_image, False, False),
        (args.image, True, True),
        (args.full_image, True, False),
    ]:
        actual = exercise(image, args.redis_image, rust=rust, minimal=minimal)
        for i, (old, new) in enumerate(zip(baseline, actual, strict=True)):
            require(
                old == new,
                f"Public memory parity failed at case {i}:\nexpected={old}\nactual={new}",
            )
    disabled = exercise(
        args.full_image, args.redis_image, rust=False, minimal=False, disabled=True
    )
    require(
        disabled
        == exercise(
            args.image, args.redis_image, rust=True, minimal=True, disabled=True
        ),
        "Disabled memory API changed",
    )
    report = {
        "status": "passed",
        "matrix": ["C10", "C13", "C16"],
        "profiles": 4,
        "calls_per_profile": len(baseline),
        "disabled_profiles": 2,
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
        "fixture_sha256": hashlib.sha256(
            (ROOT / "runtime/tests/fixtures/memory-api.json").read_bytes()
        ).hexdigest(),
        "results": baseline,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(
        f"Public memory API: {len(baseline)} calls/profile, lifecycle and rollback contracts passed."
    )
