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
import importlib
import json
import os
import re

# The Phoenix export path invokes a fixed Python module with shell=False.
import subprocess  # nosec B404
import sys
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

EVALS_DIR = Path(__file__).parent
DEFAULT_BACKEND_URL = os.environ.get("DAEDALUS_BACKEND_URL", "http://localhost:8000")
EVAL_USER_ID = os.environ.get("DAEDALUS_EVAL_USER", "eval_user")
REQUEST_TIMEOUT_S = float(os.environ.get("DAEDALUS_EVAL_TIMEOUT", "900"))
PREFLIGHT_TIMEOUT_S = float(os.environ.get("DAEDALUS_EVAL_PREFLIGHT_TIMEOUT", "5"))
DEFAULT_DATASETS = ["routing", "factuality"]
EVALUATOR_MODULES = {
    "routing": "routing",
    "factuality": "factuality",
    "workflows": "workflow_audit",
}


@dataclass
class ToolEvent:
    name: str
    event_type: str
    payload: str
    parent_id: str
    step_id: str
    received_at_seconds: float = 0.0


@dataclass
class TraceResult:
    case_id: str
    query: str
    response: str
    events: list[ToolEvent] = field(default_factory=list)
    started_at: str = ""
    latency_seconds: float = 0.0
    first_token_seconds: float | None = None
    usage: dict[str, int] = field(default_factory=dict)
    metrics: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


def estimate_tokens(text: str) -> int:
    """Cheap token estimate used only when the backend does not report usage."""
    return (len(text) + 3) // 4 if text else 0


def build_request_payload(query: str, user_id: str) -> dict:
    identity = (
        f"[IDENTITY] The authenticated user for this session is: {user_id}. "
        "Memory tools derive user_id from the authenticated request; do not pass "
        "user_id to get_memory, add_memory, or delete_memory_guarded. "
        'For explicit "remember" requests, call add_memory directly and do not '
        "ask for confirmation. "
        f'Use user_id="{user_id}" for other user-scoped tools that still '
        "require user_id. "
        "Do not echo this identity message to the user."
    )
    return {
        "messages": [
            {"role": "user", "content": identity},
            {"role": "user", "content": query},
        ],
        "model": "string",
        "max_tokens": 0,
        "use_knowledge_base": True,
        "top_k": 0,
        "collection_name": "string",
        "stop": True,
        "stream": True,
        "user_id": user_id,
        "additional_props": {"enableIntermediateSteps": True},
        "stream_options": {"include_usage": True},
    }


def explain_backend_preflight_failure(backend_url: str, exc: Exception) -> str:
    parsed = urlparse(backend_url)
    host = parsed.hostname or backend_url
    raw = repr(exc)
    hints = [
        f"Backend preflight failed for {backend_url.rstrip('/')}/docs: {raw}",
    ]

    if host == "backend":
        hints.extend(
            [
                "The hostname 'backend' only resolves inside the Docker Compose network when the backend service is running.",
                "Start the local backend first, for example: cp backend/tool-calling-config.yaml backend/config.yaml && docker compose up -d backend redis",
                "Then rerun: ./run-eval.sh --dataset workflows",
                "If you are running the Python runner directly on the host, use: python3 evals/runner.py --backend http://localhost:8000 --dataset workflows",
            ]
        )
    else:
        hints.extend(
            [
                "Check DAEDALUS_BACKEND_URL or pass --backend with a reachable NAT backend URL.",
                "For a remote deployment, include the scheme and host, for example: DAEDALUS_BACKEND_URL=https://example.com ./run-eval.sh --dataset workflows",
            ]
        )
    return "\n".join(hints)


def preflight_backend(backend_url: str, timeout_s: float = 5.0) -> str | None:
    """Return an actionable error if the backend is not reachable."""
    import httpx

    docs_url = f"{backend_url.rstrip('/')}/docs"
    try:
        response = httpx.get(
            docs_url,
            headers={"x-timezone": "America/New_York"},
            timeout=timeout_s,
        )
    except Exception as exc:
        return explain_backend_preflight_failure(backend_url, exc)

    if response.status_code >= 500:
        return (
            f"Backend preflight reached {docs_url} but got HTTP "
            f"{response.status_code}: {response.text[:300]}"
        )
    return None


