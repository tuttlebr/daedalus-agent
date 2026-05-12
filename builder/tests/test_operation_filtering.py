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


def test_agent_skills_enabled_operations_filters_registration(tmp_path):
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

        return await _names(
            agent_skills_function(
                AgentSkillsConfig(
                    skills_directory=str(tmp_path),
                    allow_script_execution=True,
                    enabled_operations=["load_skill"],
                ),
                MagicMock(),
            )
        )

    assert run(_run()) == ["load_skill"]


def test_content_distiller_enabled_operations_filters_registration():
    async def _run():
        from content_distiller.content_distiller_function import (
            ContentDistillerConfig,
            content_distiller_function,
        )

        return await _names(
            content_distiller_function(
                ContentDistillerConfig(enabled_operations=["distill_content"]),
                MagicMock(),
            )
        )

    assert run(_run()) == ["distill_content"]


def test_mas_optimizer_enabled_operations_filters_registration():
    async def _run():
        from mas_optimizer.mas_optimizer_function import (
            MasOptimizerConfig,
            mas_optimizer_function,
        )

        return await _names(
            mas_optimizer_function(
                MasOptimizerConfig(enabled_operations=["mas_evaluate"]),
                MagicMock(),
            )
        )

    assert run(_run()) == ["mas_evaluate"]


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

    assert run(_run()) == ["verify_claim"]


def test_user_interaction_enabled_operations_filters_registration():
    async def _run():
        from user_interaction.user_interaction_function import (
            UserInteractionConfig,
            user_interaction_function,
        )

        return await _names(
            user_interaction_function(
                UserInteractionConfig(
                    enabled_operations=["clarify", "confirm_action"]
                ),
                MagicMock(),
            )
        )

    assert run(_run()) == ["clarify", "confirm_action"]


def test_rss_feed_enabled_operations_filters_registration():
    async def _run():
        from rss_feed.rss_feed_function import RssFeedFunctionConfig, rss_feed_function

        return await _names(
            rss_feed_function(
                RssFeedFunctionConfig(
                    feed_url="https://example.com/feed.xml",
                    enabled_operations=["search_rss"],
                ),
                MagicMock(),
            )
        )

    assert run(_run()) == ["search_rss"]
