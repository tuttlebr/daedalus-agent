"""Fail the image build on unexpected Python dependency conflicts.

NV-Ingest 26.3 pins urllib3 below the required security floor. The
runtime uses narrow uv overrides until the publishers widen those constraints.
This check permits only those documented package/version boundaries.
"""

from __future__ import annotations

import re
import sys

from packaging.version import Version

EXPECTED_CONFLICTS = {
    "nv-ingest-client/urllib3": (
        re.compile(
            r"^The package `nv-ingest-client` requires "
            r"`urllib3==2\.6\.3`, but `(?P<installed>[^`]+)` is installed$"
        ),
        Version("2.8"),
        Version("3"),
    ),
}


def validate(output: str, returncode: int) -> None:
    if returncode == 0 and "The package `" not in output:
        return
    conflicts = [
        line for line in output.splitlines() if line.startswith("The package `")
    ]
    matched_versions: dict[str, Version] = {}
    for line in conflicts:
        for boundary, (pattern, _minimum, _maximum) in EXPECTED_CONFLICTS.items():
            match = pattern.fullmatch(line)
            if match is not None:
                matched_versions[boundary] = Version(match.group("installed"))
                break

    if (
        returncode != 1
        or "Found 1 incompatibility" not in output
        or len(conflicts) != 1
        or set(matched_versions) != set(EXPECTED_CONFLICTS)
    ):
        raise RuntimeError("uv pip check reported an unexpected dependency conflict")

    for boundary, installed in matched_versions.items():
        _pattern, minimum, maximum = EXPECTED_CONFLICTS[boundary]
        if not minimum <= installed < maximum:
            raise RuntimeError(
                f"{boundary} installed version {installed} is outside the "
                "security override range"
            )


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: verify_uv_pip_check.py UV_PIP_CHECK_STATUS")

    validate(sys.stdin.read(), int(sys.argv[1]))


if __name__ == "__main__":
    main()
