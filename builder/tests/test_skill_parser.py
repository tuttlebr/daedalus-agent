"""Unit tests for agent_skills.skill_parser module."""

from pathlib import Path

import pytest
from agent_skills.skill_parser import (
    _MAX_DESCRIPTION_LENGTH,
    _MAX_NAME_LENGTH,
    SkillMetadata,
    SkillParser,
)

# ---------------------------------------------------------------------------
# Test fixtures / helpers
# ---------------------------------------------------------------------------

_VALID_SKILL_MD = """\
---
name: my-skill
description: A test skill for unit testing
---

# My Skill

This is the skill instructions body.
"""

_VALID_SKILL_MD_NO_BODY = """\
---
name: another-skill
description: Another test skill
---
"""

_VALID_SKILL_MD_NO_FRONTMATTER_BODY = """\
---
name: plain-skill
description: Plain skill with no body after frontmatter
---"""


def _make_skill(parent: Path, dir_name: str, content: str) -> Path:
    skill_dir = parent / dir_name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")
    return skill_dir


# ---------------------------------------------------------------------------
# SkillMetadata
# ---------------------------------------------------------------------------


class TestSkillMetadata:
    def test_to_dict(self, tmp_path):
        meta = SkillMetadata(
            name="my-skill",
            description="A test skill",
            directory=tmp_path,
        )
        assert meta.to_dict() == {"name": "my-skill", "description": "A test skill"}

    def test_frozen(self, tmp_path):
        meta = SkillMetadata(name="x", description="y", directory=tmp_path)
        with pytest.raises(Exception):  # frozen dataclass
            meta.name = "z"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# SkillParser.discover_skills
# ---------------------------------------------------------------------------


class TestDiscoverSkills:
    def test_empty_directory(self, tmp_path):
        parser = SkillParser(skills_directory=str(tmp_path))
        assert parser.discover_skills() == []

    def test_nonexistent_directory(self):
        parser = SkillParser(skills_directory="/does/not/exist/xyz123")
        assert parser.discover_skills() == []

    def test_single_valid_skill(self, tmp_path):
        _make_skill(tmp_path, "my-skill", _VALID_SKILL_MD)
        parser = SkillParser(skills_directory=str(tmp_path))
        skills = parser.discover_skills()
        assert len(skills) == 1
        assert skills[0].name == "my-skill"
        assert skills[0].description == "A test skill for unit testing"

    def test_multiple_skills_sorted(self, tmp_path):
        _make_skill(
            tmp_path,
            "skill-b",
            "---\nname: skill-b\ndescription: Second skill\n---\n",
        )
        _make_skill(
            tmp_path,
            "skill-a",
            "---\nname: skill-a\ndescription: First skill\n---\n",
        )
        parser = SkillParser(skills_directory=str(tmp_path))
        skills = parser.discover_skills()
        assert len(skills) == 2
        names = [s.name for s in skills]
        assert "skill-a" in names
        assert "skill-b" in names

    def test_skips_plain_files_in_root(self, tmp_path):
        (tmp_path / "SKILL.md").write_text(_VALID_SKILL_MD)
        parser = SkillParser(skills_directory=str(tmp_path))
        assert parser.discover_skills() == []

    def test_skips_directory_without_skill_md(self, tmp_path):
        (tmp_path / "empty-dir").mkdir()
        parser = SkillParser(skills_directory=str(tmp_path))
        assert parser.discover_skills() == []

    def test_skips_invalid_frontmatter(self, tmp_path):
        _make_skill(tmp_path, "bad-skill", "No frontmatter here")
        parser = SkillParser(skills_directory=str(tmp_path))
        assert parser.discover_skills() == []

    def test_skips_one_invalid_keeps_valid(self, tmp_path):
        _make_skill(tmp_path, "good-skill", _VALID_SKILL_MD)
        _make_skill(tmp_path, "bad-skill", "No frontmatter")
        parser = SkillParser(skills_directory=str(tmp_path))
        skills = parser.discover_skills()
        assert len(skills) == 1
        assert skills[0].name == "my-skill"

    def test_clears_cache_on_rescan(self, tmp_path):
        _make_skill(tmp_path, "skill-one", _VALID_SKILL_MD)
        parser = SkillParser(skills_directory=str(tmp_path))
        first = parser.discover_skills()
        assert len(first) == 1

        _make_skill(
            tmp_path,
            "skill-two",
            "---\nname: skill-two\ndescription: Second skill\n---\n",
        )
        second = parser.discover_skills()
        assert len(second) == 2


