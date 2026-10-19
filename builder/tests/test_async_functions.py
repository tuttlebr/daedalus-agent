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

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def run(coro):
    """Run a coroutine synchronously."""
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# webscrape utility functions with mocked MarkItDown
# ---------------------------------------------------------------------------


class TestConvertPublicResource:
    """Fetched bytes are converted locally; converters never receive a URL.

    ``PublicContentSession`` passes every fetched article through
    ``_convert_article`` with webscrape's converter, for webscrape and source
    verification alike.
    """

    def _mock_md(self, title="Page Title", text_content="Article body"):
        mock_result = MagicMock()
        mock_result.title = title
        mock_result.text_content = text_content
        mock_md_instance = MagicMock()

        def convert(path):
            with open(path, "rb") as file_obj:
                mock_md_instance.converted_bytes = file_obj.read()
            return mock_result

        mock_md_instance.convert.side_effect = convert
        return mock_md_instance

    def _convert(self, mock_md, content, content_type, html_article=None):
        import nat_helpers.public_content as public_content
        import webscrape.webscrape_function as wsmod

        with (
            patch.object(
                public_content, "_convert_html_article", return_value=html_article
            ),
            patch.object(wsmod, "MarkItDown", return_value=mock_md),
        ):
            return public_content._convert_article(
                content,
                "https://example.com",
                content_type,
                wsmod._convert_public_resource,
            )

    def test_html_fallback_converts_a_removed_local_html_file(self):
        mock_md = self._mock_md()
        result = self._convert(mock_md, b"<html>content</html>", "text/html")
        converted_path = mock_md.convert.call_args.args[0]
        assert converted_path != "https://example.com"
        assert converted_path.endswith(".html")
        assert not os.path.exists(converted_path)
        assert result == "# Page Title\n\n_Source: https://example.com_\n\nArticle body"

    def test_legacy_encoded_html_reaches_the_converter_unchanged(self):
        # Decoding cp1252 bytes as UTF-8 first would replace these characters.
        legacy = (
            '<html><head><meta charset="windows-1252"></head>'
            "<body><p>Müller: Résumé — £42</p></body></html>"
        ).encode("cp1252")
        mock_md = self._mock_md()
        self._convert(mock_md, legacy, "text/html")
        assert mock_md.converted_bytes == legacy

    def test_documents_keep_their_media_type_and_generic_converter(self):
        import nat_helpers.public_content as public_content

        mock_md = self._mock_md(title=None, text_content="PDF body")
        with patch.object(
            public_content,
            "_convert_html_article",
            side_effect=AssertionError("documents must not use the HTML path"),
        ):
            result = self._convert_without_html_patch(
                mock_md, b"%PDF-1.7", "application/pdf"
            )
        assert mock_md.convert.call_args.args[0].endswith(".pdf")
        assert (
            result
            == "# https://example.com\n\n_Source: https://example.com_\n\nPDF body"
        )

    def _convert_without_html_patch(self, mock_md, content, content_type):
        import nat_helpers.public_content as public_content
        import webscrape.webscrape_function as wsmod

        with patch.object(wsmod, "MarkItDown", return_value=mock_md):
            return public_content._convert_article(
                content,
                "https://example.com",
                content_type,
                wsmod._convert_public_resource,
            )


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
        # Only an unclassified failure keeps the generic explanation.
        assert "may require JavaScript" in result
        article.assert_awaited_once()

    def _fetch_with(self, monkeypatch, respond):
        """Replace only the public HTTP exchange; the shared session still runs."""
        import nat_helpers.public_content as public_content

        async def fetch(_client, url, **_kwargs):
            return respond(url)

        monkeypatch.setattr(public_content, "get_public_response_async", fetch)
        return run(self._call("https://sources.test/page"))

    @pytest.mark.parametrize(
        "status,expected", [(404, "HTTP 404 (Not Found)"), (410, "HTTP 410 (Gone)")]
    )
    def test_http_status_failure_names_the_status(self, monkeypatch, status, expected):
        import httpx

        result = self._fetch_with(
            monkeypatch,
            lambda url: httpx.Response(status, request=httpx.Request("GET", url)),
        )
        assert result.startswith("Error: ")
        assert expected in result
        assert "blocking automated access" not in result
        assert "JavaScript" not in result

    def test_access_denied_status_is_reported_as_blocking(self, monkeypatch):
        import httpx

        result = self._fetch_with(
            monkeypatch,
            lambda url: httpx.Response(403, request=httpx.Request("GET", url)),
        )
        assert "HTTP 403 (Forbidden)" in result
        assert "blocking automated access" in result

    def test_raw_challenge_page_is_reported_as_blocking(self, monkeypatch):
        import httpx

        challenge = (
            b"<html><title>Just a moment...</title>"
            b"<p>Checking your browser before accessing.</p></html>"
        )
        result = self._fetch_with(
            monkeypatch,
            lambda url: httpx.Response(
                200,
                content=challenge,
                headers={"content-type": "text/html"},
                request=httpx.Request("GET", url),
            ),
        )
        assert result == "Error: The site is blocking automated access."

    def test_page_without_extractable_content_is_reported(self, monkeypatch):
        import httpx
        import webscrape.webscrape_function as wsmod

        monkeypatch.setattr(
            wsmod,
            "_bytes_to_markdown",
            lambda content, url, content_type="": (
                f"# Empty\n\n_Source: {url}_\n\n{content.decode()}"
            ),
        )
        result = self._fetch_with(
            monkeypatch,
            lambda url: httpx.Response(
                200,
                content=b"   ",
                headers={"content-type": "text/plain"},
                request=httpx.Request("GET", url),
            ),
        )
        assert result == "Error: The page returned no extractable content."

    @pytest.mark.parametrize(
        "error_name,expected",
        [
            ("TimeoutError", "did not respond in time (timeout 30s)"),
            ("ReadTimeout", "did not respond in time (timeout 30s)"),
            ("ConnectError", "Could not connect to the site (ConnectError)"),
        ],
    )
    def test_transport_failures_report_their_cause(
        self, monkeypatch, error_name, expected
    ):
        import httpx
        from nat_helpers.public_content import PublicContentSession

        error = (
            TimeoutError()
            if error_name == "TimeoutError"
            else getattr(httpx, error_name)("synthetic failure")
        )
        monkeypatch.setattr(
            PublicContentSession, "article", AsyncMock(side_effect=error)
        )
        result = run(self._call("https://sources.test/page"))
        assert result.startswith("Error: ")
        assert expected in result
        assert "blocking automated access" not in result

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