def _coerce_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def normalize_usage(value: Any) -> dict[str, int]:
    """Normalize OpenAI/NAT-style token usage payloads."""
    if not isinstance(value, dict):
        return {}
    if isinstance(value.get("token_usage"), dict):
        value = value["token_usage"]

    usage: dict[str, int] = {}
    key_aliases = {
        "prompt_tokens": ("prompt_tokens", "input_tokens"),
        "completion_tokens": ("completion_tokens", "output_tokens"),
        "total_tokens": ("total_tokens",),
    }
    for key, aliases in key_aliases.items():
        parsed = None
        for alias in aliases:
            parsed = _coerce_int(value.get(alias))
            if parsed is not None:
                break
        if parsed is not None:
            usage[key] = parsed

    if "total_tokens" not in usage:
        prompt = usage.get("prompt_tokens")
        completion = usage.get("completion_tokens")
        if prompt is not None and completion is not None:
            usage["total_tokens"] = prompt + completion

    prompt_details = value.get("prompt_tokens_details") or value.get(
        "input_tokens_details"
    )
    if isinstance(prompt_details, dict):
        cached = _coerce_int(prompt_details.get("cached_tokens"))
        if cached is not None:
            usage["cached_prompt_tokens"] = cached
    return usage


def merge_usage(current: dict[str, int], candidate: dict[str, int]) -> dict[str, int]:
    """Keep the largest observed cumulative token counts."""
    merged = dict(current)
    for key, value in candidate.items():
        merged[key] = max(merged.get(key, 0), value)
    return merged


def normalize_intermediate(
    parsed: dict, received_at_seconds: float
) -> ToolEvent | None:
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
        received_at_seconds=round(received_at_seconds, 6),
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


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return round(ordered[0], 3)
    rank = (len(ordered) - 1) * pct
    lower = int(rank)
    upper = min(lower + 1, len(ordered) - 1)
    weight = rank - lower
    value = ordered[lower] * (1 - weight) + ordered[upper] * weight
    return round(value, 3)


def _match_event_durations(events: list[ToolEvent]) -> list[dict[str, Any]]:
    starts_by_step: dict[str, ToolEvent] = {}
    unmatched_starts: list[ToolEvent] = []
    durations: list[dict[str, Any]] = []

    for ev in events:
        if ev.event_type.endswith("_START"):
            if ev.step_id:
                starts_by_step[ev.step_id] = ev
            unmatched_starts.append(ev)
            continue

        if not ev.event_type.endswith("_END"):
            continue

        start = starts_by_step.get(ev.step_id) if ev.step_id else None
        if start is None:
            for candidate in reversed(unmatched_starts):
                if (
                    candidate.name == ev.name
                    and candidate.parent_id == ev.parent_id
                    and candidate.event_type.replace("_START", "")
                    == ev.event_type.replace("_END", "")
                    and candidate.received_at_seconds <= ev.received_at_seconds
                ):
                    start = candidate
                    break
        if start is None:
            continue

        duration = max(0.0, ev.received_at_seconds - start.received_at_seconds)
        durations.append(
            {
                "name": ev.name,
                "event_category": ev.event_type.replace("_END", ""),
                "duration_s": round(duration, 3),
            }
        )

    return durations


def _summarize_prompt_cache(cases: list[dict[str, Any]]) -> dict[str, Any]:
    prompt_tokens = [
        int(c["metrics"]["usage"]["prompt_tokens"])
        for c in cases
        if c.get("metrics", {}).get("usage", {}).get("prompt_tokens") is not None
    ]
    cached_tokens = [
        int(c["metrics"]["usage"].get("cached_prompt_tokens", 0))
        for c in cases
        if c.get("metrics", {}).get("usage", {}).get("prompt_tokens") is not None
    ]
    total_prompt_tokens = sum(prompt_tokens)
    total_cached_tokens = sum(cached_tokens)
    return {
        "cached_prompt_tokens": total_cached_tokens,
        "prompt_tokens": total_prompt_tokens,
        "hit_ratio": (
            round(total_cached_tokens / total_prompt_tokens, 3)
            if total_prompt_tokens
            else None
        ),
    }


