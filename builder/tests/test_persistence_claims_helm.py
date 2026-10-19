"""Chart storage and scale settings match what the workloads actually use."""

import subprocess
from pathlib import Path

import pytest
import yaml

CHART = Path(__file__).parents[2] / "helm" / "daedalus"
pytestmark = pytest.mark.requires_helm

CASES = {
    # component: (values enabling the volume, existing-claim key, chart claim)
    "redis": ([], "redis.persistence.existingClaimName", "test-daedalus-redis"),
    "nginx": (
        ["nginx.imageVolume.enabled=true"],
        "nginx.imageVolume.existingClaimName",
        "test-daedalus-images",
    ),
}


def render(*values):
    args = ["helm", "template", "test", str(CHART)]
    for value in values:
        args.extend(["--set", value])
    result = subprocess.run(args, text=True, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def mounted_claims(documents, deployment):
    workload = next(
        doc
        for doc in documents
        if doc["kind"] == "Deployment" and doc["metadata"]["name"] == deployment
    )
    return {
        volume["persistentVolumeClaim"]["claimName"]
        for volume in workload["spec"]["template"]["spec"]["volumes"]
        if "persistentVolumeClaim" in volume
    }


def created_claims(documents):
    return {
        doc["metadata"]["name"]
        for doc in documents
        if doc["kind"] == "PersistentVolumeClaim"
    }


@pytest.mark.parametrize("component", sorted(CASES))
def test_existing_claim_does_not_provision_an_unmounted_chart_claim(component):
    enable, existing_key, chart_claim = CASES[component]
    deployment = f"test-daedalus-{component}"

    default = render(*enable)
    assert chart_claim in created_claims(default)
    assert mounted_claims(default, deployment) == {chart_claim}

    # The chart claims keep `helm.sh/resource-policy: keep`, so an orphan would
    # hold storage after uninstall even though no workload ever mounts it.
    existing = render(*enable, f"{existing_key}=operator-data")
    assert mounted_claims(existing, deployment) == {"operator-data"}
    assert chart_claim not in created_claims(existing)


@pytest.mark.parametrize(("value", "expected"), [("0", 0), ("3", 3), ("null", 1)])
def test_backend_replicas_honor_zero_and_default_to_one(value, expected):
    # Two pods cannot share the default ReadWriteOnce backend claim across
    # nodes, so an explicit 0 must not become a stuck two-replica rollout.
    documents = render(f"backend.default.replicas={value}")
    backend = next(
        doc
        for doc in documents
        if doc["kind"] == "Deployment"
        and doc["metadata"]["name"] == "test-daedalus-backend-default"
    )
    assert backend["spec"]["replicas"] == expected
