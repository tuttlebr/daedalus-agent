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


def test_files_named_by_commands_are_checked(tmp_path):
    # Commands are examples too, so only files under a real top-level
    # directory count: a renamed test file in a fence must not go unnoticed.
    root = fixture_repo(
        tmp_path,
        "Run `python -m pytest builder/service.py builder/test_gone.py -q`.\n"
        "```sh\n"
        "builder/.venv/bin/python builder/migration/image_check.py --image x\n"
        "python3 builder/renamed_check.py /tmp/report.json <changed-files>\n"
        "make builder retired-in-fence\n"
        "cat example/invented.py\n"
        "```\n",
    )

    assert skills_module.check(root) == [
        ".agents/skills/demo/references/guide.md: missing path builder/renamed_check.py",
        ".agents/skills/demo/references/guide.md: missing make target retired-in-fence",
        ".agents/skills/demo/references/guide.md: missing path builder/test_gone.py",
    ]


def test_retired_root_files_are_reported(tmp_path):
    # Root files carry no directory separator but are still repository paths.
    root = fixture_repo(
        tmp_path,
        "Read `Makefile`, `docker-compose.yaml`, `.pre-commit-config.yaml` "
        "and `references/guide.md`.\n",
    )

    assert skills_module.check(root) == [
        ".agents/skills/demo/references/guide.md: missing path docker-compose.yaml",
        ".agents/skills/demo/references/guide.md: missing path .pre-commit-config.yaml",
    ]


def test_blank_spans_make_options_and_variables_are_not_references(tmp_path):
    root = fixture_repo(
        tmp_path,
        "Indent with ` ` and run `make -j4 builder` or "
        "`make builder MIGRATION_PYTHON=python3`; `nat_helpers` is a name.\n",
    )

    assert skills_module.check(root) == []


def test_skill_name_must_match_its_directory(tmp_path):
    root = fixture_repo(tmp_path, "")
    write(root / ".agents/skills/demo/SKILL.md", "---\nname: other\n---\n")
    (root / ".agents/skills/empty").mkdir()

    assert skills_module.check(root) == [
        ".agents/skills/demo/SKILL.md: name must be demo",
        ".agents/skills/empty: missing SKILL.md",
    ]


SYNC_SPEC = importlib.util.spec_from_file_location(
    "sync_agent_skills", ROOT / "scripts/sync_agent_skills.py"
)
sync_module = importlib.util.module_from_spec(SYNC_SPEC)
SYNC_SPEC.loader.exec_module(sync_module)


def skill_repo(tmp_path, *names):
    for name in names:
        write(
            tmp_path / ".agents/skills" / name / "SKILL.md", f"---\nname: {name}\n---\n"
        )
    return tmp_path


def test_repository_skill_links_are_synchronized():
    assert sync_module.sync(fix=False) == []


def test_missing_claude_directory_is_skipped_by_check_but_created_by_sync(tmp_path):
    root = skill_repo(tmp_path, "one", "two")
    assert sync_module.sync(root, fix=False) == []
    assert len(sync_module.sync(root)) == 2
    assert sync_module.sync(root, fix=False) == []
    link = root / ".claude/skills/one"
    assert link.is_symlink() and (link / "SKILL.md").is_file()


def test_stale_wrong_and_shadowing_entries_are_reported_and_repaired(tmp_path):
    root = skill_repo(tmp_path, "one", "two")
    sync_module.sync(root)
    mirror = root / ".claude/skills"
    (mirror / "one").unlink()
    (mirror / "one").symlink_to("../../elsewhere")
    (mirror / "gone").symlink_to("../../.agents/skills/gone")
    (mirror / "two").unlink()
    (mirror / "two").mkdir()
    problems = sync_module.sync(root, fix=False)
    assert any("one" in p and "wrong link" in p for p in problems)
    assert any("gone" in p and "stale" in p for p in problems)
    assert any("two" in p and "shadows" in p for p in problems)
    sync_module.sync(root)
    assert not (mirror / "gone").is_symlink()
    assert (mirror / "one").resolve() == (root / ".agents/skills/one").resolve()
    # A real directory is never deleted automatically.
    assert (mirror / "two").is_dir() and not (mirror / "two").is_symlink()


def test_unrelated_links_in_the_mirror_are_left_alone(tmp_path):
    root = skill_repo(tmp_path / "repo", "one")
    sync_module.sync(root)
    mirror = root / ".claude/skills"
    personal = tmp_path / "personal-skills/mine"
    personal.mkdir(parents=True)
    (mirror / "mine").symlink_to(personal)
    (mirror / "relative").symlink_to("../../../other/skills/relative")
    assert sync_module.sync(root, fix=False) == []
    sync_module.sync(root)
    assert (mirror / "mine").is_symlink() and (mirror / "relative").is_symlink()


def test_personal_copies_are_reported(tmp_path):
    root = skill_repo(tmp_path / "repo", "one")
    home = tmp_path / "home"
    (home / ".codex/skills/one").mkdir(parents=True)
    assert sync_module.personal_copies(root, home) == [str(home / ".codex/skills/one")]
