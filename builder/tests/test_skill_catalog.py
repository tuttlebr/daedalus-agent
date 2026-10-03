"""Exercise the shipped skill catalog through the application dispatcher."""

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from agent_skills.agent_skills_function import (
    DAILY_SUMMARY_BOOTSTRAP_RESOURCES,
    _daily_summary_clock,
    _list_skills,
    _load_skill,
)
from agent_skills.skill_parser import SkillParser

SKILLS = Path(__file__).resolve().parents[2] / "skills"


def test_entire_catalog_and_resources_round_trip():
    parser = SkillParser(str(SKILLS))
    discovered = parser.discover_skills()
    expected = {p.parent.name for p in SKILLS.glob("*/SKILL.md")}
    listed = json.loads(asyncio.run(_list_skills(parser)))
    assert {item["name"] for item in listed["skills"]} == expected
    assert expected
    assert len(discovered) == len(expected) == listed["count"]
    for meta in discovered:
        assert meta.name == meta.directory.name
        loaded = asyncio.run(_load_skill(parser, meta.name))
        assert parser.get_skill_instructions(meta.name) in loaded
        for resource in parser.list_skill_resources(meta.name):
            result = asyncio.run(_load_skill(parser, meta.name, resource))
            assert result == (meta.directory / resource).read_text()


def test_cross_skill_handoffs_load_target_instead_of_traversing():
    parser = SkillParser(str(SKILLS))
    parser.discover_skills()
    for source in SKILLS.glob("*/SKILL.md"):
        import re

        for target in re.findall(r"\]\(\.\./([^/]+)/SKILL\.md\)", source.read_text()):
            assert target in parser.get_skill_names()
            assert not asyncio.run(_load_skill(parser, target)).startswith("Error:")
    rejected = asyncio.run(
        _load_skill(parser, "daily-summary", "../unifi-network/SKILL.md")
    )
    assert "escapes the skill directory" in rejected


def test_resource_listing_excludes_local_cache_and_signature_noise(tmp_path):
    skill = tmp_path / "example"
    skill.mkdir()
    (skill / "SKILL.md").write_text(
        "---\nname: example\ndescription: Example\n---\nUse me.\n"
    )
    for path in [
        ".DS_Store",
        "skill.oms.sig",
        "scripts/__pycache__/a.pyc",
        ".cache/file",
        "references/guide.md",
    ]:
        item = skill / path
        item.parent.mkdir(parents=True, exist_ok=True)
        item.write_text("resource")
    parser = SkillParser(str(tmp_path))
    parser.discover_skills()
    assert parser.list_skill_resources("example") == ["references/guide.md"]


def test_daily_summary_bootstrap_contains_exact_canonical_references_once():
    parser = SkillParser(str(SKILLS))
    parser.discover_skills()
    loaded = asyncio.run(_load_skill(parser, "daily-summary"))
    for path in DAILY_SUMMARY_BOOTSTRAP_RESOURCES:
        assert loaded.count(f"## Bundled resource: `{path}`") == 1
        assert parser.get_skill_resource("daily-summary", path) in loaded
    # Rendering assets remain the renderer's responsibility, not model context.
    assert "<!DOCTYPE html>\n<html" not in loaded


def test_missing_bootstrap_resource_does_not_emit_successful_load(
    tmp_path, monkeypatch
):
    from agent_skills import load_events

    skill = tmp_path / "daily-summary"
    skill.mkdir()
    (skill / "SKILL.md").write_text(
        "---\nname: daily-summary\ndescription: Briefing\n---\nUse canonical policy.\n"
    )
    events = []
    monkeypatch.setattr(load_events, "main_skill_loaded", events.append)
    parser = SkillParser(str(tmp_path))
    parser.discover_skills()
    loaded = asyncio.run(_load_skill(parser, "daily-summary"))
    assert loaded.startswith("Error:")
    assert "edition-policy.json" in loaded
    assert events == []


def test_bundled_clock_is_fresh_and_uses_reader_date_and_dst(monkeypatch):
    from agent_skills import agent_skills_function as module

    current = [datetime(2026, 9, 21, 2, 30, tzinfo=UTC)]

    class Clock:
        @staticmethod
        def now(zone):
            assert zone is UTC
            return current[0]

    monkeypatch.setattr(module, "datetime", Clock)
    policy = '{"edition":{"timezone":"America/Detroit"}}'
    first = _daily_summary_clock(policy)
    assert first["local"] == "2026-09-20T22:30:00-04:00"
    current[0] = datetime(2026, 12, 21, 2, 30, tzinfo=UTC)
    second = _daily_summary_clock(policy)
    assert second["local"] == "2026-12-20T21:30:00-05:00"
    assert first["utc"] != second["utc"]


@pytest.mark.parametrize(
    "policy",
    ["{}", '{"edition":{"timezone":"invalid/fixture"}}', "not json"],
)
def test_bundled_clock_rejects_missing_or_invalid_timezone(policy):
    with pytest.raises(ValueError, match="no valid edition timezone"):
        _daily_summary_clock(policy)
