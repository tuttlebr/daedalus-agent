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


def test_accepts_single_quoted_hash_source(tmp_path):
    env_path = tmp_path / ".env"
    env_path.write_text(
        "AUTH_USER_1_PASSWORD_HASH='$2b$12$" + "a" * 53 + "'\n",
        encoding="utf-8",
    )

    assert validate_auth_env.find_unquoted_password_hashes(env_path) == []


@pytest.mark.parametrize(
    "source",
    [
        "AUTH_PASSWORD_HASH=$2b$12$" + "a" * 53,
        'AUTH_USER_1_PASSWORD_HASH="$2b$12$' + "a" * 53 + '"',
    ],
)
def test_reports_hash_source_that_compose_would_interpolate(tmp_path, source):
    env_path = tmp_path / ".env"
    env_path.write_text(source + "\n", encoding="utf-8")

    assert validate_auth_env.find_unquoted_password_hashes(env_path) == [
        source.split("=", 1)[0]
    ]


def test_load_env_reads_values_as_compose_does(tmp_path):
    env_path = tmp_path / ".env"
    env_path.write_text(
        "\n".join(
            [
                "# comment",
                "PLAIN=bar # trailing comment",
                "QUOTED='quoted' # c",
                "LITERAL='keep $this'",
                'DQ="x y"',
                "SPACED=' spaced '",
                "export EXP=1",
                "HASH=value#not-a-comment",
                "EMPTY=",
                "EMPTY_SQ=''",
                'EMPTY_DQ=""',
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    assert validate_auth_env.load_env(env_path) == {
        "PLAIN": "bar",
        "QUOTED": "quoted",
        "LITERAL": "keep $this",
        "DQ": "x y",
        "SPACED": " spaced ",
        "EXP": "1",
        "HASH": "value#not-a-comment",
        "EMPTY": "",
        "EMPTY_SQ": "",
        "EMPTY_DQ": "",
    }


def test_load_env_accepts_the_shipped_template():
    # Optional settings ship as bare `KEY=` lines; a deployment starts from
    # this file, so the parser must read them as empty values.
    template = Path(__file__).resolve().parents[2] / ".env.template"

    entries = validate_auth_env.load_env(template)

    assert entries
    assert "" in entries.values()


@pytest.mark.parametrize(
    "line",
    ["KEY=a$FOO", 'KEY="a$FOO"', "KEY='unterminated", 'KEY="done" trailing'],
)
def test_load_env_rejects_values_compose_would_read_differently(tmp_path, line):
    env_path = tmp_path / ".env"
    env_path.write_text(line + "\n", encoding="utf-8")

    with pytest.raises(ValueError, match="KEY"):
        validate_auth_env.load_env(env_path)


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