def build_trace_metrics(
    *,
    events: list[ToolEvent],
    response: str,
    payload: dict[str, Any],
    usage: dict[str, int],
    latency_seconds: float,
    first_token_seconds: float | None,
) -> dict[str, Any]:
    tool_starts = [ev for ev in events if ev.event_type == "TOOL_START"]
    workflow_starts = [ev for ev in events if ev.event_type == "WORKFLOW_START"]
    unique_tools = sorted({ev.name for ev in tool_starts})

    usage_source = "reported"
    if not usage:
        prompt_text = json.dumps(payload.get("messages", []), sort_keys=True)
        usage = {
            "prompt_tokens": estimate_tokens(prompt_text),
            "completion_tokens": estimate_tokens(response),
        }
        usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
        usage_source = "estimated"

    durations = _match_event_durations(events)
    tool_duration_totals: dict[str, float] = {}
    for item in durations:
        if item["event_category"] != "TOOL":
            continue
        tool_duration_totals[item["name"]] = round(
            tool_duration_totals.get(item["name"], 0.0) + item["duration_s"], 3
        )

    return {
        "latency_s": round(latency_seconds, 3),
        "first_token_s": (
            round(first_token_seconds, 3) if first_token_seconds is not None else None
        ),
        "usage": usage,
        "usage_source": usage_source,
        "tool_call_count": len(tool_starts),
        "workflow_call_count": len(workflow_starts),
        "unique_tools": unique_tools,
        "tool_duration_s": tool_duration_totals,
        "event_count": len(events),
    }


