#!/usr/bin/env python3
"""Prove frozen private-source delivery through a built image without inference.

All model-shaped requests go to scripted loopback HTTP peers. This is transport
evidence only: it cannot establish model attention, editorial quality, empirical
model-window fit, or the benefit of an isolation policy.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import delivery_preflight
import run
import runtime_fixture

HERE = Path(__file__).resolve().parent


def _call(name, arguments, identity):
    return {
        "id": "fc_" + identity,
        "call_id": identity,
        "type": "function_call",
        "name": name,
        "arguments": json.dumps(arguments),
        "status": "completed",
    }


def _edition(case, workload, policy):
    source = case["public_sources"][0]
    return {
        "format": "daily-daedalus/v1",
        "policy_version": policy["policy_version"],
        "generated_at": {
            "iso": workload["as_of"],
            "display": "Frozen synthetic transport preflight",
            "issue_label": "No-inference preflight",
        },
        "description": "Scripted transport check; no editorial quality is measured.",
        "lead": {
            "desk_key": "technology",
            "headline": "Synthetic transport check completed",
            "dek": "A scripted source-transport check without model inference.",
            "paragraphs": [
                "This scripted output proves source delivery only. It is not a model-generated editorial evaluation."
            ],
            "source": {
                "kind": "web",
                "label": "Frozen synthetic source",
                "url": source["url"],
            },
        },
        "day_ahead": {
            "weather": {
                "status": "unavailable",
                "title": "Weather",
                "rows": [],
                "note": "No forecast is requested in this scripted preflight.",
            },
            "email_calendar": {
                "status": "covered",
                "agenda": [],
                "actions": [],
                "lookahead": [],
                "source": {
                    "kind": "tool",
                    "label": "Actual synthetic source reads",
                    "refs": ["gmail_mcp_server", "calendar_mcp_server"],
                },
            },
        },
        "departments": [],
        "operations_details": [],
        "coverage": [
            {
                "desk_key": desk["key"],
                "status": "covered"
                if desk["key"] in {"technology", "email-calendar"}
                else "unavailable",
            }
            for desk in policy["desks"]
        ],
    }


@contextlib.contextmanager
def scripted_provider(case, workload, policy):
    """Exactly three scripted model responses; no real provider is reachable."""
    requests = []
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            return

        def event(self, value):
            self.wfile.write(("data: " + json.dumps(value) + "\n\n").encode())

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            with lock:
                stage = len(requests)
                requests.append({"path": self.path, "body": body})
            if stage == 0:
                items = [
                    _call(
                        "agent_skills_tool",
                        {"operation": "load_skill", "skill_name": "daily-summary"},
                        "delivery_skill",
                    )
                ]
            elif stage == 1:
                items = [
                    _call(
                        "gmail_mcp_server__search_threads",
                        {"query": "newer_than:3d"},
                        "delivery_mail",
                    ),
                    _call(
                        "calendar_mcp_server__list_events",
                        {
                            "startTime": "2026-10-26T00:00:00Z",
                            "endTime": "2026-10-29T23:59:59Z",
                            "timeZone": "UTC",
                        },
                        "delivery_calendar",
                    ),
                    _call("current_datetime_tool", {}, "delivery_clock"),
                ]
            elif stage == 2:
                items = [
                    _call(
                        "briefing_renderer_tool",
                        {"edition": _edition(case, workload, policy)},
                        "delivery_renderer",
                    )
                ]
            else:
                self.send_error(409, "scripted preflight exceeded its three responses")
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            if self.path.endswith("/chat/completions"):
                self.event(
                    {
                        "id": "mock-delivery-chat",
                        "object": "chat.completion.chunk",
                        "model": body["model"],
                        "created": 1,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {
                                    "role": "assistant",
                                    "tool_calls": [
                                        {
                                            "index": index,
                                            "id": item["call_id"],
                                            "type": "function",
                                            "function": {
                                                "name": item["name"],
                                                "arguments": item["arguments"],
                                            },
                                        }
                                        for index, item in enumerate(items)
                                    ],
                                },
                                "finish_reason": None,
                            }
                        ],
                    }
                )
                self.event(
                    {
                        "id": "mock-delivery-chat",
                        "object": "chat.completion.chunk",
                        "model": body["model"],
                        "created": 1,
                        "choices": [
                            {"index": 0, "delta": {}, "finish_reason": "tool_calls"}
                        ],
                    }
                )
                self.wfile.write(b"data: [DONE]\n\n")
            else:
                for index, item in enumerate(items):
                    self.event(
                        {
                            "type": "response.output_item.added",
                            "output_index": index,
                            "sequence_number": index * 3,
                            "item": {**item, "status": "in_progress", "arguments": ""},
                        }
                    )
                    self.event(
                        {
                            "type": "response.function_call_arguments.delta",
                            "output_index": index,
                            "item_id": item["id"],
                            "sequence_number": index * 3 + 1,
                            "delta": item["arguments"],
                        }
                    )
                    self.event(
                        {
                            "type": "response.output_item.done",
                            "output_index": index,
                            "sequence_number": index * 3 + 2,
                            "item": item,
                        }
                    )
                self.event(
                    {
                        "type": "response.completed",
                        "sequence_number": len(items) * 3,
                        "response": {
                            "id": "mock-delivery-response",
                            "object": "response",
                            "created_at": 1,
                            "status": "completed",
                            "model": body["model"],
                            "output": items,
                        },
                    }
                )
            self.wfile.flush()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def check(image: str, redis_image: str, output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    workload = run.load_workload(HERE / "workload.json")
    bundle = output / "synthetic-skills"
    run.make_synthetic_bundle(bundle)
    policy = json.loads(
        (bundle / "daily-summary/references/edition-policy.json").read_text()
    )
    budget = run.AttemptBudget(16, 900)
    report = {
        "schema_version": 1,
        "mock_only": True,
        "real_model_inference": False,
        "requested_image": image,
        "workload_sha256": delivery_preflight.digest(workload),
        "workload_file_sha256": hashlib.sha256(
            (HERE / "workload.json").read_bytes()
        ).hexdigest(),
        "host_sources_sha256": {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(HERE.glob("*.py"))
        },
        "cases": [],
    }
    for case_id in ("personal-heavy", "long-context"):
        case = next(case for case in workload["cases"] if case["id"] == case_id)
        for variant, role in (("baseline", "baseline"), ("candidate", "local")):
            target = output / f"{variant}-{case_id}"
            target.mkdir()
            with scripted_provider(case, workload, policy) as (origin, requests):
                routes = {
                    name: run.Route(  # nosec B106 - scripted loopback peer, no real credential
                        role=name,
                        base_url=origin + "/v1",
                        api_type="chat" if name == "local" else "responses",
                        model_name="scripted-delivery-" + name,
                        api_key_env="SYNTHETIC_ONLY",
                        trust="trusted_local" if name == "local" else "approved_cloud",
                        secret="synthetic-no-inference",
                    )
                    for name in run.ROLES
                }
                capture = runtime_fixture.execute_case(
                    image=image,
                    redis_image=redis_image,
                    variant=variant,
                    repetition=0,
                    case=case,
                    workload=workload,
                    routes=routes,
                    budget=budget,
                    bundle=bundle,
                    output=target,
                    per_run_timeout=420,
                    max_iterations=128,
                    max_output_tokens_per_attempt=8192,
                )
                capture["mock_only"] = True
                capture["real_model_inference"] = False
                capture["scripted_provider_request_count"] = len(requests)
            capture_path = target / "capture.json"
            capture_path.write_text(json.dumps(capture, indent=2) + "\n")
            delivery = delivery_preflight.check_delivery(
                workload, capture, case_id, role
            )
            (target / "delivery.json").write_text(json.dumps(delivery, indent=2) + "\n")
            report["cases"].append(
                {
                    "case_id": case_id,
                    "variant": variant,
                    "capture_sha256": hashlib.sha256(
                        capture_path.read_bytes()
                    ).hexdigest(),
                    "delivery": delivery,
                    "scripted_provider_request_count": len(requests),
                }
            )
    report["passed"] = all(
        item["delivery"]["delivery_passed"]
        and item["delivery"]["actual_built_image_recorded"]
        and item["delivery"]["workflow_and_provider_completed"]
        and not item["delivery"]["empirical_workload_fit"]
        and item["scripted_provider_request_count"] == 3
        for item in report["cases"]
    )
    report["scripted_attempts"] = budget.count
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = check(args.image, args.redis_image, args.output)
    print(
        json.dumps(
            {
                "passed": report["passed"],
                "mock_only": True,
                "cases": len(report["cases"]),
                "scripted_attempts": report["scripted_attempts"],
            }
        )
    )
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
