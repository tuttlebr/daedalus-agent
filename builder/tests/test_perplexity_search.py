"""Tests for the Perplexity Search API tool."""

import asyncio
import inspect
import json
from typing import get_args
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


def test_request_normalizes_iso_dates_and_prefers_exact_dates():
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
                search_recency_filter="week",
                search_after_date_filter="2026-08-20",
                search_before_date_filter="08/22/2026",
                last_updated_after_filter="2026-08-21",
            )

    output = run(_run())

    assert "[NVIDIA](https://www.nvidia.com/)" in output
    assert FakeAsyncClient.last_json["search_after_date_filter"] == "08/20/2026"
    assert FakeAsyncClient.last_json["search_before_date_filter"] == "08/22/2026"
    assert FakeAsyncClient.last_json["last_updated_after_filter"] == "08/21/2026"
    assert "search_recency_filter" not in FakeAsyncClient.last_json


def test_tool_schema_annotations_describe_date_contract():
    from perplexity_search.perplexity_search_function import PerplexitySearchConfig

    async def _run():
        return await _registered_search_fn(PerplexitySearchConfig(api_key="test-key"))

    search = run(_run())
    parameters = inspect.signature(search).parameters
    date_metadata = get_args(parameters["search_after_date_filter"].annotation)[1:]
    recency_metadata = get_args(parameters["search_recency_filter"].annotation)[1:]

    assert any(
        "MM/DD/YYYY or YYYY-MM-DD" in str(getattr(item, "description", ""))
        for item in date_metadata
    )
    assert any(
        "exact dates take precedence" in str(getattr(item, "description", ""))
        for item in recency_metadata
    )


def test_invalid_exact_date_returns_local_error_without_provider_request():
    import perplexity_search.perplexity_search_function as mod
    from perplexity_search.perplexity_search_function import PerplexitySearchConfig

    async def _run():
        FakeAsyncClient.last_json = None
        with patch.object(mod.httpx, "AsyncClient", FakeAsyncClient):
            search = await _registered_search_fn(
                PerplexitySearchConfig(api_key="test-key"),
            )
            return await search(
                query="nvidia blackwell",
                search_after_date_filter="02/30/2026",
            )

    output = run(_run())

    assert "search_after_date_filter must be a valid date" in output
    assert "MM/DD/YYYY or YYYY-MM-DD" in output
    assert FakeAsyncClient.last_json is None


def test_missing_api_key_returns_readable_error(monkeypatch):
    from perplexity_search.perplexity_search_function import PerplexitySearchConfig

    async def _run():
        monkeypatch.delenv("PERPLEXITY_SEARCH_API_KEY", raising=False)
        search = await _registered_search_fn(PerplexitySearchConfig(api_key=""))
        return await search(query="nvidia")

    assert "PERPLEXITY_SEARCH_API_KEY" in run(_run())


def test_rate_limit_is_explicitly_user_visible():
    import perplexity_search.perplexity_search_function as mod
    from perplexity_search.perplexity_search_function import PerplexitySearchConfig

    async def _run():
        FakeAsyncClient.response = FakeResponse(status_code=429, text="rate limited")
        with patch.object(mod.httpx, "AsyncClient", FakeAsyncClient):
            search = await _registered_search_fn(
                PerplexitySearchConfig(api_key="test-key"),
            )
            return await search(query="nvidia")

    output = run(_run())
    assert "server-side rate limit" in output
    assert "Report this limitation to the user" in output
    assert "do not retry" in output


def test_server_side_quota_exhaustion_is_explicitly_user_visible():
    import perplexity_search.perplexity_search_function as mod
    from perplexity_search.perplexity_search_function import PerplexitySearchConfig

    async def _run():
        FakeAsyncClient.response = FakeResponse(
            status_code=401,
            data={
                "error": {
                    "message": "You exceeded your current quota",
                    "type": "insufficient_quota",
                    "code": 401,
                }
            },
        )
        with patch.object(mod.httpx, "AsyncClient", FakeAsyncClient):
            search = await _registered_search_fn(
                PerplexitySearchConfig(api_key="test-key"),
            )
            return await search(query="nvidia")

    output = run(_run())
    assert "server-side API quota is exhausted" in output
    assert "operator billing or quota change" in output
    assert "Report this limitation to the user" in output


def test_provider_bad_request_returns_actionable_validation_detail():
    import perplexity_search.perplexity_search_function as mod
    from perplexity_search.perplexity_search_function import PerplexitySearchConfig

    async def _run():
        FakeAsyncClient.response = FakeResponse(
            status_code=400,
            data={
                "error": {
                    "message": "search_recency_filter conflicts with exact dates",
                    "type": "invalid_request",
                    "code": 400,
                }
            },
        )
        with patch.object(mod.httpx, "AsyncClient", FakeAsyncClient):
            search = await _registered_search_fn(
                PerplexitySearchConfig(api_key="test-key"),
            )
            return await search(query="nvidia")

    output = run(_run())

    assert "rejected the request arguments" in output
    assert "search_recency_filter conflicts with exact dates" in output
    assert "Correct the arguments before retrying" in output


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
