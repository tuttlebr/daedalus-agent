#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Report observed AIPerf profiling records without hiding partial or failed runs."""

import argparse
import json
import math
import statistics
from pathlib import Path


def find_jsonl(path):
    if path.is_file():
        return path
    matches = sorted(path.rglob("profile_export.jsonl"))
    if len(matches) != 1:
        raise ValueError(
            f"expected one profile_export.jsonl, found {len(matches)}; select one run"
        )
    return matches[0]


def analyze(path, expected_count=None):
    counts = dict(
        attempted=0, completed=0, cancelled=0, failed=0, invalid=0, other_phase=0
    )
    starts, ends, latencies, ttfts = [], [], [], []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            metadata = row["metadata"]
            if metadata.get("benchmark_phase") != "profiling":
                counts["other_phase"] += 1
                continue
            counts["attempted"] += 1
            if metadata.get("was_cancelled"):
                counts["cancelled"] += 1
                continue
            if (
                row.get("error")
                or metadata.get("error")
                or metadata.get("request_error")
            ):
                counts["failed"] += 1
                continue
            start, end = metadata["request_start_ns"], metadata["request_end_ns"]
            if (
                not isinstance(start, (int, float))
                or not isinstance(end, (int, float))
                or not math.isfinite(start)
                or not math.isfinite(end)
                or end <= start
            ):
                raise ValueError("invalid interval")
            metrics = row.get("metrics") or {}
            values = []
            for name in ["request_latency", "time_to_first_token"]:
                metric = metrics.get(name) or {}
                value = metric.get("value")
                if value is not None:
                    if (
                        metric.get("unit", "ms") not in {"ms", "milliseconds"}
                        or not isinstance(value, (int, float))
                        or not math.isfinite(value)
                        or value < 0
                    ):
                        raise ValueError("invalid metric value/unit")
                values.append(value)
            starts.append(start)
            ends.append(end)
            if values[0] is not None:
                latencies.append(values[0])
            if values[1] is not None:
                ttfts.append(values[1])
            counts["completed"] += 1
        except (ValueError, KeyError, TypeError, AttributeError):
            counts["invalid"] += 1
    complete = bool(starts) and not any(
        counts[key] for key in ["cancelled", "failed", "invalid"]
    )
    if expected_count is not None and counts["attempted"] != expected_count:
        complete = False
    wall = (max(ends) - min(starts)) / 1e9 if starts else None
    result = {
        "file": str(path),
        "counts": counts,
        "expected_count": expected_count,
        "records_complete": complete,
        "scope": "observed records; process/run completion must be verified separately",
        "observed_success_window_seconds": wall,
        "observed_completed_requests_per_second": len(starts) / wall if wall else None,
    }
    for name, values in [("request_latency_ms", latencies), ("ttft_ms", ttfts)]:
        if values:
            ordered = sorted(values)
            result[name] = {
                "count": len(values),
                "mean": statistics.mean(values),
                "p50": statistics.median(values),
                "p99": ordered[math.ceil(0.99 * len(values)) - 1],
            }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("--conc", type=int)
    parser.add_argument("--expected-count", type=int)
    args = parser.parse_args()
    if (args.conc is not None and args.conc < 1) or (
        args.expected_count is not None and args.expected_count < 1
    ):
        parser.error("counts must be positive")
    try:
        result = analyze(find_jsonl(args.path), args.expected_count)
    except (OSError, ValueError) as exc:
        parser.exit(2, f"{exc}\n")
    if args.conc and result.get("request_latency_ms", {}).get("mean", 0) > 0:
        result["closed_loop_sanity_requests_per_second"] = (
            args.conc * 1000 / result["request_latency_ms"]["mean"]
        )
    print(json.dumps(result, indent=2))
    return 0 if result["records_complete"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
