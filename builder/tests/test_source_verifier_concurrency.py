"""Bound shared verifier load and return permits on cancellation."""

import asyncio
import json

import pytest
import source_verifier.source_verifier_function as verifier
from daedalus_runtime.tools import ToolRegistry
from pydantic import ValidationError


@pytest.mark.parametrize("limit", [1, 3])
def test_verifier_bounded_overlap_and_cancel_releases_slot(monkeypatch, limit):
    async def exercise():
        started, finished = [], []
        gates = {str(i): asyncio.Event() for i in range(6)}
        changed = asyncio.Event()
        active, peak = 0, 0

        async def fetch(url, config):
            nonlocal active, peak
            claim = url.rsplit("/", 1)[-1]
            started.append(claim)
            active += 1
            peak = max(peak, active)
            changed.set()
            try:
                await gates[claim].wait()
                return verifier.FetchResult(status="ok", content=f"Claim {claim}.")
            finally:
                active -= 1
                finished.append(claim)

        async def call_llm(builder, config, system_prompt, user_prompt):
            request = json.loads(user_prompt.splitlines()[1])
            return json.dumps(
                {
                    "verdict": "supported",
                    "confidence": 1.0,
                    "evidence": request["claim"],
                    "reasoning": "Fixture fact.",
                    "claim_issues": [],
                }
            )

        monkeypatch.setattr(verifier, "_fetch_source", fetch)
        monkeypatch.setattr(verifier, "_call_llm", call_llm)
        registry = ToolRegistry(
            {
                "functions": {
                    "verify": {"_type": "source_verifier", "max_concurrency": limit}
                }
            }
        )
        tool = await registry.get_function("verify")
        tasks = [
            asyncio.create_task(
                tool.ainvoke(
                    {
                        "operation": "verify_claim",
                        "claim": f"Claim {i}.",
                        "source_url": f"https://sources.test/{i}",
                    }
                )
            )
            for i in range(6)
        ]
        try:

            async def wait_started(count):
                while len(started) < count:
                    changed.clear()
                    await asyncio.wait_for(changed.wait(), 2)

            await wait_started(limit)
            await asyncio.sleep(0)
            assert len(started) == limit
            tasks[0].cancel()
            with pytest.raises(asyncio.CancelledError):
                await tasks[0]
            await wait_started(limit + 1)
            assert peak == limit
            for gate in gates.values():
                gate.set()
            results = await asyncio.gather(*tasks[1:])
            for i, raw in enumerate(results, 1):
                result = json.loads(raw)
                assert result["verdict"] == "supported"
                assert result["evidence"] == f"Claim {i}."
                assert result["source_url"] == f"https://sources.test/{i}"
            assert len(started) == len(finished) == 6
            assert active == 0 and peak == limit
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await registry.close()

    asyncio.run(exercise())


@pytest.mark.parametrize("value", [0, 9, -1, True, 1.5, "3", None])
def test_verifier_rejects_invalid_concurrency(value):
    with pytest.raises(ValidationError):
        verifier.SourceVerifierConfig(max_concurrency=value)
