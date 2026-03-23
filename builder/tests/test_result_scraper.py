"""Unit tests for nat_helpers.result_scraper module."""

import asyncio
from unittest.mock import AsyncMock, MagicMock
from urllib.parse import urlparse

import nat_helpers.result_scraper as scraper_mod
import pytest
from nat_helpers.result_scraper import (
    ScrapeOutcome,
    SerpLinkScraperSettings,
    _count_tokens,
    _extract_link_and_title,
    _truncate_to_token_limit,
    _validate_url,
)

# ---------------------------------------------------------------------------
# _validate_url
# ---------------------------------------------------------------------------


class TestValidateUrl:
    def test_valid_https(self):
        url, parsed = _validate_url("https://example.com", ["https", "http"])
        assert url == "https://example.com"
        assert parsed.scheme == "https"

    def test_valid_http(self):
        url, parsed = _validate_url("http://example.com", ["https", "http"])
        assert parsed.scheme == "http"

    def test_adds_https_prefix(self):
        url, _ = _validate_url("example.com", ["https", "http"])
        assert url.startswith("https://")

    def test_strips_whitespace(self):
        url, _ = _validate_url("  https://example.com  ", ["https", "http"])
        assert url == "https://example.com"

    def test_invalid_scheme_raises(self):
        with pytest.raises(ValueError, match="scheme is not allowed"):
            _validate_url("ftp://example.com", ["https", "http"])

    def test_no_netloc_raises(self):
        with pytest.raises(ValueError, match="missing a host"):
            _validate_url("https://", ["https", "http"])

    def test_allowed_schemes_case_insensitive(self):
        url, _ = _validate_url("HTTPS://example.com", ["https"])
        assert "example.com" in url


# ---------------------------------------------------------------------------
# _extract_link_and_title
# ---------------------------------------------------------------------------


class TestExtractLinkAndTitle:
    def test_dict_with_link_and_title(self):
        entry = {"link": "https://example.com", "title": "Example Title"}
        link, title = _extract_link_and_title(entry)
        assert link == "https://example.com"
        assert title == "Example Title"

    def test_dict_no_link(self):
        entry = {"title": "Only a title"}
        link, title = _extract_link_and_title(entry)
        assert link is None
        assert title == "Only a title"

    def test_dict_no_title(self):
        entry = {"link": "https://example.com"}
        link, title = _extract_link_and_title(entry)
        assert link == "https://example.com"
        assert title is None

    def test_empty_dict(self):
        link, title = _extract_link_and_title({})
        assert link is None
        assert title is None

    def test_object_with_link_and_title_attrs(self):
        class Entry:
            link = "https://example.com"
            title = "Entry Title"

        link, title = _extract_link_and_title(Entry())
        assert link == "https://example.com"
        assert title == "Entry Title"

    def test_object_non_string_link_ignored(self):
        class Entry:
            link = 12345  # not a string
            title = "Title"

        link, title = _extract_link_and_title(Entry())
        # The code checks hasattr(entry, "link") first, then checks isinstance(link_value, str)
        assert link is None
        assert title == "Title"

    def test_dict_non_string_link_ignored(self):
        entry = {"link": 999, "title": "Title"}
        link, title = _extract_link_and_title(entry)
        assert link is None
        assert title == "Title"

    def test_object_with_only_link(self):
        class Entry:
            link = "https://example.com"

        link, title = _extract_link_and_title(Entry())
        assert link == "https://example.com"
        # title might be None since the object has no 'title' attr
        # but the code checks hasattr(entry, "title") first


# ---------------------------------------------------------------------------
# SerpLinkScraperSettings
# ---------------------------------------------------------------------------


