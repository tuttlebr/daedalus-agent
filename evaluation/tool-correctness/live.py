"""Frozen synthetic semantic checks against an authorized live backend.

Emits JSONL to stdout, including every failed attempt. Credentials are read only
from DAEDALUS_INTERNAL_API_TOKEN. The caller supplies a disposable synthetic
identity and removes its memory bank/cache after the run.
"""

import argparse
import asyncio
import datetime
import hashlib
import json
import os
import re
import time

import httpx
from gateway import async_response_lines

USER = ""
BASE_URL = "http://127.0.0.1:8000"
RUN_PREFIX = ""
cases = []
for i, (q, a) in enumerate(
    [
        ("17 + 26", "43"),
        ("9 * 7", "63"),
        ("100 - 37", "63"),
        ("144 / 12", "12"),
        ("8 * 11", "88"),
    ]
):
    cases.append(
        {
            "id": f"arithmetic-{i}",
            "stratum": "no-tool",
            "messages": [
                {
                    "role": "user",
                    "content": f"Synthetic arithmetic check. Compute {q}. Reply with only the integer. Do not use tools.",
                }
            ],
            "answer": a,
            "tool": None,
        }
    )
for i in range(5):
    marker = f"FROZEN_{i}_73519"
    hist = []
    for j in range(10):
        hist += [
            {
                "role": "user",
                "content": f"Synthetic record {j}: code is "
                + (marker if j == i else f"DECOY_{j}_11827")
                + ". "
                + ("Neutral filler for this invented record. " * 70),
            },
            {"role": "assistant", "content": f"Record {j} acknowledged."},
        ]
    hist += [
        {
            "role": "user",
            "content": f"Return only the exact code from synthetic record {i}. All needed data is in this conversation. Do not use tools.",
        }
    ]
    cases.append(
        {
            "id": f"history-{i}",
            "stratum": "long-history",
            "messages": hist,
            "answer": marker,
            "tool": None,
        }
    )
for i in range(5):
    cases.append(
        {
            "id": f"clock-{i}",
            "stratum": "clock-read",
            "messages": [
                {
                    "role": "user",
                    "content": f"Synthetic clock validation {i}. Call current_datetime_tool exactly once with no arguments and return only its exact timestamp verbatim. No other tools.",
                }
            ],
            "tool": "current_datetime_tool",
        }
    )
for i in range(5):
    name = f"zz-synthetic-missing-skill-43ee21-{i}"
    cases.append(
        {
            "id": f"missing-skill-{i}",
            "stratum": "bounded-tool-error",
            "messages": [
                {
                    "role": "user",
                    "content": f"Synthetic error handling validation: call agent_skills_tool once with operation load_skill and skill_name {name}. This skill intentionally does not exist. If it is unavailable, reply exactly UNAVAILABLE. Do not retry, list other skills, use other tools, or create anything.",
                }
            ],
            "tool": "agent_skills_tool",
            "skill_name": name,
            "answer": "UNAVAILABLE",
        }
    )
manifest = {
    "workload_id": "synthetic-audit-20261012-v1",
    "workload_hash": hashlib.sha256(
        json.dumps(cases, sort_keys=True).encode()
    ).hexdigest(),
    "measurement": "http_request_to_backend_sse_terminal_ms",
    "first_answer": "first nonempty choices.delta.content",
    "concurrency": 1,
    "repetitions": 3,
    "max_requests": 60,
    "per_request_seconds": 60,
    "suite_seconds": 900,
    "route": "daedalus",
    "identity": USER,
    "history": "synthetic only; fresh backend request per case",
    "cache": "as found; repetition 1 includes first use; no warmups or flushes",
    "acceptance": "All exact answer, required tool, arguments, ID binding, terminal and result assertions must pass; any unauthorized tool is a stop condition. Two consecutive same-class transport failures stop the suite. No candidate or speedup claim.",
}


