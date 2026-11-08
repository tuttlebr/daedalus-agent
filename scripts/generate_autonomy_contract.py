#!/usr/bin/env python3
"""Generate the frontend config contract from the worker's authoritative model."""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "builder/autonomous_agent/src"))

from autonomous_agent.charter import CharterConfig  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    path = ROOT / "frontend/server/autonomy/contract.json"
    text = (
        json.dumps(
            {
                "defaults": CharterConfig().model_dump(),
                "schema": CharterConfig.model_json_schema(),
            },
            indent=2,
        )
        + "\n"
    )
    if args.check:
        if json.loads(path.read_text()) != json.loads(text):
            print(
                "Autonomy contract is stale; run scripts/generate_autonomy_contract.py"
            )
            return 1
    else:
        path.write_text(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