# ---------------------------------------------------------------------------
# SkillParser.get_skill_names / get_skill_metadata
# ---------------------------------------------------------------------------


class TestGetSkillMetadata:
    def test_get_names(self, tmp_path):
        _make_skill(tmp_path, "my-skill", _VALID_SKILL_MD)
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        assert "my-skill" in parser.get_skill_names()

    def test_get_metadata_found(self, tmp_path):
        _make_skill(tmp_path, "my-skill", _VALID_SKILL_MD)
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        meta = parser.get_skill_metadata("my-skill")
        assert meta.name == "my-skill"

    def test_get_metadata_not_found(self, tmp_path):
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        with pytest.raises(KeyError, match="Skill not found"):
            parser.get_skill_metadata("ghost")

    def test_empty_names_before_discovery(self, tmp_path):
        parser = SkillParser(skills_directory=str(tmp_path))
        assert parser.get_skill_names() == []


# ---------------------------------------------------------------------------
# SkillParser.get_skill_instructions
# ---------------------------------------------------------------------------


class TestGetSkillInstructions:
    def test_body_after_frontmatter(self, tmp_path):
        _make_skill(tmp_path, "my-skill", _VALID_SKILL_MD)
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        body = parser.get_skill_instructions("my-skill")
        assert "# My Skill" in body
        assert "This is the skill instructions body." in body
        assert "name: my-skill" not in body

    def test_empty_body(self, tmp_path):
        _make_skill(tmp_path, "another-skill", _VALID_SKILL_MD_NO_BODY)
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        body = parser.get_skill_instructions("another-skill")
        assert body == ""

    def test_instructions_cached(self, tmp_path):
        _make_skill(tmp_path, "my-skill", _VALID_SKILL_MD)
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        body1 = parser.get_skill_instructions("my-skill")
        body2 = parser.get_skill_instructions("my-skill")
        assert body1 == body2

    def test_not_found_raises(self, tmp_path):
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        with pytest.raises(KeyError):
            parser.get_skill_instructions("ghost")


# ---------------------------------------------------------------------------
# SkillParser.get_skill_resource
# ---------------------------------------------------------------------------


class TestGetSkillResource:
    def test_read_valid_resource(self, tmp_path):
        skill_dir = _make_skill(tmp_path, "my-skill", _VALID_SKILL_MD)
        (skill_dir / "notes.md").write_text("Extra notes", encoding="utf-8")
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        content = parser.get_skill_resource("my-skill", "notes.md")
        assert content == "Extra notes"

    def test_directory_traversal_rejected(self, tmp_path):
        _make_skill(tmp_path, "my-skill", _VALID_SKILL_MD)
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        with pytest.raises(PermissionError, match="escapes the skill directory"):
            parser.get_skill_resource("my-skill", "../SKILL.md")

    def test_resource_not_found(self, tmp_path):
        _make_skill(tmp_path, "my-skill", _VALID_SKILL_MD)
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        with pytest.raises(FileNotFoundError, match="Resource not found"):
            parser.get_skill_resource("my-skill", "nonexistent.md")

    def test_binary_file_raises_value_error(self, tmp_path):
        skill_dir = _make_skill(tmp_path, "my-skill", _VALID_SKILL_MD)
        (skill_dir / "data.bin").write_bytes(b"\x00\x01\x02\xff\xfe")
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        with pytest.raises(ValueError, match="binary file"):
            parser.get_skill_resource("my-skill", "data.bin")

    def test_subdirectory_resource(self, tmp_path):
        skill_dir = _make_skill(tmp_path, "my-skill", _VALID_SKILL_MD)
        sub = skill_dir / "sub"
        sub.mkdir()
        (sub / "template.txt").write_text("template content", encoding="utf-8")
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        content = parser.get_skill_resource("my-skill", "sub/template.txt")
        assert content == "template content"


