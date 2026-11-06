"""Unlisted image changes must not silently bypass deployment scan gates."""

import importlib.util
import json
import re
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
    monkeypatch.setattr(
        inventory_module,
        "load_inventory",
        lambda: {
            "builtServices": {},
            "upstream": [{"id": "fixture", "image": "fixture@sha256:" + "a" * 64}],
            "platforms": ["linux/amd64", "linux/arm64"],
        },
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


def test_compose_render_uses_a_disposable_env_file(monkeypatch):
    seen_env_file = None

    def output(*command, env=None):
        nonlocal seen_env_file
        assert command[:2] == ("docker", "compose")
        seen_env_file = Path(env["DAEDALUS_COMPOSE_ENV_FILE"])
        assert seen_env_file.is_file()
        assert seen_env_file.read_text() == ""
        assert seen_env_file != ROOT / ".env"
        return '{"services": {}}'

    monkeypatch.setattr(inventory_module, "output", output)
    assert inventory_module.render_compose("docker-compose.yaml") == {"services": {}}
    assert seen_env_file is not None
    assert not seen_env_file.exists()


def test_compose_services_allow_the_inventory_env_override():
    compose = yaml.safe_load((ROOT / "docker-compose.yaml").read_text())
    services_with_env_files = {
        name: service["env_file"]
        for name, service in compose["services"].items()
        if "env_file" in service
    }
    assert services_with_env_files
    assert set(map(tuple, services_with_env_files.values())) == {
        ("${DAEDALUS_COMPOSE_ENV_FILE:-.env}",)
    }


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


@pytest.mark.parametrize("change", [None, "image", "context", "missing_build"])
def test_derived_services_cannot_change_or_omit_the_declared_build(monkeypatch, change):
    inventory = json.loads((ROOT / "deployment-images.json").read_text())
    compose = yaml.safe_load((ROOT / "docker-compose.yaml").read_text())
    browser = yaml.safe_load((ROOT / "frontend/e2e/docker-compose.yml").read_text())
    service = compose["services"]["object-store"]
    if change == "image":
        service["image"] = "unreviewed:latest"
    elif change == "context":
        service["build"]["context"] = "./unreviewed-build"
    elif change == "missing_build":
        del service["build"]
    monkeypatch.setattr(
        inventory_module,
        "render_compose",
        lambda source: compose if source == "docker-compose.yaml" else browser,
    )
    monkeypatch.setattr(inventory_module, "output", _rendered_built_images(inventory))
    if change:
        with pytest.raises(ValueError, match="Derived"):
            inventory_module.validate(inventory)
    else:
        inventory_module.validate(inventory)


def test_derived_scan_uses_an_immutable_id_and_rejects_wrong_architecture(monkeypatch):
    item = {"image": "fixture:patched", "context": "vendor-images/nginx"}
    metadata = {"Os": "linux", "Architecture": "arm64", "Id": "sha256:immutable"}
    monkeypatch.setattr(inventory_module.shutil, "which", lambda _: "/fixture/docker")

    def build(argv, **kwargs):
        assert kwargs["check"] and kwargs["shell"] is False
        assert argv[argv.index("--platform") + 1] == "linux/arm64"

    monkeypatch.setattr(inventory_module.subprocess, "run", build)
    monkeypatch.setattr(
        inventory_module, "output", lambda *args: json.dumps([metadata])
    )
    assert (
        inventory_module.build_derived_image(item, "linux/arm64") == "sha256:immutable"
    )
    metadata["Architecture"] = "amd64"
    with pytest.raises(ValueError, match="architecture mismatch"):
        inventory_module.build_derived_image(item, "linux/arm64")


def _rendered_built_images(inventory):
    """Fake a Helm render containing only the overridden built images."""
    rendered = "".join(
        f"  image: inventory.invalid/daedalus:{name}\n"
        for name in inventory["builtServices"]
    )
    return lambda *args: rendered


def _offline_inventory(monkeypatch, compose):
    browser = yaml.safe_load((ROOT / "frontend/e2e/docker-compose.yml").read_text())
    monkeypatch.setattr(
        inventory_module,
        "render_compose",
        lambda source: compose if source == "docker-compose.yaml" else browser,
    )


def test_helm_nginx_is_a_release_only_built_service():
    inventory = json.loads((ROOT / "deployment-images.json").read_text())
    compose = yaml.safe_load((ROOT / "docker-compose.yaml").read_text())
    assert inventory["builtServices"]["nginx-helm"] == {
        "helmImage": "nginx",
        "context": "vendor-images/nginx-unprivileged",
    }
    service = compose["services"]["nginx-helm"]
    # `docker compose up` must not start the Helm-only image; release paths
    # build it by name and the inventory renders every profile.
    assert service["profiles"] == ["release"]
    assert service["build"] == {"context": "./vendor-images/nginx-unprivileged"}
    assert service["image"].endswith("/daedalus:nginx-helm-${DAEDALUS_VERSION:-0.1.0}")
    # The Compose proxy keeps its own derived image.
    assert compose["services"]["nginx"]["image"].startswith("daedalus/nginx:")


def test_helm_nginx_rebuild_keeps_the_upstream_unprivileged_interface():
    dockerfile = (ROOT / "vendor-images/nginx-unprivileged/Dockerfile").read_text()
    instructions = [
        line.split(None, 1)
        for line in dockerfile.splitlines()
        if line.strip() and not line.startswith("#")
    ]
    assert [item[0] for item in instructions] == ["FROM", "USER", "RUN", "USER"]
    assert re.fullmatch(
        r"mirror\.gcr\.io/nginxinc/nginx-unprivileged:1\.31\.6-alpine-slim"
        r"@sha256:[0-9a-f]{64}",
        instructions[0][1],
    )
    assert instructions[1][1] == "root"
    assert instructions[2][1] == "apk add --no-cache 'zlib=1.4-r0'"
    # Upstream runs as numeric user 101; the chart pins the same identity.
    values = yaml.safe_load((ROOT / "helm/daedalus/values.yaml").read_text())
    assert instructions[3][1] == str(values["nginx"]["securityContext"]["runAsUser"])
    assert values["nginx"]["containerSecurityContext"]["readOnlyRootFilesystem"]
    assert values["nginx"]["containerPort"] == 8080
    assert values["nginx"]["https"]["containerPort"] == 8443


def test_every_built_service_flows_through_every_release_path():
    inventory = json.loads((ROOT / "deployment-images.json").read_text())
    built = inventory["builtServices"]
    compose = yaml.safe_load((ROOT / "docker-compose.yaml").read_text())
    ci = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
    release = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text())
    deploy = (ROOT / "deploy.sh").read_text()
    makefile = (ROOT / "Makefile").read_text()
    values = yaml.safe_load((ROOT / "helm/daedalus/values.yaml").read_text())
    custom = yaml.safe_load((ROOT / "custom-values.yaml").read_text())

    names = list(built)
    helm_keys = [built[name]["helmImage"] for name in names]
    assert f"RELEASE_SERVICES=({' '.join(names)})" in deploy
    assert f"RELEASE_HELM_IMAGES=({' '.join(helm_keys)})" in deploy
    assert "docker compose --profile release" in deploy
    assert (
        "docker compose build --provenance=mode=max --sbom=true " + " ".join(names)
        in makefile
    )
    assert f"for service in {' '.join(names)}; do" in makefile

    docker = ci["jobs"]["docker"]
    docker_runs = "\n".join(step.get("run", "") for step in docker["steps"])
    assert f"-f docker-compose.yaml {' '.join(names)}" in docker_runs
    assert f"for target in {' '.join(names)}; do" in docker_runs
    attest_digests = {
        step["with"]["subject-digest"] for step in ci["jobs"]["docker-attest"]["steps"]
    }

    release_steps = release["jobs"]["release-images"]["steps"]
    release_runs = "\n".join(step.get("run", "") for step in release_steps)
    release_env = {}
    for step in release_steps:
        release_env.update(step.get("env", {}))
    metadata_step = next(
        step
        for step in release_steps
        if step.get("name") == "Record commit-to-digest evidence"
    )

    for name, key in zip(names, helm_keys):
        service = compose["services"][name]
        assert "build" in service
        assert service["image"].endswith(
            f"/daedalus:{name}-${{DAEDALUS_VERSION:-0.1.0}}"
        )
        assert docker["outputs"][f"{name}-digest"] == (
            f"${{{{ steps.image_digests.outputs.{name} }}}}"
        )
        assert f"${{{{ needs.docker.outputs.{name}-digest }}}}" in attest_digests

        build = next(
            step
            for step in release_steps
            if str(step.get("uses", "")).startswith("docker/build-push-action@")
            and step["with"]["tags"].endswith(f":{name}-${{{{ github.sha }}}}")
        )
        assert build["with"]["platforms"] == "linux/amd64"
        assert build["with"]["provenance"] == "mode=max"
        assert build["with"]["sbom"] is True
        context = (ROOT / service["build"]["context"]).resolve()
        assert (ROOT / build["with"]["context"]).resolve() == context
        output = f"${{{{ steps.{build['id']}.outputs.digest }}}}"
        variable = next(var for var, value in release_env.items() if value == output)
        assert f'cosign sign --yes "$BASE_IMAGE@${variable}"' in release_runs
        assert f'"images.{key}.repository=$BASE_IMAGE"' in release_runs
        assert f'"images.{key}.digest=${variable}"' in release_runs
        assert any(
            str(step.get("uses", "")).startswith("actions/attest-build-provenance@")
            and step["with"]["subject-digest"] == output
            for step in release_steps
        )
        assert any(
            str(step.get("uses", "")).startswith("aquasecurity/trivy-action@")
            and step["with"]["image-ref"].endswith("@" + output)
            for step in release_steps
        )
        metadata = metadata_step["run"]
        for section in ("images", "scans", "signatures", "attestations"):
            block = re.search(section + r":\{([^}]*)\}", metadata).group(1)
            assert re.search(rf'(^|,)"?{re.escape(name)}"?:', block), (section, name)

        assert values["images"][key]["repository"] == "YOUR_REGISTRY/daedalus"
        assert values["images"][key]["tag"] == f"{name}-0.1.0"
        assert values["images"][key]["digest"] == ""
        assert (
            custom["images"][key]["repository"]
            == custom["images"]["backend"]["repository"]
        )


