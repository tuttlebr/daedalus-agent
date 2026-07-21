#!/usr/bin/env python3
"""Mirror authoritative RAG credentials into namespace-local workload Secrets."""

from __future__ import annotations

import argparse
import base64
import json

# subprocess is used only with fixed kubectl argument lists and shell=False.
import subprocess  # nosec B404
import sys


class SyncError(RuntimeError):
    """A safe-to-display Secret synchronization failure."""


def _kubectl_json(namespace: str, name: str) -> dict:
    command = ["kubectl", "-n", namespace, "get", "secret", name, "-o", "json"]
    # The argument positions are fixed and subprocess does not invoke a shell.
    completed = subprocess.run(  # nosec B603
        command, text=True, capture_output=True, timeout=30, check=False
    )
    if completed.returncode != 0:
        raise SyncError(f"cannot read source Secret {namespace}/{name}")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise SyncError(
            f"source Secret {namespace}/{name} returned invalid JSON"
        ) from exc


def _required_data(secret: dict, namespace: str, name: str, key: str) -> str:
    encoded = str(secret.get("data", {}).get(key, "")).strip()
    if not encoded:
        raise SyncError(
            f"source Secret {namespace}/{name} is missing non-empty key {key}"
        )
    try:
        if not base64.b64decode(encoded, validate=True):
            raise ValueError
    except (ValueError, base64.binascii.Error) as exc:
        raise SyncError(
            f"source Secret {namespace}/{name} has invalid key {key}"
        ) from exc
    return encoded


def target_manifests(args: argparse.Namespace, milvus: dict, minio: dict) -> list[dict]:
    if (args.source_milvus_namespace, args.source_milvus_secret) == (
        args.target_namespace,
        args.target_milvus_secret,
    ) or (args.source_minio_namespace, args.source_minio_secret) in {
        (args.target_namespace, args.target_minio_secret),
        (args.target_namespace, args.target_document_secret),
    }:
        raise SyncError(
            "a target Secret must not overwrite an authoritative source Secret"
        )

    password = _required_data(
        milvus,
        args.source_milvus_namespace,
        args.source_milvus_secret,
        args.source_milvus_password_key,
    )
    access_key = _required_data(
        minio,
        args.source_minio_namespace,
        args.source_minio_secret,
        args.source_minio_access_key,
    )
    secret_key = _required_data(
        minio,
        args.source_minio_namespace,
        args.source_minio_secret,
        args.source_minio_secret_key,
    )
    username = base64.b64encode(args.milvus_username.encode()).decode()

    def manifest(name: str, data: dict[str, str]) -> dict:
        return {
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {
                "name": name,
                "namespace": args.target_namespace,
                "labels": {"app.kubernetes.io/managed-by": "daedalus-deploy"},
            },
            "type": "Opaque",
            "data": data,
        }

    return [
        manifest(
            args.target_milvus_secret,
            {"MILVUS_USERNAME": username, "MILVUS_PASSWORD": password},
        ),
        manifest(
            args.target_minio_secret,
            {"MINIO_ACCESS_KEY": access_key, "MINIO_SECRET_KEY": secret_key},
        ),
        manifest(
            args.target_document_secret,
            {
                "DOCUMENT_OBJECT_ACCESS_KEY": access_key,
                "DOCUMENT_OBJECT_SECRET_KEY": secret_key,
            },
        ),
    ]


def sync(args: argparse.Namespace) -> None:
    manifests = target_manifests(
        args,
        _kubectl_json(args.source_milvus_namespace, args.source_milvus_secret),
        _kubectl_json(args.source_minio_namespace, args.source_minio_secret),
    )
    for manifest in manifests:
        # kubectl is intentionally PATH-resolved; argv is fixed and shell=False.
        completed = subprocess.run(  # nosec B603, B607
            ["kubectl", "apply", "-f", "-"],
            input=json.dumps(manifest),
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        if completed.returncode != 0:
            name = manifest["metadata"]["name"]
            raise SyncError(
                f"cannot apply target Secret {args.target_namespace}/{name}"
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-milvus-namespace", default="milvus")
    parser.add_argument("--source-milvus-secret", default="milvus-root-credentials")
    parser.add_argument("--source-milvus-password-key", default="password")
    parser.add_argument("--milvus-username", default="root")
    parser.add_argument("--source-minio-namespace", default="milvus")
    parser.add_argument("--source-minio-secret", default="milvus-minio-credentials")
    parser.add_argument("--source-minio-access-key", default="accesskey")
    parser.add_argument("--source-minio-secret-key", default="secretkey")
    parser.add_argument("--target-namespace", required=True)
    parser.add_argument("--target-milvus-secret", required=True)
    parser.add_argument("--target-minio-secret", required=True)
    parser.add_argument("--target-document-secret", required=True)
    return parser.parse_args()


def main() -> int:
    try:
        sync(parse_args())
    except (SyncError, subprocess.TimeoutExpired) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
