"""Unit tests for rss_feed utility functions and data models."""

from unittest.mock import MagicMock, patch

import pytest
import rss_feed.rss_feed_function as rss_mod
from rss_feed.rss_feed_function import (
    RssEntry,
    RssSearchRequest,
    RssSearchResponse,
    _can_use_tiktoken,
    _count_tokens,
    _scrape_content,
    truncate_text,
)

# ---------------------------------------------------------------------------
# _can_use_tiktoken
# ---------------------------------------------------------------------------


class TestCanUseTiktoken:
    def test_returns_bool(self):
        result = _can_use_tiktoken()
        assert isinstance(result, bool)


# ---------------------------------------------------------------------------
# _count_tokens
# ---------------------------------------------------------------------------


class TestCountTokens:
    def test_empty_string(self):
        assert _count_tokens("") == 0

    def test_returns_integer(self):
        assert isinstance(_count_tokens("hello"), int)

    def test_positive_for_nonempty(self):
        assert _count_tokens("hello world") > 0

    def test_no_tiktoken_char_fallback(self):
        original = rss_mod.TIKTOKEN_AVAILABLE
        try:
            rss_mod.TIKTOKEN_AVAILABLE = False
            # 4 chars => 4 // 4 = 1
            assert _count_tokens("test") == 1
            # 8 chars => 8 // 4 = 2
            assert _count_tokens("testtest") == 2
        finally:
            rss_mod.TIKTOKEN_AVAILABLE = original

    def test_longer_text_more_tokens(self):
        assert _count_tokens("word " * 100) > _count_tokens("word")


# ---------------------------------------------------------------------------
# truncate_text
# ---------------------------------------------------------------------------


class TestTruncateText:
    def test_short_text_unchanged(self):
        text = "Hello world"
        assert truncate_text(text, max_tokens=1000) == text

    def test_returns_string(self):
        assert isinstance(truncate_text("hello", 100), str)

    def test_char_based_truncation(self):
        """Without tiktoken, truncates by chars: max_tokens * 4."""
        with patch.object(rss_mod, "_can_use_tiktoken", return_value=False):
            long_text = "a" * 5000
            result = truncate_text(long_text, max_tokens=100)
            # 100 * 4 = 400 char limit
            assert len(result) <= 400

    def test_char_based_short_text_unchanged(self):
        """Short text not truncated even without tiktoken."""
        with patch.object(rss_mod, "_can_use_tiktoken", return_value=False):
            text = "short"
            result = truncate_text(text, max_tokens=100)
            assert result == text

    def test_empty_string(self):
        assert truncate_text("", 100) == ""

    def test_zero_max_tokens(self):
        """Edge case: 0 tokens means empty char limit => empty string."""
        with patch.object(rss_mod, "_can_use_tiktoken", return_value=False):
            result = truncate_text("hello", max_tokens=0)
            # 0 * 4 = 0, so text[:0] = ""
            assert result == ""


# ---------------------------------------------------------------------------
# RssEntry
# ---------------------------------------------------------------------------


class TestRssEntry:
    def test_required_title_and_link(self):
        entry = RssEntry(title="Article Title", link="https://example.com/article")
        assert entry.title == "Article Title"
        assert entry.link == "https://example.com/article"

    def test_optional_fields_default_none(self):
        entry = RssEntry(title="T", link="https://x.com")
        assert entry.published is None
        assert entry.author is None
        assert entry.description is None

    def test_all_fields(self):
        entry = RssEntry(
            title="T",
            link="https://x.com",
            published="2024-01-01T00:00:00Z",
            author="Jane Doe",
            description="Summary of article",
        )
        assert entry.published == "2024-01-01T00:00:00Z"
        assert entry.author == "Jane Doe"
        assert entry.description == "Summary of article"

    def test_model_validation(self):
        with pytest.raises(Exception):  # missing required 'title'
            RssEntry(link="https://x.com")


# ---------------------------------------------------------------------------
# RssSearchRequest
# ---------------------------------------------------------------------------


class TestRssSearchRequest:
    def test_required_query(self):
        req = RssSearchRequest(query="AI news today")
        assert req.query == "AI news today"

    def test_optional_description_none_by_default(self):
        req = RssSearchRequest(query="test")
        assert req.description is None

    def test_with_description(self):
        req = RssSearchRequest(query="test", description="A test search")
        assert req.description == "A test search"

    def test_missing_query_raises(self):
        with pytest.raises(Exception):
            RssSearchRequest()