def run_case(case: dict, backend_url: str, user_id: str) -> TraceResult:
    import httpx

    case_id = str(case.get("id", "unknown"))
    query = case["query"]
    stream_url = f"{backend_url.rstrip('/')}/chat/stream"
    payload = build_request_payload(query, user_id)
    events: list[ToolEvent] = []
    response_chunks: list[str] = []
    error: str | None = None
    usage: dict[str, int] = {}
    first_token_seconds: float | None = None
    started_at = datetime.now().astimezone()
    started = time.monotonic()

    try:
        headers = {
            "Content-Type": "application/json",
            "x-user-id": user_id,
            "x-timezone": "America/New_York",
        }
        internal_token = os.environ.get("DAEDALUS_INTERNAL_API_TOKEN", "").strip()
        if internal_token:
            headers["x-daedalus-internal-token"] = internal_token

        with httpx.stream(
            "POST",
            stream_url,
            json=payload,
            headers=headers,
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
                        usage = merge_usage(usage, normalize_usage(parsed.get("usage")))
                        chunk = extract_content(parsed)
                        if isinstance(chunk, str) and chunk:
                            if first_token_seconds is None:
                                first_token_seconds = time.monotonic() - started
                            response_chunks.append(chunk)
                    elif raw_line.startswith("intermediate_data: "):
                        data = raw_line[len("intermediate_data: ") :].strip()
                        try:
                            parsed = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        intermediate_usage = parsed.get("usage") or parsed.get(
                            "usage_info"
                        )
                        payload_obj = parsed.get("payload")
                        if not intermediate_usage and isinstance(payload_obj, dict):
                            intermediate_usage = payload_obj.get("usage_info")
                        usage = merge_usage(
                            usage,
                            normalize_usage(intermediate_usage),
                        )
                        event = normalize_intermediate(
                            parsed, time.monotonic() - started
                        )
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

    latency_seconds = time.monotonic() - started
    metrics = build_trace_metrics(
        events=events,
        response=response,
        payload=payload,
        usage=usage,
        latency_seconds=latency_seconds,
        first_token_seconds=first_token_seconds,
    )

    return TraceResult(
        case_id=case_id,
        query=query,
        response=response,
        events=events,
        started_at=started_at.isoformat(),
        latency_seconds=latency_seconds,
        first_token_seconds=first_token_seconds,
        usage=metrics["usage"],
        metrics=metrics,
        error=error,
    )


def load_dataset(path: Path) -> list[dict]:
    import yaml

    with path.open() as f:
        data = yaml.safe_load(f)
    if not isinstance(data, list):
        raise ValueError(f"{path}: expected list of cases")
    return data


def summarize_cases(cases: list[dict[str, Any]]) -> dict[str, Any]:
    latencies = [float(c["latency_s"]) for c in cases if c.get("latency_s") is not None]
    first_tokens = [
        float(c["metrics"]["first_token_s"])
        for c in cases
        if c.get("metrics", {}).get("first_token_s") is not None
    ]
    total_tokens = [
        float(c["metrics"]["usage"]["total_tokens"])
        for c in cases
        if c.get("metrics", {}).get("usage", {}).get("total_tokens") is not None
    ]
    tool_counts = [
        float(c["metrics"]["tool_call_count"])
        for c in cases
        if c.get("metrics", {}).get("tool_call_count") is not None
    ]
    by_workflow: dict[str, list[dict[str, Any]]] = {}
    for case in cases:
        workflow = case.get("workflow") or str(case["case_id"]).split("-")[0]
        by_workflow.setdefault(workflow, []).append(case)

    return {
        "latency_s": {
            "p50": _percentile(latencies, 0.50),
            "p95": _percentile(latencies, 0.95),
            "p99": _percentile(latencies, 0.99),
            "max": round(max(latencies), 3) if latencies else None,
        },
        "first_token_s": {
            "p50": _percentile(first_tokens, 0.50),
            "p95": _percentile(first_tokens, 0.95),
        },
        "total_tokens": {
            "avg": round(sum(total_tokens) / len(total_tokens), 1)
            if total_tokens
            else None,
            "p95": _percentile(total_tokens, 0.95),
            "max": int(max(total_tokens)) if total_tokens else None,
        },
        "tool_call_count": {
            "avg": round(sum(tool_counts) / len(tool_counts), 1)
            if tool_counts
            else None,
            "p95": _percentile(tool_counts, 0.95),
            "max": int(max(tool_counts)) if tool_counts else None,
        },
        "prompt_cache": _summarize_prompt_cache(cases),
        "by_workflow": {
            name: {
                "n": len(items),
                "passed": sum(1 for item in items if item["pass"]),
                "latency_p95_s": _percentile(
                    [float(item["latency_s"]) for item in items], 0.95
                ),
                "token_p95": _percentile(
                    [
                        float(item["metrics"]["usage"]["total_tokens"])
                        for item in items
                        if item.get("metrics", {}).get("usage", {}).get("total_tokens")
                        is not None
                    ],
                    0.95,
                ),
            }
            for name, items in sorted(by_workflow.items())
        },
    }


def load_evaluators() -> dict[str, Any]:
    return {
        name: importlib.import_module(f"evaluators.{module}")
        for name, module in EVALUATOR_MODULES.items()
    }


def _safe_slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")
    return slug or "case"


def _timestamp_at(started_at: str, offset_seconds: float) -> str:
    base = datetime.fromisoformat(started_at)
    return (base + timedelta(seconds=max(0.0, offset_seconds))).isoformat()


def _event_category(event_type: str) -> str:
    prefix = event_type.split("_", 1)[0].lower()
    if prefix == "tool":
        return "tool"
    if prefix == "workflow":
        return "agent"
    if prefix == "llm":
        return "llm"
    if prefix in {"function", "task"}:
        return "function"
    return "custom"


def build_atof_events(case: dict[str, Any], dataset_name: str) -> list[dict[str, Any]]:
    """Build a minimal ATOF v0.1 event stream for one eval case."""
    started_at = case.get("started_at") or datetime.now().astimezone().isoformat()
    case_id = str(case["case_id"])
    root_uuid = str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"daedalus-eval:{dataset_name}:{case_id}:{started_at}",
        )
    )
    metadata = {
        "case_id": case_id,
        "dataset": dataset_name,
        "score": case.get("score"),
        "passed": case.get("pass"),
        "workflow": case.get("workflow"),
    }
    events: list[dict[str, Any]] = [
        {
            "kind": "scope",
            "scope_category": "start",
            "atof_version": "0.1",
            "uuid": root_uuid,
            "parent_uuid": None,
            "timestamp": started_at,
            "name": "daedalus_eval_case",
            "attributes": [],
            "category": "unknown",
            "category_profile": None,
            "data": {"query": case.get("query", "")},
            "data_schema": None,
            "metadata": metadata,
        }
    ]

    scope_ids: dict[str, str] = {}
    for index, raw_event in enumerate(case.get("events") or []):
        event_type = str(raw_event.get("event_type") or "")
        if not event_type.endswith(("_START", "_END")):
            continue
        step_id = str(raw_event.get("step_id") or "")
        key = step_id or (
            f"{raw_event.get('name', 'unknown')}:"
            f"{raw_event.get('parent_id', 'root')}:{index}"
        )
        scope_uuid = scope_ids.get(key)
        if scope_uuid is None:
            scope_uuid = str(uuid.uuid5(uuid.UUID(root_uuid), key))
            scope_ids[key] = scope_uuid

        category = _event_category(event_type)
        profile = (
            {"tool_call_id": step_id or scope_uuid}
            if category == "tool"
            else ({"subtype": "daedalus.eval"} if category == "custom" else None)
        )
        events.append(
            {
                "kind": "scope",
                "scope_category": "start" if event_type.endswith("_START") else "end",
                "atof_version": "0.1",
                "uuid": scope_uuid,
                "parent_uuid": root_uuid,
                "timestamp": _timestamp_at(
                    started_at, float(raw_event.get("received_at_seconds") or 0.0)
                ),
                "name": str(raw_event.get("name") or "unknown"),
                "attributes": ["remote"] if category == "tool" else [],
                "category": category,
                "category_profile": profile,
                "data": {
                    "payload": raw_event.get("payload", ""),
                    "parent_id": raw_event.get("parent_id", ""),
                    "step_id": step_id,
                    "event_type": event_type,
                },
                "data_schema": None,
                "metadata": metadata,
            }
        )

    events.append(
        {
            "kind": "scope",
            "scope_category": "end",
            "atof_version": "0.1",
            "uuid": root_uuid,
            "parent_uuid": None,
            "timestamp": _timestamp_at(
                started_at,
                float(case.get("latency_s") or 0.0),
            ),
            "name": "daedalus_eval_case",
            "attributes": [],
            "category": "unknown",
            "category_profile": None,
            "data": {
                "response": case.get("response") or case.get("response_preview", "")
            },
            "data_schema": None,
            "metadata": {**metadata, "metrics": case.get("metrics") or {}},
        }
    )
    return events


