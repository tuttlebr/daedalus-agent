"""
Shared pytest configuration for all builder package tests.

Sets up sys.path for all package src/ directories and mocks heavy external dependencies before any test module is imported.
"""

import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

# F-007: integration mode. When enabled (PYTEST_USE_REAL_REDIS=1) the `redis`
# module is left UNMOCKED so tests exercise the real client, and tests marked
# `integration` are collected; otherwise integration-marked tests are skipped.
_USE_REAL_REDIS = (os.environ.get("PYTEST_USE_REAL_REDIS") or "").strip().lower() in (
    "1",
    "true",
    "yes",
)

# ---------------------------------------------------------------------------
# sys.path: add every package's src/ directory so imports work without install
# ---------------------------------------------------------------------------
BUILDER_DIR = Path(__file__).parent
for _pkg_dir in sorted(BUILDER_DIR.iterdir()):
    _src = _pkg_dir / "src"
    if _src.is_dir() and str(_src) not in sys.path:
        sys.path.insert(0, str(_src))


# ---------------------------------------------------------------------------
# Other heavy external dependencies that may not be installed locally
# ---------------------------------------------------------------------------


class _FakeHit:
    """Drop-in for pymilvus.client.abstract.Hit (must be a real class for isinstance)."""

    def __init__(self):
        self.fields: dict = {}
        self.distance: float = 0.0


_pymilvus_abstract_mod = MagicMock()
_pymilvus_abstract_mod.Hit = _FakeHit

_EXTERNAL_MOCKS = [
    "markitdown",
    "fastfeedparser",
    "cachetools",
    "openai",
    "pymilvus",
    "pymilvus.client",
    "nv_ingest_client",
    "nv_ingest_client.client",
    "redis",
    "langchain_core",
    "langchain_core.embeddings",
    "langchain_core.messages",
    # httpx handled separately below (needs real exception classes)
    "fastapi",
    "fastapi.responses",
]
if _USE_REAL_REDIS and "redis" in _EXTERNAL_MOCKS:
    _EXTERNAL_MOCKS.remove("redis")
for _mod_name in _EXTERNAL_MOCKS:
    sys.modules.setdefault(_mod_name, MagicMock())


# ---------------------------------------------------------------------------
# httpx mock: real exception classes so isinstance() works in mcp_patches
# ---------------------------------------------------------------------------
class _FakeHTTPError(Exception):
    pass


class _FakeTimeoutException(_FakeHTTPError):
    pass


class _FakeConnectTimeout(_FakeTimeoutException):
    pass


class _FakeReadTimeout(_FakeTimeoutException):
    pass


class _FakeNetworkError(_FakeHTTPError):
    pass


class _FakeConnectError(_FakeNetworkError):
    pass


class _FakeReadError(_FakeNetworkError):
    pass


class _FakeRemoteProtocolError(_FakeHTTPError):
    pass


class _FakeProxyError(_FakeHTTPError):
    pass


class _FakeHTTPStatusError(_FakeHTTPError):
    def __init__(self, message="", *, request=None, response=None):
        super().__init__(message)
        self.request = request
        self.response = response


try:
    import httpx as _httpx_mod
except ImportError:  # pragma: no cover - minimal test environments only
    _httpx_mod = MagicMock()
    _httpx_mod.ConnectTimeout = _FakeConnectTimeout
    _httpx_mod.ConnectError = _FakeConnectError
    _httpx_mod.ReadTimeout = _FakeReadTimeout
    _httpx_mod.TimeoutException = _FakeTimeoutException
    _httpx_mod.NetworkError = _FakeNetworkError
    _httpx_mod.ReadError = _FakeReadError
    _httpx_mod.RemoteProtocolError = _FakeRemoteProtocolError
    _httpx_mod.ProxyError = _FakeProxyError
    _httpx_mod.HTTPError = _FakeHTTPError
    _httpx_mod.HTTPStatusError = _FakeHTTPStatusError
    sys.modules.setdefault("httpx", _httpx_mod)

# pymilvus.client.abstract needs a real Hit class for isinstance() checks
sys.modules.setdefault("pymilvus.client.abstract", _pymilvus_abstract_mod)


# ---------------------------------------------------------------------------
# Integration-test gating (F-007)
# ---------------------------------------------------------------------------
import pytest  # noqa: E402


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "integration: test requires real backing services (e.g. Redis); "
        "skipped unless PYTEST_USE_REAL_REDIS=1 (run via `make test-integration`).",
    )


def pytest_collection_modifyitems(config, items):
    """Skip `integration`-marked tests unless integration mode is enabled."""
    if _USE_REAL_REDIS:
        return
    skip_integration = pytest.mark.skip(
        reason="integration test: set PYTEST_USE_REAL_REDIS=1 (make test-integration)"
    )
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip_integration)
