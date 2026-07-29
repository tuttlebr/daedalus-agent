#!/usr/bin/env python3
"""Run authenticated Milvus and retrieval-endpoint rollout preflights."""

from __future__ import annotations

import argparse
import json
import re

# subprocess is used only with a fixed kubectl argv and shell=False.
import subprocess  # nosec B404
import sys
import uuid
from dataclasses import dataclass


class CheckError(RuntimeError):
    """A safe-to-display preflight failure."""


@dataclass(frozen=True)
class SecretReference:
    name: str
    key: str


@dataclass(frozen=True)
class RagConfig:
    uri: str
    database: str
    username: SecretReference | None
    password: SecretReference | None
    token: SecretReference | None
    env_from_secret: str | None
    labels: dict[str, str]


def _scalar(raw: str) -> str:
    value = raw.strip()
    if value.startswith('"'):
        return str(json.loads(value))
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    return value.split(" #", 1)[0].strip()


def _backend_document(manifest: str) -> str | None:
    for document in re.split(r"^---\s*$", manifest, flags=re.MULTILINE):
        if re.search(r"^kind:\s*Deployment\s*$", document, re.MULTILINE) and re.search(
            r"^\s+app\.kubernetes\.io/component:\s*[\"']?backend-default[\"']?\s*$",
            document,
            re.MULTILINE,
        ):
            return document
    return None


def _env_blocks(document: str) -> dict[str, list[str]]:
    wanted = {
        "MILVUS_URI",
        "MILVUS_DATABASE",
        "MILVUS_USERNAME",
        "MILVUS_PASSWORD",
        "MILVUS_TOKEN",
    }
    lines = document.splitlines()
    blocks: dict[str, list[str]] = {}
    for index, line in enumerate(lines):
        match = re.match(r"^(\s*)- name:\s*([A-Z0-9_]+)\s*$", line)
        if not match or match.group(2) not in wanted:
            continue
        indent = len(match.group(1))
        block = []
        for nested in lines[index + 1 :]:
            if re.match(rf"^\s{{{indent}}}- name:", nested):
                break
            block.append(nested)
        blocks[match.group(2)] = block
    return blocks


def _env_from_secret(document: str) -> str | None:
    match = re.search(
        r"^\s+envFrom:\s*$\n" r"\s+- secretRef:\s*$\n" r"\s+name:\s*(.+?)\s*$",
        document,
        re.MULTILINE,
    )
    return _scalar(match.group(1)) if match else None


def _value(block: list[str], name: str) -> str:
    for line in block:
        match = re.match(r"^\s+value:\s*(.*?)\s*$", line)
        if match:
            return _scalar(match.group(1))
    raise CheckError(f"backend deployment is missing a value for {name}")


def _secret(block: list[str], name: str) -> SecretReference:
    in_ref = False
    secret_name: str | None = None
    key: str | None = None
    for line in block:
        stripped = line.strip()
        if stripped == "secretKeyRef:":
            in_ref = True
        elif in_ref and stripped.startswith("name:") and not secret_name:
            secret_name = _scalar(stripped.split(":", 1)[1])
        elif in_ref and stripped.startswith("key:") and not key:
            key = _scalar(stripped.split(":", 1)[1])
    if not secret_name or not key:
        raise CheckError(
            f"backend deployment has an invalid Secret reference for {name}"
        )
    return SecretReference(secret_name, key)


def config_from_manifest(manifest: str) -> RagConfig | None:
    document = _backend_document(manifest)
    if document is None:
        raise CheckError("rendered backend Deployment was not found")
    blocks = _env_blocks(document)
    if "MILVUS_URI" not in blocks:
        return None
    token = (
        _secret(blocks["MILVUS_TOKEN"], "MILVUS_TOKEN")
        if "MILVUS_TOKEN" in blocks
        else None
    )
    username = (
        _secret(blocks["MILVUS_USERNAME"], "MILVUS_USERNAME")
        if "MILVUS_USERNAME" in blocks
        else None
    )
    password = (
        _secret(blocks["MILVUS_PASSWORD"], "MILVUS_PASSWORD")
        if "MILVUS_PASSWORD" in blocks
        else None
    )
    if token is None and (username is None or password is None):
        raise CheckError(
            "rendered Milvus configuration has no complete authentication Secret"
        )
    labels = {}
    for label in (
        "app.kubernetes.io/name",
        "app.kubernetes.io/component",
        "app.kubernetes.io/instance",
    ):
        match = re.search(
            rf"^\s+{re.escape(label)}:\s*(.+?)\s*$", document, re.MULTILINE
        )
        if not match:
            raise CheckError(f"backend deployment is missing label {label}")
        labels[label] = _scalar(match.group(1))
    return RagConfig(
        uri=_value(blocks["MILVUS_URI"], "MILVUS_URI"),
        database=_value(blocks["MILVUS_DATABASE"], "MILVUS_DATABASE"),
        username=username,
        password=password,
        token=token,
        env_from_secret=_env_from_secret(document),
        labels=labels,
    )


