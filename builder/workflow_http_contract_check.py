"""Exercise a built backend over HTTP against a disposable local Responses fixture.

Run on a Linux Docker host with ``python3 builder/workflow_http_contract_check.py
--image <local-image>``. No live providers, Redis, or real credentials are used.
Both servers bind only to loopback; the backend container is always removed.
Fixture requests, response bodies and logs remain in the printed evidence folder.
"""

import argparse
import json
import shutil
import socket
import subprocess  # nosec B404 - local Docker fixture with explicit argv, no shell
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parent / "nat_helpers" / "src" / "nat_helpers"
PARTIAL = "HTTP_FIXTURE_RESEARCH: retained useful partial findings."
CALLS = []
RESP_MODES = {}
PROVIDER_EVENTS = []


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def response(identifier, output=None, status="in_progress"):
    return {
        "id": identifier,
        "object": "response",
        "created_at": int(time.time()),
        "model": "fixture",
        "status": status,
        "output": output or [],
        "error": None,
        "incomplete_details": None,
        "instructions": None,
        "parallel_tool_calls": False,
        "tools": [],
        "tool_choice": "auto",
        "usage": None,
        "service_tier": "default",
        "text": {"format": {"type": "text"}},
    }


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        CALLS.append(payload)
        if self.path != "/v1/responses" or payload.get("stream") is not True:
            self.send_error(400, "Expected streamed Responses API request")
            return
        inputs = payload.get("input", [])
        mode = RESP_MODES.get(payload.get("previous_response_id"))
        if mode is None:
            serialized = json.dumps(inputs)
            mode = next(
                (
                    candidate
                    for candidate in (
                        "incomplete_tool",
                        "failed_tool",
                        "incomplete",
                        "failed",
                        "complete",
                        "error",
                    )
                    if "HTTP_MODE_" + candidate.upper() in serialized
                ),
                None,
            )
        if mode is None:
            self.send_error(400, "Missing fixture mode")
            return
        outputs = [
            v
            for v in inputs
            if isinstance(v, dict) and v.get("type") == "function_call_output"
        ]
        identifier = f"resp_fixture_{len(CALLS)}"
        RESP_MODES[identifier] = mode
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        seq = 0

        def event(kind, **data):
            nonlocal seq
            data.update(type=kind, sequence_number=seq)
            PROVIDER_EVENTS.append({"response_id": identifier, "type": kind})
            seq += 1
            self.wfile.write(
                (f"event: {kind}\ndata: " + json.dumps(data) + "\n\n").encode()
            )
            self.wfile.flush()

        event("response.created", response=response(identifier))
        if not outputs:
            item = {
                "type": "function_call",
                "id": f"fc_{identifier}",
                "call_id": f"call_{identifier}",
                "name": "current_datetime_tool",
                "arguments": json.dumps({"unused": "fixture"}),
                "status": "completed",
            }
            event("response.output_item.added", output_index=0, item=item)
            event("response.output_item.done", output_index=0, item=item)
            if mode in {"incomplete_tool", "failed_tool"}:
                terminal = response(
                    identifier,
                    [item],
                    "incomplete" if mode == "incomplete_tool" else "failed",
                )
                if mode == "incomplete_tool":
                    terminal["incomplete_details"] = {"reason": "max_output_tokens"}
                    event("response.incomplete", response=terminal)
                else:
                    terminal["error"] = {
                        "code": "server_error",
                        "message": "Synthetic incomplete tool call",
                    }
                    event("response.failed", response=terminal)
            else:
                event(
                    "response.completed",
                    response=response(identifier, [item], "completed"),
                )
            return
        item = {
            "type": "message",
            "id": f"msg_{identifier}",
            "role": "assistant",
            "status": "in_progress",
            "phase": "final_answer",
            "content": [],
        }
        event("response.output_item.added", output_index=0, item=item)
        event(
            "response.content_part.added",
            output_index=0,
            item_id=item["id"],
            content_index=0,
            part={"type": "output_text", "text": "", "annotations": []},
        )
        event(
            "response.output_text.delta",
            output_index=0,
            item_id=item["id"],
            content_index=0,
            delta=PARTIAL,
            logprobs=[],
        )
        if mode == "error":
            event(
                "error",
                error={
                    "message": "Synthetic fixture interruption",
                    "type": "server_error",
                    "code": "fixture_error",
                },
            )
            return
        item["content"] = [{"type": "output_text", "text": PARTIAL, "annotations": []}]
        item["status"] = "incomplete"
        event(
            "response.output_text.done",
            output_index=0,
            item_id=item["id"],
            content_index=0,
            text=PARTIAL,
            logprobs=[],
        )
        event("response.output_item.done", output_index=0, item=item)
        final = response(identifier, [item], "incomplete")
        final["incomplete_details"] = {"reason": "max_output_tokens"}

        if mode == "complete":
            final["status"] = "completed"
            final["incomplete_details"] = None
            event("response.completed", response=final)
        elif mode == "failed":
            final["status"] = "failed"
            final["error"] = {
                "code": "server_error",
                "message": "Synthetic response.failed fixture",
            }
            event("response.failed", response=final)
        else:
            event("response.incomplete", response=final)


