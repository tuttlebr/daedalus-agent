#!/usr/bin/env python3
"""Capture a protected Chat request from a built image using only local mocks."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import re
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path[:0] = [str(ROOT / "builder"), str(ROOT / "builder/migration")]

from image_check import MemoryPeers, environment, run  # noqa: E402
from leaf_check import measure  # noqa: E402

ANSWER = "Synthetic Chat budget fixture completed."
PRIVATE = {
    "system": "PRIVATE_CHAT_SYSTEM_7391",
    "history": "PRIVATE_CHAT_HISTORY_7391",
    "summary": "The fictional reader has a confidential appointment and private records.",
    "message": "PRIVATE_CHAT_MESSAGE_7391",
}


class ChatPeers(MemoryPeers):
    def __init__(self):
        super().__init__()
        self.captures = []
        self.lock = threading.Lock()

    def handler(self):
        peers = self

        class Handler(super().handler()):
            def do_POST(self):
                if not self.path.startswith(("/local/", "/cloud/")):
                    return super().do_POST()
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                with peers.lock:
                    peers.captures.append(
                        {
                            "path": self.path,
                            "body": body,
                            "headers": {
                                key.lower(): value
                                for key, value in self.headers.items()
                                if key.lower() != "authorization"
                            },
                        }
                    )
                if self.path != "/local/v1/chat/completions":
                    return self.reply({"error": "unexpected destination or API"}, 400)
                if not body.get("stream"):
                    return self.reply(
                        {
                            "id": "chatcmpl_synthetic",
                            "object": "chat.completion",
                            "created": 1,
                            "model": "synthetic-local-chat",
                            "choices": [
                                {
                                    "index": 0,
                                    "message": {"role": "assistant", "content": ANSWER},
                                    "finish_reason": "stop",
                                }
                            ],
                            "usage": {
                                "prompt_tokens": 20,
                                "completion_tokens": 8,
                                "total_tokens": 28,
                            },
                        }
                    )
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                for delta, finish in (
                    ({"role": "assistant", "content": ANSWER}, None),
                    ({}, "stop"),
                ):
                    event = {
                        "id": "chatcmpl_synthetic",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": "synthetic-local-chat",
                        "choices": [
                            {"index": 0, "delta": delta, "finish_reason": finish}
                        ],
                    }
                    if finish:
                        event["usage"] = {
                            "prompt_tokens": 20,
                            "completion_tokens": 8,
                            "total_tokens": 28,
                        }
                    self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

        return Handler


@contextlib.contextmanager
def register_redis(root, _peer_port, redis_port, _runtime_port):
    import yaml

    path = root / "config.yaml"
    config = yaml.safe_load(path.read_text())
    config["workflow"]["context_isolation"]["trusted_local_services"]["redis"] = (
        f"rediss://localhost:{redis_port}/0"
    )
    path.write_text(yaml.safe_dump(config))
    yield {}


def thinking_budget_matches(body, include_hard_budget, budget_control):
    if not include_hard_budget:
        return "thinking_token_budget" not in body and "nvext" not in body
    if budget_control == "nvext":
        native = body.get("nvext")
        return (
            "thinking_token_budget" not in body
            and isinstance(native, dict)
            and set(native) == {"max_thinking_tokens"}
            and type(native["max_thinking_tokens"]) is int
            and native["max_thinking_tokens"] == 256
        )
    return (
        "nvext" not in body
        and type(body.get("thinking_token_budget")) is int
        and body["thinking_token_budget"] == 256
    )


def configuration(
    config, port, _runtime_port, *, include_hard_budget=True, budget_control="canonical"
):
    if budget_control not in {"canonical", "nvext"} or (
        not include_hard_budget and budget_control != "canonical"
    ):
        raise ValueError("Choose one supported thinking-budget control")
    origin = f"http://127.0.0.1:{port}"
    config["llms"]["main"].update(
        api_type="chat",
        base_url=origin + "/local/v1",
        model_name="synthetic-local-chat",
        max_retries=0,
    )
    config["llms"]["public"] = {
        **config["llms"]["main"],
        "base_url": origin + "/cloud/v1",
        "model_name": "synthetic-public-chat",
    }
    config["workflow"].update(
        max_iterations=2,
        instructions="Follow the synthetic request. Private local instructions: "
        + PRIVATE["system"],
        model_routes={
            "deep": "synthetic-public-chat",
            "deep_max": "synthetic-public-chat",
        },
        context_isolation={
            "enabled": True,
            "policy_version": "context-isolation-v1",
            "coordinator": "local",
            "destinations": {
                "local": {
                    "llm": "main",
                    "trust": "trusted_local",
                    "transport": "direct",
                    "extra_body": {
                        "thinking_token_budget": 256,
                        "chat_template_kwargs": {
                            "enable_thinking": True,
                            "medium_effort": True,
                        },
                    },
                },
                "cloud": {
                    "llm": "public",
                    "trust": "approved_cloud",
                    "transport": "direct",
                },
            },
            "worker_profiles": {
                "medium": "cloud",
                "high": "cloud",
                "xhigh": "cloud",
                "max": "cloud",
            },
            "trusted_local_services": {},
        },
    )
    options = config["workflow"]["context_isolation"]["destinations"]["local"][
        "extra_body"
    ]
    if budget_control == "nvext":
        del options["thinking_token_budget"]
        options["nvext"] = {"max_thinking_tokens": 256}
    elif not include_hard_budget:
        del options["thinking_token_budget"]


def check(
    image: str,
    redis_image: str,
    output: Path | None = None,
    *,
    include_hard_budget: bool = True,
    budget_control: str = "canonical",
) -> dict:
    if budget_control not in {"canonical", "nvext"} or (
        not include_hard_budget and budget_control != "canonical"
    ):
        raise ValueError("Choose one supported thinking-budget control")
    if re.fullmatch(r"sha256:[a-f0-9]{64}", image) is None:
        raise ValueError("An immutable local runtime image ID is required")
    if output is not None:
        output.mkdir(mode=0o700, parents=True, exist_ok=False)
    peers = ChatPeers()
    report = {
        "schema_version": 1,
        "mock_only": True,
        "status": "failed",
        "requested_image": image,
        "thinking_profile": (
            "native_bounded_efficient"
            if budget_control == "nvext"
            else "bounded_efficient"
            if include_hard_budget
            else "efficient"
        ),
        "budget_control": budget_control if include_hard_budget else None,
        "native_budget_scope": (
            "per_reasoning_span_may_reset; total output and workflow limits remain separate"
            if budget_control == "nvext"
            else None
        ),
        "scope": "One protected non-briefing Chat coordinator request; scripted provider, no real generation or external source access. No renderer or public-worker quality claim.",
        "host_source_sha256": {
            str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (
                Path(__file__),
                ROOT / "builder/migration/image_check.py",
                ROOT / "builder/migration/leaf_check.py",
            )
        },
        "source_manifest_scope": "Host source snapshot, not an embedded-image source attestation. Actual container image ID identifies the executed artifact.",
    }

    def configure(config, port, runtime_port):
        configuration(
            config,
            port,
            runtime_port,
            include_hard_budget=include_hard_budget,
            budget_control=budget_control,
        )

    try:
        with environment(
            image,
            redis_image,
            minimal=True,
            memory=False,
            api_type="chat",
            peers=peers,
            configure=configure,
            namespace_factory=register_redis,
        ) as env:
            report["image_id"] = run(
                "docker",
                "inspect",
                env["container"],
                "--format",
                "{{.Image}}",
                capture_output=True,
                text=True,
            ).stdout.strip()
            report["result"] = measure(
                env,
                message=PRIVATE["message"],
                request_fields={
                    "messages": [
                        {"role": "user", "content": PRIVATE["history"]},
                        {"role": "assistant", "content": PRIVATE["summary"]},
                        {"role": "user", "content": PRIVATE["message"]},
                    ],
                    "additional_props": {
                        "model_profile": "deep",
                        "context_class": "EXTERNAL_ALLOWED",
                        "policy_version": "forged-end-user-policy",
                    },
                },
                extra_headers={
                    "x-context-class": "EXTERNAL_ALLOWED",
                    "x-switchyard-policy": "forged-end-user-policy",
                },
            )
            report["runtime_log"] = (env["root"] / "backend.log").read_text()
            report["protected_enrollment_count"] = len(
                list(env["redis"].scan_iter("daedalus:context-policy:v1:*"))
            )
    except Exception as error:
        report["failure"] = {"kind": type(error).__name__, "message": str(error)}
    report["captures"] = peers.captures
    local = [
        record
        for record in peers.captures
        if record["path"] == "/local/v1/chat/completions"
    ]
    forbidden = {
        "metadata",
        "conversation",
        "previous_response_id",
        "chat_history",
        "private_profile",
        "credentials",
        "attachments",
        "prompt_cache_key",
        "session_id",
    }
    result = report.get("result", {})
    report["checks"] = {
        "actual_immutable_image": report.get("image_id") == image,
        "one_local_chat_request_no_cloud": len(local) == len(peers.captures) == 1,
        "thinking_budget_policy": bool(local)
        and all(
            thinking_budget_matches(record["body"], include_hard_budget, budget_control)
            for record in local
        ),
        "thinking_enabled": bool(local)
        and all(
            record["body"].get("chat_template_kwargs", {}).get("enable_thinking")
            is True
            for record in local
        ),
        "efficient_mode_preserved": bool(local)
        and all(
            record["body"].get("chat_template_kwargs", {}).get("medium_effort") is True
            for record in local
        ),
        "independent_output_cap": bool(local)
        and all(record["body"].get("max_tokens") == 8192 for record in local),
        "private_context_reaches_only_local": bool(local)
        and all(marker in json.dumps(local[0]["body"]) for marker in PRIVATE.values()),
        "no_forbidden_context_or_session_fields": bool(local)
        and all(
            not forbidden.intersection(record["body"])
            and all(
                "session" not in name
                and "conversation" not in name
                and name not in {"x-user-id", "x-context-class", "x-switchyard-policy"}
                for name in record["headers"]
            )
            and (
                "user" not in record["body"]
                or re.fullmatch(r"[a-f0-9]{64}", record["body"]["user"]) is not None
            )
            for record in local
        ),
        "no_forged_policy_metadata": bool(local)
        and all("forged-end-user-policy" not in json.dumps(record) for record in local),
        "protected_enrollment_persisted": report.get("protected_enrollment_count") == 1,
        "scripted_answer_completed": result.get("done") is True
        and not result.get("errors")
        and result.get("answer") == ANSWER
        and result.get("terminal") == "stop",
    }
    report["status"] = "passed" if all(report["checks"].values()) else "failed"
    if output is not None:
        (output / "capture.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--redis-image", default="redis:7.4-alpine")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--budget-control", choices=("canonical", "nvext", "none"), default="canonical"
    )
    args = parser.parse_args()
    report = check(
        args.image,
        args.redis_image,
        args.output,
        include_hard_budget=args.budget_control != "none",
        budget_control="canonical"
        if args.budget_control == "none"
        else args.budget_control,
    )
    print(
        json.dumps(
            {
                "status": report["status"],
                "checks": report["checks"],
                "capture": str(args.output / "capture.json"),
            },
            indent=2,
        )
    )
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
