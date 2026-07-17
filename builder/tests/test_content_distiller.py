"""Tests for the content_distiller package -- secondary LLM content processing."""

import asyncio
from unittest.mock import AsyncMock, MagicMock


def run(coro):
    """Run a coroutine synchronously."""
    return asyncio.run(coro)


async def _get_tools(config_overrides=None):
    """Instantiate content_distiller and collect yielded FunctionInfo objects."""
    from content_distiller.content_distiller_function import (
        ContentDistillerConfig,
        content_distiller_function,
    )

    kwargs = config_overrides or {}
    config = ContentDistillerConfig(**kwargs)
    builder = MagicMock()
    items = []
    async for item in content_distiller_function(config, builder):
        items.append(item)
    return items, builder


class TestContentDistillerRegistration:
    def test_yields_one_function_info(self):
        items, _ = run(_get_tools())
        assert len(items) == 1

    def test_all_have_fn_and_description(self):
        items, _ = run(_get_tools())
        for item in items:
            assert item.fn is not None
            assert item.description

    def test_tool_names(self):
        items, _ = run(_get_tools())
        fn_names = [item.fn.__name__ for item in items]
        assert fn_names == ["distill_content"]


class TestDistillContent:
    def test_calls_llm_with_content(self):
        """distill_content should invoke the secondary LLM."""

        async def _run():
            from content_distiller.content_distiller_function import (
                ContentDistillerConfig,
                content_distiller_function,
            )

            config = ContentDistillerConfig()
            builder = MagicMock()

            # Mock the LLM to return a string
            mock_llm = MagicMock()
            mock_result = MagicMock()
            mock_result.content = "Summarized content here."
            mock_llm.bind.return_value.ainvoke = AsyncMock(return_value=mock_result)
            builder.get_llm = AsyncMock(return_value=mock_llm)

            items = []
            async for item in content_distiller_function(config, builder):
                items.append(item)

            distill_fn = items[0].fn
            result = await distill_fn(
                content="A very long article about AI...",
                focus="key findings",
                max_words=100,
            )
            assert result == "Summarized content here."
            builder.get_llm.assert_called_once()

        run(_run())

    def test_truncates_long_content(self):
        """Content exceeding max_input_chars should be truncated."""

        async def _run():
            from content_distiller.content_distiller_function import (
                ContentDistillerConfig,
                content_distiller_function,
            )

            config = ContentDistillerConfig(max_input_chars=1000)
            builder = MagicMock()

            mock_llm = MagicMock()
            mock_result = MagicMock()
            mock_result.content = "Summary"
            mock_llm.bind.return_value.ainvoke = AsyncMock(return_value=mock_result)
            builder.get_llm = AsyncMock(return_value=mock_llm)

            items = []
            async for item in content_distiller_function(config, builder):
                items.append(item)

            distill_fn = items[0].fn
            long_content = "x" * 5000
            result = await distill_fn(content=long_content)
            assert "truncated" in result.lower()

        run(_run())

    def test_handles_llm_failure(self):
        """Should return error message on LLM failure."""

        async def _run():
            from content_distiller.content_distiller_function import (
                ContentDistillerConfig,
                content_distiller_function,
            )

            config = ContentDistillerConfig()
            builder = MagicMock()
            builder.get_llm = AsyncMock(side_effect=RuntimeError("LLM unavailable"))

            items = []
            async for item in content_distiller_function(config, builder):
                items.append(item)

            distill_fn = items[0].fn
            result = await distill_fn(content="test content")
            assert "error" in result.lower()

        run(_run())

    def test_fast_llm_fallback_to_default(self):
        """When fast_llm_name fails, should fall back to llm_name."""

        async def _run():
            from content_distiller.content_distiller_function import (
                ContentDistillerConfig,
                content_distiller_function,
            )

            config = ContentDistillerConfig(
                fast_llm_name="nonexistent_llm",
                llm_name="tool_calling_llm",
            )
            builder = MagicMock()

            call_count = 0

            async def mock_get_llm(name, **kwargs):
                nonlocal call_count
                call_count += 1
                if name == "nonexistent_llm":
                    raise ValueError("LLM not found")
                mock_llm = MagicMock()
                mock_result = MagicMock()
                mock_result.content = "Fallback result"
                mock_llm.bind.return_value.ainvoke = AsyncMock(return_value=mock_result)
                return mock_llm

            builder.get_llm = mock_get_llm

            items = []
            async for item in content_distiller_function(config, builder):
                items.append(item)

            distill_fn = items[0].fn
            result = await distill_fn(content="Some content to distill")
            assert result == "Fallback result"
            # Should have been called twice: once for fast (fail), once for fallback
            assert call_count == 2

        run(_run())

    def test_distill_uses_fast_llm(self):
        """distill_content should use fast_llm_name."""

        async def _run():
            from content_distiller.content_distiller_function import (
                ContentDistillerConfig,
                content_distiller_function,
            )

            config = ContentDistillerConfig(
                fast_llm_name="fast_model",
                llm_name="strong_model",
            )
            builder = MagicMock()

            llm_names_called = []

            async def mock_get_llm(name, **kwargs):
                llm_names_called.append(name)
                mock_llm = MagicMock()
                mock_result = MagicMock()
                mock_result.content = "Distilled"
                mock_llm.bind.return_value.ainvoke = AsyncMock(return_value=mock_result)
                return mock_llm

            builder.get_llm = mock_get_llm

            items = []
            async for item in content_distiller_function(config, builder):
                items.append(item)

            distill_fn = items[0].fn
            await distill_fn(content="Long content here")
            # distill should call the fast model
            assert "fast_model" in llm_names_called
            assert "strong_model" not in llm_names_called

        run(_run())