def http(url, payload=None, headers=None):
    request = urllib.request.Request(
        url,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    if not url.startswith("http://127.0.0.1:"):
        raise ValueError("HTTP fixture permits loopback HTTP only")
    with urllib.request.urlopen(request, timeout=50) as result:  # nosec B310 - loopback only
        return result.status, result.read().decode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--image",
        required=True,
        help="Already built local backend image; no registry pull.",
    )
    parser.add_argument(
        "--evidence-dir",
        type=Path,
        help="Keep local fixture config, response bodies and logs here.",
    )
    parser.add_argument("--mount-source", action="store_true")
    args = parser.parse_args()
    evidence_dir = args.evidence_dir or Path(
        tempfile.mkdtemp(prefix="daedalus-http-contract-")
    )
    evidence_dir.mkdir(parents=True, exist_ok=True)
    evidence_dir = evidence_dir.resolve()
    print(f"HTTP fixture evidence: {evidence_dir}", flush=True)
    docker = shutil.which("docker")
    if docker is None:
        raise RuntimeError("Docker is required for the HTTP runtime contract")
    image_id = subprocess.run(  # nosec B603 - local CLI image argument, no shell
        [docker, "image", "inspect", "--format", "{{.Id}}", args.image],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    nat_port = port()
    config = evidence_dir / "config.yaml"
    config.write_text(f"""functions:
  current_datetime_tool:
    _type: current_datetime
    verbose: false
general:
  per_user_workflow_timeout: 600
  front_end:
    _type: fastapi
    runner_class: nat_helpers.front_end.DaedalusFastApiFrontEndPluginWorker
    enable_interactive_extensions: true
    step_adaptor:
      mode: custom
      custom_event_types: [LLM_START, LLM_END, TOOL_START, TOOL_END, WORKFLOW_START, WORKFLOW_END, TASK_START, TASK_END, TTC_START, TTC_END, FUNCTION_START, FUNCTION_END, CUSTOM_START, CUSTOM_END, SPAN_START, SPAN_END]
llms:
  tool_calling_llm:
    _type: openai
    api_type: responses
    api_key: unused-fixture-key
    base_url: http://127.0.0.1:{provider.server_port}/v1
    model_name: fixture
    max_retries: 0
    request_timeout: 15.0
workflow:
  _type: daedalus_per_user_responses_api_agent
  llm_name: tool_calling_llm
  max_iterations: 8
  tool_output_compaction_enabled: false
  nat_tools: [current_datetime_tool]
  instructions: Use fixture tool and report results.
  verbose: false
""")
    name = f"daedalus-http-contract-{uuid.uuid4().hex[:8]}"
    log_path = evidence_dir / f"{name}.log"
    command = [
        docker,
        "run",
        "--rm",
        "--pull=never",
        "--name",
        name,
        "--network",
        "host",
        "--env",
        f"NAT_PORT={nat_port}",
        "--env",
        "NAT_HOST=127.0.0.1",
        "--env",
        "NAT_CONFIG_FILE=/contract/config.yaml",
        "--env",
        "ALLOW_INSECURE_INTERNAL=1",
        "--env",
        "DAEDALUS_MEMORY_MODE=disabled",
        "--env",
        "RAG_READINESS_MODE=disabled",
        "--mount",
        f"type=bind,src={evidence_dir},dst=/contract,readonly",
    ]
    if args.mount_source:
        command += [
            "--mount",
            f"type=bind,src={SOURCE},dst=/workspace/nat_helpers/src/nat_helpers,readonly",
        ]
    command += [args.image]
    with log_path.open("w") as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)  # nosec B603 - fixed Docker argv
        try:
            endpoint = f"http://127.0.0.1:{nat_port}"
            for _ in range(300):
                if process.poll() is not None:
                    raise RuntimeError(f"Backend exited; inspect {log_path}")
                try:
                    http(endpoint + "/openapi.json")
                    break
                except (urllib.error.URLError, ConnectionError):
                    time.sleep(0.2)
            else:
                raise RuntimeError(f"Backend did not start; inspect {log_path}")
            results = []
            for mode in (
                "complete",
                "error",
                "incomplete",
                "failed",
                "incomplete_tool",
                "failed_tool",
            ):
                for streaming, activity in (
                    (True, True),
                    (True, False),
                    (False, False),
                ):
                    before = len(CALLS)
                    before_events = len(PROVIDER_EVENTS)
                    marker = "HTTP_MODE_" + mode.upper()
                    code, body = http(
                        endpoint + "/v1/chat/completions",
                        {
                            "messages": [{"role": "user", "content": marker}],
                            "stream": streaming,
                            "additional_props": {"enableIntermediateSteps": activity},
                        },
                        {
                            "x-user-id": f"fixture-{mode}-{streaming}-{activity}",
                            "Cookie": "nat-session=" + str(uuid.uuid4()),
                        },
                    )
                    suffix = f"{mode}-{streaming}-{activity}"
                    (evidence_dir / f"{suffix}.body").write_text(body)
                    tool_interruption = mode in {"incomplete_tool", "failed_tool"}
                    if not tool_interruption and PARTIAL not in body:
                        raise RuntimeError(
                            f"Partial findings absent: {suffix}; body={body[-500:]}"
                        )
                    requests = CALLS[before:]
                    emitted = PROVIDER_EVENTS[before_events:]
                    expected_terminal = {
                        "complete": "response.completed",
                        "error": "error",
                        "incomplete": "response.incomplete",
                        "failed": "response.failed",
                        "incomplete_tool": "response.incomplete",
                        "failed_tool": "response.failed",
                    }[mode]
                    if not emitted or emitted[-1]["type"] != expected_terminal:
                        raise RuntimeError(
                            f"Fixture emitted wrong terminal event: {suffix}"
                        )
                    if len(requests) != (1 if tool_interruption else 2):
                        raise RuntimeError(
                            f"Expected one tool call then failed provider turn, got {len(requests)}: {suffix}"
                        )
                    tool_outputs = [
                        item["output"]
                        for item in requests[-1]["input"]
                        if item.get("type") == "function_call_output"
                    ]
                    tool_output = tool_outputs[0] if tool_outputs else None
                    if streaming:
                        data = [
                            json.loads(line[6:])
                            for line in body.splitlines()
                            if line.startswith("data: ") and line[6:] != "[DONE]"
                        ]
                        errors = [
                            item
                            for item in data
                            if item.get("error")
                            or (
                                item.get("code") == "workflow_error"
                                and item.get("message")
                            )
                        ]
                        terminals = [
                            item
                            for item in data
                            for choice in item.get("choices", [])
                            if choice.get("finish_reason")
                            or choice.get("daedalus_terminal")
                        ]
                        if mode == "complete":
                            if errors or not terminals:
                                raise RuntimeError(
                                    f"Healthy response did not complete: {suffix}"
                                )
                        elif not errors or terminals:
                            raise RuntimeError(
                                f"Expected JSON stream error and no success terminal: {suffix}; errors={errors}; terminals={terminals}"
                            )
                        if tool_interruption:
                            if "Function Start: current_datetime_tool" in body:
                                raise RuntimeError(
                                    f"Incomplete model response executed a tool: {suffix}"
                                )
                        elif activity:
                            if (
                                "Function Complete: current_datetime_tool" not in body
                                or tool_output not in body
                            ):
                                raise RuntimeError(
                                    f"Tool evidence event absent: {suffix}"
                                )
                        elif mode != "complete" and tool_output not in body:
                            raise RuntimeError(
                                f"Normal API stream lost tool evidence: {suffix}"
                            )
                    else:
                        text = json.loads(body)["choices"][0]["message"]["content"]
                        if mode != "complete" and (
                            "incomplete" not in text.lower()
                            or (tool_output is not None and tool_output not in text)
                        ):
                            raise RuntimeError(
                                f"Nonstream recovery lacks tool evidence/incomplete label: {suffix}; {text}"
                            )
                    results.append(
                        {
                            "mode": mode,
                            "streaming": streaming,
                            "activity_stream": activity,
                            "http_status": code,
                            "provider_calls": len(requests),
                            "provider_terminal_event": expected_terminal,
                            "partial_retained": None if tool_interruption else True,
                            "tool_evidence_checked": not tool_interruption
                            and (mode != "complete" or activity),
                            "incomplete_tools_blocked": tool_interruption,
                        }
                    )
            evidence = {
                "image": args.image,
                "image_id": image_id,
                "mounted_source": args.mount_source,
                "results": results,
                "backend_log": str(log_path),
            }
            (evidence_dir / "result.json").write_text(json.dumps(evidence, indent=2))
            print(json.dumps(evidence, indent=2))
        finally:
            subprocess.run(  # nosec B603 - task-owned container only
                [docker, "stop", "-t", "3", name],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            provider.shutdown()
            provider.server_close()
            (evidence_dir / "provider_requests.json").write_text(
                json.dumps(CALLS, indent=2)
            )


if __name__ == "__main__":
    main()
