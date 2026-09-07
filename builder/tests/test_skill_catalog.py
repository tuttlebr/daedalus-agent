"""Exercise the shipped skill catalog through the application dispatcher."""

import asyncio
import json
from pathlib import Path

from agent_skills.agent_skills_function import _list_skills, _load_skill
from agent_skills.skill_parser import SkillParser

SKILLS = Path(__file__).resolve().parents[2] / "skills"


def test_entire_catalog_and_resources_round_trip():
    parser = SkillParser(str(SKILLS))
    discovered = parser.discover_skills()
    expected = {p.parent.name for p in SKILLS.glob("*/SKILL.md")}
    listed = json.loads(asyncio.run(_list_skills(parser)))
    assert {item["name"] for item in listed["skills"]} == expected
    assert len(discovered) == len(expected) == 18
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
