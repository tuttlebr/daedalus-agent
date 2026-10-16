#!/usr/bin/env python3
"""Profile import API parity through real backend images and a stateful HTTP peer."""

import argparse
import copy
import hashlib
import io
import json
import socket
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from image_check import environment, require, run
from memory_api_check import MemoryApiPeers, bank, digest

ROOT = Path(__file__).resolve().parents[1]
DEFAULT = object()
ENTRY = {"label": "Identity", "memory": "Synthetic profile preference 雪🌲"}


def expand(value):
    if isinstance(value, dict):
        if set(value) == {"$string_parts"}:
            return "".join(value["$string_parts"])
        return {k: expand(v) for k, v in value.items()}
    if isinstance(value, list):
        return [expand(v) for v in value]
    return value


class ProfilePeers(MemoryApiPeers):
    def __init__(self):
        super().__init__()
        self.profile_documents = {}
        self.inventory_reply = DEFAULT
        self.retention_reply = DEFAULT
        self.profile_fault = None
        self.fail_method = None

    def documents(self, key):
        return self.profile_documents.setdefault(
            key, [{"id": "old-z"}, {"id": "old-a"}, {"id": "old-z"}]
        )

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def dispatch(self):
                url = urlparse(self.path)
                prefix, _, suffix = url.path.partition("/v1/default/banks/")
                key, _, suffix = suffix.partition("/")
                query = {
                    k: v[-1]
                    for k, v in parse_qs(url.query, keep_blank_values=True).items()
                }
                profile = not prefix and (
                    suffix == "documents"
                    and query.get("tags") == "source:profile-import"
                    or suffix.startswith("documents/")
                    and self.command == "DELETE"
                )
                body = None
                if not prefix and suffix == "memories" and self.command == "POST":
                    raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                    body = json.loads(raw)
                    profile = any(
                        item.get("context") == "Daedalus authenticated profile import"
                        for item in body.get("items", [])
                    )
                    if not profile:
                        original = self.rfile
                        try:
                            self.rfile = io.BytesIO(raw)
                            return super().dispatch()
                        finally:
                            self.rfile = original
                if not profile:
                    return super().dispatch()
                peers.calls.append(
                    {
                        "method": self.command,
                        "path": url.path,
                        "query": query,
                        "body": body,
                        "authorization": self.headers.get("Authorization"),
                    }
                )
                fault = (
                    peers.profile_fault if peers.fail_method == self.command else None
                )
                if fault == "block":
                    peers.started.set()
                    self.wait_for_disconnect(peers.disconnected, peers.release)
                    return True
                if isinstance(fault, int):
                    self.reply({"detail": "SYNTHETIC_PRIVATE_PROFILE"}, fault)
                    return True
                documents = peers.documents(key)
                if self.command == "GET":
                    offset, limit = int(query["offset"]), int(query["limit"])
                    result = (
                        {"items": copy.deepcopy(documents[offset : offset + limit])}
                        if peers.inventory_reply is DEFAULT
                        else peers.inventory_reply
                    )
                elif self.command == "DELETE":
                    document = unquote(suffix.removeprefix("documents/"))
                    peers.profile_documents[key] = [
                        d for d in documents if str(d.get("id")) != document
                    ]
                    if fault == "lost":
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.close_connection = True
                        return True
                    self.send_response(204)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return True
                else:
                    # Model a successful durable write even if its reply is lost.
                    for item in body["items"]:
                        peers.profile_documents[key] = [
                            d
                            for d in peers.documents(key)
                            if d["id"] != item["document_id"]
                        ] + [{"id": item["document_id"], "content": item["content"]}]
                    result = (
                        (
                            {"status": "pending", "operation_id": body["operation_id"]}
                            if body["async"]
                            else {"success": True, "status": "completed"}
                        )
                        if peers.retention_reply is DEFAULT
                        else peers.retention_reply
                    )
                    operation = body["operation_id"]
                    peers.state(key)["operations"][operation] = {
                        "operation_id": operation,
                        "status": "completed",
                        "result_metadata": {
                            "unit_ids_count": len(body["items"]),
                            "extraction_errors_count": 0,
                        },
                    }
                if fault == "lost":
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.close_connection = True
                    return True
                self.reply(result)
                return True

        return Handler