# ---------------------------------------------------------------------------
# RssSearchResponse
# ---------------------------------------------------------------------------


class TestRssSearchResponse:
    def test_success_response(self):
        resp = RssSearchResponse(
            success=True,
            query="test",
            feed_url="https://feed.example.com/rss",
        )
        assert resp.success is True
        assert resp.entries_count == 0
        assert resp.cached is False
        assert resp.error is None
        assert resp.top_result is None
        assert resp.scraped_content is None

    def test_failure_response(self):
        resp = RssSearchResponse(
            success=False,
            query="test",
            feed_url="",
            error="Service unavailable",
        )
        assert resp.success is False
        assert resp.error == "Service unavailable"

    def test_with_top_result(self):
        resp = RssSearchResponse(
            success=True,
            query="q",
            feed_url="https://feed.example.com",
            top_result={"title": "Article", "link": "https://x.com"},
            entries_count=5,
        )
        assert resp.top_result is not None
        assert resp.top_result["title"] == "Article"
        assert resp.entries_count == 5

    def test_model_dump_returns_dict(self):
        resp = RssSearchResponse(success=True, query="q", feed_url="url")
        d = resp.model_dump()
        assert isinstance(d, dict)
        assert "success" in d
        assert "query" in d
        assert "feed_url" in d

    def test_cached_flag(self):
        resp = RssSearchResponse(success=True, query="q", feed_url="url", cached=True)
        assert resp.cached is True


# ---------------------------------------------------------------------------
# _scrape_content
# ---------------------------------------------------------------------------


class TestScrapeContent:
    def _make_mock_md(self, title="Page Title", text_content="Content here"):
        mock_result = MagicMock()
        mock_result.title = title
        mock_result.text_content = text_content
        mock_md_instance = MagicMock()
        mock_md_instance.convert.return_value = mock_result
        return mock_md_instance

    def test_returns_content_and_flag(self):
        mock_md = self._make_mock_md()
        with patch.object(rss_mod, "MarkItDown", return_value=mock_md):
            content, was_truncated = _scrape_content(
                "https://example.com", 64000, "TRUNC"
            )
        assert isinstance(content, str)
        assert isinstance(was_truncated, bool)

    def test_content_includes_title(self):
        mock_md = self._make_mock_md(title="My Article Title")
        with patch.object(rss_mod, "MarkItDown", return_value=mock_md):
            content, _ = _scrape_content("https://example.com", 64000, "TRUNC")
        assert "My Article Title" in content

    def test_content_includes_source_url(self):
        mock_md = self._make_mock_md()
        with patch.object(rss_mod, "MarkItDown", return_value=mock_md):
            content, _ = _scrape_content("https://example.com", 64000, "TRUNC")
        assert "https://example.com" in content

    def test_content_includes_text_body(self):
        mock_md = self._make_mock_md(text_content="This is the article body text.")
        with patch.object(rss_mod, "MarkItDown", return_value=mock_md):
            content, _ = _scrape_content("https://example.com", 64000, "TRUNC")
        assert "This is the article body text." in content

    def test_no_title_falls_back_to_url(self):
        mock_md = self._make_mock_md(title=None)
        with patch.object(rss_mod, "MarkItDown", return_value=mock_md):
            content, _ = _scrape_content("https://example.com/no-title", 64000, "TRUNC")
        assert "https://example.com/no-title" in content

    def test_not_truncated_within_limit(self):
        mock_md = self._make_mock_md(text_content="Short content")
        with patch.object(rss_mod, "MarkItDown", return_value=mock_md):
            _, was_truncated = _scrape_content("https://example.com", 64000, "TRUNC")
        assert not was_truncated

    def test_raises_on_exception(self):
        mock_md_instance = MagicMock()
        mock_md_instance.convert.side_effect = RuntimeError("Connection refused")
        with patch.object(rss_mod, "MarkItDown", return_value=mock_md_instance):
            with pytest.raises(RuntimeError, match="Connection refused"):
                _scrape_content("https://example.com", 64000, "TRUNC")

    def test_none_text_content_handled(self):
        """text_content=None should not crash — treated as empty string."""
        mock_md = self._make_mock_md(title="Title", text_content=None)
        with patch.object(rss_mod, "MarkItDown", return_value=mock_md):
            content, _ = _scrape_content("https://example.com", 64000, "TRUNC")
        assert "Title" in content
