#!/usr/bin/env python3
"""Fail when a rendered workload weakens the chart's container baseline."""

from __future__ import annotations

import argparse
from pathlib import Path

import yaml

WORKLOAD_KINDS = {"DaemonSet", "Deployment", "Job", "StatefulSet"}


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
        pod_spec = workload.get("spec", {}).get("template", {}).get("spec", {})
        prefix = f"{path}:{workload.get('kind')}/{name}"
        if pod_spec.get("automountServiceAccountToken") is not False:
            failures.append(f"{prefix}: automountServiceAccountToken must be false")
        pod_security = pod_spec.get("securityContext", {})
        if pod_security.get("runAsNonRoot") is not True:
            failures.append(f"{prefix}: pod runAsNonRoot must be true")
        if pod_security.get("seccompProfile", {}).get("type") != "RuntimeDefault":
            failures.append(f"{prefix}: pod seccompProfile.type must be RuntimeDefault")

        containers = pod_spec.get("initContainers", []) + pod_spec.get("containers", [])
        if not containers:
            failures.append(f"{prefix}: no containers were rendered")
        for container in containers:
            container_name = container.get("name", "<unnamed>")
            security = container.get("securityContext", {})
            container_prefix = f"{prefix}:{container_name}"
            if security.get("allowPrivilegeEscalation") is not False:
                failures.append(
                    f"{container_prefix}: allowPrivilegeEscalation must be false"
                )
            if security.get("readOnlyRootFilesystem") is not True:
                failures.append(
                    f"{container_prefix}: readOnlyRootFilesystem must be true"
                )
            dropped = security.get("capabilities", {}).get("drop", [])
            if "ALL" not in dropped:
                failures.append(
                    f"{container_prefix}: capabilities.drop must include ALL"
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
