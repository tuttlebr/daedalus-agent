"""Rendered workloads may require only Secrets the chart or deploy path documents."""

import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.requires_helm
WORKLOAD_KINDS = {"CronJob", "DaemonSet", "Deployment", "Job", "StatefulSet"}


def render(*args):
    output = subprocess.run(
        ["helm", "template", "fixture", "helm/daedalus", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return [document for document in yaml.safe_load_all(output) if document]


def secret_references(node):
    if isinstance(node, dict):
        for field in ("secretKeyRef", "secretRef"):
            if field in node:
                yield node[field]["name"], bool(node[field].get("optional"))
        secret = node.get("secret")
        if isinstance(secret, dict) and "secretName" in secret:
            yield secret["secretName"], bool(secret.get("optional"))
        for value in node.values():
            yield from secret_references(value)
    elif isinstance(node, list):
        for value in node:
            yield from secret_references(value)


def required_external_secrets(documents):
    created = {d["metadata"]["name"] for d in documents if d["kind"] == "Secret"}
    return {
        name
        for document in documents
        if document["kind"] in WORKLOAD_KINDS
        for name, optional in secret_references(document)
        if name not in created and not optional
    }


def test_default_chart_requires_only_documented_operator_secrets():
    # helm/daedalus/README.md documents the backend env Secret and the
    # release-local Milvus/MinIO Secrets. Externally provisioned exploration
    # grants must not block workloads that do not configure that tool.
    assert required_external_secrets(render()) == {
        "fixture-daedalus-backend-env",
        "fixture-milvus-auth",
        "fixture-minio-auth",
    }


def test_exploration_grant_is_injected_but_optional():
    documents = render()
    backend = next(
        d
        for d in documents
        if d["kind"] == "Deployment"
        and d["metadata"]["name"] == "fixture-daedalus-backend-default"
    )
    env = backend["spec"]["template"]["spec"]["containers"][0]["env"]
    grant = next(item for item in env if item["name"] == "EXPLORATION_GRANT_KEY")
    assert grant["valueFrom"]["secretKeyRef"] == {
        "name": "exploration-grants",
        "key": "key",
        "optional": True,
    }
    disabled = render("--set", "exploration.enabled=false")
    assert "EXPLORATION_GRANT_KEY" not in yaml.safe_dump_all(disabled)
