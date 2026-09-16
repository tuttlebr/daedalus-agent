"""Exercise the real backend HTTP boundary against a recording Responses server.

Run inside the built backend image (no provider credentials or external tools):
docker run --rm --entrypoint python IMAGE /workspace/model_routing_http_check.py
Also runnable with the repository's fully installed builder virtual environment.
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import socket
import subprocess  # nosec B404 - launches only the local backend fixture
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import yaml


def require(condition, detail):
    if not condition:
        raise RuntimeError(detail)


def response_events(outputs, *, incomplete=False):
    response = {
        "id": "resp_" + uuid.uuid4().hex,
        "object": "response",
        "created_at": int(time.time()),
        "model": "fixture-provider-target",
        "status": "incomplete" if incomplete else "completed",
        "output": outputs,
        "usage": None,
        "error": None,
        "incomplete_details": {"reason": "max_output_tokens"} if incomplete else None,
    }
    events = [
        {
            "type": "response.created",
            "response": {**response, "status": "in_progress", "output": []},
        }
    ]
    for index, item in enumerate(outputs):
        events.append(
            {"type": "response.output_item.added", "output_index": index, "item": item}
        )
        if item["type"] == "message":
            events.append(
                {
                    "type": "response.output_text.delta",
                    "output_index": index,
                    "content_index": 0,
                    "item_id": item["id"],
                    "delta": item["content"][0]["text"],
                }
            )
            events.append(
                {
                    "type": "response.output_text.done",
                    "output_index": index,
                    "content_index": 0,
                    "item_id": item["id"],
                    "text": item["content"][0]["text"],
                }
            )
        events.append(
            {"type": "response.output_item.done", "output_index": index, "item": item}
        )
    events.append(
        {
            "type": "response.incomplete" if incomplete else "response.completed",
            "response": response,
        }
    )
    return "".join(
        f"event: {event['type']}\ndata: {json.dumps({**event, 'sequence_number': i})}\n\n"
        for i, event in enumerate(events)
    ).encode()


def answer(text="Fixture completed."):
    return {
        "type": "message",
        "id": "msg_" + uuid.uuid4().hex,
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": text, "annotations": []}],
    }


def call(name, args):
    return {
        "type": "function_call",
        "id": "fc_" + uuid.uuid4().hex,
        "call_id": "call_" + uuid.uuid4().hex,
        "name": name,
        "arguments": json.dumps(args),
        "status": "completed",
    }


class RecordingUpstream(ThreadingHTTPServer):
    def __init__(self):
        super().__init__(("127.0.0.1", 0), RecordingHandler)
        self.cases = {}
        self.records = {}
        self.lock = threading.Lock()


class RecordingHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        case_id = next(
            key
            for key in tuple(self.server.cases)
            if key in json.dumps(payload["input"])
        )
        mode = self.server.cases[case_id]
        with self.server.lock:
            records = self.server.records.setdefault(case_id, [])
            records.append(payload)
            round_number = len(records)
        if mode == "budget" and round_number == 1:
            time.sleep(30.1)  # Exercise the real minimum research budget.
        if mode == "provider_failure":
            self.send_response(503)
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"Fixture unavailable"}}')
            return
        outputs = []
        if round_number == 1 and mode not in {"answer", "provider_failure"}:
            operations = {
                "list": {"operation": "list_skills"},
                "resource": {
                    "operation": "load_skill",
                    "skill_name": "heavy",
                    "resource": "reference.md",
                },
                "missing": {"operation": "load_skill", "skill_name": "missing"},
                "error": {
                    "operation": "load_skill",
                    "skill_name": "heavy",
                    "resource": "missing.md",
                },
                "unmapped": {"operation": "load_skill", "skill_name": "light"},
            }
            outputs = [
                {
                    "type": "reasoning",
                    "id": "rs_fixture",
                    "summary": [{"type": "summary_text", "text": "Fixture plan."}],
                },
                call(
                    "skills",
                    operations.get(
                        mode, {"operation": "load_skill", "skill_name": "heavy"}
                    ),
                ),
            ]
            if mode == "parallel":
                outputs.append(
                    call("skills", {"operation": "load_skill", "skill_name": "light"})
                )
        else:
            outputs = [
                answer(
                    "Useful partial fixture."
                    if mode == "retry" and round_number == 2
                    else "Fixture completed."
                )
            ]
        wire = response_events(
            outputs, incomplete=mode == "retry" and round_number == 2
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(wire)))
        self.end_headers()
        self.wfile.write(wire)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def run_suite(routed, upstream, directory):
    port = free_port()
    configuration = {
        "functions": {
            "clock": {"_type": "current_datetime", "verbose": False},
            "skills": {
                "_type": "agent_skills",
                "skills_directory": str(directory / "skills"),
            },
        },
        "general": {
            "enable_per_user_monitoring": False,
            "front_end": {
                "_type": "fastapi",
                "runner_class": "nat_helpers.front_end.DaedalusFastApiFrontEndPluginWorker",
                "enable_interactive_extensions": True,
            },
        },
        "llms": {
            "tool_calling_llm": {
                "_type": "openai",
                "api_type": "responses",
                "api_key": "fixture",
                "base_url": f"http://127.0.0.1:{upstream.server_port}/v1",
                "model_name": "fixture/default",
                "max_retries": 0,
                "request_timeout": 45,
                "truncation": "auto",
            }
        },
        "workflow": {
            "_type": "daedalus_per_user_responses_api_agent",
            "llm_name": "tool_calling_llm",
            "nat_tools": ["skills", "clock"],
            "daily_summary_nat_tools": ["skills"],
            "daily_summary_final_nat_tools": ["clock"],
            "max_iterations": 5,
            "daily_summary_research_budget_seconds": 30,
            "tool_output_compaction_enabled": False,
            "instructions": "Preserve these fixture instructions.",
            "parallel_tool_calls": True,
            "verbose": False,
        },
    }
    if routed:
        configuration["workflow"].update(
            model_routes={"deep": "fixture/deep", "deep_max": "fixture/max"},
            request_model_profiles={"daily_summary": "deep"},
            skill_model_profiles={"heavy": "deep"},
        )
    config_file = directory / "config.yaml"
    config_file.write_text(yaml.safe_dump(configuration))
    env = {
        **os.environ,
        "NAT_CONFIG_FILE": str(config_file),
        "NAT_HOST": "127.0.0.1",
        "NAT_PORT": str(port),
        "DAEDALUS_MEMORY_MODE": "disabled",
        "DAEDALUS_RAG_READINESS_MODE": "disabled",
        "DAEDALUS_MEMORY_READINESS_MODE": "degraded",
        "DAEDALUS_INTERNAL_API_TOKEN": "routing-fixture-internal",
        "LOG_LEVEL": "INFO",
    }
    base_url = f"http://127.0.0.1:{port}"
    log_path = directory / f"backend-{routed}.log"
    results = []
    with log_path.open("w") as log:
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name("entrypoint.py"))],
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )  # nosec B603 - fixed local runtime entrypoint
        try:
            with httpx.Client(timeout=2) as client:
                for _ in range(180):
                    require(
                        process.poll() is None,
                        f"Backend exited: {log_path.read_text()[-8000:]}",
                    )
                    try:
                        if client.get(base_url + "/health/ready").is_success:
                            break
                    except httpx.TransportError:
                        pass
                    time.sleep(0.5)
                else:
                    raise RuntimeError(
                        f"Backend readiness timed out: {log_path.read_text()[-8000:]}"
                    )

            def invoke(
                mode="promote",
                profile="omitted",
                streaming=True,
                daily=False,
                user="same-user",
                invalid=False,
                image=False,
                historical=False,
            ):
                case_id = "routing-fixture-" + uuid.uuid4().hex
                upstream.cases[case_id] = mode
                text = case_id + (" daily summary" if daily else " inspect fixture")
                content = (
                    [
                        {"type": "text", "text": text},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="
                            },
                        },
                    ]
                    if image
                    else text
                )
                props = {} if profile == "omitted" else {"model_profile": profile}
                history = (
                    [
                        {"role": "user", "content": "Prior completed request"},
                        {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call_old",
                                    "type": "function",
                                    "function": {
                                        "name": "skills",
                                        "arguments": '{"operation":"load_skill","skill_name":"heavy"}',
                                    },
                                }
                            ],
                        },
                        {
                            "role": "tool",
                            "tool_call_id": "call_old",
                            "content": "Prior instructions",
                        },
                        {"role": "assistant", "content": "Prior answer"},
                    ]
                    if historical
                    else []
                )
                response = httpx.post(
                    base_url + "/v1/chat/completions",
                    json={
                        "messages": [*history, {"role": "user", "content": content}],
                        "stream": streaming,
                        "additional_props": props,
                    },
                    headers={
                        "Cookie": f"nat-session={user}",
                        "x-user-id": user,
                        "x-daedalus-internal-token": "routing-fixture-internal",
                    },
                    timeout=45,
                )
                records = upstream.records.get(case_id, [])
                if invalid:
                    require(not records, f"Invalid profile reached upstream: {profile}")
                    require(
                        not response.is_success or "error" in response.text.lower(),
                        "Invalid profile was silently accepted",
                    )
                    return {"case": "invalid", "profile": profile, "calls": 0}
                require(
                    response.is_success,
                    f"HTTP {response.status_code}: {response.text[:1000]}",
                )
                if mode == "provider_failure":
                    require(len(records) == 1, "Provider failure caused recovery calls")
                    require(
                        "Fixture completed." not in response.text,
                        "Provider failure reported completion",
                    )
                else:
                    require(
                        "Fixture completed." in response.text,
                        f"Missing answer: {response.text[-1500:]}; logs: {log_path.read_text()[-4000:]}",
                    )
                    require(
                        len(records)
                        == (1 if mode == "answer" else 3 if mode == "retry" else 2),
                        "Unexpected tool replay or missing round",
                    )
                expected = {
                    "default": "fixture/default",
                    "deep": "fixture/deep",
                    "deep_max": "fixture/max",
                }.get(profile)
                for index, payload in enumerate(records):
                    automatic = (
                        "fixture/deep"
                        if routed
                        and (
                            daily
                            or (index > 0 and mode in {"promote", "parallel", "retry"})
                        )
                        else "fixture/default"
                    )
                    require(
                        payload["model"] == (expected or automatic),
                        f"Incorrect alias: {payload['model']}",
                    )
                    require(
                        payload.get("instructions")
                        == "Preserve these fixture instructions.",
                        "Lost instructions",
                    )
                    require(
                        payload.get("parallel_tool_calls") is True,
                        "Lost parallel calls",
                    )
                    require(
                        not (
                            {
                                "reasoning",
                                "reasoning_effort",
                                "temperature",
                                "top_p",
                                "previous_response_id",
                            }
                            & payload.keys()
                        ),
                        "Routing injected provider policy or continuation",
                    )
                    require(
                        payload.get("truncation") == "auto", "Lost transport option"
                    )
                    if index == 1:
                        calls = [
                            item
                            for item in payload["input"]
                            if item.get("type") == "function_call"
                        ]
                        outputs = [
                            item
                            for item in payload["input"]
                            if item.get("type") == "function_call_output"
                        ]
                        require(
                            calls
                            and {item["call_id"] for item in calls}
                            == {item["call_id"] for item in outputs},
                            "Lost call/result association",
                        )
                        require(
                            any(
                                item.get("type") == "reasoning"
                                for item in payload["input"]
                            ),
                            "Lost reasoning history",
                        )
                        if image:
                            require(
                                "input_image" in json.dumps(payload["input"]),
                                "Lost image history",
                            )
                    if (mode == "retry" and index == 2) or (
                        mode == "budget" and index == 1
                    ):
                        require(
                            [tool["name"] for tool in payload["tools"]] == ["clock"],
                            "Synthesis restored research tools",
                        )
                if streaming and mode != "provider_failure":
                    stream_models = [
                        json.loads(line[6:]).get("model")
                        for line in response.text.splitlines()
                        if line.startswith("data: ")
                        and line != "data: [DONE]"
                        and "choices" in line
                    ]
                    require(
                        bool(stream_models)
                        and set(stream_models) <= {p["model"] for p in records},
                        "Stream metadata does not match outgoing routes",
                    )
                return {
                    "case": mode,
                    "profile": profile,
                    "streaming": streaming,
                    "daily": daily,
                    "aliases": [p["model"] for p in records],
                }

            for streaming in (False, True):
                for profile in (
                    ["omitted", "default", "deep", "deep_max"]
                    if routed
                    else ["omitted", "default"]
                ):
                    results.append(
                        invoke(profile=profile, streaming=streaming, image=True)
                    )
                if routed:
                    results.append(invoke(daily=True, streaming=streaming))
                    results.append(
                        invoke(mode="retry", daily=True, streaming=streaming)
                    )
                for profile in (
                    [None, "", "invalid", True, 1, {}, []]
                    if routed
                    else ["deep", "deep_max"]
                ):
                    results.append(
                        invoke(profile=profile, streaming=streaming, invalid=True)
                    )
            if routed:
                results.append(invoke(mode="budget", daily=True))
                for mode in (
                    "list",
                    "resource",
                    "missing",
                    "error",
                    "unmapped",
                    "parallel",
                    "provider_failure",
                ):
                    results.append(invoke(mode=mode))
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                    futures = [
                        pool.submit(invoke, profile=profile, user=user)
                        for profile, user in [
                            ("default", "same-user"),
                            ("deep_max", "same-user"),
                            ("omitted", "other-user"),
                            ("deep", "third-user"),
                        ]
                    ]
                    results.extend(future.result() for future in futures)
                results.append(
                    invoke(mode="answer")
                )  # Fresh request after all promotions.
                results.append(invoke(mode="answer", historical=True))
            logs = log_path.read_text()
            require(
                "Main-agent model selection:" in logs
                and "requested_route_alias" in logs,
                "Missing routing diagnostics",
            )
            require(
                '"requested_model_profile": "automatic"' in logs,
                "Missing automatic selection diagnostics",
            )
        finally:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    return results


def main():
    require(
        bool(os.environ.get("REDIS_URL")),
        "Set REDIS_URL to a disposable test Redis instance",
    )
    with tempfile.TemporaryDirectory(prefix="daedalus-routing-") as temporary:
        directory = Path(temporary)
        for name in ("heavy", "light"):
            skill = directory / "skills" / name
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text(
                f"---\nname: {name}\ndescription: Fixture skill\n---\nUse the fixture evidence."
            )
            (skill / "reference.md").write_text("Fixture reference.")
        upstream = RecordingUpstream()
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        try:
            results = (
                run_suite(False, upstream, directory)
                + run_suite(True, upstream, directory)
                + run_suite(False, upstream, directory)
            )
            print(
                json.dumps(
                    {"passed": True, "cases": len(results), "results": results},
                    indent=2,
                )
            )
        finally:
            upstream.shutdown()
            upstream.server_close()


if __name__ == "__main__":
    main()
