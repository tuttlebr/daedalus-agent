"""Tests for the backend container entrypoint."""

import logging
import os

import entrypoint


def test_optional_tool_env_defaults_missing_exa_key(monkeypatch):
    monkeypatch.delenv("EXA_API_KEY", raising=False)

    entrypoint._configure_optional_tool_env(logging.getLogger("test"))

    assert os.environ["EXA_API_KEY"] == ""


def test_optional_tool_env_defaults_preserve_configured_exa_key(monkeypatch):
    monkeypatch.setenv("EXA_API_KEY", "real-key")

    entrypoint._configure_optional_tool_env(logging.getLogger("test"))

    assert os.environ["EXA_API_KEY"] == "real-key"