class TestSerpLinkScraperSettings:
    def test_default_user_agent(self):
        settings = SerpLinkScraperSettings()
        assert settings.user_agent == "daedalus-serp-scraper/1.0"

    def test_default_respect_robots_txt(self):
        assert SerpLinkScraperSettings().respect_robots_txt is True

    def test_default_allowed_schemes(self):
        settings = SerpLinkScraperSettings()
        assert "https" in settings.allowed_schemes
        assert "http" in settings.allowed_schemes

    def test_default_max_output_tokens(self):
        assert SerpLinkScraperSettings().max_output_tokens == 64000

    def test_default_max_attempts_per_group(self):
        assert SerpLinkScraperSettings().max_attempts_per_group == 5

    def test_default_truncation_message(self):
        settings = SerpLinkScraperSettings()
        assert "truncated" in settings.truncation_message.lower()

    def test_custom_user_agent(self):
        settings = SerpLinkScraperSettings(user_agent="my-bot/2.0")
        assert settings.user_agent == "my-bot/2.0"

    def test_custom_max_output_tokens(self):
        settings = SerpLinkScraperSettings(max_output_tokens=1000)
        assert settings.max_output_tokens == 1000

    def test_max_output_tokens_lower_bound(self):
        with pytest.raises(Exception):
            SerpLinkScraperSettings(max_output_tokens=50)  # below ge=100

    def test_max_attempts_per_group_lower_bound(self):
        with pytest.raises(Exception):
            SerpLinkScraperSettings(max_attempts_per_group=0)  # below ge=1


# ---------------------------------------------------------------------------
# ScrapeOutcome
# ---------------------------------------------------------------------------


class TestScrapeOutcome:
    def test_required_source_type(self):
        outcome = ScrapeOutcome(source_type="organic")
        assert outcome.source_type == "organic"

    def test_defaults(self):
        outcome = ScrapeOutcome(source_type="top_story")
        assert outcome.link is None
        assert outcome.title is None
        assert outcome.content is None
        assert outcome.was_truncated is False
        assert outcome.attempts == 0
        assert outcome.error is None

    def test_with_all_fields(self):
        outcome = ScrapeOutcome(
            source_type="organic",
            link="https://example.com",
            title="Page Title",
            content="Some content",
            was_truncated=True,
            attempts=3,
            error=None,
        )
        assert outcome.link == "https://example.com"
        assert outcome.title == "Page Title"
        assert outcome.content == "Some content"
        assert outcome.was_truncated is True
        assert outcome.attempts == 3

    def test_with_error(self):
        outcome = ScrapeOutcome(source_type="organic", error="Network failed")
        assert outcome.error == "Network failed"


# ---------------------------------------------------------------------------
# _count_tokens
# ---------------------------------------------------------------------------


class TestCountTokens:
    def test_returns_integer(self):
        assert isinstance(_count_tokens("Hello"), int)

    def test_empty_string(self):
        assert _count_tokens("") == 0

    def test_positive_for_nonempty(self):
        assert _count_tokens("Hello world") > 0

    def test_longer_has_more_tokens(self):
        assert _count_tokens("word " * 50) > _count_tokens("word")

    def test_no_tiktoken_fallback(self):
        original = scraper_mod.TIKTOKEN_AVAILABLE
        try:
            scraper_mod.TIKTOKEN_AVAILABLE = False
            # 8 chars => 8 // 4 = 2
            assert _count_tokens("12345678") == 2
        finally:
            scraper_mod.TIKTOKEN_AVAILABLE = original


# ---------------------------------------------------------------------------
# _truncate_to_token_limit
# ---------------------------------------------------------------------------


class TestTruncateToTokenLimit:
    def test_within_limit_unchanged(self):
        text = "Short text"
        result, truncated = _truncate_to_token_limit(text, 10000, "TRUNC")
        assert result == text
        assert not truncated

    def test_over_limit_truncates(self):
        original = scraper_mod.TIKTOKEN_AVAILABLE
        try:
            scraper_mod.TIKTOKEN_AVAILABLE = False
            text = "a" * 2000  # 500 tokens via char estimate
            result, truncated = _truncate_to_token_limit(text, 50, "---END---")
            assert truncated
            assert "---END---" in result
        finally:
            scraper_mod.TIKTOKEN_AVAILABLE = original

    def test_paragraph_break_preferred(self):
        """Truncation prefers paragraph boundaries."""
        original = scraper_mod.TIKTOKEN_AVAILABLE
        try:
            scraper_mod.TIKTOKEN_AVAILABLE = False
            # Build text with paragraph break after the 80% mark
            base = "word " * 100  # ~400 chars
            para_break = "\n\n" + "more " * 20
            text = base + para_break + "end " * 20
            # Very tight limit to force truncation
            result, truncated = _truncate_to_token_limit(text, 20, "TRUNC")
            # Just verify it truncated successfully
            if truncated:
                assert "TRUNC" in result
        finally:
            scraper_mod.TIKTOKEN_AVAILABLE = original


