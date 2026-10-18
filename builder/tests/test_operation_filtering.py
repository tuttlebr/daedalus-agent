"""Registration tests for production operation filtering."""

import asyncio
import json
from unittest.mock import MagicMock

import pytest
import source_verifier.source_verifier_function  # noqa: F401 - registers the factory
from daedalus_runtime.tools import ToolRegistry
from jsonschema import Draft202012Validator
from pydantic import ValidationError


def run(coro):
    return asyncio.run(coro)


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


@pytest.mark.parametrize(
    "enabled", [["verify_claim"], ["audit_citations"], ["plan_sources"], []]
)
def test_source_verifier_filters_published_schema_and_actual_dispatch(enabled):
    async def scenario():
        registry = ToolRegistry(
            {
                "functions": {
                    "verify": {
                        "_type": "source_verifier",
                        "enabled_operations": enabled,
                    }
                }
            }
        )
        try:
            tool = await registry.get_function("verify")
            schema = tool.schema("verify")["parameters"]
            validator = Draft202012Validator(schema)
            inputs = {
                "verify_claim": {
                    "claim": "A fact",
                    "source_url": "https://sources.test/fact",
                },
                "plan_sources": {"research_question": "A topic"},
                "audit_citations": {"answer_markdown": "An answer"},
            }
            for operation, arguments in inputs.items():
                assert validator.is_valid({"operation": operation, **arguments}) == (
                    operation in enabled
                )
                if operation in enabled:
                    continue
                with pytest.raises(ValidationError):
                    await tool.ainvoke({"operation": operation, **arguments})
                denied = json.loads(await tool.fn(operation=operation, **arguments))
                assert denied["error"] == "operation_disabled"
                assert denied["operation"] == operation
                assert denied["enabled_operations"] == enabled
        finally:
            await registry.close()

    run(scenario())


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
