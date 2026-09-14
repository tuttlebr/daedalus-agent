"""Tests for the deployment authentication preflight."""

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "validate_auth_env.py"
SPEC = importlib.util.spec_from_file_location("validate_auth_env", SCRIPT)
validate_auth_env = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = validate_auth_env
SPEC.loader.exec_module(validate_auth_env)


def test_accepts_cost_12_fallback_hash():
    count = validate_auth_env.validate_auth(
        {
            "AUTH_USERNAME": "operator",
            "AUTH_PASSWORD_HASH": "$2b$12$" + "a" * 53,
        }
    )

    assert count == 1


def test_accepts_contiguous_numbered_users():
    count = validate_auth_env.validate_auth(
        {
            "AUTH_USER_1_USERNAME": "one",
            "AUTH_USER_1_PASSWORD_HASH": "$2a$12$" + "a" * 53,
            "AUTH_USER_2_USERNAME": "two",
            "AUTH_USER_2_PASSWORD_HASH": "$2y$13$" + "b" * 53,
        }
    )

    assert count == 2


@pytest.mark.parametrize(
    ("entries", "message"),
    [
        ({"AUTH_USERNAME": "operator", "AUTH_PASSWORD": "secret"}, "plaintext"),
        (
            {
                "AUTH_USERNAME": "operator",
                "AUTH_PASSWORD_HASH": "$2b$10$" + "a" * 53,
            },
            "cost 12",
        ),
        (
            {
                "AUTH_USER_2_USERNAME": "two",
                "AUTH_USER_2_PASSWORD_HASH": "$2b$12$" + "a" * 53,
            },
            "contiguous",
        ),
        ({"AUTH_USERNAME": "operator"}, "must both be configured"),
        ({}, "configure AUTH_USERNAME"),
    ],
)
def test_rejects_unsafe_or_incomplete_configuration(entries, message):
    with pytest.raises(ValueError, match=message):
        validate_auth_env.validate_auth(entries)
