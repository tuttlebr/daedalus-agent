"""Unit tests for webscrape utility functions.

Focuses on pure-Python helpers that don't require network access
or external library calls: URL validation, content detection,
token counting, and truncation.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock
from urllib.parse import urlparse

import pytest
import webscrape.webscrape_function as webscrape_mod
from webscrape.webscrape_function import (
    _count_tokens,
    _format_error,
    _is_challenge_page,
    _is_valid_content,
    _truncate_to_token_limit,
    _validate_url,
)

# ---------------------------------------------------------------------------
# _format_error
# ---------------------------------------------------------------------------


class TestFormatError:
    def test_includes_message(self):
        result = _format_error("Something went wrong")
        assert "Something went wrong" in result

    def test_includes_scrape_failed(self):
        assert "Scrape failed" in _format_error("oops")

    def test_returns_string(self):
        assert isinstance(_format_error("x"), str)


# ---------------------------------------------------------------------------
# _validate_url
# ---------------------------------------------------------------------------


class TestValidateUrl:
    def test_valid_https(self):
        url, parsed = _validate_url("https://example.com/path", ["https", "http"])
        assert url == "https://example.com/path"
        assert parsed.scheme == "https"
        assert parsed.netloc == "example.com"

    def test_valid_http(self):
        url, parsed = _validate_url("http://example.com", ["https", "http"])
        assert parsed.scheme == "http"

    def test_adds_https_prefix_when_no_scheme(self):
        url, parsed = _validate_url("example.com", ["https", "http"])
        assert url.startswith("https://")

    def test_strips_whitespace(self):
        url, _ = _validate_url("  https://example.com  ", ["https", "http"])
        assert url == "https://example.com"

    def test_empty_url_raises(self):
        with pytest.raises(ValueError, match="No URL supplied"):
            _validate_url("", ["https", "http"])

    def test_whitespace_only_raises(self):
        # After strip, "   " → "" → gets https:// prefix → urlparse gives no netloc
        with pytest.raises(ValueError):
            _validate_url("   ", ["https", "http"])

    def test_invalid_scheme_raises(self):
        with pytest.raises(ValueError, match="scheme is not allowed"):
            _validate_url("ftp://example.com", ["https", "http"])

    def test_no_netloc_raises(self):
        with pytest.raises(ValueError, match="missing a host"):
            _validate_url("https://", ["https", "http"])

    def test_scheme_case_insensitive(self):
        url, _ = _validate_url("HTTPS://example.com", ["https"])
        assert url.startswith("HTTPS://")

    def test_returns_tuple(self):
        result = _validate_url("https://example.com", ["https"])
        assert isinstance(result, tuple)
        assert len(result) == 2


# ---------------------------------------------------------------------------
# _is_challenge_page
# ---------------------------------------------------------------------------


class TestIsChallengePage:
    def test_empty_string_not_challenge(self):
        assert not _is_challenge_page("")

    def test_legitimate_content_not_challenge(self):
        text = "Welcome to our website. We have great products and services here."
        assert not _is_challenge_page(text)

    def test_single_signature_not_challenge(self):
        # Only 1 match — needs >= 2
        assert not _is_challenge_page("just a moment while we load the page")

    def test_two_signatures_is_challenge(self):
        text = "just a moment... checking your browser before accessing"
        assert _is_challenge_page(text)

    def test_cloudflare_challenge_detected(self):
        text = "just a moment enable javascript and cookies to continue"
        assert _is_challenge_page(text)

    def test_ddos_guard_detected(self):
        text = "ddos-guard is checking your browser"
        assert _is_challenge_page(text)

    def test_ray_id_detected(self):
        text = "ray id: 12345 checking your browser security"
        assert _is_challenge_page(text)

    def test_cf_challenge_signatures(self):
        text = "_cf_chl_opt challenge-platform verification pending"
        assert _is_challenge_page(text)

    def test_case_insensitive(self):
        text = "JUST A MOMENT... CHECKING YOUR BROWSER"
        assert _is_challenge_page(text)

    def test_only_checks_first_5000_chars(self):
        # Challenge signatures beyond first 5000 chars should be ignored
        prefix = "a" * 5001
        text = prefix + "just a moment checking your browser"
        # This should NOT be detected because it's beyond the 5000-char window
        assert not _is_challenge_page(text)


# ---------------------------------------------------------------------------
# _is_valid_content
# ---------------------------------------------------------------------------


class TestIsValidContent:
    def test_empty_string(self):
        assert not _is_valid_content("")

    def test_none(self):
        assert not _is_valid_content(None)  # type: ignore[arg-type]

    def test_too_short(self):
        assert not _is_valid_content("Short")

    def test_valid_real_content(self):
        content = "# Page Title\n\n" + "This is real page content. " * 5
        assert _is_valid_content(content)

    def test_challenge_page_not_valid(self):
        content = "just a moment checking your browser before accessing this content "
        content = content * 5  # enough length
        assert not _is_valid_content(content)

    def test_valid_content_with_source_header(self):
        content = (
            "# Title\n\n_Source: https://example.com_\n\n"
            + "Real article content here. " * 5
        )
        assert _is_valid_content(content)

    def test_challenge_page_after_source_header_not_valid(self):
        body = "just a moment checking your browser before access " * 3
        content = f"# Title\n\n_Source: https://x.com_\n\n{body}"
        assert not _is_valid_content(content)

    def test_exactly_50_chars_valid(self):
        # _is_valid_content checks len(body) < 50, so exactly 50 is NOT too short
        assert _is_valid_content("a" * 50)

    def test_49_chars_not_valid(self):
        # 49 chars < 50 → too short
        assert not _is_valid_content("a" * 49)

    def test_51_chars_valid_if_not_challenge(self):
        assert _is_valid_content("a" * 51)


# ---------------------------------------------------------------------------
# _count_tokens
# ---------------------------------------------------------------------------


class TestCountTokens:
    def test_returns_integer(self):
        result = _count_tokens("Hello world")
        assert isinstance(result, int)

    def test_empty_string(self):
        result = _count_tokens("")
        assert result == 0

    def test_positive_for_nonempty(self):
        assert _count_tokens("Hello") > 0

    def test_longer_text_more_tokens(self):
        short = _count_tokens("Hi")
        long = _count_tokens("Hi " * 100)
        assert long > short

    def test_approximation_fallback_when_no_tiktoken(self):
        original = webscrape_mod.TIKTOKEN_AVAILABLE
        try:
            webscrape_mod.TIKTOKEN_AVAILABLE = False
            result = _count_tokens("1234")
            assert result == 1  # 4 chars // 4
        finally:
            webscrape_mod.TIKTOKEN_AVAILABLE = original

    def test_approximation_8_chars(self):
        original = webscrape_mod.TIKTOKEN_AVAILABLE
        try:
            webscrape_mod.TIKTOKEN_AVAILABLE = False
            result = _count_tokens("12345678")
            assert result == 2  # 8 // 4
        finally:
            webscrape_mod.TIKTOKEN_AVAILABLE = original


# ---------------------------------------------------------------------------
# _truncate_to_token_limit
# ---------------------------------------------------------------------------


class TestTruncateToTokenLimit:
    def test_within_limit_no_change(self):
        text = "Short text"
        result, truncated = _truncate_to_token_limit(text, 10000, "TRUNC")
        assert result == text
        assert not truncated

    def test_over_limit_truncated(self):
        # Force char-based approximation for deterministic behaviour
        original = webscrape_mod.TIKTOKEN_AVAILABLE
        try:
            webscrape_mod.TIKTOKEN_AVAILABLE = False
            text = "a" * 2000  # ~500 tokens via char estimate
            result, truncated = _truncate_to_token_limit(text, 100, "TRUNC")
            assert truncated
            assert "TRUNC" in result
        finally:
            webscrape_mod.TIKTOKEN_AVAILABLE = original

    def test_truncated_result_shorter_than_original(self):
        original = webscrape_mod.TIKTOKEN_AVAILABLE
        try:
            webscrape_mod.TIKTOKEN_AVAILABLE = False
            text = "word " * 1000  # large text
            result, truncated = _truncate_to_token_limit(text, 50, "---TRUNC---")
            if truncated:
                assert len(result) < len(text)
        finally:
            webscrape_mod.TIKTOKEN_AVAILABLE = original

    def test_truncation_message_appended(self):
        original = webscrape_mod.TIKTOKEN_AVAILABLE
        try:
            webscrape_mod.TIKTOKEN_AVAILABLE = False
            text = "x" * 4000  # ~1000 tokens
            result, truncated = _truncate_to_token_limit(text, 10, "MY_TRUNCATION_MSG")
            assert truncated
            assert "MY_TRUNCATION_MSG" in result
        finally:
            webscrape_mod.TIKTOKEN_AVAILABLE = original


# ---------------------------------------------------------------------------
# _check_robots (async, tested via asyncio.run)
# ---------------------------------------------------------------------------


class TestCheckRobots:
    def test_404_means_no_robots_no_error(self):
        async def _run():
            from webscrape.webscrape_function import _check_robots

            mock_response = MagicMock()
            mock_response.status_code = 404

            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)

            await _check_robots(
                url="https://example.com/page",
                parsed_url=urlparse("https://example.com/page"),
                client=mock_client,
                user_agent="test-agent",
            )

        asyncio.run(_run())

    def test_401_raises_permission_error(self):
        async def _run():
            from webscrape.webscrape_function import _check_robots

            mock_response = MagicMock()
            mock_response.status_code = 401

            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)

            with pytest.raises(PermissionError):
                await _check_robots(
                    url="https://example.com/page",
                    parsed_url=urlparse("https://example.com/page"),
                    client=mock_client,
                    user_agent="test-agent",
                )

        asyncio.run(_run())

    def test_403_raises_permission_error(self):
        async def _run():
            from webscrape.webscrape_function import _check_robots

            mock_response = MagicMock()
            mock_response.status_code = 403

            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)

            with pytest.raises(PermissionError):
                await _check_robots(
                    url="https://example.com/page",
                    parsed_url=urlparse("https://example.com/page"),
                    client=mock_client,
                    user_agent="test-agent",
                )

        asyncio.run(_run())

    def test_500_proceeds_optimistically(self):
        async def _run():
            from webscrape.webscrape_function import _check_robots

            mock_response = MagicMock()
            mock_response.status_code = 500

            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)

            # Should NOT raise
            await _check_robots(
                url="https://example.com/page",
                parsed_url=urlparse("https://example.com/page"),
                client=mock_client,
                user_agent="test-agent",
            )

        asyncio.run(_run())

    def test_robots_disallows_raises(self):
        async def _run():
            from webscrape.webscrape_function import _check_robots

            robots_content = "User-agent: test-agent\nDisallow: /\n"
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.text = robots_content

            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)

            with pytest.raises(PermissionError):
                await _check_robots(
                    url="https://example.com/page",
                    parsed_url=urlparse("https://example.com/page"),
                    client=mock_client,
                    user_agent="test-agent",
                )

        asyncio.run(_run())

    def test_robots_allows_no_error(self):
        async def _run():
            from webscrape.webscrape_function import _check_robots

            robots_content = "User-agent: *\nAllow: /\n"
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.text = robots_content

            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)

            # Should NOT raise
            await _check_robots(
                url="https://example.com/page",
                parsed_url=urlparse("https://example.com/page"),
                client=mock_client,
                user_agent="test-agent",
            )

        asyncio.run(_run())