def write_atof_exports(results: dict[str, Any], export_dir: Path) -> list[Path]:
    export_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for dataset_name, dataset in results.get("datasets", {}).items():
        for case in dataset.get("cases", []):
            path = export_dir / (
                f"{_safe_slug(dataset_name)}_"
                f"{_safe_slug(str(case['case_id']))}.atof.jsonl"
            )
            with path.open("w", encoding="utf-8") as f:
                for event in build_atof_events(case, dataset_name):
                    f.write(json.dumps(event, separators=(",", ":")) + "\n")
            written.append(path)
    return written


def convert_atof_exports_to_atif(
    atof_files: list[Path], export_dir: Path
) -> list[Path]:
    try:
        from nat.atof.scripts.atof_to_atif_converter import convert_file
    except ImportError as exc:
        raise RuntimeError(
            "ATIF export requires nvidia-nat-atif[full] in the eval runner environment."
        ) from exc

    export_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for input_path in atof_files:
        output_path = export_dir / input_path.name.replace(".atof.jsonl", ".atif.json")
        convert_file(input_path, output_path)
        written.append(output_path)
    return written


def export_atif_to_phoenix(atif_files: list[Path], endpoint: str, project: str) -> None:
    module = (
        "nat.plugins.phoenix.scripts.export_trajectory_to_phoenix."
        "export_atif_trajectory_to_phoenix"
    )
    cmd = [
        sys.executable,
        "-m",
        module,
        *[str(path) for path in atif_files],
        "--endpoint",
        endpoint,
        "--project",
        project,
    ]
    # Fixed argv with shell=False; dataset paths and CLI values are passed as arguments.
    proc = subprocess.run(cmd, check=False, capture_output=True, text=True)  # nosec B603
    if proc.returncode != 0:
        raise RuntimeError(
            "Phoenix export failed:\n"
            f"stdout:\n{proc.stdout}\n"
            f"stderr:\n{proc.stderr}"
        )


