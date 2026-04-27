"""Tests for agent_skills function registration safety."""

import asyncio
from unittest.mock import MagicMock


def run(coro):
    return asyncio.run(coro)


def _write_skill(root):
    skill = root / "safe-skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text(
        "---\nname: safe-skill\ndescription: Safe test skill\n---\n\nUse safely.\n",
        encoding="utf-8",
    )
    (skill / "script.py").write_text("print('unsafe')\n", encoding="utf-8")


def test_script_tool_not_registered_when_disabled(tmp_path):
    async def _run():
        from agent_skills.agent_skills_function import (
            AgentSkillsConfig,
            agent_skills_function,
        )

        _write_skill(tmp_path)
        items = []
        async for item in agent_skills_function(
            AgentSkillsConfig(
                skills_directory=str(tmp_path),
                allow_script_execution=False,
            ),
            MagicMock(),
        ):
            items.append(item)
        return [item.fn.__name__ for item in items]

    assert run(_run()) == ["list_skills", "load_skill"]


def test_script_tool_registered_only_when_enabled(tmp_path):
    async def _run():
        from agent_skills.agent_skills_function import (
            AgentSkillsConfig,
            agent_skills_function,
        )

        _write_skill(tmp_path)
        items = []
        async for item in agent_skills_function(
            AgentSkillsConfig(
                skills_directory=str(tmp_path),
                allow_script_execution=True,
            ),
            MagicMock(),
        ):
            items.append(item)
        return [item.fn.__name__ for item in items]

    assert "run_skill_script" in run(_run())
