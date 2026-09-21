"""
Tests for async generator functions and their inner closures.

These tests run the async generators with mocked dependencies to cover
the generator bodies and inner function logic that can't be tested through
simple utility function imports.
"""

import asyncio
import inspect
import json
import os
import socket
from unittest.mock import AsyncMock, MagicMock, patch

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def run(coro):
    """Run a coroutine synchronously."""
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# webscrape utility functions with mocked MarkItDown
# ---------------------------------------------------------------------------


class TestHtmlToMarkdown:
    def _mock_md(self, title="Page Title", text_content="Article body"):
        mock_result = MagicMock()
        mock_result.title = title
        mock_result.text_content = text_content
        mock_md_instance = MagicMock()
        mock_md_instance.convert.return_value = mock_result
        return mock_md_instance

    def test_basic_conversion(self):
        import webscrape.webscrape_function as wsmod
        from webscrape.webscrape_function import _html_to_markdown

        mock_md = self._mock_md()
        with patch.object(wsmod, "MarkItDown", return_value=mock_md):
            result = _html_to_markdown("<html>test</html>", "https://example.com")
        assert "Page Title" in result
        assert "Article body" in result
        assert "_Source: https://example.com_" in result

    def test_no_title_falls_back_to_url(self):
        import webscrape.webscrape_function as wsmod
        from webscrape.webscrape_function import _html_to_markdown

        mock_md = self._mock_md(title=None)
        with patch.object(wsmod, "MarkItDown", return_value=mock_md):
            result = _html_to_markdown("<html>test</html>", "https://no-title.com")
        assert "https://no-title.com" in result

    def test_custom_title_overrides_result_title(self):
        import webscrape.webscrape_function as wsmod
        from webscrape.webscrape_function import _html_to_markdown

        mock_md = self._mock_md(title="Wrong Title")
        with patch.object(wsmod, "MarkItDown", return_value=mock_md):
            result = _html_to_markdown(
                "<html>test</html>", "https://example.com", title="Custom Title"
            )
        assert "Custom Title" in result

    def test_token_limit_truncation(self):
        import webscrape.webscrape_function as wsmod
        from webscrape.webscrape_function import _html_to_markdown

        mock_md = self._mock_md(text_content="word " * 5000)
        with patch.object(wsmod, "MarkItDown", return_value=mock_md):
            original_available = wsmod.TIKTOKEN_AVAILABLE
            try:
                wsmod.TIKTOKEN_AVAILABLE = False  # use char-based
                result = _html_to_markdown(
                    "<html>test</html>",
                    "https://example.com",
                    token_limit=50,
                    truncation_msg="TRUNCATED",
                )
            finally:
                wsmod.TIKTOKEN_AVAILABLE = original_available
        assert "TRUNCATED" in result

    def test_none_text_content(self):
        import webscrape.webscrape_function as wsmod
        from webscrape.webscrape_function import _html_to_markdown

        mock_md = self._mock_md(text_content=None)
        with patch.object(wsmod, "MarkItDown", return_value=mock_md):
            result = _html_to_markdown("<html></html>", "https://example.com")
        assert "Page Title" in result

    def test_temp_file_cleaned_up(self):
        """Temp file should be deleted after conversion."""
        import webscrape.webscrape_function as wsmod
        from webscrape.webscrape_function import _html_to_markdown

        mock_md = self._mock_md()
        with patch.object(wsmod, "MarkItDown", return_value=mock_md):
            result = _html_to_markdown("<html>test</html>", "https://example.com")
        assert isinstance(result, str)


class TestScrapeWithMarkitdown:
    def test_basic_scrape(self):
        import webscrape.webscrape_function as wsmod
        from webscrape.webscrape_function import _scrape_with_markitdown

        mock_result = MagicMock()
        mock_result.title = "Test Page"
        mock_result.text_content = "Content here"
        mock_md = MagicMock()
        mock_md.convert.return_value = mock_result

        with patch.object(wsmod, "MarkItDown", return_value=mock_md):
            result = _scrape_with_markitdown(
                "https://example.com",
                fetched_content=b"<html>content</html>",
                content_type="text/html",
            )
        converted_path = mock_md.convert.call_args.args[0]
        assert converted_path != "https://example.com"
        assert not os.path.exists(converted_path)
        assert "Test Page" in result
        assert "Content here" in result

    def test_no_title(self):
        import webscrape.webscrape_function as wsmod
        from webscrape.webscrape_function import _scrape_with_markitdown

        mock_result = MagicMock()
        mock_result.title = None
        mock_result.text_content = "Some content"
        mock_md = MagicMock()
        mock_md.convert.return_value = mock_result

        with patch.object(wsmod, "MarkItDown", return_value=mock_md):
            result = _scrape_with_markitdown(
                "https://example.com",
                fetched_content=b"<html>content</html>",
                content_type="text/html",
            )
        assert "https://example.com" in result

    def test_with_token_limit(self):
        import webscrape.webscrape_function as wsmod
        from webscrape.webscrape_function import _scrape_with_markitdown

        mock_result = MagicMock()
        mock_result.title = "Title"
        mock_result.text_content = "word " * 5000

        mock_md = MagicMock()
        mock_md.convert.return_value = mock_result

        original = wsmod.TIKTOKEN_AVAILABLE
        try:
            wsmod.TIKTOKEN_AVAILABLE = False
            with patch.object(wsmod, "MarkItDown", return_value=mock_md):
                result = _scrape_with_markitdown(
                    "https://example.com",
                    token_limit=20,
                    truncation_msg="TRUNC",
                    fetched_content=b"<html>content</html>",
                    content_type="text/html",
                )
        finally:
            wsmod.TIKTOKEN_AVAILABLE = original
        assert "TRUNC" in result


