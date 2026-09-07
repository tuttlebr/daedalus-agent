#!/usr/bin/env python3
"""Snapshot and restore only benchmark-owned runtime AllowedCPUs changes."""

import argparse
import json
import os
import subprocess  # nosec B404
from pathlib import Path


def get_cpus(unit):
    return subprocess.run(  # nosec B603 B607
        ["systemctl", "show", "--property=AllowedCPUs", "--value", unit],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def set_cpus(unit, cpus):
    subprocess.run(  # nosec B603 B607
        ["systemctl", "set-property", "--runtime", unit, f"AllowedCPUs={cpus}"],
        check=True,
    )


def save(path, state):
    path.write_text(json.dumps(state, indent=2) + "\n")


def apply(path, cpus, full=False):
    units = ["system.slice", "init.scope"] + (["user.slice"] if full else [])
    state = {
        "units": {unit: {"before": get_cpus(unit), "after": cpus} for unit in units}
    }
    # Refuse to overwrite another run's recovery record.
    with path.open("x") as handle:
        json.dump(state, handle, indent=2)
    for unit, values in state["units"].items():
        set_cpus(unit, cpus)
        # Record systemd's canonical formatting for the conflict check.
        values["after"] = get_cpus(unit)
        save(path, state)


def restore(path):
    state = json.loads(path.read_text())
    for unit, values in state["units"].items():
        if unit not in {"system.slice", "init.scope", "user.slice"}:
            raise ValueError("unexpected unit in isolation record")
        current = get_cpus(unit)
        if current not in {values["before"], values["after"]}:
            raise ValueError(
                f"{unit} changed after isolation; refusing to overwrite it"
            )
    for unit, values in state["units"].items():
        set_cpus(unit, values["before"])
    path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["apply", "restore"])
    parser.add_argument("state", type=Path)
    parser.add_argument("--cpus", default="4-23")
    parser.add_argument("--full", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("run only from an authorized privileged operator shell")
    try:
        if args.operation == "apply":
            apply(args.state, args.cpus, args.full)
        else:
            restore(args.state)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        parser.exit(1, f"{exc}; retain the state file for recovery\n")


if __name__ == "__main__":
    main()
