#!/usr/bin/env python3
"""Validate rendered document-object storage with a short-lived S3 probe."""

from __future__ import annotations

import argparse
import json
import re
import shlex
import subprocess  # nosec B404 - invokes kubectl with a fixed argv
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path

DOCUMENT_ENV_NAMES = {
    "DOCUMENT_OBJECT_ACCESS_KEY",
    "DOCUMENT_OBJECT_BUCKET",
    "DOCUMENT_OBJECT_ENDPOINT",
    "DOCUMENT_OBJECT_PREFIX",
    "DOCUMENT_OBJECT_REGION",
    "DOCUMENT_OBJECT_SECRET_KEY",
    "DOCUMENT_OBJECT_SESSION_TOKEN",
}
REQUIRED_VALUE_NAMES = {
    "DOCUMENT_OBJECT_BUCKET",
    "DOCUMENT_OBJECT_ENDPOINT",
    "DOCUMENT_OBJECT_PREFIX",
    "DOCUMENT_OBJECT_REGION",
}
REQUIRED_SECRET_NAMES = {
    "DOCUMENT_OBJECT_ACCESS_KEY",
    "DOCUMENT_OBJECT_SECRET_KEY",
}
SAFE_LABEL = re.compile(r"^[A-Za-z0-9._-]+$")
PREFLIGHT_AFFINITY = {
    "nodeAffinity": {
        "requiredDuringSchedulingIgnoredDuringExecution": {
            "nodeSelectorTerms": [
                {
                    "matchExpressions": [
                        {
                            "key": "kubernetes.io/hostname",
                            "operator": "NotIn",
                            "values": ["daedalus-06"],
                        }
                    ]
                }
            ]
        }
    }
}


class CheckError(RuntimeError):
    """Safe configuration or probe failure."""


@dataclass(frozen=True)
class SecretReference:
    name: str
    key: str
    optional: bool = False


@dataclass(frozen=True)
class DocumentStorageConfig:
    endpoint: str
    bucket: str
    region: str
    prefix: str
    access_key: SecretReference
    secret_key: SecretReference
    session_token: SecretReference | None
    pod_labels: dict[str, str]


def _yaml_scalar(raw: str) -> str:
    value = raw.strip()
    if not value:
        return ""
    if value.startswith('"'):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as exc:
            raise CheckError(f"invalid rendered YAML scalar: {value}") from exc
        return str(parsed)
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    return value.split(" #", 1)[0].strip()


def _frontend_deployment(manifest: str) -> str | None:
    for document in re.split(r"^---\s*$", manifest, flags=re.MULTILINE):
        if not re.search(r"^kind:\s*Deployment\s*$", document, re.MULTILINE):
            continue
        if re.search(
            r"^\s+app\.kubernetes\.io/component:\s*[\"']?frontend[\"']?\s*$",
            document,
            re.MULTILINE,
        ):
            return document
    return None


def _pod_labels(document: str) -> dict[str, str]:
    labels: dict[str, str] = {}
    for name in (
        "app.kubernetes.io/name",
        "app.kubernetes.io/component",
        "app.kubernetes.io/instance",
    ):
        match = re.search(
            rf"^\s+{re.escape(name)}:\s*(.+?)\s*$", document, re.MULTILINE
        )
        if not match:
            raise CheckError(f"frontend deployment is missing label {name}")
        value = _yaml_scalar(match.group(1))
        if not SAFE_LABEL.fullmatch(value):
            raise CheckError(f"frontend deployment label {name} is invalid")
        labels[name] = value
    return labels


def _env_blocks(document: str) -> dict[str, list[str]]:
    lines = document.splitlines()
    blocks: dict[str, list[str]] = {}
    for index, line in enumerate(lines):
        match = re.match(r"^(\s*)- name:\s*([A-Z0-9_]+)\s*$", line)
        if not match or match.group(2) not in DOCUMENT_ENV_NAMES:
            continue
        indent = len(match.group(1))
        block: list[str] = []
        for nested in lines[index + 1 :]:
            if re.match(rf"^\s{{{indent}}}- name:", nested):
                break
            block.append(nested)
        blocks[match.group(2)] = block
    return blocks


def _block_value(block: list[str], env_name: str) -> str:
    for line in block:
        match = re.match(r"^\s+value:\s*(.*?)\s*$", line)
        if match:
            value = _yaml_scalar(match.group(1))
            if value:
                return value
    raise CheckError(f"frontend deployment is missing a value for {env_name}")


