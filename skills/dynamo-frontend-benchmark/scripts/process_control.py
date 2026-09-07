#!/usr/bin/env python3
"""Track benchmark process identity and stop only the recorded process group/unit."""

import argparse
import json
import os
import re
import signal
import subprocess  # nosec B404
import time
from pathlib import Path


def identity(pid):
    """Linux process start ticks prevent a stale PID file matching a reused PID."""
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    except (FileNotFoundError, ProcessLookupError):
        return None
    return {
        "pid": pid,
        "start_ticks": fields[19],
        "pgid": int(fields[2]),
        "state": fields[0],
    }


def record(path, pid, unit=None):
    current = identity(pid)
    for _ in range(50):
        if current is None or unit or current["pgid"] == pid:
            break
        time.sleep(0.01)
        current = identity(pid)
    if current is None or current["state"] == "Z":
        raise ValueError("process exited before it could be recorded")
    if unit:
        if not re.fullmatch(r"daedalus-bench-[a-f0-9]+\.service", unit):
            raise ValueError("unit must be a task-unique daedalus benchmark service")
        current["unit"] = unit
    elif current["pgid"] != pid:
        raise ValueError(
            "managed process must lead a dedicated session; launch with setsid"
        )
    with path.open("x") as handle:
        handle.write(json.dumps(current) + "\n")
    return current


def verified(path):
    saved = json.loads(path.read_text())
    current = identity(saved["pid"])
    if current is None or current["state"] == "Z":
        return saved, None
    if (
        current["start_ticks"] != saved["start_ticks"]
        or current["pgid"] != saved["pgid"]
    ):
        raise ValueError("stale process record; refusing to target a different process")
    return saved, current


def stop(path, grace=10):
    saved, current = verified(path)
    if current is None:
        # A missing leader cannot prove ownership of any surviving descendants.
        # Preserve the record for diagnosis instead of killing by name/old PGID.
        raise ValueError("recorded leader is absent; descendant cleanup is unverified")
    unit = saved.get("unit")
    if unit:
        if not re.fullmatch(r"daedalus-bench-[a-f0-9]+\.service", unit):
            raise ValueError("unrecognized unit in process record")
        result = subprocess.run(  # nosec B603 B607
            ["systemctl", "show", "--property=MainPID", "--value", unit],
            capture_output=True,
            text=True,
            check=True,
        )
        if int(result.stdout.strip()) != saved["pid"]:
            raise ValueError("unit MainPID changed; refusing to stop it")
        subprocess.run(["systemctl", "stop", unit], check=True)  # nosec B603 B607
    else:
        if saved["pgid"] != saved["pid"]:
            raise ValueError("record does not own a dedicated process group")
        members = []
        for item in Path("/proc").iterdir():
            if item.name.isdigit():
                member = identity(int(item.name))
                if member and member["pgid"] == saved["pgid"]:
                    members.append(member)

        def remaining():
            result = []
            for member in members:
                now = identity(member["pid"])
                if (
                    now
                    and now["state"] != "Z"
                    and now["start_ticks"] == member["start_ticks"]
                    and now["pgid"] == saved["pgid"]
                ):
                    result.append(now)
            return result

        os.killpg(saved["pgid"], signal.SIGTERM)
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            if not remaining():
                break
            time.sleep(0.1)
        for member in remaining():
            # Recheck the birth identity immediately before targeting survivors.
            now = identity(member["pid"])
            if now and now["start_ticks"] == member["start_ticks"]:
                try:
                    os.kill(member["pid"], signal.SIGKILL)
                except ProcessLookupError:
                    pass
        deadline = time.monotonic() + 2
        while remaining() and time.monotonic() < deadline:
            time.sleep(0.05)
        # A child could fork after the initial snapshot. Preserve the record
        # and report incomplete cleanup instead of targeting an unverified PID.
        for item in Path("/proc").iterdir():
            if item.name.isdigit():
                member = identity(int(item.name))
                if (
                    member
                    and member["state"] != "Z"
                    and member["pgid"] == saved["pgid"]
                ):
                    raise ValueError(
                        "process group still has live members; cleanup is incomplete"
                    )
    path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    add = sub.add_parser("record")
    add.add_argument("path", type=Path)
    add.add_argument("pid", type=int)
    add.add_argument("--unit")
    for operation in ["pid", "stop"]:
        child = sub.add_parser(operation)
        child.add_argument("path", type=Path)
    args = parser.parse_args()
    try:
        if args.operation == "record":
            record(args.path, args.pid, args.unit)
        elif args.operation == "pid":
            saved, current = verified(args.path)
            if current is None:
                raise ValueError("recorded process is not running")
            print(saved["pid"])
        else:
            stop(args.path)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
