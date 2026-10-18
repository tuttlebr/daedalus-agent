#!/usr/bin/env python3
"""Fail when a rendered workload weakens the chart's container baseline."""

from __future__ import annotations

import argparse
from pathlib import Path

import yaml

WORKLOAD_KINDS = {"CronJob", "DaemonSet", "Deployment", "Job", "StatefulSet"}
HOST_NAMESPACES = ("hostNetwork", "hostPID", "hostIPC")


def _pod_spec(workload: dict) -> dict:
    spec = workload.get("spec", {})
    if workload.get("kind") == "CronJob":
        spec = spec.get("jobTemplate", {}).get("spec", {})
    return spec.get("template", {}).get("spec", {})


def check_manifest(path: Path) -> list[str]:
    failures: list[str] = []
    with path.open(encoding="utf-8") as stream:
        documents = list(yaml.safe_load_all(stream))

    workloads = [
        document
        for document in documents
        if isinstance(document, dict) and document.get("kind") in WORKLOAD_KINDS
    ]
    if not workloads:
        return [f"{path}: no workload objects were rendered"]

    for workload in workloads:
        name = workload.get("metadata", {}).get("name", "<unnamed>")
        pod_spec = _pod_spec(workload)
        prefix = f"{path}:{workload.get('kind')}/{name}"
        if pod_spec.get("automountServiceAccountToken") is not False:
            failures.append(f"{prefix}: automountServiceAccountToken must be false")
        for field in HOST_NAMESPACES:
            if pod_spec.get(field) is True:
                failures.append(f"{prefix}: {field} must not be enabled")
        for volume in pod_spec.get("volumes") or []:
            if "hostPath" in volume:
                volume_name = volume.get("name", "<unnamed>")
                failures.append(f"{prefix}: volume {volume_name} must not use hostPath")
        pod_security = pod_spec.get("securityContext") or {}
        if pod_security.get("runAsNonRoot") is not True:
            failures.append(f"{prefix}: pod runAsNonRoot must be true")
        if pod_security.get("runAsUser") == 0:
            failures.append(f"{prefix}: pod runAsUser must not be 0")
        if pod_security.get("seccompProfile", {}).get("type") != "RuntimeDefault":
            failures.append(f"{prefix}: pod seccompProfile.type must be RuntimeDefault")

        containers = (pod_spec.get("initContainers") or []) + (
            pod_spec.get("containers") or []
        )
        if not containers:
            failures.append(f"{prefix}: no containers were rendered")
        for container in containers:
            container_name = container.get("name", "<unnamed>")
            security = container.get("securityContext") or {}
            container_prefix = f"{prefix}:{container_name}"
            if security.get("allowPrivilegeEscalation") is not False:
                failures.append(
                    f"{container_prefix}: allowPrivilegeEscalation must be false"
                )
            if security.get("readOnlyRootFilesystem") is not True:
                failures.append(
                    f"{container_prefix}: readOnlyRootFilesystem must be true"
                )
            capabilities = security.get("capabilities") or {}
            if "ALL" not in (capabilities.get("drop") or []):
                failures.append(
                    f"{container_prefix}: capabilities.drop must include ALL"
                )
            # Container settings override the pod baseline field by field.
            if capabilities.get("add"):
                failures.append(f"{container_prefix}: capabilities.add must be empty")
            if security.get("privileged") is True:
                failures.append(f"{container_prefix}: privileged must not be true")
            if security.get("runAsNonRoot") is False:
                failures.append(
                    f"{container_prefix}: runAsNonRoot must not override the pod"
                )
            if security.get("runAsUser") == 0:
                failures.append(f"{container_prefix}: runAsUser must not be 0")
            seccomp = (security.get("seccompProfile") or {}).get("type")
            if seccomp not in (None, "RuntimeDefault", "Localhost"):
                failures.append(
                    f"{container_prefix}: seccompProfile must not weaken RuntimeDefault"
                )

    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifests", nargs="+", type=Path)
    args = parser.parse_args()

    failures = [
        failure for manifest in args.manifests for failure in check_manifest(manifest)
    ]
    if failures:
        print("\n".join(failures))
        return 1
    print(f"Rendered pod security passed for {len(args.manifests)} manifest(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