# ---------------------------------------------------------------------------
# SkillParser.list_skill_resources
# ---------------------------------------------------------------------------


class TestListSkillResources:
    def test_no_extra_resources(self, tmp_path):
        _make_skill(tmp_path, "my-skill", _VALID_SKILL_MD)
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        assert parser.list_skill_resources("my-skill") == []

    def test_excludes_skill_md(self, tmp_path):
        skill_dir = _make_skill(tmp_path, "my-skill", _VALID_SKILL_MD)
        (skill_dir / "extra.py").write_text("print('hi')")
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        resources = parser.list_skill_resources("my-skill")
        assert "SKILL.md" not in resources
        assert "extra.py" in resources

    def test_lists_multiple_resources(self, tmp_path):
        skill_dir = _make_skill(tmp_path, "my-skill", _VALID_SKILL_MD)
        (skill_dir / "script.sh").write_text("#!/bin/bash")
        (skill_dir / "notes.md").write_text("notes")
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        resources = parser.list_skill_resources("my-skill")
        assert len(resources) == 2
        assert "notes.md" in resources
        assert "script.sh" in resources


# ---------------------------------------------------------------------------
# SkillParser.resolve_script_path
# ---------------------------------------------------------------------------


class TestResolveScriptPath:
    def test_valid_script(self, tmp_path):
        skill_dir = _make_skill(tmp_path, "my-skill", _VALID_SKILL_MD)
        script = skill_dir / "run.py"
        script.write_text("print('ok')")
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        resolved = parser.resolve_script_path("my-skill", "run.py")
        assert resolved == script.resolve()

    def test_traversal_rejected(self, tmp_path):
        _make_skill(tmp_path, "my-skill", _VALID_SKILL_MD)
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        with pytest.raises(PermissionError, match="escapes the skill directory"):
            parser.resolve_script_path("my-skill", "../evil.py")

    def test_missing_script_raises(self, tmp_path):
        _make_skill(tmp_path, "my-skill", _VALID_SKILL_MD)
        parser = SkillParser(skills_directory=str(tmp_path))
        parser.discover_skills()
        with pytest.raises(FileNotFoundError, match="Script not found"):
            parser.resolve_script_path("my-skill", "missing.sh")


# ---------------------------------------------------------------------------
# SkillParser._parse_frontmatter (static method)
# ---------------------------------------------------------------------------