def _block_secret(block: list[str], env_name: str) -> SecretReference:
    secret_index = next(
        (index for index, line in enumerate(block) if line.strip() == "secretKeyRef:"),
        None,
    )
    if secret_index is None:
        raise CheckError(f"frontend deployment is missing a Secret for {env_name}")
    name = ""
    key = ""
    optional = False
    for line in block[secret_index + 1 :]:
        stripped = line.strip()
        if stripped.startswith("name:") and not name:
            name = _yaml_scalar(stripped.split(":", 1)[1])
        elif stripped.startswith("key:") and not key:
            key = _yaml_scalar(stripped.split(":", 1)[1])
        elif stripped.startswith("optional:"):
            optional = _yaml_scalar(stripped.split(":", 1)[1]).lower() == "true"
    if not name or not key:
        raise CheckError(
            f"frontend deployment Secret reference for {env_name} is invalid"
        )
    return SecretReference(name=name, key=key, optional=optional)


def config_from_manifest(manifest: str) -> DocumentStorageConfig | None:
    document = _frontend_deployment(manifest)
    if document is None:
        return None
    blocks = _env_blocks(document)
    if "DOCUMENT_OBJECT_ENDPOINT" not in blocks:
        return None

    missing_values = sorted(REQUIRED_VALUE_NAMES - blocks.keys())
    missing_secrets = sorted(REQUIRED_SECRET_NAMES - blocks.keys())
    if missing_values or missing_secrets:
        missing = ", ".join(missing_values + missing_secrets)
        raise CheckError(
            f"rendered document-object configuration is incomplete: {missing}"
        )

    session_token = None
    if "DOCUMENT_OBJECT_SESSION_TOKEN" in blocks:
        session_token = _block_secret(
            blocks["DOCUMENT_OBJECT_SESSION_TOKEN"],
            "DOCUMENT_OBJECT_SESSION_TOKEN",
        )
    return DocumentStorageConfig(
        endpoint=_block_value(
            blocks["DOCUMENT_OBJECT_ENDPOINT"], "DOCUMENT_OBJECT_ENDPOINT"
        ).rstrip("/"),
        bucket=_block_value(blocks["DOCUMENT_OBJECT_BUCKET"], "DOCUMENT_OBJECT_BUCKET"),
        region=_block_value(blocks["DOCUMENT_OBJECT_REGION"], "DOCUMENT_OBJECT_REGION"),
        prefix=_block_value(
            blocks["DOCUMENT_OBJECT_PREFIX"], "DOCUMENT_OBJECT_PREFIX"
        ).strip("/"),
        access_key=_block_secret(
            blocks["DOCUMENT_OBJECT_ACCESS_KEY"], "DOCUMENT_OBJECT_ACCESS_KEY"
        ),
        secret_key=_block_secret(
            blocks["DOCUMENT_OBJECT_SECRET_KEY"], "DOCUMENT_OBJECT_SECRET_KEY"
        ),
        session_token=session_token,
        pod_labels=_pod_labels(document),
    )


def _secret_env(name: str, reference: SecretReference) -> dict[str, object]:
    return {
        "name": name,
        "valueFrom": {
            "secretKeyRef": {
                "name": reference.name,
                "key": reference.key,
                "optional": reference.optional,
            }
        },
    }


