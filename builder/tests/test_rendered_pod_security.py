"""The rendered-manifest gate must reject every weakening of the pod baseline."""

import copy
import importlib.util
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "check_rendered_pod_security", ROOT / "scripts/check_rendered_pod_security.py"
)
pod_security = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pod_security)

BASELINE_POD = {
    "automountServiceAccountToken": False,
    "securityContext": {
        "runAsNonRoot": True,
        "runAsUser": 1000,
        "seccompProfile": {"type": "RuntimeDefault"},
    },
    "initContainers": [
        {
            "name": "init",
            "securityContext": {
                "allowPrivilegeEscalation": False,
                "readOnlyRootFilesystem": True,
                "capabilities": {"drop": ["ALL"]},
            },
        }
    ],
    "containers": [
        {
            "name": "app",
            "securityContext": {
                "allowPrivilegeEscalation": False,
                "readOnlyRootFilesystem": True,
                "capabilities": {"drop": ["ALL"]},
            },
        }
    ],
    "volumes": [{"name": "tmp", "emptyDir": {}}],
}


def workload(kind="Deployment", pod=None):
    pod = copy.deepcopy(BASELINE_POD if pod is None else pod)
    template = {"template": {"spec": pod}}
    spec = {"jobTemplate": {"spec": template}} if kind == "CronJob" else template
    return {"kind": kind, "metadata": {"name": "fixture"}, "spec": spec}


def failures(tmp_path, *documents):
    manifest = tmp_path / "rendered.yaml"
    manifest.write_text(yaml.safe_dump_all(documents))
    return pod_security.check_manifest(manifest)


def test_baseline_workloads_pass(tmp_path):
    assert failures(tmp_path, workload(), workload("CronJob")) == []


def test_manifest_without_workloads_fails(tmp_path):
    assert failures(tmp_path, {"kind": "Service", "metadata": {"name": "x"}})


def weakened(change):
    pod = copy.deepcopy(BASELINE_POD)
    change(pod, pod["containers"][0]["securityContext"])
    return pod


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda pod, c: c.update(runAsNonRoot=False), "runAsNonRoot must not override"),
        (lambda pod, c: c.update(runAsUser=0), "runAsUser must not be 0"),
        (
            lambda pod, c: pod["securityContext"].update(runAsUser=0),
            "pod runAsUser must not be 0",
        ),
        (lambda pod, c: c.update(privileged=True), "privileged must not be true"),
        (
            lambda pod, c: c["capabilities"].update(add=["NET_ADMIN"]),
            "capabilities.add must be empty",
        ),
        (
            lambda pod, c: c.update(seccompProfile={"type": "Unconfined"}),
            "seccompProfile must not weaken",
        ),
        (lambda pod, c: pod.update(hostNetwork=True), "hostNetwork"),
        (lambda pod, c: pod.update(hostPID=True), "hostPID"),
        (lambda pod, c: pod.update(hostIPC=True), "hostIPC"),
        (
            lambda pod, c: pod["volumes"].append(
                {"name": "node", "hostPath": {"path": "/"}}
            ),
            "must not use hostPath",
        ),
        (
            lambda pod, c: c.update(allowPrivilegeEscalation=True),
            "allowPrivilegeEscalation must be false",
        ),
        (
            lambda pod, c: c.update(readOnlyRootFilesystem=False),
            "readOnlyRootFilesystem must be true",
        ),
        (lambda pod, c: c["capabilities"].update(drop=[]), "drop must include ALL"),
        (
            lambda pod, c: pod.update(automountServiceAccountToken=True),
            "automountServiceAccountToken",
        ),
    ],
)
@pytest.mark.parametrize("kind", ["Deployment", "CronJob"])
def test_each_weakening_is_rejected(tmp_path, kind, change, message):
    found = failures(tmp_path, workload(kind, weakened(change)))
    assert any(message in failure for failure in found), found


@pytest.mark.parametrize("kind", ["Deployment", "CronJob"])
def test_init_container_weakening_is_rejected(tmp_path, kind):
    pod = copy.deepcopy(BASELINE_POD)
    pod["initContainers"][0]["securityContext"]["privileged"] = True
    found = failures(tmp_path, workload(kind, pod))
    assert len(found) == 1, found
    assert found[0].endswith(f"{kind}/fixture:init: privileged must not be true")


@pytest.mark.requires_helm
@pytest.mark.parametrize(
    "values",
    [
        [],
        ["-f", "custom-values.yaml"],
        [
            "--set",
            "redis.tls.enabled=true,redis.tls.existingSecret=redis-tls",
            "--set",
            "nginx.https.enabled=true,nginx.https.tlsSecretName=fixture-tls",
            "--set",
            "nginx.imageVolume.enabled=true,backend.skills.enabled=true",
            "--set",
            "documentObjectStorage.enabled=true,documentObjectStorage.auth.existingSecret=docs",
            "--set",
            "documentObjectStorage.endpoint=http://objects.daedalus.svc:9000",
            "--set",
            "contentCredentials.mode=local,contentCredentials.existingSecret=c2pa",
        ],
    ],
)
def test_rendered_chart_meets_the_baseline(tmp_path, values):
    rendered = subprocess.run(
        ["helm", "template", "fixture", "helm/daedalus", *values],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    manifest = tmp_path / "rendered.yaml"
    manifest.write_text(rendered)
    assert pod_security.check_manifest(manifest) == []
