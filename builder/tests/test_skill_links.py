"""Skill link validation includes deleted resources and both skill roots."""

import importlib.util
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "check_skill_links", ROOT / "scripts/check_skill_links.py"
)
links = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(links)


@pytest.mark.parametrize("directory", ["skills", ".agents/skills"])
def test_deleted_resource_is_reported(tmp_path, monkeypatch, directory):
    monkeypatch.setattr(links, "ROOT", tmp_path)
    skill = tmp_path / directory / "demo"
    skill.mkdir(parents=True)
    source = skill / "SKILL.md"
    source.write_text("# Demo\n\n[Resource](resource.txt)\n")
    resource = skill / "resource.txt"
    resource.write_text("valid\n")
    assert links.check(tmp_path / directory) == []
    resource.unlink()
    assert links.check(tmp_path / directory) == [
        f"{directory}/demo/SKILL.md: missing local file {resource}"
    ]


def test_link_hook_runs_without_selected_filenames():
    # pre-commit does not pass deleted paths. This is a selection requirement,
    # separate from the behavioral deletion check above.
    config = yaml.safe_load((ROOT / ".pre-commit-config.yaml").read_text())
    hook = next(
        hook
        for repo in config["repos"]
        if repo["repo"] == "local"
        for hook in repo["hooks"]
        if hook["id"] == "skill-links"
    )
    assert hook["always_run"] is True
    assert hook["pass_filenames"] is False