def _secret_env(name: str, ref: SecretReference) -> dict:
    return {
        "name": name,
        "valueFrom": {"secretKeyRef": {"name": ref.name, "key": ref.key}},
    }


def probe_command(
    config: RagConfig, namespace: str, image: str, timeout: int
) -> list[str]:
    pod_name = f"rag-preflight-{uuid.uuid4().hex[:8]}"
    environment = [
        {"name": "MILVUS_URI", "value": config.uri},
        {"name": "MILVUS_DATABASE", "value": config.database},
    ]
    for name, ref in (
        ("MILVUS_TOKEN", config.token),
        ("MILVUS_USERNAME", config.username),
        ("MILVUS_PASSWORD", config.password),
    ):
        if ref is not None:
            environment.append(_secret_env(name, ref))
    code = """
import contextlib, os, socket, sys
from pymilvus import MilvusClient
from urllib.parse import urlsplit

def probe_tcp_url(name):
    raw = os.getenv(name, "").strip()
    if not raw:
        print(f"{name} is missing from the backend environment", file=sys.stderr)
        raise SystemExit(21)
    parsed = urlsplit(raw)
    if not parsed.hostname:
        print(f"{name} is not a valid URL", file=sys.stderr)
        raise SystemExit(21)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        with socket.create_connection((parsed.hostname, port), timeout=float(sys.argv[1])):
            pass
    except Exception as exc:
        print(f"{name} endpoint preflight failed: {type(exc).__name__}", file=sys.stderr)
        raise SystemExit(21)
    print(f"{name} endpoint reachable at {parsed.hostname}:{port}")

kwargs = {"uri": os.environ["MILVUS_URI"]}
token = os.getenv("MILVUS_TOKEN", "").strip()
if token:
    kwargs["token"] = token
else:
    kwargs["user"] = os.environ["MILVUS_USERNAME"]
    kwargs["password"] = os.environ["MILVUS_PASSWORD"]
database = os.getenv("MILVUS_DATABASE", "default").strip()
if database and database != "default":
    kwargs["db_name"] = database
client = None
try:
    client = MilvusClient(**kwargs)
    collections = client.list_collections(timeout=float(sys.argv[1]))
    probe_name = collections[0] if collections else "__daedalus_rag_readiness__"
    client.has_collection(probe_name, timeout=float(sys.argv[1]))
    print(f"Milvus authenticated for list/describe; collections={len(collections)}")
except Exception as exc:
    print(f"Milvus preflight failed: {type(exc).__name__}", file=sys.stderr)
    raise SystemExit(20)
finally:
    if client is not None:
        with contextlib.suppress(Exception):
            client.close()

for dependency in ("EMBEDDING_BASE_URL", "RERANKER_BASE_URL"):
    probe_tcp_url(dependency)
"""
    container = {
        "name": pod_name,
        "env": environment,
        "securityContext": {
            "allowPrivilegeEscalation": False,
            "capabilities": {"drop": ["ALL"]},
            "runAsNonRoot": True,
            "runAsUser": 1000,
            "seccompProfile": {"type": "RuntimeDefault"},
        },
    }
    if config.env_from_secret:
        container["envFrom"] = [{"secretRef": {"name": config.env_from_secret}}]
    overrides = {
        "metadata": {"labels": config.labels},
        "spec": {
            "automountServiceAccountToken": False,
            "containers": [container],
            "restartPolicy": "Never",
        },
    }
    return [
        "kubectl",
        "-n",
        namespace,
        "run",
        pod_name,
        "--rm",
        "-i",
        "--quiet",
        "--restart=Never",
        "--image",
        image,
        "--overrides",
        json.dumps(overrides, separators=(",", ":")),
        "--override-type=strategic",
        "--command",
        "--",
        "python",
        "-c",
        code,
        str(timeout),
    ]


def check(config: RagConfig, namespace: str, image: str, timeout: int) -> None:
    # probe_command returns a fixed kubectl argv; subprocess does not invoke a shell.
    completed = subprocess.run(  # nosec B603
        probe_command(config, namespace, image, timeout),
        text=True,
        capture_output=True,
        timeout=max(timeout * 3 + 90, 120),
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()[:800]
        raise CheckError(f"RAG dependency probe failed: {detail or 'unknown error'}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default="-")
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--timeout", type=int, default=20)
    args = parser.parse_args()
    try:
        manifest = (
            sys.stdin.read()
            if args.manifest == "-"
            else open(args.manifest, encoding="utf-8").read()
        )
        config = config_from_manifest(manifest)
        if config is not None:
            check(config, args.namespace, args.image, args.timeout)
    except (CheckError, OSError, subprocess.TimeoutExpired) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
