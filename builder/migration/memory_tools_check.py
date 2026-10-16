#!/usr/bin/env python3
"""C09/C10/C13/C16 memory ports against real images, Hindsight peers and TLS Redis."""

import argparse
import concurrent.futures
import copy
import hashlib
import json
import socket
import subprocess  # nosec B404 - disposable containers, explicit argv
import threading
import uuid
from pathlib import Path

from authorization_check import second_runtime
from image_check import environment, require, run
from leaf_check import LeafPeers, measure, verify
from runtime_http_check import free_port

ROOT = Path(__file__).resolve().parents[1]
ADDED = "Memory added successfully. You can continue. Please respond to the user."
AMBIGUOUS = "Memory write wasn't repeated because the same autonomous operation has an existing or ambiguous execution record."
NAMESPACE = uuid.UUID("21b4c9b7-39a3-4c5e-8e31-66e2223e5040")


def fixture():
    return json.loads(
        (ROOT / "runtime/tests/fixtures/memory-tools.json").read_text(),
        object_hook=lambda obj: "".join(obj["$string_parts"])
        if list(obj) == ["$string_parts"]
        else obj,
    )


def bank(user):
    return "du-" + str(uuid.uuid5(NAMESPACE, user))


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def operation_key(user, execution, memory):
    args = {"memory": memory, "tags": [], "metadata": {}}
    return "daedalus:idempotency:v1:" + ":".join(
        [
            digest(user),
            digest(execution),
            digest("add_memory"),
            digest(
                json.dumps(
                    args, sort_keys=True, separators=(",", ":"), ensure_ascii=False
                )
            ),
        ]
    )


class MemoryToolPeers(LeafPeers):
    def __init__(self):
        super().__init__()
        self.memory_calls = []
        self.memory_reply = fixture()["cases"][0]["reply"]
        self.mode = "normal"
        self.memory_started = threading.Event()
        self.memory_disconnected = threading.Event()
        self.before_reply = None

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def do_GET(self):
                return self.reply({"status": "ok"})

            def do_POST(self):
                if not self.path.startswith("/v1/default/banks/"):
                    return super().do_POST()
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                peers.memory_calls.append(
                    {
                        "path": self.path,
                        "method": "POST",
                        "body": body,
                        "authorization": self.headers.get("authorization"),
                    }
                )
                peers.memory_started.set()
                if peers.mode == "block":
                    self.wait_for_disconnect(peers.memory_disconnected)
                    return
                if peers.mode == "lost":
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.close_connection = True
                    return
                if peers.before_reply:
                    peers.before_reply()
                if peers.mode in ["redirect", "failure"]:
                    return self.reply(
                        {"detail": "SYNTHETIC_PRIVATE_HINDSIGHT_FAILURE"},
                        307 if peers.mode == "redirect" else 503,
                    )
                if peers.mode == "invalid":
                    return self.reply(["SYNTHETIC_PRIVATE_HINDSIGHT_FAILURE"])
                if peers.mode == "empty":
                    self.send_response(204)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                return self.reply(peers.memory_reply)

        return Handler


def configure(config, *_):
    config["functions"] = {
        "add_memory": {"_type": "daedalus_add_memory"},
        "get_memory": {"_type": "daedalus_get_memory"},
        **{
            f"get_memory_{k}": {"_type": "daedalus_get_memory", "top_k": k}
            for k in [1, 11, 50]
        },
        "remember": {
            "_type": "daedalus_add_memory",
            "description": "Custom memory write description",
        },
    }
    config["workflow"]["tools"] = list(config["functions"])


