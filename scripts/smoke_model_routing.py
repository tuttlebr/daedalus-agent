#!/usr/bin/env python3
"""Verify real gateway profiles, streaming, tools and cross-route history.

Uses synthetic inputs only. Set OPENAI_API_KEY and pass --base-url; credentials,
prompt bodies, reasoning and tool payloads are never included in the report.
This is a compatibility smoke, not a workload quality or cost evaluation.
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

TOOL = {
    "type": "function",
    "name": "routing_fixture",
    "description": "Read the synthetic routing fixture. No external action.",
    "parameters": {
        "type": "object",
        "properties": {"value": {"type": "string"}},
        "required": ["value"],
        "additionalProperties": False,
    },
}
IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="


def request(base, key, route, history, *, streaming, tool_choice):
    payload = {
        "model": route,
        "input": history,
        "tools": [TOOL],
        "parallel_tool_calls": True,
        "tool_choice": tool_choice,
        "stream": streaming,
        "max_output_tokens": 2048,
    }
    req = urllib.request.Request(
        base.rstrip("/") + "/responses",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    start = time.monotonic()
    summary = {"requested_route_alias": route, "streaming": streaming}
    data = None
    try:
        # Operator-supplied gateway, using the same Responses endpoint as the app.
        with urllib.request.urlopen(req, timeout=120) as response:  # nosec B310
            summary["http_status"] = response.status
            if streaming:
                for line in response:
                    if (
                        not line.startswith(b"data: ")
                        or line.strip() == b"data: [DONE]"
                    ):
                        continue
                    event = json.loads(line[6:])
                    if event.get("type") in {
                        "response.completed",
                        "response.incomplete",
                        "response.failed",
                    }:
                        data = event.get("response")
            else:
                data = json.load(response)
    except urllib.error.HTTPError as exc:
        summary["http_status"] = exc.code
        summary["error_class"] = type(exc).__name__
    except (OSError, ValueError) as exc:
        summary["error_class"] = type(exc).__name__
    summary["seconds"] = round(time.monotonic() - start, 3)
    if data:
        summary.update(
            provider_reported_model=data.get("model"),
            response_status=data.get("status"),
            usage=data.get("usage"),
            output_types=[item.get("type") for item in data.get("output", [])],
        )
    summary["completed"] = bool(data and data.get("status") == "completed")
    return data, summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="Gateway URL ending in /v1")
    parser.add_argument("--default", default="daedalus")
    parser.add_argument("--deep", default="daedalus/deep")
    parser.add_argument("--maximum", default="daedalus/max")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    key = os.environ.get("OPENAI_API_KEY", "")
    results = []
    for streaming in (False, True):
        for first, second, with_image in (
            (args.default, args.deep, False),
            (args.deep, args.deep, False),
            (args.maximum, args.maximum, False),
            (args.default, args.deep, True),
        ):
            content = [
                {
                    "type": "input_text",
                    "text": "Call routing_fixture once with value route-evidence. After its result, reply exactly ROUTE_OK.",
                }
            ]
            if with_image:
                content.append({"type": "input_image", "image_url": IMAGE})
            history = [{"type": "message", "role": "user", "content": content}]
            data, initial = request(
                args.base_url,
                key,
                first,
                history,
                streaming=streaming,
                tool_choice={"type": "function", "name": "routing_fixture"},
            )
            case = {"image": with_image, "calls": [initial], "passed": False}
            calls = [
                item
                for item in (data or {}).get("output", [])
                if item.get("type") == "function_call"
            ]
            if (
                initial["completed"]
                and len(calls) == 1
                and calls[0].get("name") == "routing_fixture"
                and json.loads(calls[0].get("arguments", "{}"))
                == {"value": "route-evidence"}
            ):
                # Preserve every returned reasoning/message/call item. No item
                # stripping or server-side previous_response_id continuation.
                history.extend(data["output"])
                history.append(
                    {
                        "type": "function_call_output",
                        "call_id": calls[0]["call_id"],
                        "output": "route-evidence verified; reply ROUTE_OK",
                    }
                )
                final, followup = request(
                    args.base_url,
                    key,
                    second,
                    history,
                    streaming=streaming,
                    tool_choice="none",
                )
                case["calls"].append(followup)
                text = "".join(
                    block.get("text", "")
                    for item in (final or {}).get("output", [])
                    for block in item.get("content", [])
                    if block.get("type") == "output_text"
                )
                case["passed"] = followup["completed"] and text.strip() == "ROUTE_OK"
            results.append(case)
            args.output.write_text(
                json.dumps(
                    {"passed": all(r["passed"] for r in results), "cases": results},
                    indent=2,
                )
                + "\n"
            )
            print(
                f"{first} -> {second}, stream={streaming}, image={with_image}: {'PASS' if case['passed'] else 'FAIL'}",
                flush=True,
            )
    return 0 if all(result["passed"] for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
