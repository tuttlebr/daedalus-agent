#!/usr/bin/env python3
"""Compare reviewed briefing measurements against a frozen synthetic workload.

This consumes measurements, not model credentials or prompt captures. It does
not simulate a model run or certify an unreviewed privacy assertion.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

WORKLOAD = Path(__file__).with_name("workload.json")
REQUIRED_PRIVACY_CHECKS = tuple(f"AC-{number:02d}" for number in range(1, 9))


def workload_digest(workload: dict[str, Any]) -> str:
    canonical = json.dumps(workload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def ratio(counts: dict[str, Any], numerator: str, denominator: str) -> float | None:
    top, bottom = counts.get(numerator), counts.get(denominator)
    if type(top) is not int or type(bottom) is not int or not 0 <= top <= bottom:
        raise ValueError("Invalid quality counts")
    if bottom == 0:
        return None
    return top / bottom


def summarize(
    run: dict[str, Any], workload: dict[str, Any], *, require_privacy: bool = True
) -> dict[str, Any]:
    if run.get("schema_version") != 1:
        raise ValueError("Unsupported measurement schema")
    if run.get("workload_sha256") != workload_digest(workload):
        raise ValueError("Measurements do not match the frozen workload")
    config = run.get("configuration", {})
    for key in ("runtime_image", "gateway_image", "model_versions", "config_sha256"):
        if not config.get(key):
            raise ValueError("Model, image and configuration versions are required")
    evidence = run.get("privacy_evidence", {})
    if not evidence.get("artifact_sha256") or not evidence.get("reviewer"):
        raise ValueError("Reviewed privacy capture evidence is required")
    if any(type(evidence.get(key)) is not bool for key in REQUIRED_PRIVACY_CHECKS):
        raise ValueError("Every privacy acceptance check must be measured")
    if require_privacy and any(
        evidence[key] is not True for key in REQUIRED_PRIVACY_CHECKS
    ):
        raise ValueError("Every privacy acceptance check must pass")

    expected = {
        (case["id"], repetition)
        for case in workload["cases"]
        for repetition in range(workload["repetitions"])
    }
    cases = run.get("cases", [])
    observed = {(case.get("case_id"), case.get("repetition")) for case in cases}
    if observed != expected or len(cases) != len(expected):
        raise ValueError(
            "Every frozen case and repetition must be measured exactly once"
        )

    totals = {"factuality": [0, 0], "omissions": [0, 0], "sources": [0, 0]}
    quality_fields = {
        "factuality": ("supported_claims", "total_claims"),
        "omissions": ("missing_required", "total_required"),
        "sources": ("correct_citations", "total_citations"),
    }
    latencies: list[float] = []
    cost: float | None = 0.0
    completed = 0
    output_contracts = 0
    attempts_total = 0
    by_case = {case["id"]: case for case in workload["cases"]}
    case_metrics = {}
    usage: dict[str, int | None] = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cached_input_tokens": 0,
    }
    for case in cases:
        if type(case.get("output_contract_passed")) is not bool:
            raise ValueError("Output contract status is required for every case")
        output_contracts += int(case["output_contract_passed"])
        if type(case.get("successful")) is not bool:
            raise ValueError("Completion status is required for every case")
        completed += int(case["successful"])
        if not number(case.get("latency_ms")) or case["latency_ms"] == 0:
            raise ValueError("Measured end-to-end latency is required")
        latencies.append(case["latency_ms"])
        for metric, (top, bottom) in quality_fields.items():
            counts = case.get(metric, {})
            ratio(counts, top, bottom)
            totals[metric][0] += counts[top]
            totals[metric][1] += counts[bottom]
        if case["omissions"]["total_required"] != len(
            by_case[case["case_id"]]["required_facts"]
        ):
            raise ValueError("Omission rubric must include every frozen required fact")
        case_metrics[f'{case["case_id"]}:{case["repetition"]}'] = {
            metric: ratio(case[metric], top, bottom)
            for metric, (top, bottom) in quality_fields.items()
        }

        attempts = case.get("attempts", [])
        if not attempts or case.get("attempt_count") != len(attempts):
            raise ValueError(
                "Record every attempt, including failed attempts and retries"
            )
        attempt_ids: set[str] = set()
        for attempt in attempts:
            attempt_id = attempt.get("id")
            if (
                not isinstance(attempt_id, str)
                or not attempt_id
                or attempt_id in attempt_ids
            ):
                raise ValueError("Attempt identities must be unique within a case")
            attempt_ids.add(attempt_id)
            for key in ("phase", "profile", "target", "outcome"):
                if not attempt.get(key):
                    raise ValueError("Attempt routing and outcome are required")
            if not number(attempt.get("latency_ms")):
                raise ValueError("Attempt latency is required")
            measured_cost = attempt.get("cost_usd")
            if measured_cost is None:
                cost = None
            elif not number(measured_cost):
                raise ValueError("Costs must be nonnegative measurements or null")
            elif cost is not None:
                cost += measured_cost
            for key, current in usage.items():
                value = attempt.get("usage", {}).get(key)
                if value is None:
                    usage[key] = None
                elif type(value) is not int or value < 0:
                    raise ValueError("Usage must be nonnegative integers or null")
                elif current is not None:
                    usage[key] += value
        attempts_total += len(attempts)

    latencies.sort()
    if any(bottom == 0 for _, bottom in totals.values()):
        raise ValueError("Quality evidence must contain scored observations")
    return {
        "cases": len(cases),
        "completion_rate": completed / len(cases),
        "output_contract_pass_rate": output_contracts / len(cases),
        **{name: top / bottom for name, (top, bottom) in totals.items()},
        "latency_p95_ms": latencies[math.ceil(len(latencies) * 0.95) - 1],
        "cost_usd": cost,
        "usage": usage,
        "attempts": attempts_total,
        "configuration": config,
        "privacy_checks": {key: evidence[key] for key in REQUIRED_PRIVACY_CHECKS},
        "case_metrics": case_metrics,
    }


def compare(
    baseline: dict[str, Any], candidate: dict[str, Any], workload: dict[str, Any]
) -> dict[str, Any]:
    before = summarize(baseline, workload, require_privacy=False)
    after = summarize(candidate, workload)
    margins = workload["margins"]
    checks = {
        "output_contracts": after["output_contract_pass_rate"] == 1,
        "factuality": after["factuality"]
        >= before["factuality"] - margins["maximum_factuality_drop"],
        "omissions": after["omissions"]
        <= before["omissions"] + margins["maximum_omission_increase"],
        "source_correctness": after["sources"]
        >= before["sources"] - margins["maximum_source_correctness_drop"],
        "completion": after["completion_rate"]
        >= max(
            margins["minimum_completion_rate"],
            before["completion_rate"] - margins["maximum_completion_drop"],
        ),
        "latency": after["latency_p95_ms"]
        <= before["latency_p95_ms"] * margins["maximum_latency_ratio"],
    }
    checks["per_case_quality"] = all(
        (
            before["case_metrics"][key][metric] is None
            or (
                value is not None
                and (
                    value <= before["case_metrics"][key][metric]
                    if metric == "omissions"
                    else value >= before["case_metrics"][key][metric]
                )
            )
        )
        for key, metrics in after["case_metrics"].items()
        for metric, value in metrics.items()
    )
    latency_reduction = 1 - after["latency_p95_ms"] / before["latency_p95_ms"]
    cost_reduction = None
    if (
        before["cost_usd"] is not None
        and after["cost_usd"] is not None
        and before["cost_usd"] > 0
    ):
        cost_reduction = 1 - after["cost_usd"] / before["cost_usd"]
    checks["measured_benefit"] = latency_reduction >= margins[
        "minimum_latency_reduction"
    ] - 1e-12 or (
        cost_reduction is not None
        and cost_reduction >= margins["minimum_cost_reduction"] - 1e-12
    )
    return {
        "schema_version": 1,
        "workload_sha256": workload_digest(workload),
        "passed": all(checks.values()),
        "checks": checks,
        "baseline": before,
        "candidate": after,
        "cost_reduction": cost_reduction,
        "latency_reduction": latency_reduction,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workload", type=Path, default=WORKLOAD)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--digest", action="store_true")
    args = parser.parse_args()
    workload = json.loads(args.workload.read_text())
    if args.digest:
        print(workload_digest(workload))
        return 0
    if not args.baseline or not args.candidate:
        parser.error("--baseline and --candidate are required for comparison")
    try:
        report = compare(
            json.loads(args.baseline.read_text()),
            json.loads(args.candidate.read_text()),
            workload,
        )
    except (OSError, ValueError, KeyError, TypeError) as error:
        # Exceptions from measurement parsing can contain supplied private text.
        report = {"schema_version": 1, "passed": False, "error": type(error).__name__}
    text = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.write_text(text)
    else:
        print(text, end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
