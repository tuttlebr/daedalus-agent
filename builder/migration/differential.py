#!/usr/bin/env python3
"""Compare isolated baseline and candidate image contracts; never production traffic."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime_http_check import check


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--redis-image", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    reports = []
    for name, image, preparation in [
        ("baseline", args.baseline, "python"),
        ("candidate", args.candidate, "rust"),
        ("candidate-python", args.candidate, "python"),
    ]:
        report = args.output / f"{name}.json"
        check(
            image=image,
            redis_image=args.redis_image,
            preparation=preparation,
            report=report,
        )
        reports.append(json.loads(report.read_text()))
    if any(report != reports[0] for report in reports[1:]):
        raise SystemExit(f"Unexplained contract difference: compare {args.output}")
    print(
        "Differential HTTP/model/tool and explicit rollback profile contracts passed; "
        "only clock instants normalized."
    )


if __name__ == "__main__":
    main()