def test_built_service_context_cannot_drift_from_its_scanned_rebuild(monkeypatch):
    inventory = json.loads((ROOT / "deployment-images.json").read_text())
    compose = yaml.safe_load((ROOT / "docker-compose.yaml").read_text())
    compose["services"]["nginx-helm"]["build"]["context"] = "./unreviewed-build"
    _offline_inventory(monkeypatch, compose)
    monkeypatch.setattr(inventory_module, "output", _rendered_built_images(inventory))
    with pytest.raises(ValueError, match="Built service context mismatch"):
        inventory_module.validate(inventory)


def test_built_services_need_distinct_helm_images(monkeypatch):
    inventory = json.loads((ROOT / "deployment-images.json").read_text())
    inventory["builtServices"]["nginx-helm"]["helmImage"] = "frontend"
    with pytest.raises(ValueError, match="distinct Helm images"):
        inventory_module.validate(inventory)


def test_helm_render_without_the_nginx_override_exposes_an_unlisted_image(
    monkeypatch,
):
    inventory = json.loads((ROOT / "deployment-images.json").read_text())
    compose = yaml.safe_load((ROOT / "docker-compose.yaml").read_text())
    _offline_inventory(monkeypatch, compose)
    rendered = _rendered_built_images(inventory)("helm")
    monkeypatch.setattr(
        inventory_module,
        "output",
        lambda *args: rendered + "  image: mirror.gcr.io/nginxinc/nginx:latest\n",
    )
    with pytest.raises(ValueError, match="unlisted"):
        inventory_module.validate(inventory)