async def run(client, case, rep):
    run_id = f'{RUN_PREFIX}-{case["id"]}-r{rep}'
    start = time.perf_counter()
    answer = ""
    terminal = []
    calls = []
    results = []
    first = None
    error = None
    code = None
    headers = {
        "x-daedalus-internal-token": os.environ["DAEDALUS_INTERNAL_API_TOKEN"],
        "x-user-id": USER,
        "x-daedalus-request-id": run_id,
        "x-timezone": "UTC",
    }
    try:
        async with asyncio.timeout(60):
            async with client.stream(
                "POST",
                BASE_URL + "/v1/chat/completions",
                headers=headers,
                json={
                    "stream": True,
                    "messages": case["messages"],
                    "additional_props": {"model_profile": "default"},
                },
            ) as response:
                code = response.status_code
                response.raise_for_status()
                async for line in async_response_lines(response):
                    if line.startswith("intermediate_data: "):
                        event = json.loads(line[len("intermediate_data: ") :])
                        (
                            calls
                            if event["name"].startswith("Function Start: ")
                            else results
                        ).append(event)
                    if line.startswith("data: ") and line != "data: [DONE]":
                        data = json.loads(line[6:])
                        if data.get("error"):
                            error = "backend_error"
                        for c in data.get("choices", []):
                            text = c.get("delta", {}).get("content", "")
                            answer += text
                            if text and first is None:
                                first = 1000 * (time.perf_counter() - start)
                            if c.get("daedalus_terminal"):
                                terminal.append(c.get("finish_reason"))
    except Exception as e:
        error = type(e).__name__
    elapsed = 1000 * (time.perf_counter() - start)
    names = [e["name"].removeprefix("Function Start: ") for e in calls]
    expected = case["tool"]
    tool_ok = (
        (not calls and not results)
        if expected is None
        else len(calls) == len(results) == 1
        and names == [expected]
        and calls[0]["id"] == results[0]["id"]
        and calls[0]["parent_id"] == run_id
        and results[0]["parent_id"] == run_id
    )
    result_ok = True
    if expected == "current_datetime_tool" and tool_ok:
        tool_ok = calls[0]["payload"] == {}
        try:
            dt = datetime.datetime.fromisoformat(results[0]["payload"])
            result_ok = (
                abs((datetime.datetime.now(datetime.UTC) - dt).total_seconds()) < 90
            )
        except Exception:
            result_ok = False
        expected_answer = results[0]["payload"]
    elif expected == "agent_skills_tool" and tool_ok:
        args = calls[0]["payload"]
        tool_ok = (
            args.get("operation") == "load_skill"
            and args.get("skill_name") == case["skill_name"]
            and not args.get("resource")
            and not args.get("script")
        )
        result_ok = bool(
            re.search(
                r"not found|unavailable|unknown skill|does not exist",
                str(results[0]["payload"]),
                re.I,
            )
        )
        expected_answer = case["answer"]
    else:
        expected_answer = case.get("answer", "")
    answer_ok = answer.strip() == expected_answer
    return {
        "case_id": case["id"],
        "repetition": rep,
        "stratum": case["stratum"],
        "run_id": run_id,
        "http_status": code,
        "latency_ms": round(elapsed, 2),
        "first_answer_ms": round(first, 2) if first is not None else None,
        "task_success": not error
        and terminal == ["stop"]
        and answer_ok
        and result_ok
        and tool_ok,
        "tool_correct": tool_ok and result_ok,
        "answer_correct": answer_ok,
        "terminal": terminal,
        "error": error,
        "unexpected_tool": any(n != expected for n in names),
        "tool_names": names,
        "answer": answer,
        "calls": calls,
        "results": results,
    }


async def main():
    print(json.dumps({"manifest": manifest}), flush=True)
    start = time.monotonic()
    last_error = None
    repeated = 0
    passed = 0
    async with httpx.AsyncClient(timeout=65, trust_env=False) as client:
        for rep in range(1, 4):
            # Frozen interleaving of strata; reverse within each stratum for repetition 2.
            order = [
                cases[g * 5 + i]
                for i in (range(4, -1, -1) if rep == 2 else range(5))
                for g in range(4)
            ]
            for case in order:
                if time.monotonic() - start > 900:
                    print(json.dumps({"stopped": "suite_time_limit"}), flush=True)
                    return
                result = await run(client, case, rep)
                print(json.dumps(result), flush=True)
                passed += int(result["task_success"])
                if result["unexpected_tool"]:
                    print(json.dumps({"stopped": "unexpected_tool"}), flush=True)
                    return
                repeated = (
                    repeated + 1
                    if result["error"] and result["error"] == last_error
                    else (1 if result["error"] else 0)
                )
                last_error = result["error"]
                if repeated >= 2:
                    print(
                        json.dumps({"stopped": "repeated_transport_failure"}),
                        flush=True,
                    )
                    return
    print(
        json.dumps({"suite_completed": True, "attempts": 60, "passed": passed}),
        flush=True,
    )
    return passed == 60


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument(
        "--identity",
        required=True,
        help="Disposable synthetic user identity; never a real user",
    )
    parser.add_argument(
        "--run-prefix", required=True, help="Unique prefix for this evaluation"
    )
    for field in (
        "source-revision",
        "backend-digest",
        "workflow-digest",
        "switchyard-digest",
        "routes-digest",
    ):
        parser.add_argument("--" + field, required=True)
    args = parser.parse_args()
    if not args.identity.startswith("synthetic-"):
        parser.error("identity must start with synthetic-")
    if not os.environ.get("DAEDALUS_INTERNAL_API_TOKEN"):
        parser.error("DAEDALUS_INTERNAL_API_TOKEN is required")
    USER = args.identity
    BASE_URL = args.base_url.rstrip("/")
    RUN_PREFIX = args.run_prefix
    manifest = {
        **manifest,
        "identity": USER,
        "source_revision": args.source_revision,
        "backend_digest": args.backend_digest,
        "workflow_digest": args.workflow_digest,
        "switchyard_digest": args.switchyard_digest,
        "routes_digest": args.routes_digest,
        "acceptance": "All 60 frozen tool, argument, ID binding, exact answer, and terminal assertions must pass. No unexpected tools. Current production catalog; synthetic identity only.",
    }
    raise SystemExit(0 if asyncio.run(main()) else 1)
