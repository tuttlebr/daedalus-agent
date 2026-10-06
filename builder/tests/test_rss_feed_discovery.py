"""RSS discovery concurrency, freshness, and failure contracts."""

import asyncio
import importlib.util
import json
import socket
import subprocess
import sys
from contextlib import asynccontextmanager
from datetime import datetime
from importlib.metadata import PackageNotFoundError, distribution
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
import rss_feed.rss_feed_function as rss
from pydantic import ValidationError

# conftest replaces cachetools for unrelated tests; use the installed implementation
# here so expiry and coalescing assertions cover the real feed cache.
_cache_spec = importlib.util.spec_from_file_location(
    "rss_test_cachetools",
    distribution("cachetools").locate_file("cachetools/__init__.py"),
)
_cache_module = importlib.util.module_from_spec(_cache_spec)
sys.modules[_cache_spec.name] = _cache_module
_cache_spec.loader.exec_module(_cache_module)
TTLCache = _cache_module.TTLCache


@pytest.fixture(autouse=True)
def real_feed_cache(monkeypatch):
    monkeypatch.setattr(rss, "TTLCache", TTLCache)


class FeedHarness:
    def __init__(self):
        self.fetches = []
        self.network_gets = []
        self.reranks = []
        self.active = self.peak = 0
        self.delay = 0
        self.fail_scopes = set()
        self.empty_scopes = set()
        self.rank_failure = False
        self.client_creations = 0
        self.closed = 0
        self.article = AsyncMock(
            return_value=(
                SimpleNamespace(
                    markdown="# Verified article",
                    fetched_at="2026-09-21T00:00:00+00:00",
                ),
                "hit",
            )
        )

    @asynccontextmanager
    async def content_session(self, _builder):
        yield SimpleNamespace(article=self.article)

    def client(self, **kwargs):
        self.client_creations += 1
        harness = self

        class Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                harness.closed += 1

            async def get(self, url):
                harness.network_gets.append(url)
                return httpx.Response(200, text="[]", request=httpx.Request("GET", url))

            async def post(self, url, *, headers, json):
                harness.reranks.append(json)
                if harness.rank_failure:
                    return httpx.Response(503, request=httpx.Request("POST", url))
                return httpx.Response(
                    200,
                    json={
                        "results": [
                            {"index": index, "relevance_score": 1 / (index + 1)}
                            for index in range(
                                min(json["top_n"], len(json["documents"]))
                            )
                        ]
                    },
                    request=httpx.Request("POST", url),
                )

        return Client()

    async def fetch(self, _client, url):
        self.fetches.append(url)
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            scope = url.rsplit("/", 1)[1]
            if scope in self.fail_scopes:
                raise httpx.ConnectError("private upstream diagnostic")
            count = 0 if scope in self.empty_scopes else 3
            return httpx.Response(
                200,
                text=json.dumps(
                    [
                        {
                            "title": f"{scope} article {index}",
                            "link": f"https://8.8.8.8/{scope}/{index}",
                            "published": "2026-09-21",
                            "description": "<p>Discovery&nbsp;excerpt</p> " * 100,
                        }
                        for index in range(count)
                    ]
                ),
                request=httpx.Request("GET", url),
            )
        finally:
            self.active -= 1

    @asynccontextmanager
    async def registered(self, monkeypatch, **config):
        monkeypatch.setattr(rss.httpx, "AsyncClient", self.client)
        monkeypatch.setattr(rss, "AnonymousPublicClient", self.client)
        monkeypatch.setattr(rss, "get_public_response_async", self.fetch)
        monkeypatch.setattr(rss, "public_content_session", self.content_session)
        monkeypatch.setattr(
            rss.fastfeedparser,
            "parse",
            lambda text: SimpleNamespace(entries=json.loads(text)),
        )
        values = {
            "feeds": {
                name: f"https://8.8.8.8/{name}"
                for name in ("nvidia_developer", "semianalysis")
            },
            "reranker_endpoint": "http://reranker:8080/rerank",
            "reranker_model": "reranker",
        }
        values.update(config)
        generator = rss.rss_feed_function(rss.RssFeedFunctionConfig(**values), object())
        try:
            yield await generator.__anext__()
        finally:
            await generator.aclose()