def normalize(result, user):
    result = copy.deepcopy(result)
    for call in result["calls"]:
        require(
            call["path"].startswith(f"/v1/default/banks/{bank(user)}/"),
            "Caller controlled destination bank",
        )
        require(
            call["authorization"] == "Bearer synthetic-hindsight",
            "Hindsight credential changed",
        )
        body = call["body"]
        if not body or "items" not in body:
            continue
        operation = body["operation_id"]
        require(uuid.UUID(operation).version == 4, "Fresh operation is not UUID v4")
        for item in body["items"]:
            label_hash = hashlib.sha256(item["metadata"]["label"].encode()).hexdigest()
            request_id = label_hash if body["async"] else f"{operation}:{label_hash}"
            require(
                item["document_id"]
                == "daedalus-profile-"
                + digest(bank(user), "profile", request_id, label_hash),
                "Document ID changed",
            )
            imported_at = item["metadata"]["imported_at"]
            stamp = datetime.fromisoformat(imported_at)
            require(
                stamp.utcoffset().total_seconds() == 0
                and stamp.microsecond == 0
                and imported_at.endswith("+00:00"),
                "Import timestamp changed",
            )
            item["metadata"]["imported_at"] = "<UTC seconds>"
            if not body["async"]:
                item["document_id"] = (
                    "<fresh replacement:" + item["metadata"]["label"] + ">"
                )
        body["operation_id"] = "<UUID v4>"
        if (
            isinstance(result["body"], dict)
            and result["body"].get("operation_id") == operation
        ):
            result["body"]["operation_id"] = "<UUID v4>"
    return result