class TestParseFrontmatter:
    def _write(self, tmp_path: Path, content: str) -> Path:
        p = tmp_path / "SKILL.md"
        p.write_text(content, encoding="utf-8")
        return p

    def test_valid_frontmatter(self, tmp_path):
        skill_file = self._write(tmp_path, _VALID_SKILL_MD)
        meta = SkillParser._parse_frontmatter(skill_file, tmp_path)
        assert meta.name == "my-skill"
        assert meta.description == "A test skill for unit testing"
        assert meta.directory == tmp_path

    def test_missing_frontmatter_delimiters(self, tmp_path):
        skill_file = self._write(tmp_path, "# No frontmatter\nJust text")
        with pytest.raises(ValueError, match="Missing YAML frontmatter"):
            SkillParser._parse_frontmatter(skill_file, tmp_path)

    def test_invalid_yaml(self, tmp_path):
        skill_file = self._write(tmp_path, "---\n: bad: yaml:\n---\nbody\n")
        with pytest.raises(ValueError, match="Invalid YAML frontmatter"):
            SkillParser._parse_frontmatter(skill_file, tmp_path)

    def test_non_mapping_yaml(self, tmp_path):
        skill_file = self._write(tmp_path, "---\n- item1\n- item2\n---\nbody\n")
        with pytest.raises(ValueError, match="must be a YAML mapping"):
            SkillParser._parse_frontmatter(skill_file, tmp_path)

    def test_missing_name_field(self, tmp_path):
        skill_file = self._write(tmp_path, "---\ndescription: A skill\n---\nbody\n")
        with pytest.raises(ValueError, match="missing required 'name'"):
            SkillParser._parse_frontmatter(skill_file, tmp_path)

    def test_empty_name_field(self, tmp_path):
        skill_file = self._write(tmp_path, "---\nname: \ndescription: A skill\n---\n")
        with pytest.raises(ValueError, match="missing required 'name'"):
            SkillParser._parse_frontmatter(skill_file, tmp_path)

    def test_missing_description_field(self, tmp_path):
        skill_file = self._write(tmp_path, "---\nname: my-skill\n---\nbody\n")
        with pytest.raises(ValueError, match="missing required 'description'"):
            SkillParser._parse_frontmatter(skill_file, tmp_path)

    def test_name_too_long(self, tmp_path):
        long_name = "a" * (_MAX_NAME_LENGTH + 1)
        skill_file = self._write(
            tmp_path, f"---\nname: {long_name}\ndescription: A skill\n---\n"
        )
        with pytest.raises(ValueError, match="exceeds"):
            SkillParser._parse_frontmatter(skill_file, tmp_path)

    def test_invalid_name_pattern_uppercase(self, tmp_path):
        skill_file = self._write(
            tmp_path, "---\nname: MySkill\ndescription: A skill\n---\n"
        )
        with pytest.raises(ValueError, match="lowercase alphanumeric"):
            SkillParser._parse_frontmatter(skill_file, tmp_path)

    def test_invalid_name_pattern_spaces(self, tmp_path):
        skill_file = self._write(
            tmp_path, "---\nname: my skill\ndescription: A skill\n---\n"
        )
        with pytest.raises(ValueError, match="lowercase alphanumeric"):
            SkillParser._parse_frontmatter(skill_file, tmp_path)

    def test_invalid_name_pattern_special_chars(self, tmp_path):
        skill_file = self._write(
            tmp_path, "---\nname: my_skill!\ndescription: A skill\n---\n"
        )
        with pytest.raises(ValueError, match="lowercase alphanumeric"):
            SkillParser._parse_frontmatter(skill_file, tmp_path)

    def test_valid_name_with_hyphens(self, tmp_path):
        skill_file = self._write(
            tmp_path, "---\nname: my-cool-skill\ndescription: A skill\n---\n"
        )
        meta = SkillParser._parse_frontmatter(skill_file, tmp_path)
        assert meta.name == "my-cool-skill"

    def test_description_too_long(self, tmp_path):
        long_desc = "x" * (_MAX_DESCRIPTION_LENGTH + 1)
        skill_file = self._write(
            tmp_path, f"---\nname: my-skill\ndescription: {long_desc}\n---\n"
        )
        with pytest.raises(ValueError, match="description exceeds"):
            SkillParser._parse_frontmatter(skill_file, tmp_path)

    def test_strips_whitespace_from_name_and_description(self, tmp_path):
        skill_file = self._write(
            tmp_path, "---\nname: '  my-skill  '\ndescription: '  A skill  '\n---\n"
        )
        meta = SkillParser._parse_frontmatter(skill_file, tmp_path)
        assert meta.name == "my-skill"
        assert meta.description == "A skill"

    def test_non_string_name_raises(self, tmp_path):
        skill_file = self._write(
            tmp_path, "---\nname: 123\ndescription: A skill\n---\n"
        )
        # 123 is an int in YAML — not a str — should raise
        with pytest.raises(ValueError):
            SkillParser._parse_frontmatter(skill_file, tmp_path)