def test_schema_uses_only_configured_scopes():
    schema = rss._rss_input_schema({"nvidia_developer": "https://8.8.8.8/rss"}, 2)
    document = schema.model_json_schema()
    assert document["properties"]["feed_scope"]["enum"] == ["auto", "nvidia_developer"]
    assert document["$defs"]["RssDiscoveryQuery"]["properties"]["feed_scope"][
        "enum"
    ] == ["auto", "nvidia_developer"]
    with pytest.raises(ValidationError):
        schema(query="GPU", feed_scope="nvidia_newsroom")
    with pytest.raises(ValidationError):
        schema(mode="discover", queries=[{"query": "GPU"}] * 3)
    with pytest.raises(ValidationError):
        schema(top_k=6)


def _runtime_available():
    try:
        for name in ("markitdown", "fastfeedparser"):
            distribution(name)
    except PackageNotFoundError:
        return False
    return True


@pytest.mark.skipif(
    not _runtime_available(), reason="Requires installed backend runtime dependencies"
)
def test_real_owned_registration_preserves_schema_and_nested_batch_models():
    """Subprocess uses real dependencies and the public typed invocation."""
    root = Path(__file__).resolve().parents[2]
    code = """
import asyncio, json, sys
from contextlib import asynccontextmanager
sys.path.insert(0, "builder")
from rss_feed.rss_feed_function import rss_feed_function, RssFeedFunctionConfig

async def main():
    config = RssFeedFunctionConfig()
    async with asynccontextmanager(rss_feed_function)(config, object()) as info:
        request = info.input_schema(mode="discover", queries=[{"query":"GPU", "feed_scope":"auto"}])
        result = json.loads(await info.ainvoke(request))
        assert result["mode"] == "discover"
        assert result["results"][0]["status"] == "unavailable"
        assert "not configured" in result["results"][0]["error"]
asyncio.run(main())
"""
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr


def test_batch_discovery_overlaps_fetches_and_omits_article_conversion(monkeypatch):
    async def run():
        harness = FeedHarness()
        harness.delay = 0.02
        async with harness.registered(monkeypatch, feed_concurrency=2) as info:
            result = json.loads(
                await info.fn(
                    mode="discover",
                    queries=[
                        {"query": "GPU", "feed_scope": "nvidia_developer"},
                        {"query": "AI", "feed_scope": "semianalysis"},
                    ],
                    top_k=2,
                )
            )
            assert "nvidia_newsroom" not in info.description
            assert "nvidia_developer" in info.description
        assert result["success"] is True
        assert result["article_content_verified"] is False
        assert harness.peak == 2
        assert len(harness.fetches) == 2
        assert len(result["results"]) == 2
        assert all(len(item["sources"]) == 2 for item in result["results"])
        for item in result["results"]:
            source = item["sources"][0]
            assert source["evidence"] == "feed_summary"
            assert len(source["excerpt"]) <= 800
            assert "<p>" not in source["excerpt"]
            assert datetime.fromisoformat(source["fetched_at"]).tzinfo is not None
        harness.article.assert_not_awaited()
        assert harness.client_creations == harness.closed == 2

    asyncio.run(run())


def test_concurrent_identical_cold_requests_coalesce_then_cache_hits_skip_dns(
    monkeypatch,
):
    async def run():
        harness = FeedHarness()
        harness.delay = 0.02
        async with harness.registered(monkeypatch) as info:
            first, second = [
                json.loads(item)["results"][0]
                for item in await asyncio.gather(
                    *[
                        info.fn(
                            query="GPU", feed_scope="nvidia_developer", mode="discover"
                        )
                        for _ in range(2)
                    ]
                )
            ]
            assert len(harness.fetches) == 1
            assert {
                first["feeds"][0]["coalesced"],
                second["feeds"][0]["coalesced"],
            } == {False, True}
            monkeypatch.setattr(
                socket,
                "getaddrinfo",
                lambda *a, **kw: pytest.fail("warm feed lookup attempted DNS"),
            )
            warm = json.loads(
                await info.fn(
                    query="GPU", feed_scope="nvidia_developer", mode="discover"
                )
            )["results"][0]
            assert warm["cached"] is True
            assert warm["feeds"][0]["fetched_at"] == first["feeds"][0]["fetched_at"]
            assert len(harness.fetches) == 1

    asyncio.run(run())


