"""Tests for namespace-local RAG Secret mirroring."""

import argparse
import base64
import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "sync_rag_secrets.py"
SPEC = importlib.util.spec_from_file_location("sync_rag_secrets", SCRIPT)
sync_rag = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = sync_rag
SPEC.loader.exec_module(sync_rag)


def args(**overrides):
    values = {
        "source_milvus_namespace": "milvus",
        "source_milvus_secret": "milvus-root-credentials",
        "source_milvus_password_key": "password",
        "milvus_username": "root",
        "source_minio_namespace": "milvus",
        "source_minio_secret": "milvus-minio-credentials",
        "source_minio_access_key": "accesskey",
        "source_minio_secret_key": "secretkey",
        "target_namespace": "daedalus",
        "target_milvus_secret": "daedalus-milvus-auth",
        "target_minio_secret": "daedalus-minio-auth",
        "target_document_secret": "daedalus-document-objects",
    }
    values.update(overrides)
    return argparse.Namespace(**values)


def encoded(value: str) -> str:
    return base64.b64encode(value.encode()).decode()


def test_maps_authoritative_keys_without_decoding_secret_values():
    manifests = sync_rag.target_manifests(
        args(),
        {"data": {"password": encoded("milvus-secret")}},
        {"data": {"accesskey": encoded("access"), "secretkey": encoded("secret")}},
    )

    by_name = {item["metadata"]["name"]: item for item in manifests}
    assert by_name["daedalus-milvus-auth"]["data"] == {
        "MILVUS_USERNAME": encoded("root"),
        "MILVUS_PASSWORD": encoded("milvus-secret"),
    }
    assert by_name["daedalus-minio-auth"]["data"] == {
        "MINIO_ACCESS_KEY": encoded("access"),
        "MINIO_SECRET_KEY": encoded("secret"),
    }
    assert by_name["daedalus-document-objects"]["data"] == {
        "DOCUMENT_OBJECT_ACCESS_KEY": encoded("access"),
        "DOCUMENT_OBJECT_SECRET_KEY": encoded("secret"),
    }


def test_rejects_missing_or_empty_source_key():
    with pytest.raises(sync_rag.SyncError, match="missing non-empty key password"):
        sync_rag.target_manifests(
            args(),
            {"data": {}},
            {"data": {"accesskey": encoded("access"), "secretkey": encoded("secret")}},
        )


def test_rejects_target_that_would_overwrite_source():
    with pytest.raises(sync_rag.SyncError, match="must not overwrite"):
        sync_rag.target_manifests(
            args(
                target_namespace="milvus",
                target_milvus_secret="milvus-root-credentials",
            ),
            {"data": {"password": encoded("milvus-secret")}},
            {"data": {"accesskey": encoded("access"), "secretkey": encoded("secret")}},
        )


@pytest.mark.parametrize(
    "source", ["milvus-root-credentials", "milvus-minio-credentials"]
)
@pytest.mark.parametrize(
    "target", ["target_milvus_secret", "target_minio_secret", "target_document_secret"]
)
def test_no_destination_can_alias_either_authoritative_source(
    source, target, monkeypatch
):
    sources = {
        "milvus-root-credentials": {"data": {"password": encoded("milvus-secret")}},
        "milvus-minio-credentials": {
            "data": {"accesskey": encoded("access"), "secretkey": encoded("secret")}
        },
    }
    monkeypatch.setattr(
        sync_rag, "_kubectl_json", lambda namespace, name: sources[name]
    )
    applied = []
    monkeypatch.setattr(
        sync_rag.subprocess,
        "run",
        lambda *a, **kw: applied.append(kw) or argparse.Namespace(returncode=0),
    )
    with pytest.raises(sync_rag.SyncError, match="must not overwrite"):
        sync_rag.sync(args(target_namespace="milvus", **{target: source}))
    assert applied == []


@pytest.mark.parametrize(
    "first,second",
    [
        ("target_milvus_secret", "target_minio_secret"),
        ("target_milvus_secret", "target_document_secret"),
        ("target_minio_secret", "target_document_secret"),
    ],
)
def test_rejects_destinations_that_would_replace_each_other(first, second):
    with pytest.raises(sync_rag.SyncError, match="distinct"):
        sync_rag.target_manifests(
            args(**{first: "same-secret", second: "same-secret"}),
            {"data": {"password": encoded("milvus-secret")}},
            {"data": {"accesskey": encoded("access"), "secretkey": encoded("secret")}},
        )