def test_scan_builds_every_platform_of_built_rebuilds(monkeypatch):
    import subprocess

    inventory = {
        "builtServices": {
            "backend": {"helmImage": "backend"},
            "nginx-helm": {
                "helmImage": "nginx",
                "context": "vendor-images/nginx-unprivileged",
            },
        },
        "upstream": [],
        "derived": [],
        "platforms": ["linux/amd64", "linux/arm64"],
    }
    monkeypatch.setattr(sys, "argv", ["check_image_inventory", "--scan-upstream"])
    monkeypatch.setattr(inventory_module, "load_inventory", lambda: inventory)
    monkeypatch.setattr(inventory_module, "validate", lambda _: None)
    monkeypatch.setattr(inventory_module.shutil, "which", lambda _: "/fixture/trivy")
    built = []

    def build(item, platform):
        built.append((item["id"], item["context"], platform))
        return "sha256:" + platform.split("/")[1]

    def scan(argv, **kwargs):
        assert argv[argv.index("--image-src") + 1] == "docker"
        arch = argv[argv.index("--platform") + 1].split("/")[1]
        assert argv[-1] == "sha256:" + arch
        Path(argv[argv.index("--output") + 1]).write_text(
            json.dumps(
                {
                    "SchemaVersion": 2,
                    "Metadata": {"ImageConfig": {"architecture": arch}},
                    "Results": [{"Target": "fixture", "Packages": [{"Name": "x"}]}],
                }
            )
        )
        return subprocess.CompletedProcess(argv, 0)

    monkeypatch.setattr(inventory_module, "build_derived_image", build)
    monkeypatch.setattr(inventory_module.subprocess, "run", scan)
    inventory_module.main()
    assert built == [
        ("nginx-helm", "vendor-images/nginx-unprivileged", "linux/amd64"),
        ("nginx-helm", "vendor-images/nginx-unprivileged", "linux/arm64"),
    ]