def test_cache_expiry_refetches_and_refreshes_timestamp(monkeypatch):
    async def run():
        clock = [0.0]
        monkeypatch.setattr(
            rss,
            "TTLCache",
            lambda *, maxsize, ttl: TTLCache(maxsize, ttl, timer=lambda: clock[0]),
        )
        harness = FeedHarness()
        async with harness.registered(monkeypatch, cache_ttl_hours=0.25) as info:
            first = json.loads(await info.fn(query="GPU", mode="discover"))["results"][
                0
            ]
            clock[0] = 901
            second = json.loads(await info.fn(query="GPU", mode="discover"))["results"][
                0
            ]
        assert len(harness.fetches) == 4
        assert second["cached"] is False
        for before, after in zip(first["feeds"], second["feeds"], strict=True):
            assert after["fetched_at"] > before["fetched_at"]
            assert (
                datetime.fromisoformat(after["expires_at"])
                - datetime.fromisoformat(after["fetched_at"])
            ).total_seconds() == 900

    asyncio.run(run())


def test_partial_failure_and_empty_feed_are_distinct(monkeypatch):
    async def run():
        harness = FeedHarness()
        harness.fail_scopes.add("semianalysis")
        async with harness.registered(monkeypatch) as info:
            partial = json.loads(await info.fn(query="GPU", mode="discover"))[
                "results"
            ][0]
            assert partial["success"] is True and partial["status"] == "partial"
            assert [feed["status"] for feed in partial["feeds"]] == [
                "available",
                "unavailable",
            ]
            unavailable = json.loads(
                await info.fn(query="AI", feed_scope="semianalysis", mode="discover")
            )["results"][0]
            assert unavailable["status"] == "unavailable"
            assert unavailable["success"] is False
            assert "private upstream" not in json.dumps(unavailable)
        harness = FeedHarness()
        harness.empty_scopes.add("semianalysis")
        async with harness.registered(monkeypatch) as info:
            empty = json.loads(
                await info.fn(query="AI", feed_scope="semianalysis", mode="discover")
            )["results"][0]
            assert empty["status"] == "empty" and empty["success"] is True
            assert empty["feeds"][0]["status"] == "empty"

    asyncio.run(run())


def test_feed_aliases_keep_their_scope_when_sharing_cache(monkeypatch):
    async def run():
        harness = FeedHarness()
        harness.delay = 0.01
        async with harness.registered(
            monkeypatch,
            feeds={"one": "https://8.8.8.8/shared", "two": "https://8.8.8.8/shared"},
        ) as info:
            result = json.loads(
                await info.fn(
                    mode="discover",
                    queries=[
                        {"query": "GPU", "feed_scope": scope}
                        for scope in ("one", "two")
                    ],
                )
            )
        assert len(harness.fetches) == 1
        assert [item["sources"][0]["feed_scope"] for item in result["results"]] == [
            "one",
            "two",
        ]

    asyncio.run(run())


def test_fetch_concurrency_is_bounded_across_batch(monkeypatch):
    async def run():
        harness = FeedHarness()
        harness.delay = 0.01
        async with harness.registered(monkeypatch, feed_concurrency=1) as info:
            await info.fn(mode="discover", queries=[{"query": "GPU"}, {"query": "AI"}])
        assert harness.peak == 1
        assert len(harness.fetches) == 2

    asyncio.run(run())


