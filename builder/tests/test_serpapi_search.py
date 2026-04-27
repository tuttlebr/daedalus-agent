"""Tests for SerpAPI search tool argument compatibility."""

import asyncio
from unittest.mock import MagicMock, patch


def run(coro):
    return asyncio.run(coro)


class FakeResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {
            "search_information": {"total_results": "1"},
            "organic_results": [
                {
                    "position": 1,
                    "title": "Example",
                    "link": "https://example.com",
                    "snippet": "Example result",
                }
            ],
        }


class FakeAsyncClient:
    last_params = None

    def __init__(self, timeout=None):
        self.timeout = timeout

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, base_url, params):
        FakeAsyncClient.last_params = params
        return FakeResponse()


async def _search_with_type(search_type: str):
    import serpapi_search.serpapi_search_function as mod
    from serpapi_search.serpapi_search_function import (
        SerpApiSearchConfig,
        serpapi_search_function,
    )

    with patch.object(mod.httpx, "AsyncClient", FakeAsyncClient):
        items = []
        async for item in serpapi_search_function(
            SerpApiSearchConfig(api_key="test-key"),
            MagicMock(),
        ):
            items.append(item)
        await items[0].fn(query="nvidia", search_type=search_type)
    return FakeAsyncClient.last_params["engine"]


def test_search_type_aliases_match_config_description():
    assert run(_search_with_type("organic")) == "google"
    assert run(_search_with_type("news")) == "google_news"
    assert run(_search_with_type("images")) == "google_images"
    assert run(_search_with_type("shopping")) == "google_shopping"
    assert run(_search_with_type("videos")) == "google_videos"


def test_google_prefixed_search_types_remain_supported():
    assert run(_search_with_type("google_news")) == "google_news"
