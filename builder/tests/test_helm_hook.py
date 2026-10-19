"""The Helm pre-commit hook rejects deployed values the chart would reject."""

import re
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.requires_helm


def helm_hook():
    config = yaml.safe_load((ROOT / ".pre-commit-config.yaml").read_text())
    return next(
        hook
        for repo in config["repos"]
        if repo["repo"] == "local"
        for hook in repo["hooks"]
        if hook["id"] == "helm-lint-daedalus"
    )


def run_hook(hook, cwd):
    return subprocess.run(
        shlex.split(hook["entry"]),
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )


def test_hook_lints_the_deployed_values_file(tmp_path):
    hook = helm_hook()
    # Selecting the values file matters: a values-only edit must run the hook.
    assert re.search(hook["files"], "custom-values.yaml")
    assert re.search(hook["files"], "helm/daedalus/values.yaml")
    shutil.copytree(ROOT / "helm", tmp_path / "helm")
    shutil.copy(ROOT / "custom-values.yaml", tmp_path / "custom-values.yaml")
    assert run_hook(hook, tmp_path).returncode == 0

    # Override allowlists `fail` only on real keys, never on chart defaults.
    values = yaml.safe_load((ROOT / "custom-values.yaml").read_text())
    values["frontend"]["env"]["overrides"]["SESSION_SECRET"] = "not-an-override"
    (tmp_path / "custom-values.yaml").write_text(yaml.safe_dump(values))
    result = run_hook(hook, tmp_path)

    assert result.returncode != 0
    assert "not in the frontend workload allowlist" in result.stdout + result.stderr