def test_cancelled_waiter_does_not_cancel_shared_fetch(monkeypatch):
    async def run():
        harness = FeedHarness()
        harness.delay = 0.05
        async with harness.registered(monkeypatch) as info:
            one = asyncio.create_task(
                info.fn(query="GPU", feed_scope="nvidia_developer", mode="discover")
            )
            two = asyncio.create_task(
                info.fn(query="AI", feed_scope="nvidia_developer", mode="discover")
            )
            while not harness.fetches:
                await asyncio.sleep(0)
            one.cancel()
            with pytest.raises(asyncio.CancelledError):
                await one
            result = json.loads(await two)
            assert result["success"] is True
            assert len(harness.fetches) == 1

    asyncio.run(run())


def test_legacy_article_mode_retains_content_and_freshness(monkeypatch):
    async def run():
        harness = FeedHarness()
        async with harness.registered(monkeypatch) as info:
            result = json.loads(await info.fn("GPU", "nvidia_developer"))
        assert result["success"] is True
        assert result["content"] == "# Verified article"
        assert result["content_cache_status"] == "hit"
        assert result["content_fetched_at"] == "2026-09-21T00:00:00+00:00"
        assert result["feeds"][0]["fetched_at"]
        assert harness.reranks[0]["top_n"] == 1
        harness.article.assert_awaited_once()

    asyncio.run(run())


def test_runtime_validation_rejects_ambiguous_or_unbounded_requests(monkeypatch):
    async def run():
        harness = FeedHarness()
        async with harness.registered(monkeypatch) as info:
            for kwargs in (
                {"query": "GPU", "feed_scope": "nvidia_newsroom"},
                {"query": ""},
                {"query": "GPU", "top_k": 10},
                {"queries": [{"query": "GPU"}]},
                {"mode": "discover", "query": "GPU", "queries": [{"query": "GPU"}]},
                {"mode": "discover", "queries": [{"query": "GPU"}] * 7},
            ):
                assert json.loads(await info.fn(**kwargs))["success"] is False
        assert not harness.fetches

    asyncio.run(run())


def test_reranker_failure_keeps_source_status_and_no_article(monkeypatch):
    async def run():
        harness = FeedHarness()
        harness.rank_failure = True
        async with harness.registered(monkeypatch) as info:
            result = json.loads(await info.fn(query="GPU", mode="discover"))["results"][
                0
            ]
        assert result["status"] == "unavailable"
        assert result["success"] is False
        assert result["feeds"][0]["status"] == "available"
        assert "reranking failed" in result["error"]
        harness.article.assert_not_awaited()

    asyncio.run(run())


def test_private_feed_is_unavailable_without_http_or_cache_population(monkeypatch):
    from nat_helpers.safe_http import get_public_response_async

    async def run():
        harness = FeedHarness()
        async with harness.registered(
            monkeypatch, feeds={"private": "http://169.254.169.254/latest/meta-data"}
        ) as info:
            monkeypatch.setattr(
                rss, "get_public_response_async", get_public_response_async
            )
            for _ in range(2):
                result = json.loads(await info.fn(query="GPU", mode="discover"))[
                    "results"
                ][0]
                assert result["status"] == "unavailable"
                assert result["cached"] is False
            assert not harness.fetches
            assert not harness.network_gets
            harness.article.assert_not_awaited()

    asyncio.run(run())


def test_discovery_discards_feed_links_with_private_addresses_or_unsafe_schemes(
    monkeypatch,
):
    async def run():
        harness = FeedHarness()
        async with harness.registered(
            monkeypatch, feeds={"one": "https://8.8.8.8/rss"}
        ) as info:
            monkeypatch.setattr(
                rss.fastfeedparser,
                "parse",
                lambda text: SimpleNamespace(
                    entries=[
                        {"title": "private", "link": "http://127.0.0.1/admin"},
                        {"title": "local", "link": "file:///etc/passwd"},
                        {"title": "public", "link": "https://8.8.8.8/article"},
                    ]
                ),
            )
            result = json.loads(await info.fn(query="GPU", mode="discover"))["results"][
                0
            ]
            assert result["entries_count"] == 1
            assert [source["title"] for source in result["sources"]] == ["public"]

    asyncio.run(run())