def python_reservation(env, image, execution, memory, mode):
    script = """
import asyncio, os
from nat_helpers.idempotency import reserve_operation, complete_operation
async def main():
    reservation = await reserve_operation(user_id='synthetic-alice', execution_id=os.environ['FIXTURE_EXECUTION'],
        operation='add_memory', arguments={'memory':os.environ['FIXTURE_MEMORY'],'tags':[],'metadata':{}})
    mode = os.environ['FIXTURE_MODE']
    if mode == 'read':
        assert not reservation.acquired and reservation.state == 'completed'
        assert reservation.stored_result == 'Memory added successfully. You can continue. Please respond to the user.'
    else:
        assert reservation.acquired
        if mode == 'complete':
            assert await complete_operation(reservation, 'Memory added successfully. You can continue. Please respond to the user.')
asyncio.run(main())
"""
    run(
        "docker",
        "run",
        "--rm",
        "--network",
        "host",
        "-v",
        f"{env['root']}:/fixture:ro",
        "-e",
        f"REDIS_URL={env['environment']['REDIS_URL']}",
        "-e",
        f"FIXTURE_EXECUTION={execution}",
        "-e",
        f"FIXTURE_MEMORY={memory}",
        "-e",
        f"FIXTURE_MODE={mode}",
        "--entrypoint",
        "python",
        image,
        "-c",
        script,
        stdout=subprocess.DEVNULL,
    )