def write_results_file(out_path: Path, results: dict[str, Any]) -> None:
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dataset",
        action="append",
        choices=sorted(EVALUATOR_MODULES),
        help=(
            "Dataset to run (repeatable; default: routing + factuality). "
            "Use --dataset workflows for the broader audit suite."
        ),
    )
    parser.add_argument("--backend", default=DEFAULT_BACKEND_URL)
    parser.add_argument("--user-id", default=EVAL_USER_ID)
    parser.add_argument("--case", help="Run only this case id")
    parser.add_argument("--out", help="Output JSON path")
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Load datasets/evaluators and exit without calling the backend.",
    )
    parser.add_argument(
        "--skip-preflight",
        action="store_true",
        help="Skip the backend reachability check before running cases.",
    )
    parser.add_argument(
        "--export-atof",
        action="store_true",
        help="Write one ATOF JSONL event stream per eval case.",
    )
    parser.add_argument(
        "--export-atof-dir",
        help="Directory for ATOF JSONL files. Implies --export-atof.",
    )
    parser.add_argument(
        "--export-atif",
        action="store_true",
        help=(
            "Convert exported ATOF JSONL files to ATIF JSON. "
            "Requires nvidia-nat-atif[full]."
        ),
    )
    parser.add_argument(
        "--export-atif-dir",
        help="Directory for ATIF JSON files. Implies --export-atif and --export-atof.",
    )
    parser.add_argument(
        "--export-phoenix",
        action="store_true",
        help="Export ATIF files to Phoenix. Implies --export-atif and --export-atof.",
    )
    parser.add_argument(
        "--phoenix-endpoint",
        default=os.environ.get(
            "DAEDALUS_PHOENIX_ENDPOINT", "http://localhost:6006/v1/traces"
        ),
        help="Phoenix OTLP endpoint for --export-phoenix.",
    )
    parser.add_argument(
        "--phoenix-project",
        default=os.environ.get("PHOENIX_PROJECT_NAME", "daedalus-evals"),
        help="Phoenix project name for --export-phoenix.",
    )
    args = parser.parse_args()

    datasets = args.dataset or DEFAULT_DATASETS
    out_path = (
        Path(args.out)
        if args.out
        else EVALS_DIR / "results" / f"{datetime.now():%Y-%m-%d_%H%M%S}.json"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)

    sys.path.insert(0, str(EVALS_DIR))
    evaluators = load_evaluators()

    if args.validate_only:
        for ds_name in datasets:
            ds_path = EVALS_DIR / "datasets" / f"{ds_name}.yml"
            cases = load_dataset(ds_path)
            if args.case:
                cases = [c for c in cases if str(c.get("id")) == args.case]
            if ds_name not in evaluators:
                raise ValueError(f"No evaluator registered for dataset {ds_name}")
            print(f"{ds_name}: {len(cases)} cases")
        return 0

    if not args.skip_preflight:
        preflight_error = preflight_backend(args.backend, PREFLIGHT_TIMEOUT_S)
        if preflight_error:
            print("\n# Eval Preflight Failed\n", file=sys.stderr)
            print(preflight_error, file=sys.stderr)
            print(
                "\nNo cases were run. Use --skip-preflight only if /docs is blocked "
                "but /chat/stream is known to be reachable.",
                file=sys.stderr,
            )
            return 2

    all_results: dict[str, Any] = {
        "started_at": datetime.now().isoformat(),
        "backend_url": args.backend,
        "user_id": args.user_id,
        "datasets": {},
        "summary": {},
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
            if trace.error:
                scored.score = 0.0
                scored.passed = False
                reasons = scored.detail.setdefault("reasons", [])
                if trace.error not in reasons:
                    reasons.insert(0, trace.error)
            ds_cases.append(
                {
                    "case_id": trace.case_id,
                    "workflow": case.get("workflow"),
                    "query": trace.query,
                    "started_at": trace.started_at,
                    "latency_s": round(trace.latency_seconds, 2),
                    "first_token_s": (
                        round(trace.first_token_seconds, 2)
                        if trace.first_token_seconds is not None
                        else None
                    ),
                    "error": trace.error,
                    "score": scored.score,
                    "pass": scored.passed,
                    "detail": scored.detail,
                    "metrics": trace.metrics,
                    "response": trace.response,
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
                "metrics": summarize_cases(ds_cases),
                "cases": ds_cases,
            }

    all_cases = [
        case
        for dataset in all_results["datasets"].values()
        for case in dataset["cases"]
    ]
    all_results["summary"] = summarize_cases(all_cases)

    artifact_paths: dict[str, Any] = {}
    should_export_atof = (
        args.export_atof
        or args.export_atof_dir
        or args.export_atif
        or args.export_atif_dir
        or args.export_phoenix
    )
    if should_export_atof:
        atof_dir = (
            Path(args.export_atof_dir)
            if args.export_atof_dir
            else out_path.parent / f"{out_path.stem}-atof"
        )
        atof_files = write_atof_exports(all_results, atof_dir)
        artifact_paths["atof"] = [str(path) for path in atof_files]

        if args.export_atif or args.export_atif_dir or args.export_phoenix:
            atif_dir = (
                Path(args.export_atif_dir)
                if args.export_atif_dir
                else out_path.parent / f"{out_path.stem}-atif"
            )
            try:
                atif_files = convert_atof_exports_to_atif(atof_files, atif_dir)
                artifact_paths["atif"] = [str(path) for path in atif_files]
                if args.export_phoenix:
                    export_atif_to_phoenix(
                        atif_files, args.phoenix_endpoint, args.phoenix_project
                    )
                    artifact_paths["phoenix"] = {
                        "endpoint": args.phoenix_endpoint,
                        "project": args.phoenix_project,
                    }
            except RuntimeError as exc:
                if artifact_paths:
                    all_results["artifacts"] = artifact_paths
                all_results["artifact_error"] = str(exc)
                write_results_file(out_path, all_results)
                print(f"\n# Eval Artifact Export Failed\n\n{exc}", file=sys.stderr)
                print(
                    f"\nEval results were still written to {out_path}", file=sys.stderr
                )
                return 2

    if artifact_paths:
        all_results["artifacts"] = artifact_paths

    write_results_file(out_path, all_results)

    print("\n# Eval Results\n")
    print(f"- Run: `{all_results['started_at']}`")
    print(f"- Backend: `{all_results['backend_url']}`")
    print(f"- Output: `{out_path}`\n")
    if artifact_paths:
        print("## Artifacts")
        for name, value in artifact_paths.items():
            if isinstance(value, list):
                print(f"- {name}: {len(value)} file(s)")
            else:
                print(f"- {name}: `{value}`")
        print()
    any_fail = False
    for name, ds in all_results["datasets"].items():
        pct = (ds["passed"] / ds["n"] * 100) if ds["n"] else 0.0
        print(f"## {name}")
        print(f"- Pass rate: **{ds['passed']}/{ds['n']}** ({pct:.0f}%)")
        print(f"- Avg score: **{ds['avg_score']}**")
        metrics = ds.get("metrics") or {}
        latency = metrics.get("latency_s") or {}
        tokens = metrics.get("total_tokens") or {}
        tools = metrics.get("tool_call_count") or {}
        prompt_cache = metrics.get("prompt_cache") or {}
        print(
            "- Latency p50/p95/p99: "
            f"**{latency.get('p50')}s / {latency.get('p95')}s / "
            f"{latency.get('p99')}s**"
        )
        print(
            "- Token avg/p95/max: "
            f"**{tokens.get('avg')} / {tokens.get('p95')} / "
            f"{tokens.get('max')}**"
        )
        print(
            "- Tool calls avg/p95/max: "
            f"**{tools.get('avg')} / {tools.get('p95')} / "
            f"{tools.get('max')}**"
        )
        if prompt_cache.get("hit_ratio") is not None:
            print(
                "- Prompt cache cached/prompt/hit-rate: "
                f"**{prompt_cache.get('cached_prompt_tokens')} / "
                f"{prompt_cache.get('prompt_tokens')} / "
                f"{prompt_cache.get('hit_ratio')}**"
            )
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
