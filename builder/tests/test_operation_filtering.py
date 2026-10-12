"""Registration tests for production operation filtering."""

import asyncio
from unittest.mock import MagicMock


def run(coro):
    return asyncio.run(coro)


async def _names(async_gen):
    items = []
    async for item in async_gen:
        items.append(item.fn.__name__)
    return items


def test_agent_skills_enabled_operations_filter_dispatch(tmp_path):
    async def _run():
        from agent_skills.agent_skills_function import (
            AgentSkillsConfig,
            agent_skills_function,
        )

        skill = tmp_path / "sample"
        skill.mkdir()
        (skill / "SKILL.md").write_text(
            "---\nname: sample\ndescription: Sample\n---\n\nUse it.\n",
            encoding="utf-8",
        )

        items = []
        async for item in agent_skills_function(
            AgentSkillsConfig(
                skills_directory=str(tmp_path),
                allow_script_execution=True,
                enabled_operations=["load_skill"],
            ),
            MagicMock(),
        ):
            items.append(item)

        loaded = await items[0].fn(
            operation="load_skill",
            skill_name="sample",
        )
        denied = await items[0].fn(operation="list_skills")
        return [item.fn.__name__ for item in items], loaded, denied

    names, loaded, denied = run(_run())

    assert names == ["agent_skills"]
    assert loaded == "Use it."
    assert denied == (
        "Error: operation 'list_skills' is disabled. Enabled operations: load_skill."
    )


def test_source_verifier_enabled_operations_filters_registration():
    async def _run():
        from source_verifier.source_verifier_function import (
            SourceVerifierConfig,
            source_verifier_function,
        )

        return await _names(
            source_verifier_function(
                SourceVerifierConfig(enabled_operations=["verify_claim"]),
                MagicMock(),
            )
        )

    assert run(_run()) == ["source_verifier"]


def test_source_verifier_audit_citations_operation_can_be_exposed_alone():
    async def _run():
        from source_verifier.source_verifier_function import (
            SourceVerifierConfig,
            source_verifier_function,
        )

        return await _names(
            source_verifier_function(
                SourceVerifierConfig(enabled_operations=["audit_citations"]),
                MagicMock(),
            )
        )

    assert run(_run()) == ["source_verifier"]


def test_source_verifier_plan_sources_operation_can_be_exposed_alone():
    async def _run():
        from source_verifier.source_verifier_function import (
            SourceVerifierConfig,
            source_verifier_function,
        )

        return await _names(
            source_verifier_function(
                SourceVerifierConfig(enabled_operations=["plan_sources"]),
                MagicMock(),
            )
        )

    assert run(_run()) == ["source_verifier"]


def test_rss_registration_exposes_its_single_validated_search_tool():
    async def scenario():
        from rss_feed.rss_feed_function import RssFeedFunctionConfig, rss_feed_function

        items = [
            item
            async for item in rss_feed_function(
                RssFeedFunctionConfig(feed_url="https://example.com/feed.xml"),
                MagicMock(),
            )
        ]
        assert len(items) == 1
        assert "query" in items[0].input_schema.model_json_schema()["properties"]

    run(scenario())
