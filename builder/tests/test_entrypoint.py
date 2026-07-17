"""Tests for the backend container entrypoint."""

import entrypoint
import pytest


def test_runtime_versions_accept_the_pinned_abi(monkeypatch):
    versions = {
        "nvidia-nat-core": "1.7.0",
        "nvidia-nat-mcp": "1.7.0",
        "starlette": "1.3.1",
    }
    monkeypatch.setattr(entrypoint, "version", versions.__getitem__)

    entrypoint._assert_runtime_versions()


@pytest.mark.parametrize(
    "distribution,installed",
    [("nvidia-nat-core", "1.8.0"), ("nvidia-nat-mcp", "1.6.0")],
)
def test_runtime_versions_reject_unknown_nat_abi(monkeypatch, distribution, installed):
    versions = {
        "nvidia-nat-core": "1.7.0",
        "nvidia-nat-mcp": "1.7.0",
        "starlette": "1.3.1",
    }
    versions[distribution] = installed
    monkeypatch.setattr(entrypoint, "version", versions.__getitem__)

    with pytest.raises(RuntimeError, match="Unsupported"):
        entrypoint._assert_runtime_versions()


@pytest.mark.parametrize("installed", ["1.3.0", "2.0.0"])
def test_runtime_versions_reject_unsupported_starlette(monkeypatch, installed):
    versions = {
        "nvidia-nat-core": "1.7.0",
        "nvidia-nat-mcp": "1.7.0",
        "starlette": installed,
    }
    monkeypatch.setattr(entrypoint, "version", versions.__getitem__)

    with pytest.raises(RuntimeError, match="starlette>=1.3.1,<2"):
        entrypoint._assert_runtime_versions()
