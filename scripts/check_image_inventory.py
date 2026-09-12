#!/usr/bin/env python3
"""Check all shipped image references and optionally scan the upstream images.

Rendered Compose/Helm configs are compared with deployment-images.json, so a new
service or changed upstream digest cannot silently fall outside the scan gate.
No service is started, no .env is loaded, and no cluster context is consulted.
"""

import argparse
import itertools
import json
import os
import re
import shutil

# local operator tools; argv calls never use a shell
import subprocess  # nosec B404
import tempfile
from pathlib import Path

from image_vex import matching_statement, verify_native_evidence

ROOT = Path(__file__).resolve().parents[1]


def output(*command):
    executable = shutil.which(command[0])
    if executable is None:
        raise FileNotFoundError(f"Required executable not found: {command[0]}")
    # Callers supply fixed Docker/Helm operations and repository-owned paths.
    # resolved executable and shell-free argv
    return subprocess.check_output(  # nosec B603
        (str(Path(executable).resolve()), *command[1:]),
        cwd=ROOT,
        text=True,
        timeout=60,
        shell=False,
    )


def check_refs(mode, actual, declared):
    def immutable_ref(reference):
        if "@" not in reference:
            return reference
        repository, digest = reference.split("@", 1)
        prefix, _, name = repository.rpartition("/")
        repository = (prefix + "/" if prefix else "") + name.split(":", 1)[0]
        return repository + "@" + digest

    actual = {immutable_ref(ref) for ref in actual}
    declared = {immutable_ref(ref) for ref in declared}
    if actual != declared:
        raise ValueError(
            f"{mode} inventory mismatch: unlisted={sorted(actual - declared)}, "
            f"unused={sorted(declared - actual)}"
        )


