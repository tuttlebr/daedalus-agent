"""Maintenance skills must fail fast when the repository they describe changes."""

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "check_maintenance_skills", ROOT / "scripts/check_maintenance_skills.py"
)
skills_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(skills_module)


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def fixture_repo(tmp_path, guide):
    write(tmp_path / "Makefile", "VERSION := 1\nbuilder: ## tests\n\tpytest\n")
    write(tmp_path / "builder/service.py", "")
    write(tmp_path / "builder/migration/image_check.py", "")
    skill = tmp_path / ".agents/skills/demo"
    write(skill / "SKILL.md", "---\nname: demo\ndescription: Demo.\n---\n")
    write(skill / "references/guide.md", guide)
    return tmp_path


def test_repository_maintenance_skills_resolve():
    assert skills_module.check() == []


def test_moved_paths_globs_and_retired_targets_are_reported(tmp_path):
    root = fixture_repo(
        tmp_path,
        "`builder/service.py`, `references/guide.md`, `builder/migration/*_check.py`\n"
        "`builder/tools.py`, `frontend/*.ts`, `make builder`, `make builder retired`\n"
        "Repeated references report once: `builder/tools.py`, `make retired`\n",
    )

    assert skills_module.check(root) == [
        ".agents/skills/demo/references/guide.md: missing path builder/tools.py",
        ".agents/skills/demo/references/guide.md: missing path frontend/*.ts",
        ".agents/skills/demo/references/guide.md: missing make target retired",
    ]


def test_commands_placeholders_and_code_blocks_are_not_paths(tmp_path):
    root = fixture_repo(
        tmp_path,
        "`uv venv builder/.venv --python 3.12`, `.claude/skills/<name>`, "
        "`https://example.com/a`, `/tmp/report`, `make <target>`, `make VERSION`\n"
        "```\ncat retired/file.py\n```\n",
    )

    assert skills_module.check(root) == [
        ".agents/skills/demo/references/guide.md: missing make target VERSION"
    ]


def test_skill_name_must_match_its_directory(tmp_path):
    root = fixture_repo(tmp_path, "")
    write(root / ".agents/skills/demo/SKILL.md", "---\nname: other\n---\n")
    (root / ".agents/skills/empty").mkdir()

    assert skills_module.check(root) == [
        ".agents/skills/demo/SKILL.md: name must be demo",
        ".agents/skills/empty: missing SKILL.md",
    ]
