"""Unlisted image changes must not silently bypass deployment scan gates."""

import importlib.util
import json
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location(
    "check_image_inventory", ROOT / "scripts/check_image_inventory.py"
)
inventory_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory_module)


def test_new_service_or_changed_digest_is_not_implicitly_trusted():
    with pytest.raises(ValueError, match="unlisted"):
        inventory_module.check_refs("fixture", {"unexpected:latest"}, set())
    with pytest.raises(ValueError, match="unlisted"):
        inventory_module.check_refs("fixture", {"repo@sha256:new"}, {"repo@sha256:old"})
    inventory_module.check_refs(
        "fixture",
        {"registry:5000/repo:tag@sha256:abc"},
        {"registry:5000/repo@sha256:abc"},
    )


def test_all_scan_entrypoints_use_the_central_inventory():
    inventory = json.loads((ROOT / "deployment-images.json").read_text())
    command = "python3 scripts/check_image_inventory.py --scan-upstream"
    assert command in (ROOT / "Makefile").read_text()
    for file, job in (("ci.yml", "docker"), ("release.yml", "release-images")):
        workflow = yaml.safe_load((ROOT / ".github/workflows" / file).read_text())
        steps = workflow["jobs"][job]["steps"]
        assert any(step.get("run") == command for step in steps)
        scanned_built = {
            step["name"].removeprefix("Scan ").removesuffix(" image").lower()
            for step in steps
            if str(step.get("uses", "")).startswith("aquasecurity/trivy-action@")
        }
        assert scanned_built == set(inventory["builtServices"])


def test_inventory_cannot_drop_a_supported_architecture():
    inventory = json.loads((ROOT / "deployment-images.json").read_text())
    inventory["platforms"] = ["linux/amd64"]
    with pytest.raises(ValueError, match="both supported"):
        inventory_module.validate(inventory)


def test_requested_platform_cannot_be_replaced_by_cached_host_image(monkeypatch):
    import subprocess

    monkeypatch.setattr(
        sys,
        "argv",
        ["check_image_inventory", "--scan-upstream", "--platform", "linux/arm64"],
    )
    monkeypatch.setattr(inventory_module, "validate", lambda _: None)
    monkeypatch.setattr(
        inventory_module.shutil, "which", lambda _: "/fixture/bin/trivy"
    )

    def wrong_architecture(argv, **kwargs):
        assert argv[0] == "/fixture/bin/trivy"
        assert kwargs["shell"] is False
        assert argv[argv.index("--image-src") + 1] == "remote"
        assert argv[argv.index("--platform") + 1] == "linux/arm64"
        Path(argv[argv.index("--output") + 1]).write_text(
            json.dumps(
                {
                    "SchemaVersion": 2,
                    "Metadata": {"ImageConfig": {"architecture": "amd64"}},
                    "Results": [
                        {"Target": "fixture", "Packages": [{"Name": "fixture"}]}
                    ],
                }
            )
        )
        return subprocess.CompletedProcess(argv, 0)

    monkeypatch.setattr(inventory_module.subprocess, "run", wrong_architecture)
    with pytest.raises(SystemExit, match="Scanner failed"):
        inventory_module.main()


def test_render_command_resolves_executable_and_preserves_literal_arguments(
    monkeypatch,
):
    seen = []
    monkeypatch.setattr(
        inventory_module.shutil, "which", lambda _: "/fixture/bin/docker"
    )

    def output(argv, **kwargs):
        seen.append(argv)
        assert kwargs["shell"] is False
        assert kwargs["timeout"] == 60
        return "rendered"

    monkeypatch.setattr(inventory_module.subprocess, "check_output", output)
    assert inventory_module.output("docker", "literal;$(not-a-command)") == "rendered"
    assert seen == [("/fixture/bin/docker", "literal;$(not-a-command)")]


def test_missing_render_or_scanner_executable_fails_closed(monkeypatch):
    monkeypatch.setattr(inventory_module.shutil, "which", lambda _: None)
    with pytest.raises(FileNotFoundError, match="Required executable not found"):
        inventory_module.output("docker", "compose")
    monkeypatch.setattr(sys, "argv", ["check_image_inventory", "--scan-upstream"])
    monkeypatch.setattr(inventory_module, "validate", lambda _: None)
    with pytest.raises(
        FileNotFoundError, match="Required scanner executable not found"
    ):
        inventory_module.main()
