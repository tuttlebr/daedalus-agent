"""Scrape admission spans robots checks and fetches across concurrent runs."""

import asyncio
from types import SimpleNamespace

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
