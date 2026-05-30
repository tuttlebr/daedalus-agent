"""Tests for the OpenAI client pool-recycle circuit breaker (F-007)."""

import sys
from pathlib import Path

# llm_diagnostics.py lives at the workspace root inside the Docker image.
_BUILDER_ROOT = Path(__file__).resolve().parent.parent
if str(_BUILDER_ROOT) not in sys.path:
    sys.path.insert(0, str(_BUILDER_ROOT))

import llm_diagnostics  # noqa: E402


class _FakeAsyncClient:
    """Stands in for an httpx.AsyncClient (name contains 'Async')."""

    def __init__(self):
        self._transport = object()


def test_recycle_swaps_transport():
    client = _FakeAsyncClient()
    old = client._transport
    assert llm_diagnostics._recycle_client_pool(client) is True
    assert client._transport is not old


def test_pool_recycled_after_threshold(monkeypatch):
    base = "https://llm.example/v1"
    client = _FakeAsyncClient()
    monkeypatch.setattr(llm_diagnostics, "_RECYCLE_THRESHOLD", 3)
    llm_diagnostics._http_client_registry[base] = client
    llm_diagnostics._connection_error_counts.pop(base, None)
    old = client._transport

    llm_diagnostics._note_connection_error(base)
    llm_diagnostics._note_connection_error(base)
    # Below threshold: not recycled yet.
    assert client._transport is old
    assert llm_diagnostics._connection_error_counts[base] == 2

    llm_diagnostics._note_connection_error(base)
    # Threshold reached: pool recycled and the streak reset.
    assert client._transport is not old
    assert llm_diagnostics._connection_error_counts[base] == 0


def test_disabled_when_threshold_zero(monkeypatch):
    base = "https://llm.example/v1"
    client = _FakeAsyncClient()
    monkeypatch.setattr(llm_diagnostics, "_RECYCLE_THRESHOLD", 0)
    llm_diagnostics._http_client_registry[base] = client
    llm_diagnostics._connection_error_counts.pop(base, None)
    old = client._transport
    for _ in range(5):
        llm_diagnostics._note_connection_error(base)
    assert client._transport is old  # disabled -> never recycled


def test_unknown_base_url_is_noop(monkeypatch):
    monkeypatch.setattr(llm_diagnostics, "_RECYCLE_THRESHOLD", 1)
    llm_diagnostics._connection_error_counts.pop("https://unknown/", None)
    # No registered client for this base_url; must not raise.
    llm_diagnostics._note_connection_error("https://unknown/")
