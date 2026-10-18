"""Scrape admission spans robots checks and fetches across concurrent runs."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import webscrape.webscrape_function as scrape
from daedalus_runtime.tools import ToolRegistry
from nat_helpers.public_content import PublicContentSession
from pydantic import ValidationError


@pytest.mark.parametrize("limit", [1, 4])
def test_shared_scrape_bound_and_cancellation(monkeypatch, limit):
    async def exercise():
        started = []
        changed, release = asyncio.Event(), asyncio.Event()
        active = peak = 0

        async def robots(**kwargs):
            nonlocal active, peak
            started.append(kwargs["url"])
            active += 1
            peak = max(peak, active)
            changed.set()
            try:
                await release.wait()
            finally:
                active -= 1

        monkeypatch.setattr(scrape, "_check_robots", robots)
        monkeypatch.setattr(
            scrape, "_truncate_to_token_limit", lambda s, *a: (s, False)
        )
        registry = ToolRegistry(
            {"functions": {"scrape": {"_type": "webscrape", "max_concurrency": limit}}}
        )
        tool = await registry.get_function("scrape")
        monkeypatch.setattr(PublicContentSession, "article", article_method)
        tasks = [
            asyncio.create_task(tool.ainvoke({"url": f"https://sources.test/{i}"}))
            for i in range(8)
        ]
        try:

            async def wait_started(count):
                while len(started) < count:
                    changed.clear()
                    await asyncio.wait_for(changed.wait(), 2)

            await wait_started(limit)
            assert len(started) == limit
            tasks[0].cancel()
            with pytest.raises(asyncio.CancelledError):
                await tasks[0]
            await wait_started(limit + 1)
            assert peak == limit
            release.set()
            results = await asyncio.gather(*tasks[1:])
            for i, result in enumerate(results, 1):
                assert f"_Source: https://sources.test/{i}_" in result
                assert "_Fetched:" in result
            assert active == 0 and len(started) == 8
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await registry.close()

    async def article_method(self, url, **kwargs):
        return SimpleNamespace(
            url=url,
            markdown=f"# Fixture\n\n_Source: {url}_\n\nSynthetic measurement.",
            fetched_at="2026-10-16T00:00:00Z",
        ), "miss"

    asyncio.run(exercise())


@pytest.mark.parametrize("value", [0, 9, True, 1.5, "4"])
def test_invalid_concurrency(value):
    with pytest.raises(ValidationError):
        scrape.WebscrapeFunctionConfig(max_concurrency=value)


def test_research_mode_preserves_source_before_full_mode_token_limit(monkeypatch):
    original = (
        "# Synthetic article\n\n_Source: https://sources.test/article_\n"
        + "Evidence. " * 2000
        + "TAIL_MARKER"
    )

    async def article(self, url, **kwargs):
        return SimpleNamespace(
            url=url, markdown=original, fetched_at="2026-10-17T00:00:00Z"
        ), "miss"

    async def exercise():
        registry = ToolRegistry(
            {
                "functions": {
                    "webscrape_tool": {
                        "_type": "webscrape",
                        "respect_robots_txt": False,
                        "max_output_tokens": 100,
                        "enable_research_mode": True,
                    }
                }
            }
        )
        try:
            tool = await registry.get_function("webscrape_tool")
            arguments = {"url": "https://sources.test/article"}
            full = await tool.ainvoke(arguments)
            research = json.loads(
                await tool.ainvoke({**arguments, "output_mode": "research"})
            )
            assert "TAIL_MARKER" not in full
            assert research["content"].endswith("TAIL_MARKER")
            assert research["output_mode"] == "research"
            assert research["source"]["url"] == arguments["url"]
            assert "_Fetched:" in research["content"]
            with pytest.raises(ValidationError):
                await tool.ainvoke({**arguments, "output_mode": "summarize"})
        finally:
            await registry.close()

    monkeypatch.setattr(PublicContentSession, "article", article)
    asyncio.run(exercise())


def test_full_mode_token_limit_runs_outside_the_event_loop(monkeypatch):
    """Token-limit search tokenizes large articles; other scrapes keep running."""
    import time

    delay = 0.6

    def slow_truncate(text, limit, message):
        time.sleep(delay)
        return text[:20] + message, True

    async def article(self, url, **kwargs):
        return SimpleNamespace(
            url=url,
            markdown=f"# Fixture\n\n_Source: {url}_\n\n" + "Evidence. " * 200,
            fetched_at="2026-10-18T00:00:00Z",
        ), "hit"

    monkeypatch.setattr(scrape, "_truncate_to_token_limit", slow_truncate)
    monkeypatch.setattr(PublicContentSession, "article", article)

    async def exercise():
        registry = ToolRegistry(
            {"functions": {"scrape": {"_type": "webscrape", "max_concurrency": 4}}}
        )
        gaps, done = [], asyncio.Event()

        async def heartbeat():
            last = time.perf_counter()
            while not done.is_set():
                await asyncio.sleep(0.01)
                now = time.perf_counter()
                gaps.append(now - last)
                last = now

        try:
            tool = await registry.get_function("scrape")
            monkeypatch.setattr(scrape, "_check_robots", AsyncMock())
            beat = asyncio.create_task(heartbeat())
            await asyncio.sleep(0)
            try:
                results = await asyncio.gather(
                    *(
                        tool.ainvoke({"url": f"https://sources.test/{index}"})
                        for index in range(2)
                    )
                )
            finally:
                done.set()
                await beat
        finally:
            await registry.close()
        return results, max(gaps)

    results, max_gap = asyncio.run(exercise())
    assert all(
        result.endswith(scrape.WebscrapeFunctionConfig().truncation_message)
        for result in results
    )
    assert max_gap < delay / 2, max_gap


def test_research_mode_requires_operator_opt_in():
    async def exercise():
        registry = ToolRegistry({"functions": {"scrape": {"_type": "webscrape"}}})
        try:
            tool = await registry.get_function("scrape")
            schema = tool.schema("scrape")
            assert set(schema["parameters"]["properties"]) == {"url"}
            assert "output_mode" not in schema["description"]
            with pytest.raises(ValidationError):
                await tool.ainvoke(
                    {"url": "https://sources.test/article", "output_mode": "research"}
                )
        finally:
            await registry.close()

    asyncio.run(exercise())
