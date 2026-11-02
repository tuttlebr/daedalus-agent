#!/usr/bin/env python3
"""Measure candidate YAML prose without printing values or resolving services."""

import argparse
import json
import sys
from pathlib import Path

import yaml

TEXT_KEYS = {"instructions", "system_prompt", "description", "discovery_description"}
UNITS = ("characters", "utf8_bytes", "words")
ROOT = Path(__file__).resolve().parents[4]


def load_config(path):
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Expected a mapping")
    # Reject cycles and values that do not belong to a JSON-compatible config.
    json.dumps(data, sort_keys=True, allow_nan=False)
    return data


def inventory(value, path=""):
    """Return prose metrics and the remaining configuration for comparison."""
    rows = {}
    if isinstance(value, dict):
        remaining = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("Expected string keys")
            pointer = path + "/" + key.replace("~", "~0").replace("/", "~1")
            if key in TEXT_KEYS and isinstance(item, str):
                rows[pointer] = {
                    "characters": len(item),
                    "utf8_bytes": len(item.encode("utf-8")),
                    "words": len(item.split()),
                }
            else:
                found, remaining[key] = inventory(item, pointer)
                rows.update(found)
        return rows, remaining
    if isinstance(value, list):
        remaining = []
        for index, item in enumerate(value):
            found, rest = inventory(item, f"{path}/{index}")
            rows.update(found)
            remaining.append(rest)
        return rows, remaining
    return rows, value


def totals(rows):
    return {unit: sum(row[unit] for row in rows.values()) for unit in UNITS}


def measure(config, baseline=None):
    rows, rest = inventory(config)
    report = {
        "scope": "raw_yaml_candidate_prose_only",
        "token_count": None,
        "has_base": bool(config.get("base")),
        "fields": rows,
        "totals": totals(rows),
    }
    if baseline is not None:
        before, before_rest = inventory(baseline)
        zero = dict.fromkeys(UNITS, 0)
        report["baseline_has_base"] = bool(baseline.get("base"))
        report["baseline_totals"] = totals(before)
        report["delta"] = {
            unit: report["totals"][unit] - report["baseline_totals"][unit]
            for unit in UNITS
        }
        report["field_deltas"] = {
            path: {
                unit: rows.get(path, zero)[unit] - before.get(path, zero)[unit]
                for unit in UNITS
            }
            for path in sorted(rows.keys() | before.keys())
        }
        report["added_fields"] = sorted(rows.keys() - before.keys())
        report["removed_fields"] = sorted(before.keys() - rows.keys())
        # JSON preserves scalar types (unlike Python's True == 1 comparison).
        report["other_config_changed"] = json.dumps(
            rest, sort_keys=True, allow_nan=False
        ) != json.dumps(before_rest, sort_keys=True, allow_nan=False)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "config",
        nargs="?",
        type=Path,
        default=ROOT / "backend/tool-calling-config.yaml",
    )
    parser.add_argument("--baseline", type=Path)
    args = parser.parse_args()
    try:
        config = load_config(args.config)
        baseline = load_config(args.baseline) if args.baseline else None
        report = measure(config, baseline)
    except (OSError, ValueError, TypeError, RecursionError, yaml.YAMLError):
        # Parser exceptions can include credential-bearing source lines.
        print(
            "Cannot measure config: require readable, nonrecursive YAML mappings "
            "with string keys and JSON-compatible values.",
            file=sys.stderr,
        )
        return 2
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