# ---------------------------------------------------------------------------
# webscrape _response_fn (inner function) via running the generator
# ---------------------------------------------------------------------------


class TestWebscrapeFunctionResponseFn:
    async def _call(self, url, *, respect_robots_txt=False):
        from webscrape.webscrape_function import (
            WebscrapeFunctionConfig,
            webscrape_function,
        )

        generator = webscrape_function(
            WebscrapeFunctionConfig(respect_robots_txt=respect_robots_txt), MagicMock()
        )
        fn_info = await generator.__anext__()
        try:
            return await fn_info.fn(url)
        finally:
            await generator.aclose()

    def _article(self, markdown):
        from nat_helpers.public_content import PublicArticle

        return PublicArticle(
            url="https://example.com",
            markdown=markdown,
            fetched_at="2026-09-21T12:00:00+00:00",
        ), "miss"

    def test_generator_yields_url_function(self):
        async def check():
            from webscrape.webscrape_function import (
                WebscrapeFunctionConfig,
                webscrape_function,
            )

            generator = webscrape_function(WebscrapeFunctionConfig(), MagicMock())
            fn_info = await generator.__anext__()
            try:
                assert "url" in inspect.signature(fn_info.fn).parameters
            finally:
                await generator.aclose()

        run(check())

    def test_invalid_url_returns_error(self):
        assert run(self._call("not://invalid-scheme.com")).startswith("Error: ")

    def test_non_string_input_returns_error(self):
        assert run(self._call(None)).startswith("Error: ")

    def test_hostname_resolving_private_is_rejected_before_scrape(self, monkeypatch):
        monkeypatch.setattr(
            socket,
            "getaddrinfo",
            lambda *_args, **_kwargs: [
                (socket.AF_INET, None, None, "", ("10.0.0.7", 0))
            ],
        )
        result = run(self._call("https://rebind.example/private"))
        assert result.startswith("Error: ")
        assert "non-public" in result.lower()

    def test_controlled_fetch_success_has_provenance(self, monkeypatch):
        from nat_helpers.public_content import PublicContentSession

        markdown = (
            "# Article Title\n\n_Source: https://example.com_\n\n"
            + "Real article content " * 5
        )
        article = AsyncMock(return_value=self._article(markdown))
        monkeypatch.setattr(PublicContentSession, "article", article)
        result = run(self._call("https://example.com"))
        assert "Article Title" in result
        assert "Real article content" in result
        assert "Fetched: 2026-09-21T12:00:00+00:00" in result
        article.assert_awaited_once()

    def test_challenge_page_is_error(self, monkeypatch):
        from nat_helpers.public_content import PublicContentSession

        monkeypatch.setattr(
            PublicContentSession,
            "article",
            AsyncMock(
                return_value=self._article("just a moment checking your browser")
            ),
        )
        result = run(self._call("https://example.com"))
        assert result.startswith("Error: ")

    def test_failed_article_is_error_without_browser_fallback(self, monkeypatch):
        from nat_helpers.public_content import PublicContentSession

        article = AsyncMock(side_effect=RuntimeError("blocked"))
        monkeypatch.setattr(PublicContentSession, "article", article)
        result = run(self._call("https://example.com"))
        assert result.startswith("Error: ")
        article.assert_awaited_once()

    def test_robots_denial_prevents_even_cached_article_access(self, monkeypatch):
        import webscrape.webscrape_function as wsmod
        from nat_helpers.public_content import PublicContentSession

        article = AsyncMock(return_value=self._article("cached article"))
        monkeypatch.setattr(PublicContentSession, "article", article)
        monkeypatch.setattr(
            wsmod,
            "_check_robots",
            AsyncMock(side_effect=PermissionError("robots.txt disallows")),
        )
        result = run(self._call("https://example.com", respect_robots_txt=True))
        assert "disallows" in result
        article.assert_not_awaited()


# ---------------------------------------------------------------------------
# rss_feed inner functions via running the generator
# ---------------------------------------------------------------------------


