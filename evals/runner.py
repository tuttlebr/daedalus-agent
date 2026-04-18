#!/usr/bin/env python3
"""Daedalus evaluation runner.

Posts queries to the backend /chat/stream endpoint, parses the SSE
response for tool-call traces and final response text, then dispatches
to evaluators and prints a summary.

Usage:
    python runner.py [--dataset routing] [--dataset factuality] \
                     [--backend http://localhost:8000] [--case <id>]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

EVALS_DIR = Path(__file__).parent
DEFAULT_BACKEND_URL = os.environ.get("DAEDALUS_BACKEND_URL", "http://localhost:8000")
EVAL_USER_ID = os.environ.get("DAEDALUS_EVAL_USER", "eval_user")
REQUEST_TIMEOUT_S = float(os.environ.get("DAEDALUS_EVAL_TIMEOUT", "900"))


@dataclass
class ToolEvent:
    name: str
    event_type: str
    payload: str
    parent_id: str
    step_id: str


@dataclass
class TraceResult:
    case_id: str
    query: str
    response: str
    events: list[ToolEvent] = field(default_factory=list)
    latency_seconds: float = 0.0
    error: str | None = None


def build_request_payload(query: str, user_id: str) -> dict:
    identity = (
        f"[IDENTITY] The authenticated user for this session is: {user_id}. "
        f'Use user_id="{user_id}" for ALL memory operations '
        f"(get_memory, add_memory, delete_memory)."
    )
    return {
        "messages": [
            {"role": "user", "content": identity},
            {"role": "user", "content": query},
        ],
        "model": "string",
        "temperature": 0,
        "max_tokens": 0,
        "top_p": 0,
        "use_knowledge_base": True,
        "top_k": 0,
        "collection_name": "string",
        "stop": True,
        "stream": True,
        "user_id": user_id,
        "additional_props": {"enableIntermediateSteps": True},
        "stream_options": {"include_usage": True},
    }


def normalize_intermediate(parsed: dict) -> ToolEvent | None:
    name_raw = parsed.get("name") or ""
    is_complete = "Complete:" in name_raw
    is_workflow = "<workflow>" in name_raw
    clean_name = (
        name_raw.replace("Function Start: ", "")
        .replace("Function Complete: ", "")
        .replace("<", "")
        .replace(">", "")
    ) or "unknown"
    if is_workflow:
        event_type = "WORKFLOW_END" if is_complete else "WORKFLOW_START"
    else:
        event_type = "TOOL_END" if is_complete else "TOOL_START"
    return ToolEvent(
        name=clean_name,
        event_type=event_type,
        payload=str(parsed.get("payload", "")),
        parent_id=parsed.get("parent_id") or "root",
        step_id=parsed.get("id") or "",
    )


def extract_content(parsed: dict) -> str:
    choices = parsed.get("choices") or [{}]
    first = choices[0] if choices else {}
    return (
        first.get("delta", {}).get("content")
        or first.get("message", {}).get("content")
        or parsed.get("output")
        or parsed.get("content")
        or ""
    )


def run_case(case: dict, backend_url: str, user_id: str) -> TraceResult:
    import httpx

    case_id = str(case.get("id", "unknown"))
    query = case["query"]
    stream_url = f"{backend_url.rstrip('/')}/chat/stream"
    payload = build_request_payload(query, user_id)
    events: list[ToolEvent] = []
    response_chunks: list[str] = []
    error: str | None = None
    started = time.monotonic()

    try:
        with httpx.stream(
            "POST",
            stream_url,
            json=payload,
            headers={"Content-Type": "application/json", "x-user-id": user_id},
            timeout=REQUEST_TIMEOUT_S,
        ) as r:
            if r.status_code != 200:
                body = b"".join(r.iter_bytes()).decode("utf-8", errors="replace")
                error = f"backend returned {r.status_code}: {body[:500]}"
            else:
                for raw_line in r.iter_lines():
                    if not raw_line:
                        continue
                    if raw_line.startswith("data: "):
                        data = raw_line[6:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            parsed = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        if parsed.get("error"):
                            continue
                        chunk = extract_content(parsed)
                        if isinstance(chunk, str) and chunk:
                            response_chunks.append(chunk)
                    elif raw_line.startswith("intermediate_data: "):
                        data = raw_line[len("intermediate_data: ") :].strip()
                        try:
                            parsed = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        event = normalize_intermediate(parsed)
                        if event:
                            events.append(event)
    except Exception as exc:
        error = f"HTTP error: {exc!r}"

    response = "".join(response_chunks).strip()
    if not response and events:
        for ev in reversed(events):
            if ev.event_type != "TOOL_END" or not ev.payload:
                continue
            marker = "**Function Output:**\n```"
            idx = ev.payload.rfind(marker)
            if idx == -1:
                continue
            nl = ev.payload.find("\n", idx + len(marker))
            if nl == -1:
                continue
            chunk = ev.payload[nl + 1 :]
            fence = chunk.rfind("\n```")
            if fence != -1:
                chunk = chunk[:fence]
            chunk = chunk.strip()
            if chunk and chunk != "[]":
                response = chunk
                break

    return TraceResult(
        case_id=case_id,
        query=query,
        response=response,
        events=events,
        latency_seconds=time.monotonic() - started,
        error=error,
    )


def load_dataset(path: Path) -> list[dict]:
    import yaml

    with path.open() as f:
        data = yaml.safe_load(f)
    if not isinstance(data, list):
        raise ValueError(f"{path}: expected list of cases")
    return data


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dataset",
        action="append",
        choices=["routing", "factuality"],
        help="Dataset to run (repeatable; default: all)",
    )
    parser.add_argument("--backend", default=DEFAULT_BACKEND_URL)
    parser.add_argument("--user-id", default=EVAL_USER_ID)
    parser.add_argument("--case", help="Run only this case id")
    parser.add_argument("--out", help="Output JSON path")
    args = parser.parse_args()

    datasets = args.dataset or ["routing", "factuality"]
    out_path = (
        Path(args.out)
        if args.out
        else EVALS_DIR / "results" / f"{datetime.now():%Y-%m-%d_%H%M%S}.json"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)

    sys.path.insert(0, str(EVALS_DIR))
    from evaluators import factuality as factuality_evaluator
    from evaluators import routing as routing_evaluator

    evaluators = {
        "routing": routing_evaluator,
        "factuality": factuality_evaluator,
    }

    all_results: dict[str, Any] = {
        "started_at": datetime.now().isoformat(),
        "backend_url": args.backend,
        "user_id": args.user_id,
        "datasets": {},
    }

    for ds_name in datasets:
        ds_path = EVALS_DIR / "datasets" / f"{ds_name}.yml"
        if not ds_path.exists():
            print(f"warn: dataset file missing: {ds_path}", file=sys.stderr)
            continue
        cases = load_dataset(ds_path)
        if args.case:
            cases = [c for c in cases if str(c.get("id")) == args.case]
        evaluator = evaluators[ds_name]

        print(f"\n== {ds_name} ({len(cases)} cases) ==", file=sys.stderr)
        ds_cases: list[dict] = []
        for case in cases:
            trace = run_case(case, args.backend, args.user_id)
            scored = evaluator.score(case, trace)
            ds_cases.append(
                {
                    "case_id": trace.case_id,
                    "query": trace.query,
                    "latency_s": round(trace.latency_seconds, 2),
                    "error": trace.error,
                    "score": scored.score,
                    "pass": scored.passed,
                    "detail": scored.detail,
                    "response_preview": trace.response[:400],
                    "events": [asdict(ev) for ev in trace.events],
                }
            )
            status = "PASS" if scored.passed else "FAIL"
            print(
                f"  [{status}] {trace.case_id} score={scored.score:.2f} "
                f"({trace.latency_seconds:.1f}s)",
                file=sys.stderr,
            )
            for reason in scored.detail.get("reasons", [])[:3]:
                print(f"     - {reason}", file=sys.stderr)

        if ds_cases:
            passed = sum(1 for c in ds_cases if c["pass"])
            avg = sum(c["score"] for c in ds_cases) / len(ds_cases)
            all_results["datasets"][ds_name] = {
                "n": len(ds_cases),
                "passed": passed,
                "avg_score": round(avg, 3),
                "cases": ds_cases,
            }

    with out_path.open("w") as f:
        json.dump(all_results, f, indent=2)

    print("\n# Eval Results\n")
    print(f"- Run: `{all_results['started_at']}`")
    print(f"- Backend: `{all_results['backend_url']}`")
    print(f"- Output: `{out_path}`\n")
    any_fail = False
    for name, ds in all_results["datasets"].items():
        pct = (ds["passed"] / ds["n"] * 100) if ds["n"] else 0.0
        print(f"## {name}")
        print(f"- Pass rate: **{ds['passed']}/{ds['n']}** ({pct:.0f}%)")
        print(f"- Avg score: **{ds['avg_score']}**")
        fails = [c for c in ds["cases"] if not c["pass"]]
        if fails:
            any_fail = True
            print(f"\n### Failures ({len(fails)})")
            for c in fails:
                reasons = c["detail"].get("reasons") or ["(see detail)"]
                print(f"- `{c['case_id']}` score={c['score']}: {reasons[0]}")
        print()

    return 1 if any_fail else 0


if __name__ == "__main__":
    sys.exit(main())
