"""Tests for the think_tool package -- cognitive reasoning scratchpad."""

import asyncio
import json
from unittest.mock import MagicMock


def run(coro):
    """Run a coroutine synchronously."""
    return asyncio.run(coro)


async def _get_tools(config_overrides=None):
    """Instantiate think_tool and collect yielded FunctionInfo objects."""
    from think_tool.think_tool_function import ThinkToolConfig, think_tool_function

    kwargs = config_overrides or {}
    config = ThinkToolConfig(**kwargs)
    builder = MagicMock()
    items = []
    async for item in think_tool_function(config, builder):
        items.append(item)
    return items


class TestThinkToolRegistration:
    def test_yields_two_function_infos(self):
        items = run(_get_tools())
        assert len(items) == 2

    def test_all_have_fn_and_description(self):
        items = run(_get_tools())
        for item in items:
            assert item.fn is not None
            assert item.description


class TestThink:
    def test_returns_thought_unchanged(self):
        async def _run():
            items = await _get_tools()
            think_fn = items[0].fn
            result = await think_fn(thought="This is my reasoning.")
            assert result == "This is my reasoning."

        run(_run())

    def test_empty_thought(self):
        async def _run():
            items = await _get_tools()
            think_fn = items[0].fn
            result = await think_fn(thought="")
            assert result == ""

        run(_run())

    def test_truncates_long_thought(self):
        async def _run():
            items = await _get_tools({"max_thought_length": 100})
            think_fn = items[0].fn
            long_thought = "x" * 200
            result = await think_fn(thought=long_thought)
            assert len(result) < 200
            assert "truncated" in result.lower()

        run(_run())

    def test_thought_at_exact_limit_not_truncated(self):
        async def _run():
            items = await _get_tools({"max_thought_length": 100})
            think_fn = items[0].fn
            exact_thought = "x" * 100
            result = await think_fn(thought=exact_thought)
            assert result == exact_thought

        run(_run())


class TestSequentialThink:
    def test_appends_step(self):
        async def _run():
            items = await _get_tools()
            seq_fn = items[1].fn
            result = json.loads(await seq_fn(thought="First step", chain_id="test"))
            assert result["action"] == "appended"
            assert result["step"] == 1
            assert result["chain_length"] == 1

        run(_run())

    def test_multiple_steps_increment(self):
        async def _run():
            items = await _get_tools()
            seq_fn = items[1].fn
            await seq_fn(thought="Step 1", chain_id="multi")
            result = json.loads(await seq_fn(thought="Step 2", chain_id="multi"))
            assert result["step"] == 2
            assert result["chain_length"] == 2

        run(_run())

    def test_revise_step(self):
        async def _run():
            items = await _get_tools()
            seq_fn = items[1].fn
            await seq_fn(thought="Original", chain_id="revise")
            result = json.loads(
                await seq_fn(
                    thought="Revised",
                    chain_id="revise",
                    revise_step=1,
                )
            )
            assert result["action"] == "revised"
            assert result["step"] == 1
            assert result["thought"] == "Revised"
            # Chain length should not increase on revision
            assert result["chain_length"] == 1

        run(_run())

    def test_step_label(self):
        async def _run():
            items = await _get_tools()
            seq_fn = items[1].fn
            result = json.loads(
                await seq_fn(
                    thought="Testing hypothesis",
                    chain_id="labeled",
                    step_label="hypothesis",
                )
            )
            assert result["label"] == "hypothesis"

        run(_run())

    def test_chain_limit_enforced(self):
        async def _run():
            items = await _get_tools({"max_chain_steps": 3})
            seq_fn = items[1].fn
            for i in range(3):
                await seq_fn(thought=f"Step {i+1}", chain_id="limited")

            result = json.loads(await seq_fn(thought="Step 4", chain_id="limited"))
            assert "error" in result
            assert result["chain_length"] == 3

        run(_run())

    def test_separate_chain_ids_independent(self):
        async def _run():
            items = await _get_tools()
            seq_fn = items[1].fn
            await seq_fn(thought="Chain A step 1", chain_id="a")
            await seq_fn(thought="Chain A step 2", chain_id="a")
            result = json.loads(await seq_fn(thought="Chain B step 1", chain_id="b"))
            assert result["step"] == 1
            assert result["chain_length"] == 1

        run(_run())

    def test_revise_out_of_range_appends(self):
        async def _run():
            items = await _get_tools()
            seq_fn = items[1].fn
            await seq_fn(thought="Step 1", chain_id="oor")
            result = json.loads(
                await seq_fn(
                    thought="Step 2",
                    chain_id="oor",
                    revise_step=99,
                )
            )
            # Out-of-range revision should append instead
            assert result["action"] == "appended"
            assert result["step"] == 2

        run(_run())
