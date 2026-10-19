"""Unit tests for rss_feed utility functions and data models."""

import socket
from unittest.mock import MagicMock, patch

import pytest
import rss_feed.rss_feed_function as rss_mod
from pydantic import ValidationError
from rss_feed.rss_feed_function import (
    RssEntry,
    RssFeedFunctionConfig,
    RssSearchRequest,
    _build_reranker_passages,
    _can_use_tiktoken,
    _convert_public_article,
    _count_tokens,
    _normalize_reranker_text,
    _reranker_error_message,
    _reranker_passage_token_limit,
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
        assert truncate_text(text, token_limit=1000) == text

    def test_returns_string(self):
        assert isinstance(truncate_text("hello", 100), str)

    def test_char_based_truncation(self):
        """Without tiktoken, truncates by chars: token_limit * 4."""
        with patch.object(rss_mod, "_can_use_tiktoken", return_value=False):
            long_text = "a" * 5000
            result = truncate_text(long_text, token_limit=100)
            # 100 * 4 = 400 char limit
            assert len(result) <= 400

    def test_char_based_short_text_unchanged(self):
        """Short text not truncated even without tiktoken."""
        with patch.object(rss_mod, "_can_use_tiktoken", return_value=False):
            text = "short"
            result = truncate_text(text, token_limit=100)
            assert result == text

    def test_empty_string(self):
        assert truncate_text("", 100) == ""

    def test_zero_token_limit(self):
        """Edge case: 0 tokens means empty char limit => empty string."""
        with patch.object(rss_mod, "_can_use_tiktoken", return_value=False):
            result = truncate_text("hello", token_limit=0)
            # 0 * 4 = 0, so text[:0] = ""
            assert result == ""

    def test_special_token_text_keeps_the_token_bound(self, monkeypatch):
        """Article text such as "<|endoftext|>" is content, not an encode error.

        tiktoken rejects special-token text unless disallowed_special=() is
        passed; the character fallback then allowed four characters per token.
        """

        class Encoding:
            # One token per character, like dense CJK text.
            def encode(self, text, *, allowed_special=(), disallowed_special="all"):
                if disallowed_special == "all" and "<|endoftext|>" in text:
                    raise ValueError("disallowed special token")
                return list(text)

            def decode(self, tokens):
                return "".join(tokens)

        monkeypatch.setattr(rss_mod, "_can_use_tiktoken", lambda: True)
        monkeypatch.setattr(
            rss_mod,
            "tiktoken",
            MagicMock(get_encoding=lambda _name: Encoding()),
            raising=False,
        )
        text = "Tokenizers emit <|endoftext|> between documents. " + "漢" * 2000

        assert truncate_text(text, token_limit=100) == text[:100]


# ---------------------------------------------------------------------------
# Reranker passage helpers
# ---------------------------------------------------------------------------


class TestRerankerPassageHelpers:
    def test_normalize_reranker_text_strips_html_and_whitespace(self):
        text = " <p>NVIDIA&nbsp;<b>GPU</b></p>\n\nNews "

        assert _normalize_reranker_text(text) == "NVIDIA GPU News"

    def test_reranker_passage_token_limit_scales_with_entry_count(self):
        limit = _reranker_passage_token_limit(
            query="latest AI news",
            entry_count=30,
            max_passage_tokens=512,
            max_total_tokens=7000,
        )

        assert 16 <= limit < 512

    def test_build_reranker_passages_compacts_large_rss_descriptions(self):
        entries = [
            RssEntry(
                title="Title",
                link="https://example.com/article",
                description="<p>" + ("word " * 2000) + "</p>",
                feed_scope="nvidia_blog",
                published="2026-05-18",
            )
        ]

        with patch.object(rss_mod, "_can_use_tiktoken", return_value=False):
            passages, indexes = _build_reranker_passages(
                query="gpu",
                entries=entries,
                max_passage_tokens=32,
                max_total_tokens=7000,
            )

        assert indexes == [0]
        assert passages[0]["text"].startswith("Title: Title")
        assert "<p>" not in passages[0]["text"]
        assert len(passages[0]["text"]) <= 32 * 4

    def test_reranker_error_message_does_not_expose_response_body(self):
        response = MagicMock()
        response.status_code = 400
        private_error = '{"message":"secret-host token=private"}'
        response.text = private_error

        message = _reranker_error_message(response)

        assert message == "Reranker request failed with HTTP 400."
        assert private_error not in message


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
        with pytest.raises(ValidationError, match="title"):
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
        with pytest.raises(ValidationError, match="query"):
            RssSearchRequest()


# ---------------------------------------------------------------------------
# RssFeedFunctionConfig defaults
# ---------------------------------------------------------------------------


class TestRssFeedConfigDefaults:
    def test_default_scraped_content_budget_is_8000_tokens(self):
        config = RssFeedFunctionConfig()

        assert config.scrape_max_output_tokens == 8000

    def test_default_scrape_timeout_bounds_fetch_and_conversion(self):
        config = RssFeedFunctionConfig()

        assert config.scrape_timeout == 20.0


# ---------------------------------------------------------------------------
# _convert_public_article (shared-session converter for fetched bytes)
# ---------------------------------------------------------------------------


class TestConvertPublicArticle:
    """Article bytes were fetched by the pinned public transport beforehand."""

    def _make_mock_md(self, title="Page Title", text_content="Content here"):
        mock_result = MagicMock()
        mock_result.title = title
        mock_result.text_content = text_content
        mock_md_instance = MagicMock()
        mock_md_instance.convert.return_value = mock_result
        return mock_md_instance

    def _convert(self, url="https://example.com", content_type="text/html"):
        return _convert_public_article(b"<html>article</html>", url, content_type)

    def test_converts_a_removed_local_file_never_the_url(self):
        mock_md = self._make_mock_md()
        with patch.object(rss_mod, "MarkItDown", return_value=mock_md):
            content = self._convert()
        converted_path = mock_md.convert.call_args.args[0]
        assert converted_path != "https://example.com"
        assert converted_path.endswith(".html")
        assert not rss_mod.os.path.exists(converted_path)
        assert (
            content == "# Page Title\n\n_Source: https://example.com_\n\nContent here"
        )

    def test_conversion_performs_no_dns_after_the_pinned_fetch(self, monkeypatch):
        # A resolver failure after a successful fetch must not discard the
        # article; the transport already validated the connected address.
        lookups = []

        def unavailable_dns(host, *_args, **_kwargs):
            lookups.append(host)
            raise socket.gaierror("resolver unavailable")

        monkeypatch.setattr(socket, "getaddrinfo", unavailable_dns)
        mock_md = self._make_mock_md(text_content="Fetched article body.")
        with patch.object(rss_mod, "MarkItDown", return_value=mock_md):
            content = self._convert("https://news.example/article")
        assert "Fetched article body." in content
        assert lookups == []

    def test_untrusted_suffixes_are_not_used_for_local_files(self):
        mock_md = self._make_mock_md()
        with patch.object(rss_mod, "MarkItDown", return_value=mock_md):
            self._convert("https://example.com/a.ph%2fp", content_type="")
        assert mock_md.convert.call_args.args[0].endswith(".bin")

    def test_no_title_falls_back_to_url(self):
        mock_md = self._make_mock_md(title=None)
        with patch.object(rss_mod, "MarkItDown", return_value=mock_md):
            content = self._convert("https://example.com/no-title")
        assert content.startswith("# https://example.com/no-title\n")

    def test_raises_on_exception(self):
        mock_md_instance = MagicMock()
        mock_md_instance.convert.side_effect = RuntimeError("Converter failed")
        with patch.object(rss_mod, "MarkItDown", return_value=mock_md_instance):
            with pytest.raises(RuntimeError, match="Converter failed"):
                self._convert()

    @pytest.mark.parametrize("text_content", [None, "", "  \n"])
    def test_empty_conversion_is_an_error_not_an_article(self, text_content):
        mock_md = self._make_mock_md(title="Title", text_content=text_content)
        with patch.object(rss_mod, "MarkItDown", return_value=mock_md):
            with pytest.raises(ValueError, match="no content"):
                self._convert()
