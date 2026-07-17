"""Tests for the fail-closed uv dependency conflict verifier."""

import pytest
import verify_uv_pip_check

EXPECTED_OUTPUT = """Checked 240 packages in 60ms
Found 2 incompatibilities
The package `nv-ingest-client` requires `urllib3==2.6.3`, but `2.7.0` is installed
The package `nvidia-nat-core` requires `cryptography>=46.0.6,<47`, but `48.0.1` is installed
"""


def test_allows_only_documented_security_overrides():
    verify_uv_pip_check.validate(EXPECTED_OUTPUT, 1)


def test_rejects_additional_dependency_conflict():
    output = (
        EXPECTED_OUTPUT.replace(
            "Found 2 incompatibilities",
            "Found 3 incompatibilities",
        )
        + "The package `example` requires `other<1`, but `2` is installed\n"
    )

    with pytest.raises(RuntimeError, match="unexpected dependency conflict"):
        verify_uv_pip_check.validate(output, 1)


def test_rejects_insecure_override_version():
    output = EXPECTED_OUTPUT.replace("`2.7.0` is installed", "`2.6.3` is installed")

    with pytest.raises(RuntimeError, match="outside the security override range"):
        verify_uv_pip_check.validate(output, 1)