def probe_command(
    config: DocumentStorageConfig,
    namespace: str,
    image: str,
    timeout: int,
) -> list[str]:
    pod_name = f"document-storage-preflight-{uuid.uuid4().hex[:8]}"
    object_key = f"{config.prefix}/.preflight/{uuid.uuid4().hex}"
    object_url = f"{config.endpoint}/{config.bucket}/{object_key}"
    payload = "daedalus-document-storage-preflight"
    timeout_text = str(timeout)
    script = f"""
set -eu
object_url={shlex.quote(object_url)}
region={shlex.quote(config.region)}
payload={shlex.quote(payload)}
response_body="$(mktemp)"
download_body="$(mktemp)"
created=false

s3_request() {{
  method="$1"
  shift
  if [ -n "${{DOCUMENT_OBJECT_SESSION_TOKEN:-}}" ]; then
    curl -sS --max-time {timeout_text} \\
      --aws-sigv4 "aws:amz:$region:s3" \\
      --user "$DOCUMENT_OBJECT_ACCESS_KEY:$DOCUMENT_OBJECT_SECRET_KEY" \\
      -H "x-amz-security-token: $DOCUMENT_OBJECT_SESSION_TOKEN" \\
      -X "$method" "$object_url" "$@"
  else
    curl -sS --max-time {timeout_text} \\
      --aws-sigv4 "aws:amz:$region:s3" \\
      --user "$DOCUMENT_OBJECT_ACCESS_KEY:$DOCUMENT_OBJECT_SECRET_KEY" \\
      -X "$method" "$object_url" "$@"
  fi
}}

cleanup() {{
  if [ "$created" = true ]; then
    s3_request DELETE -o /dev/null >/dev/null 2>&1 || true
  fi
}}
trap cleanup EXIT

put_status="$(s3_request PUT -o "$response_body" -w '%{{http_code}}' \\
  -H 'Content-Type: application/octet-stream' --data-binary "$payload")"
case "$put_status" in
  2??) created=true ;;
  *)
    printf 'document storage PUT returned HTTP %s: ' "$put_status" >&2
    head -c 1000 "$response_body" >&2
    printf '\n' >&2
    exit 21
    ;;
esac

get_status="$(s3_request GET -o "$download_body" -w '%{{http_code}}')"
if [ "$get_status" != 200 ]; then
  printf 'document storage GET returned HTTP %s\n' "$get_status" >&2
  exit 22
fi
if [ "$(cat "$download_body")" != "$payload" ]; then
  echo 'document storage GET returned unexpected content' >&2
  exit 23
fi

delete_status="$(s3_request DELETE -o "$response_body" -w '%{{http_code}}')"
case "$delete_status" in
  2??) created=false ;;
  *)
    printf 'document storage DELETE returned HTTP %s: ' "$delete_status" >&2
    head -c 1000 "$response_body" >&2
    printf '\n' >&2
    exit 24
    ;;
esac
"""

    environment = [
        _secret_env("DOCUMENT_OBJECT_ACCESS_KEY", config.access_key),
        _secret_env("DOCUMENT_OBJECT_SECRET_KEY", config.secret_key),
    ]
    if config.session_token is not None:
        environment.append(
            _secret_env("DOCUMENT_OBJECT_SESSION_TOKEN", config.session_token)
        )
    overrides = {
        "metadata": {"labels": config.pod_labels},
        "spec": {
            "affinity": PREFLIGHT_AFFINITY,
            "automountServiceAccountToken": False,
            "containers": [
                {
                    "name": pod_name,
                    "env": environment,
                    "securityContext": {
                        "allowPrivilegeEscalation": False,
                        "capabilities": {"drop": ["ALL"]},
                        "runAsGroup": 101,
                        "runAsNonRoot": True,
                        "runAsUser": 100,
                        "seccompProfile": {"type": "RuntimeDefault"},
                    },
                }
            ],
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
        "sh",
        "-ec",
        script,
    ]


def check_with_kubectl(
    config: DocumentStorageConfig,
    namespace: str,
    image: str,
    timeout: int,
) -> None:
    command = probe_command(config, namespace, image, timeout)
    try:
        completed = subprocess.run(  # nosec B603 - fixed kubectl argv and locally rendered probe
            command,
            text=True,
            capture_output=True,
            timeout=max(timeout * 4 + 90, 120),
            check=False,
        )
    except FileNotFoundError as exc:
        raise CheckError("kubectl was not found for document storage check") from exc
    except subprocess.TimeoutExpired as exc:
        raise CheckError("document storage preflight timed out") from exc
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        if len(detail) > 1200:
            detail = f"{detail[:1200]}..."
        raise CheckError(f"kubectl probe failed: {detail or 'unknown error'}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check rendered document-object storage credentials and access."
    )
    parser.add_argument(
        "--manifest",
        default="-",
        help="Rendered Helm manifest path, or - for stdin.",
    )
    parser.add_argument("--namespace", default="daedalus")
    parser.add_argument(
        "--image",
        default="curlimages/curl:8.8.0",
        help="Pinned curl image used by the short-lived Kubernetes probe.",
    )
    parser.add_argument("--timeout", type=int, default=20)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.timeout < 1 or args.timeout > 300:
        print(
            "Document storage preflight timeout must be between 1 and 300 seconds.",
            file=sys.stderr,
        )
        return 2
    try:
        manifest = (
            sys.stdin.read()
            if args.manifest == "-"
            else Path(args.manifest).read_text(encoding="utf-8")
        )
        config = config_from_manifest(manifest)
        if config is None:
            print("Document object storage is disabled; skipping preflight.")
            return 0
        check_with_kubectl(config, args.namespace, args.image, args.timeout)
    except (CheckError, OSError) as exc:
        print(f"Document storage preflight failed: {exc}", file=sys.stderr)
        return 1
    print(
        "Document storage preflight passed "
        f"(PUT/GET/DELETE {config.endpoint}/{config.bucket}/{config.prefix}/...)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
