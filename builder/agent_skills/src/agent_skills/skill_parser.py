"""
Discovers, parses, and manages Anthropic-style Agent Skills from the filesystem.

Skills are directories containing a SKILL.md file with YAML frontmatter (name, description)
and optional resources (additional markdown files, scripts, templates). This module implements
the three-level progressive disclosure model:
  Level 1 - Metadata (name + description from YAML frontmatter)
  Level 2 - Instructions (full SKILL.md body)
  Level 3 - Resources (additional files and executable scripts)
"""

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)

_FRONTMATTER_PATTERN = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_NAME_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_MAX_NAME_LENGTH = 64
_MAX_DESCRIPTION_LENGTH = 1024
_SKILL_FILENAME = "SKILL.md"


@dataclass(frozen=True)
class SkillMetadata:
    """Level 1: lightweight metadata extracted from SKILL.md frontmatter."""

    name: str
    description: str
    directory: Path

    def to_dict(self) -> dict[str, str]:
        return {"name": self.name, "description": self.description}


@dataclass
class SkillParser:
    """Scans a directory tree for SKILL.md files and provides access at each disclosure level."""

    skills_directory: str
    _skills: dict[str, SkillMetadata] = field(
        default_factory=dict, init=False, repr=False
    )
    _instructions_cache: dict[str, str] = field(
        default_factory=dict, init=False, repr=False
    )

    def discover_skills(self) -> list[SkillMetadata]:
        """Scan the skills directory and cache metadata for every valid skill found."""
        self._skills.clear()
        self._instructions_cache.clear()
        root = Path(self.skills_directory)

        if not root.is_dir():
            logger.warning("Skills directory does not exist: %s", root)
            return []

        for candidate in sorted(root.iterdir()):
            if not candidate.is_dir():
                continue
            skill_file = candidate / _SKILL_FILENAME
            if not skill_file.is_file():
                continue
            try:
                meta = self._parse_frontmatter(skill_file, candidate)
                self._skills[meta.name] = meta
                logger.info("Discovered skill: %s (%s)", meta.name, candidate)
            except ValueError as exc:
                logger.warning("Skipping %s: %s", candidate.name, exc)

        logger.info("Discovered %d skill(s) in %s", len(self._skills), root)
        return list(self._skills.values())

    def get_skill_names(self) -> list[str]:
        return list(self._skills.keys())

    def get_skill_metadata(self, name: str) -> SkillMetadata:
        """Level 1: return cached metadata for a skill by name."""
        if name not in self._skills:
            raise KeyError(f"Skill not found: {name}")
        return self._skills[name]

    def get_skill_instructions(self, name: str) -> str:
        """Level 2: read and return the full SKILL.md body (everything after the frontmatter)."""
        if name in self._instructions_cache:
            return self._instructions_cache[name]

        meta = self.get_skill_metadata(name)
        skill_file = meta.directory / _SKILL_FILENAME
        raw = skill_file.read_text(encoding="utf-8")
        match = _FRONTMATTER_PATTERN.match(raw)
        if match:
            body = raw[match.end() :].strip()
        else:
            body = raw.strip()

        self._instructions_cache[name] = body
        return body

    def get_skill_resource(self, name: str, resource_path: str) -> str:
        """Level 3: read an additional resource file from a skill's directory.

        The *resource_path* is relative to the skill directory. Directory traversal
        outside the skill directory is rejected.
        """
        meta = self.get_skill_metadata(name)
        resolved = (meta.directory / resource_path).resolve()
        skill_root = meta.directory.resolve()

        if (
            not str(resolved).startswith(str(skill_root) + os.sep)
            and resolved != skill_root
        ):
            raise PermissionError(
                f"Resource path escapes the skill directory: {resource_path}"
            )

        if not resolved.is_file():
            raise FileNotFoundError(
                f"Resource not found in skill '{name}': {resource_path}"
            )

        try:
            return resolved.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            raise ValueError(
                f"Resource '{resource_path}' in skill '{name}' is a binary file and cannot be read as text"
            )

    def list_skill_resources(self, name: str) -> list[str]:
        """Level 3: list all files in a skill directory (relative paths), excluding SKILL.md."""
        meta = self.get_skill_metadata(name)
        resources: list[str] = []
        for path in sorted(meta.directory.rglob("*")):
            if path.is_file() and path.name != _SKILL_FILENAME:
                resources.append(str(path.relative_to(meta.directory)))
        return resources

    def resolve_script_path(self, name: str, script_path: str) -> Path:
        """Resolve and validate a script path within a skill directory.

        Returns the absolute path after verifying it exists and is contained
        within the skill directory.
        """
        meta = self.get_skill_metadata(name)
        resolved = (meta.directory / script_path).resolve()
        skill_root = meta.directory.resolve()

        if not str(resolved).startswith(str(skill_root) + os.sep):
            raise PermissionError(
                f"Script path escapes the skill directory: {script_path}"
            )

        if not resolved.is_file():
            raise FileNotFoundError(
                f"Script not found in skill '{name}': {script_path}"
            )

        return resolved

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_frontmatter(skill_file: Path, skill_dir: Path) -> SkillMetadata:
        """Parse and validate the YAML frontmatter from a SKILL.md file."""
        raw = skill_file.read_text(encoding="utf-8")
        match = _FRONTMATTER_PATTERN.match(raw)
        if not match:
            raise ValueError("Missing YAML frontmatter (expected --- delimiters)")

        try:
            fm = yaml.safe_load(match.group(1))
        except yaml.YAMLError as exc:
            raise ValueError(f"Invalid YAML frontmatter: {exc}") from exc

        if not isinstance(fm, dict):
            raise ValueError("Frontmatter must be a YAML mapping")

        name = fm.get("name")
        description = fm.get("description")

        if not name or not isinstance(name, str):
            raise ValueError("Frontmatter missing required 'name' field")
        if not description or not isinstance(description, str):
            raise ValueError("Frontmatter missing required 'description' field")

        name = name.strip()
        description = description.strip()

        if len(name) > _MAX_NAME_LENGTH:
            raise ValueError(
                f"Skill name exceeds {_MAX_NAME_LENGTH} characters: {name!r}"
            )
        if not _NAME_PATTERN.match(name):
            raise ValueError(
                f"Skill name must be lowercase alphanumeric with hyphens: {name!r}"
            )
        if len(description) > _MAX_DESCRIPTION_LENGTH:
            raise ValueError(
                f"Skill description exceeds {_MAX_DESCRIPTION_LENGTH} characters"
            )

        return SkillMetadata(name=name, description=description, directory=skill_dir)
