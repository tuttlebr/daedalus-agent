import asyncio
import json
from unittest.mock import MagicMock

import pytest


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Fake httpx client used by the SSRF redirect tests (F-002a / F-002b).
# Mirrors the _QueuedClient pattern in tests/test_webscrape_utils.py: each
# request returns the next queued response regardless of URL, so a test can
# model a redirect chain that ends at a private/metadata target.
# ---------------------------------------------------------------------------
class _FakeResponse:
    def __init__(self, *, is_redirect=False, location=None, status_code=200, text=""):
        self.is_redirect = is_redirect
        self.headers = {"location": location} if location else {}
        self.status_code = status_code
        self.text = text

    @property
    def is_success(self):
        return 200 <= self.status_code < 300


class _QueuedClient:
    def __init__(self, responses):
        self._responses = list(responses)
        self.requested_urls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def head(self, url):
        self.requested_urls.append(url)
        return self._responses.pop(0)

    async def get(self, url):
        self.requested_urls.append(url)
        return self._responses.pop(0)


async def _plan_fn(config_overrides=None):
    from source_verifier.source_verifier_function import (
        SourceVerifierConfig,
        source_verifier_function,
    )

    config = SourceVerifierConfig(
        enabled_operations=["plan_sources"],
        **(config_overrides or {}),
    )
    async for item in source_verifier_function(config, MagicMock()):
        return item.fn
    raise AssertionError("plan_sources was not registered")


def test_plan_sources_prioritizes_current_source_families():
    async def _run():
        plan_sources = await _plan_fn()
        raw = await plan_sources(
            research_question=(
                "What is the latest NVIDIA Developer Blog post about inference?"
            ),
            depth="quick",
        )
        return json.loads(raw)

    result = run(_run())

    assert result["passed"] is True
    tool_order = [
        tool for item in result["recommended_tool_sequence"] for tool in item["tools"]
    ]
    assert tool_order[:3] == [
        "curated_feed_search_tool",
        "perplexity_search_tool",
        "domain_retriever_tool",
    ]
    assert result["recommended_tool_sequence"][1]["hints"] == [
        {"tool": "perplexity_search_tool", "search_recency_filter": "week"}
    ]
    assert result["source_ledger_contract"]["audit_tool"].endswith("audit_citations")


def test_plan_sources_respects_selected_and_disabled_sources():
    async def _run():
        plan_sources = await _plan_fn()
        raw = await plan_sources(
            research_question="Deep research CUDA inference strategy.",
            selected_sources_json=json.dumps(["curated_domains", "perplexity_search"]),
            disabled_sources_json=json.dumps(["perplexity_search"]),
            depth="deep",
        )
        return json.loads(raw)

    result = run(_run())

    assert [source["id"] for source in result["selected_sources"]] == [
        "curated_domains"
    ]
    assert result["blocked_tools"] == ["perplexity_search_tool"]
    assert result["approval_recommended"] is False


def test_plan_sources_reports_unknown_sources():
    async def _run():
        plan_sources = await _plan_fn()
        raw = await plan_sources(
            research_question="Compare CUDA and ROCm.",
            selected_sources_json=json.dumps(["curated_domains", "missing"]),
        )
        return json.loads(raw)

    result = run(_run())

    assert result["passed"] is True
    assert result["unknown_sources"] == ["missing"]
    assert any("unknown source ids" in warning for warning in result["warnings"])


# ---------------------------------------------------------------------------
# F-002b: _check_link_reachable SSRF validation
# ---------------------------------------------------------------------------
def test_check_link_reachable_rejects_metadata_url_without_fetch():
    import source_verifier.source_verifier_function as mod

    captured = {}

    def _client_factory(*args, **kwargs):
        client = _QueuedClient([_FakeResponse(status_code=200)])
        captured["client"] = client
        return client

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(mod.httpx, "AsyncClient", _client_factory)
        result = run(
            mod._check_link_reachable("http://169.254.169.254/latest/meta-data/")
        )

    # Unsafe target rejected up front; no HEAD request was ever issued.
    assert result is False
    assert "client" not in captured


def test_check_link_reachable_rejects_redirect_to_internal():
    import source_verifier.source_verifier_function as mod

    # Public URL that HEAD-redirects to a metadata address.
    responses = [
        _FakeResponse(
            is_redirect=True, location="http://169.254.169.254/latest/meta-data/"
        ),
        _FakeResponse(status_code=200),
    ]
    client = _QueuedClient(responses)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(mod.httpx, "AsyncClient", lambda *a, **k: client)
        result = run(mod._check_link_reachable("https://example.com/redirector"))

    assert result is False
    # Only the first hop was fetched; the metadata target was never requested.
    assert client.requested_urls == ["https://example.com/redirector"]


def test_check_link_reachable_follows_safe_redirect():
    import source_verifier.source_verifier_function as mod

    responses = [
        _FakeResponse(is_redirect=True, location="https://example.org/final"),
        _FakeResponse(status_code=200),
    ]
    client = _QueuedClient(responses)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(mod.httpx, "AsyncClient", lambda *a, **k: client)
        result = run(mod._check_link_reachable("https://example.com/redirector"))

    assert result is True
    assert client.requested_urls == [
        "https://example.com/redirector",
        "https://example.org/final",
    ]


# ---------------------------------------------------------------------------
# F-002a: _fetch_source rejects redirects to internal/metadata addresses
# ---------------------------------------------------------------------------
def test_fetch_source_rejects_redirect_to_internal():
    import source_verifier.source_verifier_function as mod

    config = mod.SourceVerifierConfig(enabled_operations=["plan_sources"])

    # markitdown strategy is exercised first; force it to fail so the redirect-safe
    # httpx strategy runs.
    responses = [
        _FakeResponse(
            is_redirect=True, location="http://169.254.169.254/latest/meta-data/"
        ),
        _FakeResponse(status_code=200, text="<html>secret</html>"),
    ]
    client = _QueuedClient(responses)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            mod, "_scrape_with_markitdown", MagicMock(side_effect=RuntimeError("no js"))
        )
        mp.setattr(mod.httpx, "AsyncClient", lambda *a, **k: client)
        result = run(mod._fetch_source("https://example.com/redirector", config))

    assert result.status == "invalid_url"
    # The internal metadata target was never fetched.
    assert client.requested_urls == ["https://example.com/redirector"]


def test_fetch_source_rejects_literal_internal_url():
    import source_verifier.source_verifier_function as mod

    config = mod.SourceVerifierConfig(enabled_operations=["plan_sources"])

    # A literal metadata URL is rejected up front, before any network strategy.
    called = {"http": False}

    def _no_http(*args, **kwargs):
        called["http"] = True
        raise AssertionError("httpx client should not be constructed")

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(mod.httpx, "AsyncClient", _no_http)
        result = run(
            mod._fetch_source("http://169.254.169.254/latest/meta-data/", config)
        )

    assert result.status == "invalid_url"
    assert called["http"] is False
