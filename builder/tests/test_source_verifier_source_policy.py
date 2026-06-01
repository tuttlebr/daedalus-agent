import asyncio
import json
from unittest.mock import MagicMock


def run(coro):
    return asyncio.run(coro)


async def _plan_fn(config_overrides=None):
    from source_verifier.source_verifier_function import (
        SourceVerifierConfig,
        source_verifier_function,
    )

    config = SourceVerifierConfig(
        enabled_operations=["plan_sources"],
        **(config_overrides or {}),
    )
    async for item in source_verifier_function(config, MagicMock()):
        return item.fn
    raise AssertionError("plan_sources was not registered")


def test_plan_sources_prioritizes_current_source_families():
    async def _run():
        plan_sources = await _plan_fn()
        raw = await plan_sources(
            research_question=(
                "What is the latest NVIDIA Developer Blog post about inference?"
            ),
            depth="quick",
        )
        return json.loads(raw)

    result = run(_run())

    assert result["passed"] is True
    tool_order = [
        tool for item in result["recommended_tool_sequence"] for tool in item["tools"]
    ]
    assert tool_order[:3] == [
        "curated_feed_search_tool",
        "serpapi_search_tool",
        "domain_retriever_tool",
    ]
    assert result["source_ledger_contract"]["audit_tool"].endswith("audit_citations")


def test_plan_sources_respects_selected_and_disabled_sources():
    async def _run():
        plan_sources = await _plan_fn()
        raw = await plan_sources(
            research_question="Deep research CUDA inference strategy.",
            selected_sources_json=json.dumps(["curated_domains", "google_search"]),
            disabled_sources_json=json.dumps(["google_search"]),
            depth="deep",
        )
        return json.loads(raw)

    result = run(_run())

    assert [source["id"] for source in result["selected_sources"]] == [
        "curated_domains"
    ]
    assert result["blocked_tools"] == ["serpapi_search_tool"]
    assert result["approval_recommended"] is False


def test_plan_sources_reports_unknown_sources():
    async def _run():
        plan_sources = await _plan_fn()
        raw = await plan_sources(
            research_question="Compare CUDA and ROCm.",
            selected_sources_json=json.dumps(["curated_domains", "missing"]),
        )
        return json.loads(raw)

    result = run(_run())

    assert result["passed"] is True
    assert result["unknown_sources"] == ["missing"]
    assert any("unknown source ids" in warning for warning in result["warnings"])
