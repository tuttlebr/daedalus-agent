"""Fail the image build on unexpected Python dependency conflicts.

NAT 1.7 caps cryptography below 47, and NV-Ingest 26.3 pins urllib3 2.6.3.
Both constraints exclude the first upstream releases containing required
security fixes. The runtime uses narrow uv overrides until the publishers
widen those constraints. This check permits only those documented boundaries.
"""

from __future__ import annotations

import re
import sys

from packaging.version import Version

EXPECTED_CONFLICTS = {
    "cryptography": (
        re.compile(
            r"^The package `nvidia-nat-core` requires "
            r"`cryptography>=46\.0\.6,<47`, but "
            r"`(?P<installed>[^`]+)` is installed$"
        ),
        Version("48.0.1"),
        Version("49"),
    ),
    "urllib3": (
        re.compile(
            r"^The package `nv-ingest-client` requires "
            r"`urllib3==2\.6\.3`, but `(?P<installed>[^`]+)` is installed$"
        ),
        Version("2.7"),
        Version("3"),
    ),
}


def validate(output: str, returncode: int) -> None:
    conflicts = [
        line for line in output.splitlines() if line.startswith("The package `")
    ]
    matched_versions: dict[str, Version] = {}
    for line in conflicts:
        for dependency, (pattern, _minimum, _maximum) in EXPECTED_CONFLICTS.items():
            match = pattern.fullmatch(line)
            if match is not None:
                matched_versions[dependency] = Version(match.group("installed"))
                break

    if (
        returncode != 1
        or "Found 2 incompatibilities" not in output
        or len(conflicts) != 2
        or set(matched_versions) != set(EXPECTED_CONFLICTS)
    ):
        raise RuntimeError("uv pip check reported an unexpected dependency conflict")

    for dependency, installed in matched_versions.items():
        _pattern, minimum, maximum = EXPECTED_CONFLICTS[dependency]
        if not minimum <= installed < maximum:
            raise RuntimeError(
                f"{dependency} {installed} is outside the security override range"
            )


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: verify_uv_pip_check.py UV_PIP_CHECK_STATUS")

    validate(sys.stdin.read(), int(sys.argv[1]))


if __name__ == "__main__":
    main()