def exercise(
    image, redis_image, baseline, *, minimal, rust, disabled=False, legacy=False
):
    print(
        f"Checking memory tools: minimal={minimal}, rust={rust}, "
        f"disabled={disabled}, legacy={legacy}",
        flush=True,
    )
    peers = MemoryToolPeers()
    records = []
    cancellation = {}
    with environment(
        image,
        redis_image,
        minimal=minimal,
        memory=False,
        peers=peers,
        configure=configure,
        extra_env=lambda _: {
            "DAEDALUS_PREPARATION": "rust" if rust else "python",
            "DAEDALUS_AUTHORIZATION": "rust" if rust else "python",
            "DAEDALUS_MEMORY_MODE": "disabled" if disabled else "hindsight",
            "HINDSIGHT_API_KEY": "synthetic-hindsight",
        },
    ) as env:

        def call(
            name,
            arguments,
            *,
            user="synthetic-alice",
            execution="",
            scope="autonomy",
            request=None,
            target=None,
            record=True,
        ):
            peers.plan = [{"name": name, "arguments": arguments}]
            before = len(peers.memory_calls)
            result = measure(
                env if target is None else {**env, "base": target},
                user=user,
                extra_headers={
                    "x-daedalus-execution-scope": scope,
                    "x-daedalus-execution-id": execution,
                },
                request_id=request
                or f"memory-http-{len(records)}-{uuid.uuid4().hex[:8]}",
                message="hello",
            )
            advertised = copy.deepcopy(peers.plan)
            if (
                legacy
                and advertised[0]["arguments"].get("metadata", {}).get("number")
                == 10**30
            ):
                # P0's provider decoded out-of-u64 integer arguments as floats.
                # Current Rust preserves integer tokens, independently of this
                # tool port. Keep this explicit historical transport vector.
                advertised[0]["arguments"]["metadata"]["number"] = float(10**30)
            verify(result, advertised)
            payload = result["ends"][0]["payload"]
            if record:
                records.append(
                    {
                        "payload": payload,
                        "model_output": peers.results[-1][0]["output"],
                        "calls": peers.memory_calls[before:],
                    }
                )
            return payload

        if disabled:
            require(
                call("get_memory", {"query": "Synthetic facts"})
                == "Memories as a JSON: \n[]",
                "Disabled recall changed",
            )
            require(
                call(
                    "add_memory",
                    {"memory": "Synthetic disabled fact"},
                    execution="disabled",
                )
                == "Durable memory is disabled by the operator.",
                "Disabled retain changed",
            )
            require(not peers.memory_calls, "Disabled memory contacted Hindsight")
            record = json.loads(
                env["redis"].get(
                    operation_key(
                        "synthetic-alice", "disabled", "Synthetic disabled fact"
                    )
                )
            )
            require(
                record["state"] == "in_progress",
                "Disabled write lost baseline reservation",
            )
            return {"results": records}

        for case in fixture()["cases"]:
            name = (
                "add_memory" if case["kind"] == "daedalus_add_memory" else "get_memory"
            )
            if case["config"].get("top_k"):
                name += "_" + str(case["config"]["top_k"])
            result = call(name, case["arguments"], request=case["request_id"])
            require(result == case["expected"], "Frozen memory output changed")
            expected_calls = copy.deepcopy(case["calls"])
            if legacy and case["arguments"].get("metadata", {}).get("number") == 10**30:
                expected_calls[0]["body"]["items"][0]["metadata"]["number"] = (
                    json.dumps(float(10**30))
                )
            require(
                records[-1]["calls"] == expected_calls,
                "Frozen Hindsight request changed",
            )
        for mode in ["redirect", "failure", "invalid", "empty"]:
            peers.mode = mode
            for name, arguments in [
                ("add_memory", {"memory": "Synthetic uncertain memory"}),
                ("get_memory", {"query": "Synthetic facts"}),
            ]:
                call(name, arguments, request="mode-" + mode + name)
        peers.mode = "normal"
        for user in ["synthetic-alice", "synthetic-bob"]:
            call(
                "remember",
                {
                    "memory": "Synthetic identity isolation",
                    "user_id": "forged-user",
                    "bank_id": "forged-bank",
                },
                user=user,
                request="identity-" + user,
            )
            require(
                peers.memory_calls[-1]["path"]
                == f"/v1/default/banks/{bank(user)}/memories",
                "Memory write crossed users",
            )
        # An execution ID sent on the interactive path must not deduplicate.
        before = len(peers.memory_calls)
        for request in ["interactive-1", "interactive-2"]:
            call(
                "add_memory",
                {"memory": "Synthetic interactive memory"},
                scope="interactive",
                execution="interactive",
                request=request,
            )
        require(
            len(peers.memory_calls) == before + 2,
            "Interactive retries were treated as worker replays",
        )

        memory = "Synthetic autonomous memory 雪🌲"
        before = len(peers.memory_calls)
        require(
            call(
                "add_memory",
                {"memory": memory},
                execution="completed",
                request="completed-1",
            )
            == ADDED,
            "Autonomous write failed",
        )
        require(
            call(
                "add_memory",
                {"memory": memory},
                execution="completed",
                request="completed-2",
            )
            == ADDED,
            "Completed result not reused",
        )
        require(len(peers.memory_calls) == before + 1, "Completed write was repeated")
        stored_key = operation_key("synthetic-alice", "completed", memory)
        require(
            json.loads(env["redis"].get(stored_key))
            == {"state": "completed", "result": ADDED},
            "Completion record changed",
        )
        require(604700 < env["redis"].ttl(stored_key) <= 604800, "Receipt TTL changed")
        python_reservation(env, baseline, "completed", memory, "read")
        env["redis"].expire(stored_key, 91)
        require(
            call("add_memory", {"memory": memory}, execution="completed") == ADDED
            and 0 < env["redis"].ttl(stored_key) <= 91,
            "Replaying a completed result renewed its TTL",
        )
        for mode in ["complete", "pending"]:
            python_reservation(env, baseline, mode, memory, mode)
            before = len(peers.memory_calls)
            require(
                call("add_memory", {"memory": memory}, execution=mode)
                == (ADDED if mode == "complete" else AMBIGUOUS),
                "Python reservation was not consumed",
            )
            require(len(peers.memory_calls) == before, "Python-owned write replayed")

        # The service accepted the request but its response was lost. A later
        # worker attempt must not call Hindsight again or record success.
        peers.mode = "lost"
        before = len(peers.memory_calls)
        call("add_memory", {"memory": memory}, execution="lost", request="lost-first")
        peers.mode = "normal"
        require(
            call("add_memory", {"memory": memory}, execution="lost") == AMBIGUOUS,
            "Uncertain write replayed",
        )
        require(len(peers.memory_calls) == before + 1, "Transport retried a write")

        # Completion must be fenced by the reservation owner even when the
        # upstream side effect succeeded. Preserve the successor's bytes/TTL.
        successor = '{"state":"in_progress","owner":"successor"}'
        fenced_key = operation_key("synthetic-alice", "fenced", memory)
        peers.before_reply = lambda: env["redis"].set(fenced_key, successor, ex=77)
        require(
            call("add_memory", {"memory": memory}, execution="fenced", request="fenced")
            == ADDED,
            "Confirmed write result changed after lease loss",
        )
        peers.before_reply = None
        require(
            env["redis"].get(fenced_key).decode() == successor
            and 0 < env["redis"].ttl(fenced_key) <= 77,
            "Stale owner overwrote successor",
        )
        require(
            call("add_memory", {"memory": memory}, execution="fenced") == AMBIGUOUS,
            "Successor reservation replayed",
        )

        # A confirmed upstream write whose receipt cannot be saved stays
        # ambiguous. Restoring Redis must not cause a second side effect.
        before = len(peers.memory_calls)
        peers.before_reply = lambda: env["redis"].execute_command(
            "ACL", "SETUSER", "backend", "-set"
        )
        failed = call(
            "add_memory",
            {"memory": memory},
            execution="completion-failure",
            record=False,
        )
        peers.before_reply = None
        env["redis"].execute_command("ACL", "SETUSER", "backend", "+set")
        require(failed.startswith("Tool failed ("), "Receipt failure reported success")
        require(
            call("add_memory", {"memory": memory}, execution="completion-failure")
            == AMBIGUOUS
            and len(peers.memory_calls) == before + 1,
            "Receipt failure repeated a confirmed write",
        )

        # Two processes share only Redis; a language-local mutex cannot satisfy
        # this gate. Winner request ID is nondeterministic, so test the effect
        # count and final record instead of comparing its document ID.
        other_env = {
            **env,
            "environment": {
                **env["environment"],
                "DAEDALUS_TOOLS_PORT": str(free_port()),
            },
        }
        with second_runtime(
            other_env, image
        ) as second, concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            peers.plan = [{"name": "add_memory", "arguments": {"memory": memory}}]
            before = len(peers.memory_calls)
            barrier = threading.Barrier(2)

            def race(target):
                barrier.wait(5)
                return call(
                    "add_memory",
                    {"memory": memory},
                    execution="race",
                    target=target,
                    record=False,
                )

            results = list(pool.map(race, [env["base"], second]))
            require(
                results.count(ADDED) >= 1
                and all(r in [ADDED, AMBIGUOUS] for r in results),
                "Invalid write race outcomes",
            )
            require(
                len(peers.memory_calls) == before + 1,
                "Concurrent processes duplicated a write",
            )

        # Stop must close both recall and retain transports. Interrupted writes
        # retain an ambiguous reservation, including when the peer saw a body.
        for name, arguments in [
            ("get_memory", {"query": "Synthetic blocking recall"}),
            ("add_memory", {"memory": memory}),
        ]:
            peers.mode = "block"
            peers.memory_started.clear()
            peers.memory_disconnected.clear()
            peers.plan = [{"name": name, "arguments": arguments}]
            request_id = "cancel-" + name
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(
                    measure,
                    env,
                    extra_headers={
                        "x-daedalus-execution-scope": "autonomy",
                        "x-daedalus-execution-id": request_id,
                    },
                    request_id=request_id,
                    message="hello",
                )
                require(
                    peers.memory_started.wait(8),
                    "Memory cancellation barrier not reached",
                )
                response = env["client"].post(
                    env["base"] + f"/v1/runs/{request_id}/control",
                    headers=env["headers"],
                    json={"type": "cancel", "command_id": str(uuid.uuid4())},
                )
                require(response.is_success, "Memory Stop rejected")
                cancelled = future.result(timeout=8)
                require(
                    cancelled["done"]
                    and cancelled["terminal"] == "error"
                    and not cancelled["ends"]
                    and any(
                        event.get("error", {}).get("message") == "Run cancelled by user"
                        for event in cancelled["errors"]
                    ),
                    "Stop reported a completed memory call",
                )
                cancellation[name] = peers.memory_disconnected.wait(5)
                # The immutable P0 baseline interrupts the chat but can leave
                # HTTPX sockets open. The current Python cleanup fixed that
                # before this port; every candidate profile must retain it.
                if not legacy:
                    require(
                        cancellation[name], "Stop did not close Hindsight transport"
                    )
            peers.mode = "normal"
            if name == "add_memory":
                before = len(peers.memory_calls)
                require(
                    call(name, arguments, execution=request_id) == AMBIGUOUS,
                    "Stopped write was repeated",
                )
                require(
                    len(peers.memory_calls) == before,
                    "Stopped write reached Hindsight again",
                )

        for index, stored in enumerate(["{broken", '{"state":"other"}', "null", "[]"]):
            execution = f"corrupt-{index}"
            env["redis"].set(
                operation_key("synthetic-alice", execution, memory), stored, ex=60
            )
            before = len(peers.memory_calls)
            result = call(
                "add_memory", {"memory": memory}, execution=execution, record=False
            )
            require(
                result == AMBIGUOUS
                if index < 2
                else result.startswith("Error: add_memory idempotency unavailable:"),
                f"Corrupt reservation failure changed for case {index}: {result}",
            )
            require(
                len(peers.memory_calls) == before,
                "Corrupt record dispatched memory write",
            )

        # Fail closed before dispatch; never expose the Redis URL or upstream
        # exception text. Driver-specific exception prose is not a contract.
        before = len(peers.memory_calls)
        env["redis"].execute_command("ACL", "SETUSER", "backend", "-set")
        failed = call(
            "add_memory", {"memory": memory}, execution="redis-failure", record=False
        )
        require(
            failed.startswith("Error: add_memory idempotency unavailable:"),
            "Reservation failure was not reported",
        )
        require(
            len(peers.memory_calls) == before, "Reservation failure dispatched a write"
        )
        env["redis"].execute_command("ACL", "SETUSER", "backend", "+set")
        logs = (env["root"] / "backend.log").read_text()
        for private in [
            "SYNTHETIC_PRIVATE_HINDSIGHT_FAILURE",
            "Synthetic autonomous memory",
            "synthetic-hindsight",
        ]:
            require(
                private not in logs, "Private memory/service content leaked to logs"
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
        tools = peers.requests[0]["tools"]
    return {"tools": tools, "results": records, "cancellation": cancellation}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--full-image", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    old = exercise(
        args.baseline,
        args.redis_image,
        args.baseline,
        minimal=False,
        rust=False,
        legacy=True,
    )
    expected = exercise(
        args.full_image, args.redis_image, args.baseline, minimal=False, rust=False
    )
    require(old["tools"] == expected["tools"], "Baseline memory catalog changed")
    for first, current in zip(old["results"], expected["results"], strict=True):
        old_calls = copy.deepcopy(first["calls"])
        for call in old_calls:
            for item in call["body"].get("items", []):
                if item["metadata"].get("number") == json.dumps(float(10**30)):
                    item["metadata"]["number"] = str(10**30)
        require(
            first["payload"] == current["payload"] and old_calls == current["calls"],
            "Baseline memory/service payload changed",
        )
        if first["payload"].startswith("Error:"):
            require(
                json.loads(current["model_output"])
                == {"status": "error", "content": first["payload"]},
                "Current model error envelope changed",
            )
        else:
            require(
                first["model_output"] == current["model_output"],
                "Model memory result changed",
            )
    for image, minimal in [(args.image, True), (args.full_image, False)]:
        actual = exercise(
            image, args.redis_image, args.baseline, minimal=minimal, rust=True
        )
        require(
            actual == expected, f"Native memory parity failed for minimal={minimal}"
        )
    disabled = exercise(
        args.full_image,
        args.redis_image,
        args.baseline,
        minimal=False,
        rust=False,
        disabled=True,
    )
    require(
        exercise(
            args.image,
            args.redis_image,
            args.baseline,
            minimal=True,
            rust=True,
            disabled=True,
        )
        == disabled,
        "Disabled memory parity failed",
    )
    report = {
        "matrix": ["C09", "C10", "C13", "C16"],
        "status": "passed",
        "profiles": 4,
        "calls_per_profile": len(expected["results"]),
        "disabled_profiles": 2,
        "baseline_hindsight_disconnected_after_stop": old["cancellation"],
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
            for image in [args.baseline, args.image, args.full_image]
        },
        "fixture_sha256": digest(
            (ROOT / "runtime/tests/fixtures/memory-tools.json").read_text()
        ),
        "results": expected,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(
        f"Memory tools: {len(expected['results'])} calls/profile, cross-process races, cancellation, rollback, and disabled-mode contracts passed."
    )
