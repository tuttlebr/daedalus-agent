"""Tests for the document-object storage deployment preflight."""

import importlib.util
import json
import sys
import types
from pathlib import Path

SCRIPT = (
    Path(__file__).resolve().parents[2] / "scripts" / "check_document_object_storage.py"
)
DEPLOY = Path(__file__).resolve().parents[2] / "deploy.sh"
SPEC = importlib.util.spec_from_file_location("check_document_object_storage", SCRIPT)
check_storage = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = check_storage
SPEC.loader.exec_module(check_storage)


def rendered_frontend(document_storage: bool = True) -> str:
    document_env = ""
    if document_storage:
        document_env = """
        - name: DOCUMENT_OBJECT_ENDPOINT
          value: "http://milvus-minio.milvus.svc.cluster.local:9000"
        - name: DOCUMENT_OBJECT_BUCKET
          value: "nv-ingest"
        - name: DOCUMENT_OBJECT_REGION
          value: "us-east-1"
        - name: DOCUMENT_OBJECT_PREFIX
          value: "daedalus-documents"
        - name: DOCUMENT_OBJECT_ACCESS_KEY
          valueFrom:
            secretKeyRef:
              name: daedalus-document-objects
              key: DOCUMENT_OBJECT_ACCESS_KEY
        - name: DOCUMENT_OBJECT_SECRET_KEY
          valueFrom:
            secretKeyRef:
              name: daedalus-document-objects
              key: DOCUMENT_OBJECT_SECRET_KEY
        - name: DOCUMENT_OBJECT_SESSION_TOKEN
          valueFrom:
            secretKeyRef:
              name: daedalus-document-objects
              key: DOCUMENT_OBJECT_SESSION_TOKEN
              optional: true
"""
    return f"""
apiVersion: apps/v1
kind: Deployment
metadata:
  name: daedalus-frontend
  labels:
    app.kubernetes.io/name: daedalus
    app.kubernetes.io/component: frontend
    app.kubernetes.io/instance: daedalus
spec:
  template:
    spec:
      containers:
      - name: frontend
        env:
{document_env}
"""


def test_extracts_values_secret_refs_and_network_policy_labels():
    config = check_storage.config_from_manifest(rendered_frontend())

    assert config is not None
    assert config.endpoint == "http://milvus-minio.milvus.svc.cluster.local:9000"
    assert config.bucket == "nv-ingest"
    assert config.region == "us-east-1"
    assert config.prefix == "daedalus-documents"
    assert config.access_key == check_storage.SecretReference(
        "daedalus-document-objects", "DOCUMENT_OBJECT_ACCESS_KEY"
    )
    assert config.session_token == check_storage.SecretReference(
        "daedalus-document-objects", "DOCUMENT_OBJECT_SESSION_TOKEN", True
    )
    assert config.pod_labels["app.kubernetes.io/component"] == "frontend"


def test_disabled_storage_skips_manifest_config():
    assert check_storage.config_from_manifest(rendered_frontend(False)) is None


def test_probe_uses_secret_refs_without_putting_credentials_in_argv(monkeypatch):
    config = check_storage.config_from_manifest(rendered_frontend())
    assert config is not None
    captured = {}

    def fake_run(command, **_kwargs):
        captured["command"] = command
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(check_storage.subprocess, "run", fake_run)

    check_storage.check_with_kubectl(
        config,
        "daedalus",
        "curlimages/curl:8.8.0@sha256:test",
        20,
    )

    command = captured["command"]
    rendered = " ".join(command)
    overrides = json.loads(command[command.index("--overrides") + 1])
    environment = overrides["spec"]["containers"][0]["env"]
    assert "DOCUMENT_OBJECT_SECRET_KEY" in rendered
    assert "actual-secret-value" not in rendered
    assert environment[0]["valueFrom"]["secretKeyRef"] == {
        "name": "daedalus-document-objects",
        "key": "DOCUMENT_OBJECT_ACCESS_KEY",
        "optional": False,
    }
    assert overrides["metadata"]["labels"] == config.pod_labels
    assert overrides["spec"]["automountServiceAccountToken"] is False
    assert overrides["spec"]["affinity"] == check_storage.PREFLIGHT_AFFINITY
    security_context = overrides["spec"]["containers"][0]["securityContext"]
    assert security_context["runAsNonRoot"] is True
    assert security_context["runAsUser"] == 100
    assert security_context["runAsGroup"] == 101


def test_deploy_runs_document_storage_preflight_before_helm():
    deploy = DEPLOY.read_text(encoding="utf-8")

    assert "scripts/check_document_object_storage.py" in deploy
    assert deploy.index("Checking document object storage access") < deploy.index(
        "Deploying Daedalus via Helm"
    )
