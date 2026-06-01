"""Tests for the backend container entrypoint."""

import logging
import os

import entrypoint


def test_optional_tool_env_defaults_do_not_seed_unlisted_keys(monkeypatch):
    monkeypatch.delenv("UNLISTED_OPTIONAL_KEY", raising=False)

    entrypoint._configure_optional_tool_env(logging.getLogger("test"))

    assert "UNLISTED_OPTIONAL_KEY" not in os.environ


def test_optional_tool_env_defaults_leave_existing_env_untouched(monkeypatch):
    monkeypatch.setenv("UNLISTED_OPTIONAL_KEY", "real-key")

    entrypoint._configure_optional_tool_env(logging.getLogger("test"))

    assert os.environ["UNLISTED_OPTIONAL_KEY"] == "real-key"