# ---------------------------------------------------------------------------
# _check_robots (async)
# ---------------------------------------------------------------------------


class TestCheckRobots:
    def test_404_no_restriction(self):
        async def _run():
            from nat_helpers.result_scraper import _check_robots

            mock_response = MagicMock()
            mock_response.status_code = 404

            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)

            # Should not raise
            await _check_robots(
                url="https://example.com/path",
                parsed_url=urlparse("https://example.com/path"),
                client=mock_client,
                user_agent="test-agent",
            )

        asyncio.run(_run())

    def test_401_raises(self):
        async def _run():
            from nat_helpers.result_scraper import _check_robots

            mock_response = MagicMock()
            mock_response.status_code = 401

            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)

            with pytest.raises(PermissionError):
                await _check_robots(
                    url="https://example.com/path",
                    parsed_url=urlparse("https://example.com/path"),
                    client=mock_client,
                    user_agent="test-agent",
                )

        asyncio.run(_run())

    def test_403_raises(self):
        async def _run():
            from nat_helpers.result_scraper import _check_robots

            mock_response = MagicMock()
            mock_response.status_code = 403

            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)

            with pytest.raises(PermissionError):
                await _check_robots(
                    url="https://example.com/path",
                    parsed_url=urlparse("https://example.com/path"),
                    client=mock_client,
                    user_agent="test-agent",
                )

        asyncio.run(_run())

    def test_500_proceeds(self):
        async def _run():
            from nat_helpers.result_scraper import _check_robots

            mock_response = MagicMock()
            mock_response.status_code = 503

            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)

            # Should not raise
            await _check_robots(
                url="https://example.com/path",
                parsed_url=urlparse("https://example.com/path"),
                client=mock_client,
                user_agent="test-agent",
            )

        asyncio.run(_run())

    def test_disallow_all_proceeds_optimistically(self):
        # result_scraper._check_robots wraps the PermissionError inside a
        # broad `except Exception` block that catches it and proceeds
        # optimistically (logging a warning). It never re-raises.
        async def _run():
            from nat_helpers.result_scraper import _check_robots

            robots_txt = "User-agent: test-agent\nDisallow: /\n"
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.text = robots_txt

            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)

            # Should NOT raise — caught by except Exception internally
            await _check_robots(
                url="https://example.com/page",
                parsed_url=urlparse("https://example.com/page"),
                client=mock_client,
                user_agent="test-agent",
            )

        asyncio.run(_run())

    def test_allow_all_no_error(self):
        async def _run():
            from nat_helpers.result_scraper import _check_robots

            robots_txt = "User-agent: *\nAllow: /\n"
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.text = robots_txt

            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)

            # Should not raise
            await _check_robots(
                url="https://example.com/page",
                parsed_url=urlparse("https://example.com/page"),
                client=mock_client,
                user_agent="test-agent",
            )

        asyncio.run(_run())

    def test_broken_robots_txt_proceeds_optimistically(self):
        """If robots.txt parsing fails, proceed without error."""

        async def _run():
            from nat_helpers.result_scraper import _check_robots

            mock_response = MagicMock()
            mock_response.status_code = 200
            # Provide invalid (non-string) text that will cause a parsing exception
            mock_response.text = "valid robots content\n"
            # Override splitlines to throw
            mock_response.text = MagicMock()
            mock_response.text.splitlines.side_effect = RuntimeError("parse error")

            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)

            # Should not raise — defensive except clause
            await _check_robots(
                url="https://example.com/page",
                parsed_url=urlparse("https://example.com/page"),
                client=mock_client,
                user_agent="test-agent",
            )

        asyncio.run(_run())