def validate(inventory):
    if set(inventory.get("platforms", [])) != {"linux/amd64", "linux/arm64"}:
        raise ValueError("Inventory must cover both supported runtime platforms")
    upstream = inventory["upstream"]
    for item in upstream:
        if not re.fullmatch(r"[^\s@]+@sha256:[a-f0-9]{64}", item["image"]):
            raise ValueError(f"Upstream image must be digest pinned: {item['id']}")

    def declared(mode):
        return {item["image"] for item in upstream if mode in item["modes"]}

    for mode, source in (
        ("compose", "docker-compose.yaml"),
        ("e2e", "frontend/e2e/docker-compose.yml"),
    ):
        config = json.loads(
            output(
                "docker",
                "compose",
                "--env-file",
                ".env.template",
                "-f",
                source,
                "config",
                "--no-env-resolution",
                "--format",
                "json",
            )
        )
        services = config["services"]
        built_refs = {value["image"] for value in services.values() if "build" in value}
        if mode == "compose":
            actual_built = {
                name
                for name, value in services.items()
                if "build" in value and value["build"].get("target") != "base"
            }
            check_refs("built services", actual_built, set(inventory["builtServices"]))
        actual = {value["image"] for value in services.values()} - built_refs
        check_refs(mode, actual, declared(mode))

    built_refs = {
        f"inventory.invalid/daedalus:{name}" for name in inventory["builtServices"]
    }
    for mode, values in (
        ("helm-default", []),
        ("helm-custom", ["-f", "custom-values.yaml"]),
    ):
        overrides = []
        for name in inventory["builtServices"]:
            overrides += [
                "--set-string",
                f"images.{name}.repository=inventory.invalid/daedalus,images.{name}.tag={name},images.{name}.digest=",
            ]
        rendered = output(
            "helm", "template", "inventory", "helm/daedalus", *values, *overrides
        )
        # Helm's image helper emits one quoted scalar per Pod image field.
        refs = set(
            re.findall(r"^\s+image:\s*[\"\']?([^\s\"\']+)", rendered, re.MULTILINE)
        )
        if not refs:
            raise ValueError(f"No workload image fields found in {mode}")
        check_refs(mode, refs - built_refs, declared(mode))
    print(
        "PASS image inventory: Compose, browser fixtures, default/custom Helm",
        flush=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scan-upstream", action="store_true")
    parser.add_argument("--trivy", default=os.environ.get("TRIVY", "trivy"))
    parser.add_argument("--platform", choices=("linux/amd64", "linux/arm64"))
    args = parser.parse_args()
    inventory = json.loads((ROOT / "deployment-images.json").read_text())
    validate(inventory)
    failures = []
    if args.scan_upstream:
        trivy = shutil.which(args.trivy)
        if trivy is None:
            raise FileNotFoundError(
                f"Required scanner executable not found: {args.trivy}"
            )
        trivy = str(Path(trivy).resolve())
        statements = json.loads((ROOT / "security/image-vex.json").read_text())[
            "statements"
        ]
        platforms = [args.platform] if args.platform else inventory["platforms"]
        for item, platform in itertools.product(inventory["upstream"], platforms):
            print(f"Scanning {item['id']} ({platform}): {item['image']}", flush=True)
            with tempfile.TemporaryDirectory(prefix="daedalus-image-scan-") as temp:
                report = Path(temp) / "raw.json"
                # The scanner override is an operator-selected executable;
                # image references come from the validated, tracked inventory.
                # resolved scanner, shell-free argv
                result = subprocess.run(  # nosec B603
                    [
                        trivy,
                        "image",
                        "--image-src",
                        "remote",
                        "--scanners",
                        "vuln,secret",
                        "--severity",
                        "CRITICAL,HIGH",
                        "--exit-code",
                        "1",
                        "--format",
                        "json",
                        "--output",
                        str(report),
                        "--platform",
                        platform,
                        item["image"],
                    ],
                    cwd=ROOT,
                    check=False,
                    shell=False,
                )
                if not report.exists():
                    raise SystemExit(f"Scanner produced no report for {item['id']}")
                data = json.loads(report.read_text())
                # Keep the scanner's unadjudicated exit/findings visible without
                # printing detected secret values or the entire package SBOM.
                summary = {
                    "image": item["image"],
                    "platform": platform,
                    "actual_architecture": data.get("Metadata", {})
                    .get("ImageConfig", {})
                    .get("architecture"),
                    "raw_scan_exit": result.returncode,
                    "results": [
                        {
                            "target": target.get("Target"),
                            "vulnerabilities": target.get("Vulnerabilities", []),
                            "secrets": [
                                {
                                    key: secret.get(key)
                                    for key in (
                                        "RuleID",
                                        "Severity",
                                        "StartLine",
                                        "EndLine",
                                    )
                                }
                                for secret in target.get("Secrets", [])
                            ],
                        }
                        for target in data.get("Results", [])
                    ],
                }
                print(json.dumps(summary), flush=True)
                if (
                    result.returncode not in (0, 1)
                    or data.get("SchemaVersion") != 2
                    or summary["actual_architecture"] != platform.split("/")[1]
                    or not any(
                        target.get("Packages") for target in data.get("Results", [])
                    )
                ):
                    raise SystemExit(f"Scanner failed for {item['id']}")
                unresolved, count = [], 0
                checked_native = False
                for target in data.get("Results", []):
                    unresolved.extend(target.get("Secrets", []))
                    for finding in target.get("Vulnerabilities", []):
                        count += 1
                        statement = matching_statement(
                            statements,
                            item["image"],
                            target["Target"],
                            finding,
                            architecture=data.get("Metadata", {})
                            .get("ImageConfig", {})
                            .get("architecture"),
                        )
                        if statement is None:
                            unresolved.append(finding)
                            continue
                        if not checked_native:
                            verify_native_evidence(
                                item["image"], statement["x-architecture"]
                            )
                            checked_native = True
                        print(
                            f"VEX not_affected {finding['VulnerabilityID']}: exact digest/component and native evidence verified; expires {statement['x-expires']}",
                            flush=True,
                        )
                if unresolved or (result.returncode and not count):
                    failures.append(f"{item['id']} ({platform})")
    if failures:
        raise SystemExit(f"Image scan failed: {', '.join(failures)}")


if __name__ == "__main__":
    main()