def exercise(image, redis_image, *, rust, minimal, disabled=False, maximum=250):
    print(
        f"Profile import: rust={rust}, minimal={minimal}, disabled={disabled}, maximum={maximum}",
        flush=True,
    )
    peers, records = ProfilePeers(), []
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
            "PROFILE_IMPORT_MAX_ENTRIES": str(maximum),
        },
    ) as env:
        user = "synthetic-alice"
        fixture = expand(
            json.loads(
                (ROOT / "runtime/tests/fixtures/profile-import.json").read_text()
            )
        )

        def request(
            payload=DEFAULT,
            *,
            headers=None,
            method="POST",
            path="/v1/profile/import",
            **kwargs,
        ):
            before = len(peers.calls)
            response = env["client"].request(
                method,
                env["base"] + path,
                headers=env["headers"] if headers is None else headers,
                **({"json": payload} if payload is not DEFAULT else {}),
                **kwargs,
            )
            try:
                body = response.json()
            except ValueError:
                body = response.text
            result = {
                "status": response.status_code,
                "body": body,
                "calls": copy.deepcopy(peers.calls[before:]),
            }
            if "allow" in response.headers:
                result["allow"] = response.headers["allow"]
            if "location" in response.headers:
                result["redirect_path"] = urlparse(response.headers["location"]).path
            records.append(
                normalize(result, (headers or env["headers"]).get("x-user-id", user))
            )
            return result

        for headers in [
            {},
            {"x-user-id": user},
            env["headers"] | {"x-user-id": ""},
            env["headers"] | {"x-daedalus-internal-token": "wrong"},
        ]:
            result = request({"entries": [ENTRY]}, headers=headers)
            require(
                result["status"] == 401 and not result["calls"],
                "Profile authentication bypassed",
            )
        if disabled:
            for mode in ["append", "replace"]:
                result = request({"entries": [ENTRY], "mode": mode})
                require(
                    result
                    == {
                        "status": 500,
                        "body": {"detail": "Profile import failed."},
                        "calls": [],
                    },
                    "Disabled profile imported",
                )
            return records
        if maximum != 250:
            result = request({"entries": [ENTRY, {**ENTRY, "label": "second"}]})
            require(
                result["status"] == 422 and not result["calls"], "Entry cap ignored"
            )
            return records
        for case in fixture["cases"]:
            peers.profile_documents.clear()
            # json=None in httpx means an absent body; literal null is covered too.
            result = request(case["input"])
            if case["status"] != 200:
                require(
                    result["status"] == 422
                    and result["body"] == case["expected"]
                    and not result["calls"],
                    "Profile validation differs from frozen oracle",
                )
        for case in fixture["batches"]:
            peers.profile_documents.clear()
            result = request(case["input"])
            expected = normalize(
                {
                    "status": case["status"],
                    "body": case["expected"],
                    "calls": case["calls"],
                },
                user,
            )
            require(records[-1] == expected, "Profile batch differs from frozen oracle")
        for method in ["GET", "PUT", "DELETE", "HEAD", "OPTIONS"]:
            request(method=method)
        request({"entries": [ENTRY]}, path="/v1/profile/import/?synthetic=1")
        request(
            content="null",
            headers=env["headers"] | {"content-type": "application/json"},
        )
        request(
            content="profile", headers=env["headers"] | {"content-type": "text/plain"}
        )
        malformed = request(
            content="{", headers=env["headers"] | {"content-type": "application/json"}
        )
        require(
            malformed["status"] == 422
            and malformed["body"]["detail"][0]["type"] == "json_invalid"
            and not malformed["calls"],
            "Malformed JSON accepted",
        )
        records[-1]["body"] = {"detail": [{"type": "json_invalid"}]}
        # Append is an upsert by label, with a new operation for every request.
        peers.profile_documents.clear()
        first = request({"entries": [ENTRY], "user_id": "forged", "bank_id": "forged"})
        second = request(
            {"entries": [{**ENTRY, "memory": "Updated synthetic preference"}]}
        )
        a, b = first["calls"][0]["body"], second["calls"][0]["body"]
        require(
            a["operation_id"] != b["operation_id"]
            and a["items"][0]["document_id"] == b["items"][0]["document_id"],
            "Append idempotent document/fresh operation changed",
        )
        request(
            {"entries": [ENTRY]},
            headers=env["headers"] | {"x-user-id": "synthetic-bob"},
        )
        require(
            peers.documents(bank(user)) != peers.documents(bank("synthetic-bob")),
            "User stores shared",
        )
        # Pagination, duplicate IDs, opaque IDs, and deterministic delete ordering.
        peers.profile_documents[bank(user)] = [
            {"id": f"old-{i:03}"} for i in range(101)
        ] + [{"id": "old-001"}, {"id": " space/雪?# "}]
        replacement = request({"mode": "replace", "entries": [ENTRY]})
        calls = replacement["calls"]
        require(
            replacement["body"]["replaced"] == 102
            and [c["query"]["offset"] for c in calls if c["method"] == "GET"]
            == ["0", "100"],
            "Inventory pagination/deduplication changed",
        )
        require(
            [c["method"] for c in calls] == ["GET", "GET", "POST"] + ["DELETE"] * 102,
            "Deleted before confirmed retention",
        )
        # A repeated replacement must stage a fresh generation, then remove the old.
        previous = peers.documents(bank(user))[0]["id"]
        repeated = request({"mode": "replace", "entries": [ENTRY]})
        fresh = repeated["calls"][1]["body"]["items"][0]["document_id"]
        require(
            fresh != previous and repeated["calls"][-1]["path"].endswith(previous),
            "Replacement reused its old document",
        )
        # Dynamic previous ID is already verified above; normalize just this delete.
        records[-1]["calls"][-1]["path"] = (
            f"/v1/default/banks/{bank(user)}/documents/<previous generation>"
        )
        for inventory in [
            {"items": None},
            {"items": {}},
            {"items": [None]},
            {"items": [{}]},
            {"items": [{"id": " "}]},
            {"items": [{"id": False}]},
            {"items": [{"id": 0}]},
        ]:
            peers.inventory_reply = inventory
            result = request({"mode": "replace", "entries": [ENTRY]})
            require(
                result["status"] == 500
                and all(c["method"] == "GET" for c in result["calls"]),
                "Malformed inventory mutated profile",
            )
        peers.inventory_reply = DEFAULT
        for accepted in [
            {},
            {"success": 1},
            {"success": True, "status": "pending"},
            {"success": True, "status": "running"},
            {"success": True, "status": "failed"},
            {"success": True, "status": "error"},
            {"success": True, "error": "SYNTHETIC_PRIVATE_PROFILE"},
            {"success": True, "async": True},
            {"success": True, "status": []},
            [],
            None,
        ]:
            peers.profile_documents.clear()
            peers.retention_reply = accepted
            result = request({"mode": "replace", "entries": [ENTRY]})
            require(
                result["status"] == 500
                and [c["method"] for c in result["calls"]] == ["GET", "POST"],
                "Unconfirmed replacement deleted old source",
            )
            require(
                any(d["id"] == "old-a" for d in peers.documents(bank(user))),
                "Old profile lost after failed retention",
            )
        for accepted in [
            {"success": True},
            {"success": True, "status": "processing", "async": 1, "error": ""},
        ]:
            peers.profile_documents.clear()
            peers.retention_reply = accepted
            require(
                request({"mode": "replace", "entries": [ENTRY]})["status"] == 200,
                "Confirmed replacement rejected",
            )
        for operation in [
            None,
            "",
            " ",
            0,
            False,
            " upstream-operation ",
            5,
            True,
            ["a'", True, None, "雪", "\u001c"],
            {"key": "雪"},
        ]:
            peers.retention_reply = {"operation_id": operation}
            result = request({"entries": [ENTRY]})
            require(
                result["status"] == (202 if str(operation or "").strip() else 500),
                "Upstream operation ID coercion changed",
            )
        peers.retention_reply = DEFAULT
        for inventory in [
            {},
            {
                "items": [
                    {"id": True},
                    {"id": 7},
                    {"id": ["opaque", None, "\u00a0"]},
                    {"id": {"x": True}},
                ]
            },
        ]:
            peers.inventory_reply = inventory
            require(
                request({"mode": "replace", "entries": [ENTRY]})["status"] == 200,
                "Legacy inventory ID coercion changed",
            )
        peers.inventory_reply = DEFAULT
        # Failures at each phase never retry mutations, acknowledge a partial
        # replacement, or expose the upstream's private response.
        for method in ["GET", "POST", "DELETE"]:
            for fault in [400, 404, 503, "lost"]:
                peers.profile_documents.clear()
                peers.fail_method, peers.profile_fault = method, fault
                result = request({"mode": "replace", "entries": [ENTRY]})
                require(
                    result["status"] == 500
                    and result["body"] == {"detail": "Profile import failed."},
                    "Profile failure contract changed",
                )
                require(
                    sum(c["method"] == method for c in result["calls"]) == 1,
                    "Uncertain profile request replayed",
                )
                if method != "DELETE":
                    require(
                        not any(c["method"] == "DELETE" for c in result["calls"]),
                        "Failed profile deleted old source",
                    )
        # The project wrapper treats status <400 as a response, unlike HTTPX's
        # raise_for_status. Preserve that legacy behavior without following it.
        for method, status in [("GET", 200), ("POST", 500), ("DELETE", 200)]:
            peers.profile_documents.clear()
            peers.fail_method, peers.profile_fault = method, 307
            result = request({"mode": "replace", "entries": [ENTRY]})
            require(result["status"] == status, "Legacy 3xx response handling changed")
            if method == "POST":
                require(
                    not any(c["method"] == "DELETE" for c in result["calls"]),
                    "Unconfirmed redirect reply deleted old sources",
                )
        peers.fail_method, peers.profile_fault = "POST", "block"
        timed_out = request({"entries": [ENTRY]})
        require(
            timed_out["status"] == 500 and len(timed_out["calls"]) == 1,
            "Append timeout acknowledged/replayed",
        )
        # P0 does not reliably close its per-request httpx client on cancellation.
        # Releasing the fixture is not a retry and leaves the uncertain write alone.
        peers.release.set()
        peers.profile_fault = None
        if rust:
            logs = (env["root"] / "backend.log").read_text()
            require(
                "SYNTHETIC_PRIVATE_PROFILE" not in logs
                and "synthetic-hindsight" not in logs
                and ENTRY["memory"] not in logs,
                "Profile contents leaked to logs",
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
                old == new, f"Profile parity case {i}:\nexpected={old}\nactual={new}"
            )
    for options in [{"disabled": True}, {"maximum": 1}]:
        old = exercise(
            args.full_image, args.redis_image, rust=False, minimal=False, **options
        )
        new = exercise(args.image, args.redis_image, rust=True, minimal=True, **options)
        require(old == new, f"Profile operator settings changed: {options}")
    report = {
        "status": "passed",
        "profiles": 4,
        "calls_per_profile": len(baseline),
        "operator_profiles": 4,
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
            (ROOT / "runtime/tests/fixtures/profile-import.json").read_bytes()
        ).hexdigest(),
        "results": baseline,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(
        f"Profile import: {len(baseline)} calls/profile; lifecycle, isolation, and rollback passed."
    )