class TestRssFeedInnerFunctions:
    """Exercise registration while its clients remain inside their lifecycle."""

    def _make_config(self, **kwargs):
        from rss_feed.rss_feed_function import RssFeedFunctionConfig

        defaults = {
            "feed_url": "https://8.8.8.8/rss",
            "reranker_endpoint": "http://reranker:8080/rerank",
            "reranker_model": "nvidia/test-reranker",
        }
        defaults.update(kwargs)
        return RssFeedFunctionConfig(**defaults)

    async def _call(self, config, query="AI news", entries=None, rankings=None):
        from contextlib import asynccontextmanager
        from types import SimpleNamespace

        import httpx
        import rss_feed.rss_feed_function as rss_mod

        feed_response = httpx.Response(
            200,
            text="<rss/>",
            request=httpx.Request("GET", config.feed_url or "https://8.8.8.8"),
        )
        rerank_response = httpx.Response(
            200,
            json={"results": rankings or [{"index": 0, "relevance_score": 0.9}]},
            request=httpx.Request("POST", "http://reranker:8080/rerank"),
        )
        client = AsyncMock()
        client.get.return_value = feed_response
        client.post.return_value = rerank_response
        client.__aenter__.return_value = client
        article = SimpleNamespace(
            markdown="# Article", fetched_at="2026-09-21T00:00:00+00:00"
        )
        content = SimpleNamespace(article=AsyncMock(return_value=(article, "miss")))

        @asynccontextmanager
        async def content_session(_builder):
            yield content

        with (
            patch.object(rss_mod.httpx, "AsyncClient", return_value=client),
            patch.object(rss_mod, "AnonymousPublicClient", return_value=client),
            patch.object(rss_mod, "TTLCache", side_effect=lambda **kwargs: {}),
            patch.object(rss_mod, "public_content_session", content_session),
            patch.object(
                rss_mod.fastfeedparser,
                "parse",
                return_value=SimpleNamespace(entries=entries or []),
            ),
        ):
            generator = rss_mod.rss_feed_function(config, object())
            try:
                info = await generator.__anext__()
                result = await info.fn(query)
                return json.loads(result), client, info
            finally:
                await generator.aclose()

    def test_generator_yields_single_function(self):
        result, _, info = run(self._call(self._make_config(feed_url=None)))
        assert info.fn.__name__ == "search_rss"
        assert result["success"] is False

    def test_rss_search_no_feed_url(self):
        result, _, _ = run(self._call(self._make_config(feed_url=None)))
        assert result["success"] is False
        assert "feed_url" in result["error"]

    def test_rss_search_empty_entries(self):
        result, _, _ = run(self._call(self._make_config()))
        assert result["success"] is False
        assert result["error"] == "No entries found in RSS feed"
        assert result["feeds"][0]["status"] == "empty"

    def test_search_rss_returns_structured_error_on_failure(self):
        result, _, _ = run(self._call(self._make_config(feed_url=None)))
        assert result["query"] == "AI news"
        assert "not configured" in result["error"]

    def test_rss_search_allows_unauthenticated_vllm_reranker(self):
        entries = [{"title": "Article 1", "link": "https://8.8.8.8/1"}]
        with patch.dict(
            os.environ,
            {k: v for k, v in os.environ.items() if k != "NVIDIA_API_KEY"},
            clear=True,
        ):
            result, client, _ = run(self._call(self._make_config(), entries=entries))
        assert result["success"] is True
        assert result["source"]["url"] == "https://8.8.8.8/1"
        assert result["content"] == "# Article"
        assert result["content_fetched_at"] == "2026-09-21T00:00:00+00:00"
        assert "Authorization" not in client.post.call_args.kwargs["headers"]

    def test_rss_search_sends_compact_reranker_passages(self):
        import rss_feed.rss_feed_function as rss_mod

        entries = [
            {
                "title": "Verbose",
                "link": "https://8.8.8.8/1",
                "description": "<p>" + "word " * 2000 + "</p>",
            },
            {
                "title": "Relevant",
                "link": "https://8.8.8.8/2",
                "description": "Relevant summary",
            },
        ]
        result, client, _ = run(
            self._call(
                self._make_config(
                    reranker_api_key="test-key", reranker_max_passage_tokens=32
                ),
                entries=entries,
                rankings=[
                    {"index": 1, "relevance_score": 0.9},
                    {"index": 0, "relevance_score": 0.1},
                ],
            )
        )
        payload = client.post.call_args.kwargs["json"]
        assert result["source"]["url"] == "https://8.8.8.8/2"
        assert payload["top_n"] == 1
        assert "<p>" not in payload["documents"][0]
        assert rss_mod._count_tokens(payload["documents"][0]) <= 32
        assert (
            client.post.call_args.kwargs["headers"]["Authorization"]
            == "Bearer test-key"
        )
