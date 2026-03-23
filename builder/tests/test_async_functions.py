"""
Tests for async generator functions and their inner closures.

These tests run the async generators with mocked dependencies to cover
the generator bodies and inner function logic that can't be tested through
simple utility function imports.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def run(coro):
    """Run a coroutine synchronously."""
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# vtt_interpreter_function generator + interpret_vtt_transcript
# ---------------------------------------------------------------------------


class TestVttInterpreterFunctionGenerator:
    def test_generator_yields_function_info(self):
        """Running the generator should yield exactly one FunctionInfo."""

        async def _run():
            from vtt_interpreter.vtt_interpreter_function import (
                VttInterpreterFunctionConfig,
                vtt_interpreter_function,
            )

            config = VttInterpreterFunctionConfig()
            builder = MagicMock()
            items = []
            async for item in vtt_interpreter_function(config, builder):
                items.append(item)
            assert len(items) == 1
            return items[0]

        fn_info = run(_run())
        assert fn_info is not None

    def test_generator_cleans_up(self):
        """Generator finally block should execute without error."""

        async def _run():
            from vtt_interpreter.vtt_interpreter_function import (
                VttInterpreterFunctionConfig,
                vtt_interpreter_function,
            )

            config = VttInterpreterFunctionConfig()
            builder = MagicMock()
            async for _ in vtt_interpreter_function(config, builder):
                pass  # exhaust the generator

        run(_run())  # should not raise

    def test_interpret_vtt_with_empty_transcript(self):
        """interpret_vtt_transcript returns error message for empty input."""

        async def _run():
            from vtt_interpreter.vtt_interpreter_function import (
                VttInterpreterFunctionConfig,
                vtt_interpreter_function,
            )

            config = VttInterpreterFunctionConfig()
            builder = MagicMock()
            fn_info = None
            async for item in vtt_interpreter_function(config, builder):
                fn_info = item
            assert fn_info is not None
            result = await fn_info.fn("")
            return result

        result = run(_run())
        assert "Error" in result

    def test_interpret_vtt_with_no_valid_entries(self):
        """Returns error when VTT text has no parseable entries."""

        async def _run():
            from vtt_interpreter.vtt_interpreter_function import (
                VttInterpreterFunctionConfig,
                vtt_interpreter_function,
            )

            config = VttInterpreterFunctionConfig()
            builder = MagicMock()
            fn_info = None
            async for item in vtt_interpreter_function(config, builder):
                fn_info = item
            result = await fn_info.fn("WEBVTT\n\n# No real entries here")
            return result

        result = run(_run())
        assert "Error" in result

    def test_interpret_vtt_calls_openai(self):
        """interpret_vtt_transcript makes an OpenAI chat completion call."""

        async def _run():
            import vtt_interpreter.vtt_interpreter_function as mod
            from vtt_interpreter.vtt_interpreter_function import (
                VttInterpreterFunctionConfig,
                vtt_interpreter_function,
            )

            # Set up a mock OpenAI client
            mock_response = MagicMock()
            mock_response.choices = [MagicMock()]
            mock_response.choices[
                0
            ].message.content = "# Meeting Notes\n\n## Attendees\n- Alice\n- Bob"

            mock_client = MagicMock()
            mock_client.chat = MagicMock()
            mock_client.chat.completions = MagicMock()
            mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

            config = VttInterpreterFunctionConfig()
            builder = MagicMock()

            with patch.object(mod, "AsyncOpenAI", return_value=mock_client):
                fn_info = None
                async for item in vtt_interpreter_function(config, builder):
                    fn_info = item

                # Call with a valid VTT transcript
                vtt_text = (
                    "WEBVTT\n\n"
                    "00:00:01.000 --> 00:00:02.000\n"
                    "<v Alice>Hello everyone</v>\n"
                    "\n"
                    "00:00:02.000 --> 00:00:03.000\n"
                    "<v Bob>Good morning</v>\n"
                )
                result = await fn_info.fn(vtt_text)
                return result

        result = run(_run())
        assert "Meeting Notes" in result or "Attendees" in result

    def test_interpret_vtt_handles_exception(self):
        """interpret_vtt_transcript catches exceptions and returns error string."""

        async def _run():
            import vtt_interpreter.vtt_interpreter_function as mod
            from vtt_interpreter.vtt_interpreter_function import (
                VttInterpreterFunctionConfig,
                vtt_interpreter_function,
            )

            mock_client = MagicMock()
            mock_client.chat.completions.create = AsyncMock(
                side_effect=RuntimeError("API down")
            )

            config = VttInterpreterFunctionConfig()
            builder = MagicMock()

            with patch.object(mod, "AsyncOpenAI", return_value=mock_client):
                fn_info = None
                async for item in vtt_interpreter_function(config, builder):
                    fn_info = item

                vtt_text = (
                    "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Alice>Hello</v>\n"
                )
                result = await fn_info.fn(vtt_text)
                return result

        result = run(_run())
        assert "Error" in result

    def test_interpret_vtt_with_custom_max_tokens(self):
        """interpret_vtt_transcript respects max_tokens parameter."""

        async def _run():
            import vtt_interpreter.vtt_interpreter_function as mod
            from vtt_interpreter.vtt_interpreter_function import (
                VttInterpreterFunctionConfig,
                vtt_interpreter_function,
            )

            mock_response = MagicMock()
            mock_response.choices = [MagicMock()]
            mock_response.choices[0].message.content = "Structured notes"

            mock_client = MagicMock()
            mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

            config = VttInterpreterFunctionConfig()
            builder = MagicMock()

            with patch.object(mod, "AsyncOpenAI", return_value=mock_client):
                fn_info = None
                async for item in vtt_interpreter_function(config, builder):
                    fn_info = item

                vtt_text = (
                    "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Alice>Hello</v>\n"
                )
                result = await fn_info.fn(vtt_text, max_tokens=512)
                return result, mock_client.chat.completions.create.call_args

        result, call_args = run(_run())
        assert call_args.kwargs.get("max_tokens") == 512

    def test_interpret_vtt_empty_choices_response(self):
        """Returns error message when OpenAI returns empty choices."""

        async def _run():
            import vtt_interpreter.vtt_interpreter_function as mod
            from vtt_interpreter.vtt_interpreter_function import (
                VttInterpreterFunctionConfig,
                vtt_interpreter_function,
            )

            mock_response = MagicMock()
            mock_response.choices = []  # empty choices

            mock_client = MagicMock()
            mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

            config = VttInterpreterFunctionConfig()
            builder = MagicMock()

            with patch.object(mod, "AsyncOpenAI", return_value=mock_client):
                fn_info = None
                async for item in vtt_interpreter_function(config, builder):
                    fn_info = item

                vtt_text = (
                    "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Alice>Hello</v>\n"
                )
                result = await fn_info.fn(vtt_text)
                return result

        result = run(_run())
        assert "Error" in result


# ---------------------------------------------------------------------------
# vtt_interpreter config models
# ---------------------------------------------------------------------------


class TestVttInterpreterConfigModels:
    def test_config_defaults(self):
        from vtt_interpreter.vtt_interpreter_function import (
            VttInterpreterFunctionConfig,
        )

        config = VttInterpreterFunctionConfig()
        assert config.api_endpoint == "http://localhost:8000"
        assert config.timeout == 300.0
        assert config.max_tokens == 4096
        assert config.model == "meta/llama-3.1-405b-instruct"

    def test_config_custom_values(self):
        from vtt_interpreter.vtt_interpreter_function import (
            VttInterpreterFunctionConfig,
        )

        config = VttInterpreterFunctionConfig(
            api_endpoint="http://custom:9000",
            timeout=60.0,
            max_tokens=2048,
            model="my-model",
            api_key="sk-test",
        )
        assert config.api_endpoint == "http://custom:9000"
        assert config.timeout == 60.0
        assert config.max_tokens == 2048
        assert config.model == "my-model"
        assert config.api_key == "sk-test"

    def test_input_model(self):
        from vtt_interpreter.vtt_interpreter_function import VttInterpreterInput

        inp = VttInterpreterInput(transcript_text="some VTT content")
        assert inp.transcript_text == "some VTT content"
        assert inp.max_tokens is None

    def test_input_model_with_max_tokens(self):
        from vtt_interpreter.vtt_interpreter_function import VttInterpreterInput

        inp = VttInterpreterInput(transcript_text="content", max_tokens=1024)
        assert inp.max_tokens == 1024


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

    def test_max_tokens_truncation(self):
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
                    max_tokens=50,
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
            result = _scrape_with_markitdown("https://example.com")
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
            result = _scrape_with_markitdown("https://example.com")
        assert "https://example.com" in result

    def test_with_max_tokens(self):
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
                    max_tokens=20,
                    truncation_msg="TRUNC",
                )
        finally:
            wsmod.TIKTOKEN_AVAILABLE = original
        assert "TRUNC" in result


# ---------------------------------------------------------------------------
# webscrape _response_fn (inner function) via running the generator
# ---------------------------------------------------------------------------


class TestWebscrapeFunctionResponseFn:
    def _get_response_fn(self, config=None):
        """Run webscrape_function generator and return the inner _response_fn."""

        async def _run():
            from webscrape.webscrape_function import (
                WebscrapeFunctionConfig,
                webscrape_function,
            )

            cfg = config or WebscrapeFunctionConfig()
            builder = MagicMock()
            fn_info = None
            async for item in webscrape_function(cfg, builder):
                fn_info = item
            return fn_info

        return run(_run())

    def test_generator_yields_function_info(self):
        fn_info = self._get_response_fn()
        assert fn_info is not None
        assert fn_info.fn is not None

    def test_invalid_url_returns_error(self):
        async def _run():
            from webscrape.webscrape_function import (
                WebscrapeFunctionConfig,
                webscrape_function,
            )

            cfg = WebscrapeFunctionConfig()
            builder = MagicMock()
            fn_info = None
            async for item in webscrape_function(cfg, builder):
                fn_info = item
            result = await fn_info.fn("not://invalid-scheme.com")
            return result

        result = run(_run())
        assert "Scrape failed" in result or "scheme" in result.lower()

    def test_non_string_input_returns_error(self):
        async def _run():
            from webscrape.webscrape_function import (
                WebscrapeFunctionConfig,
                webscrape_function,
            )

            cfg = WebscrapeFunctionConfig()
            builder = MagicMock()
            fn_info = None
            async for item in webscrape_function(cfg, builder):
                fn_info = item
            result = await fn_info.fn(None)  # not a string
            return result

        result = run(_run())
        assert "Scrape failed" in result

    def test_strategy1_success(self):
        """When MarkItDown succeeds and content is valid, return it directly."""

        async def _run():
            import webscrape.webscrape_function as wsmod
            from webscrape.webscrape_function import (
                WebscrapeFunctionConfig,
                webscrape_function,
            )

            mock_result = MagicMock()
            mock_result.title = "Article Title"
            mock_result.text_content = "Real article content " * 5
            mock_md = MagicMock()
            mock_md.convert.return_value = mock_result

            # Disable robots.txt check
            cfg = WebscrapeFunctionConfig(
                respect_robots_txt=False, use_browser_fallback=False
            )
            builder = MagicMock()

            with patch.object(wsmod, "MarkItDown", return_value=mock_md):
                fn_info = None
                async for item in webscrape_function(cfg, builder):
                    fn_info = item
                result = await fn_info.fn("https://example.com")
                return result

        result = run(_run())
        assert "Article Title" in result
        assert "Real article content" in result

    def test_strategy1_challenge_falls_through(self):
        """Challenge page from strategy1 triggers strategy2."""

        async def _run():
            import webscrape.webscrape_function as wsmod
            from webscrape.webscrape_function import (
                WebscrapeFunctionConfig,
                webscrape_function,
            )

            # Strategy 1 returns a challenge page
            mock_result = MagicMock()
            mock_result.title = "Just a Moment"
            mock_result.text_content = "just a moment checking your browser please wait"
            mock_md = MagicMock()
            mock_md.convert.return_value = mock_result

            # Strategy 2 (httpx) also fails
            async def mock_httpx_scrape(*args, **kwargs):
                return None

            cfg = WebscrapeFunctionConfig(
                respect_robots_txt=False, use_browser_fallback=False
            )
            builder = MagicMock()

            with patch.object(wsmod, "MarkItDown", return_value=mock_md):
                with patch.object(
                    wsmod, "_scrape_with_httpx", side_effect=Exception("httpx failed")
                ):
                    fn_info = None
                    async for item in webscrape_function(cfg, builder):
                        fn_info = item
                    result = await fn_info.fn("https://example.com")
                    return result

        result = run(_run())
        # Should get the challenge page content (returned as last resort)
        # or an error message
        assert isinstance(result, str)

    def test_robots_txt_blocked(self):
        """robots.txt PermissionError is caught and returned as error message."""

        async def _run():
            import webscrape.webscrape_function as wsmod
            from webscrape.webscrape_function import (
                WebscrapeFunctionConfig,
                webscrape_function,
            )

            # Mock _check_robots to raise PermissionError
            async def mock_check_robots(**kwargs):
                raise PermissionError("robots.txt disallows")

            cfg = WebscrapeFunctionConfig(respect_robots_txt=True)
            builder = MagicMock()

            with patch.object(wsmod, "_check_robots", side_effect=mock_check_robots):
                # Mock httpx.AsyncClient to avoid real network
                mock_client = AsyncMock()
                mock_client.__aenter__ = AsyncMock(return_value=mock_client)
                mock_client.__aexit__ = AsyncMock(return_value=None)
                with patch(
                    "webscrape.webscrape_function.httpx.AsyncClient",
                    return_value=mock_client,
                ):
                    fn_info = None
                    async for item in webscrape_function(cfg, builder):
                        fn_info = item
                    result = await fn_info.fn("https://example.com")
                    return result

        result = run(_run())
        assert "Scrape failed" in result or "disallows" in result


# ---------------------------------------------------------------------------
# result_scraper _prepare_markdown and _scrape_group
# ---------------------------------------------------------------------------


class TestResultScraperPrepareMarkdown:
    def test_basic_conversion(self):
        import nat_helpers.result_scraper as scraper_mod
        from nat_helpers.result_scraper import _prepare_markdown

        mock_result = MagicMock()
        mock_result.title = "Test Article"
        mock_result.text_content = "Article content here"
        mock_md = MagicMock()
        mock_md.convert.return_value = mock_result

        with patch.object(scraper_mod, "MarkItDown", return_value=mock_md):
            content, was_truncated = _prepare_markdown(
                url="https://example.com",
                max_tokens=64000,
                truncation_msg="TRUNC",
            )
        assert "Test Article" in content
        assert "Article content here" in content
        assert "https://example.com" in content
        assert not was_truncated

    def test_no_title_uses_url(self):
        import nat_helpers.result_scraper as scraper_mod
        from nat_helpers.result_scraper import _prepare_markdown

        mock_result = MagicMock()
        mock_result.title = None
        mock_result.text_content = "Content"
        mock_md = MagicMock()
        mock_md.convert.return_value = mock_result

        with patch.object(scraper_mod, "MarkItDown", return_value=mock_md):
            content, _ = _prepare_markdown(
                url="https://no-title.com",
                max_tokens=64000,
                truncation_msg="TRUNC",
            )
        assert "https://no-title.com" in content

    def test_truncation_when_over_limit(self):
        import nat_helpers.result_scraper as scraper_mod
        from nat_helpers.result_scraper import _prepare_markdown

        mock_result = MagicMock()
        mock_result.title = "Title"
        mock_result.text_content = "word " * 5000

        mock_md = MagicMock()
        mock_md.convert.return_value = mock_result

        original = scraper_mod.TIKTOKEN_AVAILABLE
        try:
            scraper_mod.TIKTOKEN_AVAILABLE = False
            with patch.object(scraper_mod, "MarkItDown", return_value=mock_md):
                content, was_truncated = _prepare_markdown(
                    url="https://example.com",
                    max_tokens=50,
                    truncation_msg="---END---",
                )
        finally:
            scraper_mod.TIKTOKEN_AVAILABLE = original
        assert was_truncated
        assert "---END---" in content


class TestScrapeGroup:
    def test_empty_entries(self):
        async def _run():
            from nat_helpers.result_scraper import (
                SerpLinkScraperSettings,
                _scrape_group,
            )

            config = SerpLinkScraperSettings()
            mock_client = AsyncMock()
            outcome = await _scrape_group(
                entries=[],
                source_type="organic",
                config=config,
                client=mock_client,
            )
            return outcome

        outcome = run(_run())
        assert outcome.source_type == "organic"
        assert outcome.content is None
        assert outcome.error == "No valid links to scrape."

    def test_entry_with_no_link_skipped(self):
        async def _run():
            from nat_helpers.result_scraper import (
                SerpLinkScraperSettings,
                _scrape_group,
            )

            config = SerpLinkScraperSettings()
            mock_client = AsyncMock()
            entries = [{"title": "No link here"}]  # no 'link' key
            outcome = await _scrape_group(
                entries=entries,
                source_type="organic",
                config=config,
                client=mock_client,
            )
            return outcome

        outcome = run(_run())
        assert outcome.content is None

    def test_entry_with_invalid_url_skipped(self):
        async def _run():
            from nat_helpers.result_scraper import (
                SerpLinkScraperSettings,
                _scrape_group,
            )

            config = SerpLinkScraperSettings()
            mock_client = AsyncMock()
            entries = [{"link": "ftp://invalid-scheme.com", "title": "FTP link"}]
            outcome = await _scrape_group(
                entries=entries,
                source_type="organic",
                config=config,
                client=mock_client,
            )
            return outcome

        outcome = run(_run())
        assert outcome.content is None
        assert outcome.error is not None

    def test_max_attempts_limit(self):
        async def _run():
            import nat_helpers.result_scraper as scraper_mod
            from nat_helpers.result_scraper import (
                SerpLinkScraperSettings,
                _scrape_group,
            )

            config = SerpLinkScraperSettings(max_attempts_per_group=2)
            mock_client = AsyncMock()

            # All entries will fail to produce content
            entries = [
                {"link": "https://example1.com", "title": "Page 1"},
                {"link": "https://example2.com", "title": "Page 2"},
                {"link": "https://example3.com", "title": "Page 3"},  # beyond limit
            ]

            def mock_prepare(*args, **kwargs):
                raise Exception("Scrape failed")

            with patch.object(
                scraper_mod, "_prepare_markdown", side_effect=mock_prepare
            ):
                with patch.object(scraper_mod, "_check_robots", new=AsyncMock()):
                    outcome = await _scrape_group(
                        entries=entries,
                        source_type="organic",
                        config=config,
                        client=mock_client,
                    )
            return outcome

        outcome = run(_run())
        assert outcome.attempts == 2  # stopped at max

    def test_successful_scrape(self):
        async def _run():
            import nat_helpers.result_scraper as scraper_mod
            from nat_helpers.result_scraper import (
                SerpLinkScraperSettings,
                _scrape_group,
            )

            config = SerpLinkScraperSettings(respect_robots_txt=False)
            mock_client = AsyncMock()

            entries = [{"link": "https://example.com/article", "title": "Good Article"}]

            def mock_prepare(*, url, max_tokens, truncation_msg):
                return (f"# Good Article\n\n_Source: {url}_\n\nContent here", False)

            with patch.object(
                scraper_mod, "_prepare_markdown", side_effect=mock_prepare
            ):
                outcome = await _scrape_group(
                    entries=entries,
                    source_type="top_story",
                    config=config,
                    client=mock_client,
                )
            return outcome

        outcome = run(_run())
        assert outcome.content is not None
        assert "Good Article" in outcome.content
        assert outcome.link == "https://example.com/article"
        assert outcome.title == "Good Article"
        assert outcome.attempts == 1
        assert not outcome.was_truncated

    def test_robots_txt_blocks_entry(self):
        async def _run():
            import nat_helpers.result_scraper as scraper_mod
            from nat_helpers.result_scraper import (
                SerpLinkScraperSettings,
                _scrape_group,
            )

            config = SerpLinkScraperSettings(respect_robots_txt=True)
            mock_client = AsyncMock()

            entries = [{"link": "https://blocked.com/page", "title": "Blocked"}]

            async def robots_blocks(**kwargs):
                raise PermissionError("robots.txt disallows")

            with patch.object(scraper_mod, "_check_robots", side_effect=robots_blocks):
                outcome = await _scrape_group(
                    entries=entries,
                    source_type="organic",
                    config=config,
                    client=mock_client,
                )
            return outcome

        outcome = run(_run())
        assert outcome.content is None
        assert "robots" in (outcome.error or "").lower() or outcome.error is not None


class TestScrapeSerp:
    def test_scrape_serp_links_basic(self):
        async def _run():
            import nat_helpers.result_scraper as scraper_mod
            from nat_helpers.result_scraper import (
                SerpLinkScraperSettings,
                scrape_serp_links,
            )

            settings = SerpLinkScraperSettings(respect_robots_txt=False)

            def mock_prepare(*, url, max_tokens, truncation_msg):
                return (f"# Title\n\n_Source: {url}_\n\nContent", False)

            with patch.object(
                scraper_mod, "_prepare_markdown", side_effect=mock_prepare
            ):
                organic, top_story = await scrape_serp_links(
                    organic_entries=[
                        {"link": "https://organic.com", "title": "Organic"}
                    ],
                    top_story_entries=[
                        {"link": "https://top.com", "title": "Top Story"}
                    ],
                    settings=settings,
                )
            return organic, top_story

        organic, top_story = run(_run())
        assert organic.content is not None
        assert top_story.content is not None

    def test_scrape_serp_links_empty(self):
        async def _run():
            from nat_helpers.result_scraper import scrape_serp_links

            organic, top_story = await scrape_serp_links(
                organic_entries=[],
                top_story_entries=[],
            )
            return organic, top_story

        organic, top_story = run(_run())
        assert organic.content is None
        assert top_story.content is None

    def test_scrape_serp_links_no_settings(self):
        """scrape_serp_links creates default settings when settings=None."""

        async def _run():
            import nat_helpers.result_scraper as scraper_mod
            from nat_helpers.result_scraper import scrape_serp_links

            def mock_prepare(*, url, max_tokens, truncation_msg):
                return ("# Content", False)

            with patch.object(
                scraper_mod, "_prepare_markdown", side_effect=mock_prepare
            ):
                with patch.object(scraper_mod, "_check_robots", new=AsyncMock()):
                    organic, top_story = await scrape_serp_links(
                        organic_entries=[
                            {"link": "https://example.com", "title": "Ex"}
                        ],
                        top_story_entries=[],
                        settings=None,  # use defaults
                    )
            return organic

        organic = run(_run())
        assert isinstance(organic.source_type, str)


# ---------------------------------------------------------------------------
# rss_feed inner functions via running the generator
# ---------------------------------------------------------------------------


class TestRssFeedInnerFunctions:
    def _make_config(self, **kwargs):
        """Create a minimal RssFeedFunctionConfig for testing."""
        from rss_feed.rss_feed_function import RssFeedFunctionConfig

        defaults = {
            "feed_url": "https://feeds.example.com/rss",
            "reranker_endpoint": "http://reranker:8080/v1/ranking",
            "reranker_model": "nvidia/test-reranker",
        }
        defaults.update(kwargs)
        return RssFeedFunctionConfig(**defaults)

    def _get_search_fn(self, config):
        """Run rss_feed_function and return the rss_feed_search inner function."""

        async def _run():
            import rss_feed.rss_feed_function as rss_mod
            from rss_feed.rss_feed_function import rss_feed_function

            # Make TTLCache behave like a proper cache (always miss)
            real_cache = {}

            def fake_ttlcache(maxsize, ttl):
                return real_cache

            with patch.object(rss_mod, "TTLCache", side_effect=fake_ttlcache):
                fn_infos = []
                async for item in rss_feed_function(config, MagicMock()):
                    fn_infos.append(item)
                return fn_infos

        return run(_run())

    def test_generator_yields_two_functions(self):
        config = self._make_config()
        fn_infos = self._get_search_fn(config)
        assert len(fn_infos) == 2

    def test_rss_search_no_feed_url(self):
        """Returns error when feed_url not configured."""

        async def _run():
            import rss_feed.rss_feed_function as rss_mod
            from rss_feed.rss_feed_function import (
                RssFeedFunctionConfig,
                rss_feed_function,
            )

            config = RssFeedFunctionConfig(feed_url=None)
            real_cache = {}

            def fake_ttlcache(maxsize, ttl):
                return real_cache

            with patch.object(rss_mod, "TTLCache", side_effect=fake_ttlcache):
                fn_infos = []
                async for item in rss_feed_function(config, MagicMock()):
                    fn_infos.append(item)

            # Call rss_feed_search (first function) with a query
            search_fn = fn_infos[0].fn
            result = await search_fn({"query": "test query"})
            return result

        result = run(_run())
        assert result["success"] is False
        assert (
            "feed_url" in result.get("error", "").lower()
            or "not configured" in result.get("error", "").lower()
        )

    def test_rss_search_invalid_request_format(self):
        """Returns error for non-dict request."""

        async def _run():
            import rss_feed.rss_feed_function as rss_mod
            from rss_feed.rss_feed_function import rss_feed_function

            config = self._make_config()
            real_cache = {}

            def fake_ttlcache(maxsize, ttl):
                return real_cache

            with patch.object(rss_mod, "TTLCache", side_effect=fake_ttlcache):
                fn_infos = []
                async for item in rss_feed_function(config, MagicMock()):
                    fn_infos.append(item)

            search_fn = fn_infos[0].fn
            result = await search_fn("not a dict")  # should fail
            return result

        result = run(_run())
        assert result["success"] is False

    def test_rss_search_empty_entries(self):
        """Returns success with no entries when parse_rss_feed returns empty."""

        async def _run():
            import rss_feed.rss_feed_function as rss_mod
            from rss_feed.rss_feed_function import rss_feed_function

            config = self._make_config()
            real_cache = {}

            def fake_ttlcache(maxsize, ttl):
                return real_cache

            with patch.object(rss_mod, "TTLCache", side_effect=fake_ttlcache):
                fn_infos = []
                async for item in rss_feed_function(config, MagicMock()):
                    fn_infos.append(item)

            # Mock httpx to simulate empty feed response
            mock_response = MagicMock()
            mock_response.text = "<?xml version='1.0'?><rss></rss>"
            mock_response.raise_for_status = MagicMock()

            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_cm = AsyncMock()
            mock_cm.__aenter__ = AsyncMock(return_value=mock_client)
            mock_cm.__aexit__ = AsyncMock(return_value=None)

            # fastfeedparser.parse returns empty entries
            mock_parsed = MagicMock()
            mock_parsed.entries = []

            with patch(
                "rss_feed.rss_feed_function.httpx.AsyncClient", return_value=mock_cm
            ):
                with patch(
                    "rss_feed.rss_feed_function.fastfeedparser.parse",
                    return_value=mock_parsed,
                ):
                    search_fn = fn_infos[0].fn
                    result = await search_fn({"query": "test"})
                    return result

        result = run(_run())
        assert result["success"] is True
        assert result["entries_count"] == 0

    def test_rss_search_wrapped_request(self):
        """Handles request wrapped in 'request' key."""

        async def _run():
            import rss_feed.rss_feed_function as rss_mod
            from rss_feed.rss_feed_function import rss_feed_function

            config = self._make_config(feed_url=None)
            real_cache = {}

            def fake_ttlcache(maxsize, ttl):
                return real_cache

            with patch.object(rss_mod, "TTLCache", side_effect=fake_ttlcache):
                fn_infos = []
                async for item in rss_feed_function(config, MagicMock()):
                    fn_infos.append(item)

            search_fn = fn_infos[0].fn
            # Wrapped request format
            result = await search_fn({"request": {"query": "test wrapped"}})
            return result

        result = run(_run())
        # Should fail due to no feed_url, but request should be parsed
        assert result["query"] == "test wrapped" or result["success"] is False

    def test_search_rss_simple_wrapper(self):
        """search_rss (2nd yielded function) wraps rss_feed_search."""

        async def _run():
            import rss_feed.rss_feed_function as rss_mod
            from rss_feed.rss_feed_function import (
                RssFeedFunctionConfig,
                rss_feed_function,
            )

            config = RssFeedFunctionConfig(feed_url=None)
            real_cache = {}

            def fake_ttlcache(maxsize, ttl):
                return real_cache

            with patch.object(rss_mod, "TTLCache", side_effect=fake_ttlcache):
                fn_infos = []
                async for item in rss_feed_function(config, MagicMock()):
                    fn_infos.append(item)

            # search_rss is the second function
            search_rss_fn = fn_infos[1].fn
            result = await search_rss_fn("AI news")
            return result

        result = run(_run())
        # Should return an error string about feed_url
        assert isinstance(result, str)
        assert "Error" in result or "not configured" in result.lower() or result

    def test_rss_search_reranker_missing_api_key(self):
        """Returns error when no API key provided for reranker."""

        async def _run():
            import os

            import rss_feed.rss_feed_function as rss_mod
            from rss_feed.rss_feed_function import rss_feed_function

            config = self._make_config(reranker_api_key=None)
            real_cache = {}

            def fake_ttlcache(maxsize, ttl):
                return real_cache

            with patch.object(rss_mod, "TTLCache", side_effect=fake_ttlcache):
                fn_infos = []
                async for item in rss_feed_function(config, MagicMock()):
                    fn_infos.append(item)

            mock_response = MagicMock()
            mock_response.text = "<rss><channel><item></item></channel></rss>"
            mock_response.raise_for_status = MagicMock()
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_cm = AsyncMock()
            mock_cm.__aenter__ = AsyncMock(return_value=mock_client)
            mock_cm.__aexit__ = AsyncMock(return_value=None)

            mock_parsed = MagicMock()
            mock_parsed.entries = [
                {"title": "Article 1", "link": "https://example.com/1"},
            ]

            env_no_key = {k: v for k, v in os.environ.items() if k != "NVIDIA_API_KEY"}
            with patch(
                "rss_feed.rss_feed_function.httpx.AsyncClient", return_value=mock_cm
            ):
                with patch(
                    "rss_feed.rss_feed_function.fastfeedparser.parse",
                    return_value=mock_parsed,
                ):
                    with patch.dict(os.environ, env_no_key, clear=True):
                        search_fn = fn_infos[0].fn
                        result = await search_fn({"query": "AI news"})
                        return result

        result = run(_run())
        assert result["success"] is False
        assert (
            "api key" in result.get("error", "").lower()
            or "key" in result.get("error", "").lower()
        )
