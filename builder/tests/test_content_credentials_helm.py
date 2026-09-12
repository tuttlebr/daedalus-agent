"""Render the actual signing configuration and credential mounts."""

import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

CHART = Path(__file__).parents[2] / "helm" / "daedalus"
pytestmark = pytest.mark.skipif(not shutil.which("helm"), reason="helm not installed")


def render(*values):
    args = ["helm", "template", "test", str(CHART)]
    for value in values:
        args.extend(["--set-string", value])
    return subprocess.run(args, text=True, capture_output=True, check=False)


@pytest.mark.parametrize("mode", ["off", "local"])
def test_only_backend_receives_signing_configuration_and_needed_credentials(mode):
    result = render(
        f"contentCredentials.mode={mode}",
        "contentCredentials.existingSecret=signing-certificate",
        "backend.default.env.overrides.C2PA_SIGNING_MODE=off",
    )
    assert result.returncode == 0, result.stderr
    workloads = [
        doc
        for doc in yaml.safe_load_all(result.stdout)
        if doc and doc["kind"] == "Deployment"
    ]
    backend = next(
        doc
        for doc in workloads
        if doc["metadata"]["labels"].get("app.kubernetes.io/component")
        == "backend-default"
    )
    spec = backend["spec"]["template"]["spec"]
    env = spec["containers"][0]["env"]
    assert [
        entry["value"] for entry in env if entry["name"] == "C2PA_SIGNING_MODE"
    ] == [mode]
    volumes = [v for v in spec.get("volumes", []) if v["name"] == "content-credentials"]
    if mode == "off":
        assert not volumes
    else:
        assert volumes[0]["secret"]["secretName"] == "signing-certificate"
        assert {item["path"] for item in volumes[0]["secret"]["items"]} == (
            {"chain.pem", "key.pem"}
        )
    for workload in workloads:
        if workload is not backend:
            assert "content-credentials" not in str(
                workload["spec"]["template"]["spec"].get("volumes", [])
            )


@pytest.mark.parametrize(
    "values",
    [
        ["contentCredentials.mode=typo"],
        ["contentCredentials.mode=local"],
    ],
)
def test_chart_rejects_incomplete_signing_configuration(values):
    result = render(*values)
    assert result.returncode != 0
    assert "contentCredentials." in result.stderr
