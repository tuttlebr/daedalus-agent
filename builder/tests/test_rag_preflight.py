"""Tests for the authenticated Milvus rollout preflight."""

import importlib.util
import json
import sys
from pathlib import Path

import yaml

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check_rag_backend.py"
DEPLOY = Path(__file__).resolve().parents[2] / "deploy.sh"
ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("check_rag_backend", SCRIPT)
check_rag = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = check_rag
SPEC.loader.exec_module(check_rag)


MANIFEST = """
apiVersion: apps/v1
kind: Deployment
metadata:
  name: daedalus-backend-default
  labels:
    app.kubernetes.io/name: daedalus
    app.kubernetes.io/component: backend-default
    app.kubernetes.io/instance: daedalus
spec:
  template:
    spec:
      containers:
        - name: backend
          envFrom:
            - secretRef:
                name: daedalus-backend-env
          env:
            - name: MILVUS_URI
              value: "http://milvus.daedalus.svc.cluster.local:19530"
            - name: MILVUS_DATABASE
              value: "default"
            - name: MILVUS_USERNAME
              valueFrom:
                secretKeyRef:
                  name: daedalus-milvus-auth
                  key: MILVUS_USERNAME
            - name: MILVUS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: daedalus-milvus-auth
                  key: MILVUS_PASSWORD
"""


def test_extracts_endpoint_and_secret_references():
    config = check_rag.config_from_manifest(MANIFEST)

    assert config is not None
    assert config.uri == "http://milvus.daedalus.svc.cluster.local:19530"
    assert config.username == check_rag.SecretReference(
        "daedalus-milvus-auth", "MILVUS_USERNAME"
    )
    assert config.password == check_rag.SecretReference(
        "daedalus-milvus-auth", "MILVUS_PASSWORD"
    )
    assert config.env_from_secret == "daedalus-backend-env"


def test_probe_uses_secret_refs_and_backend_policy_labels():
    config = check_rag.config_from_manifest(MANIFEST)
    assert config is not None
    command = check_rag.probe_command(config, "daedalus", "backend@sha256:test", 10)
    overrides = json.loads(command[command.index("--overrides") + 1])
    env = overrides["spec"]["containers"][0]["env"]
    assert overrides["spec"]["containers"][0]["envFrom"] == [
        {"secretRef": {"name": "daedalus-backend-env"}}
    ]

    assert env[2]["valueFrom"]["secretKeyRef"] == {
        "name": "daedalus-milvus-auth",
        "key": "MILVUS_USERNAME",
    }
    assert (
        overrides["metadata"]["labels"]["app.kubernetes.io/component"]
        == "backend-default"
    )
    assert overrides["spec"]["automountServiceAccountToken"] is False
    assert overrides["spec"]["affinity"] == check_rag.PREFLIGHT_AFFINITY
    code = command[command.index("-c") + 1]
    assert '("EMBEDDING_BASE_URL", "RERANKER_BASE_URL")' in code


def test_deploy_runs_rag_preflight_before_helm():
    deploy = DEPLOY.read_text(encoding="utf-8")
    assert "scripts/check_rag_backend.py" in deploy
    assert deploy.index(
        "Checking authenticated Milvus and retrieval endpoint access"
    ) < deploy.index("Deploying Daedalus via Helm")


def test_chart_contract_matches_daedalus_context_services_and_secret_keys():
    values = yaml.safe_load(
        (ROOT / "helm/daedalus/values.yaml").read_text(encoding="utf-8")
    )["retrieval"]
    custom = yaml.safe_load((ROOT / "custom-values.yaml").read_text(encoding="utf-8"))[
        "retrieval"
    ]
    deployment = (
        ROOT / "helm/daedalus/templates/backend-default-deployment.yaml"
    ).read_text(encoding="utf-8")

    assert (
        values["milvus"]["endpoint"] == "http://milvus.daedalus.svc.cluster.local:19530"
    )
    frontend_deployment = (
        ROOT / "helm/daedalus/templates/frontend-deployment.yaml"
    ).read_text(encoding="utf-8")
    backend_config = yaml.safe_load(
        (ROOT / "backend/tool-calling-config.yaml").read_text(encoding="utf-8")
    )
    assert (
        values["minio"]["endpoint"]
        == "http://milvus-minio.daedalus.svc.cluster.local:9000"
    )
    assert values["milvus"]["networkPolicy"] == {"namespace": "daedalus", "port": 19530}
    assert values["minio"]["networkPolicy"] == {"namespace": "daedalus", "port": 9000}
    assert custom["milvus"]["auth"]["existingSecret"] == "daedalus-milvus-auth"
    assert custom["minio"]["auth"]["existingSecret"] == "daedalus-minio-auth"
    retriever_egress = next(
        entry
        for entry in yaml.safe_load(
            (ROOT / "custom-values.yaml").read_text(encoding="utf-8")
        )["backend"]["networkPolicy"]["extraEgressNamespaces"]
        if entry["name"] == "daedalus"
    )
    assert retriever_egress["ports"] == [
        {"port": 8080, "protocol": "TCP"},
        {"port": 4000, "protocol": "TCP"},
    ]
    assert "MILVUS_SEARCH_TIMEOUT_SECONDS" in deployment
    assert backend_config["functions"]["domain_retriever_tool"]["search_timeout"] == (
        "${MILVUS_SEARCH_TIMEOUT_SECONDS}"
    )
    assert "secretKeyRef:" in deployment
    assert "path: /health" in deployment
    for key in (
        "milvus-secret-resource-version",
        "minio-secret-resource-version",
        "document-object-secret-resource-version",
    ):
        assert key in deployment
    assert "document-object-secret-resource-version" in frontend_deployment


def test_deploy_reads_secret_resource_versions_after_sync_and_passes_only_metadata():
    deploy = DEPLOY.read_text(encoding="utf-8")

    sync_call = deploy.index('python3 "$SCRIPT_DIR/scripts/sync_rag_secrets.py"')
    first_version_read = deploy.index(
        'RAG_MILVUS_SECRET_RESOURCE_VERSION="$(secret_resource_version',
        sync_call,
    )
    assert sync_call < first_version_read
    assert "-o jsonpath='{.metadata.resourceVersion}'" in deploy
    assert "retrieval.secretResourceVersions.milvus=" in deploy
    assert "retrieval.secretResourceVersions.minio=" in deploy
    assert "retrieval.secretResourceVersions.documentObject=" in deploy
