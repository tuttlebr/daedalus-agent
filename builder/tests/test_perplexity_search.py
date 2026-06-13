"""Tests for the Perplexity Search API tool."""

import asyncio
import json
from unittest.mock import MagicMock, patch

import httpx


def run(coro):
    return asyncio.run(coro)


class FakeResponse:
    def __init__(self, status_code=200, data=None, text=""):
        self.status_code = status_code
        self._data = data or {
            "id": "search-123",
            "server_time": "2026-06-11T12:00:00Z",
            "results": [
                {
                    "title": "NVIDIA",
                    "url": "https://www.nvidia.com/",
                    "snippet": "NVIDIA accelerates computing.",
                    "date": "2026-06-10",
                    "last_updated": "2026-06-11",
                }
            ],
        }
        self.text = text

    def raise_for_status(self):
        if self.status_code >= 400:
            request = object()
            raise httpx.HTTPStatusError("error", request=request, response=self)

    def json(self):
        return self._data


class FakeAsyncClient:
    last_base_url = None
    last_headers = None
    last_json = None
    response = FakeResponse()

    def __init__(self, timeout=None):
        self.timeout = timeout

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, base_url, headers, json):
        FakeAsyncClient.last_base_url = base_url
        FakeAsyncClient.last_headers = headers
        FakeAsyncClient.last_json = json
        return FakeAsyncClient.response


async def _registered_search_fn(config):
    from perplexity_search.perplexity_search_function import perplexity_search_function

    items = []
    async for item in perplexity_search_function(config, MagicMock()):
        items.append(item)
    return items[0].fn


def test_config_reads_perplexity_search_api_key(monkeypatch):
    from perplexity_search.perplexity_search_function import PerplexitySearchConfig

    monkeypatch.setenv("PERPLEXITY_SEARCH_API_KEY", "env-key")

    assert PerplexitySearchConfig().api_key == "env-key"


def test_request_uses_bearer_auth_and_supported_filters():
    import perplexity_search.perplexity_search_function as mod
    from perplexity_search.perplexity_search_function import PerplexitySearchConfig

    async def _run():
        FakeAsyncClient.response = FakeResponse()
        with patch.object(mod.httpx, "AsyncClient", FakeAsyncClient):
            search = await _registered_search_fn(
                PerplexitySearchConfig(api_key="test-key"),
            )
            return await search(
                query="nvidia blackwell",
                country="us",
                max_results=42,
                search_context_size="low",
                search_recency_filter="week",
                search_domain_filter="nvidia.com, developer.nvidia.com",
                search_language_filter="EN, fr",
            )

    output = run(_run())

    assert FakeAsyncClient.last_base_url == "https://api.perplexity.ai/search"
    assert FakeAsyncClient.last_headers["Authorization"] == "Bearer test-key"
    assert FakeAsyncClient.last_json == {
        "query": "nvidia blackwell",
        "max_results": 20,
        "country": "US",
        "search_context_size": "low",
        "search_recency_filter": "week",
        "search_domain_filter": ["nvidia.com", "developer.nvidia.com"],
        "search_language_filter": ["en", "fr"],
    }
    assert "[NVIDIA](https://www.nvidia.com/)" in output
    assert "<searchresults>" in output

    payload = json.loads(
        output.split("<searchresults>", 1)[1].split("</searchresults>", 1)[0]
    )
    assert payload["organic_results"][0]["link"] == "https://www.nvidia.com/"
    assert payload["organic_results"][0]["displayed_link"] == "nvidia.com"
    assert payload["organic_results"][0]["last_updated"] == "2026-06-11"


def test_missing_api_key_returns_readable_error(monkeypatch):
    from perplexity_search.perplexity_search_function import PerplexitySearchConfig

    async def _run():
        monkeypatch.delenv("PERPLEXITY_SEARCH_API_KEY", raising=False)
        search = await _registered_search_fn(PerplexitySearchConfig(api_key=""))
        return await search(query="nvidia")

    assert "PERPLEXITY_SEARCH_API_KEY" in run(_run())


def test_http_error_returns_status():
    import perplexity_search.perplexity_search_function as mod
    from perplexity_search.perplexity_search_function import PerplexitySearchConfig

    async def _run():
        FakeAsyncClient.response = FakeResponse(status_code=429, text="rate limited")
        with patch.object(mod.httpx, "AsyncClient", FakeAsyncClient):
            search = await _registered_search_fn(
                PerplexitySearchConfig(api_key="test-key"),
            )
            return await search(query="nvidia")

    assert run(_run()) == "Error: Perplexity Search returned status 429."


def test_build_payload_ignores_incomplete_results():
    from perplexity_search.perplexity_search_function import _build_payload

    payload = _build_payload(
        {
            "results": [
                {"title": "Missing URL", "snippet": "No URL"},
                {
                    "title": "Complete",
                    "url": "https://example.com/path",
                    "snippet": "Useful result",
                },
            ],
        },
        "example",
    )

    assert payload["search_info"]["total_results"] == 1
    assert payload["organic_results"] == [
        {
            "position": 1,
            "title": "Complete",
            "link": "https://example.com/path",
            "displayed_link": "example.com",
            "snippet": "Useful result",
        }
    ]
