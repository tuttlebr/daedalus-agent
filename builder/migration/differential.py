#!/usr/bin/env python3
"""Compare shared legacy contracts and both current preparation implementations.

The retained image predates required-tool enforcement and batch/decode recovery.
Those current safety contracts run against both candidate profiles, while the
legacy comparison uses a fixed text/clock/profile workload supported by all three.
No live providers or production Redis are contacted.
"""

import argparse
import json
import re
import sys
from pathlib import Path

from image_check import compare_preparation, environment, require

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime_http_check import check


def requests_by_conversation(report):
    """Ignore cross-conversation scheduling, retaining every ordered round."""
    grouped = {}
    for request in report["requests"]:
        grouped.setdefault(request["user"], []).append(request)
    return grouped


def compatibility_check(image, redis_image, *, preparation):
    """Version 1: complete model requests for text/clock across four profiles."""
    with environment(
        image, redis_image, minimal=preparation == "rust", memory=False
    ) as fixture:
        client, base, headers, peers = (
            fixture[key] for key in ("client", "base", "headers", "peers")
        )
        for profile in (None, "default", "deep", "deep_max"):
            for scenario in ("TEXT_ONLY", "BASIC"):
                run = f"compat-v1-{profile}-{scenario}"
                response = client.post(
                    base + "/v1/chat/completions",
                    headers={
                        **headers,
                        "x-daedalus-request-id": run,
                        "x-conversation-id": run,
                    },
                    json={
                        "stream": True,
                        "messages": [{"role": "user", "content": scenario}],
                        "additional_props": {"model_profile": profile}
                        if profile
                        else {},
                    },
                )
                require(
                    response.status_code == 200, f"{run}: HTTP {response.status_code}"
                )
                require(
                    '"finish_reason":"stop"' in response.text, f"{run}: no completion"
                )
                answer = (
                    "Synthetic text response 雪🌲."
                    if scenario == "TEXT_ONLY"
                    else "The real datetime tool completed"
                )
                require(answer in response.text, f"{run}: missing answer")
                if scenario == "BASIC":
                    require(
                        "Function Complete: current_datetime_tool" in response.text,
                        f"{run}: clock was not executed",
                    )
        requests = json.loads(json.dumps(peers.requests))
        for request in requests:
            clocks = {
                item["call_id"]
                for item in request.get("input", [])
                if item.get("type") == "function_call"
                and item.get("name") == "current_datetime_tool"
            }
            for item in request.get("input", []):
                if (
                    item.get("type") == "function_call_output"
                    and item.get("call_id") in clocks
                    and re.fullmatch(
                        r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?[+-]\d\d:\d\d",
                        item.get("output", ""),
                    )
                ):
                    item["output"] = "<clock-instant>"
        return {"version": 1, "model_requests": requests}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    compatible = []
    for name, image, preparation in [
        ("baseline", args.baseline, "python"),
        ("candidate", args.candidate, "rust"),
        ("candidate-python", args.candidate, "python"),
    ]:
        report = compatibility_check(image, args.redis_image, preparation=preparation)
        (args.output / f"compatibility-{name}.json").write_text(
            json.dumps(report, indent=2) + "\n"
        )
        compatible.append(report)
    # Reuse the existing, explicit three-field tool-policy compatibility rule.
    # Current Python/Rust requests must match without any such adjustment.
    compare_preparation(compatible[1], compatible[0], compatible[2])

    reports = []
    for name, preparation in [("candidate", "rust"), ("candidate-python", "python")]:
        report = args.output / f"{name}.json"
        check(
            image=args.candidate,
            redis_image=args.redis_image,
            preparation=preparation,
            report=report,
        )
        reports.append(requests_by_conversation(json.loads(report.read_text())))
    require(
        reports[0] == reports[1],
        f"Current preparation difference: compare {args.output}",
    )
    print(
        "Legacy text/clock/profile compatibility and full current HTTP/model/tool "
        "contracts passed in both preparation modes. Clock instants normalized; "
        "round ordering retained within each conversation."
    )


if __name__ == "__main__":
    main()
