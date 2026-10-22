#!/usr/bin/env python3
"""Measure a maintenance skill with hosted inference and offline task execution."""

import argparse
import hashlib
import hmac
import json
import subprocess  # nosec B404
import sys
import uuid
from pathlib import Path

from actor import configuration, perform
from common import (
    HERE,
    ROOT,
    canonical,
    digest,
    identity,
    load_cases,
    skill_context,
    write_json,
)
from judge import grade
from sandbox import image_identity

BASELINE = HERE / "baseline.json"
REFERENCE = HERE / "reference.json"


def committed(path):
    result = subprocess.run(
        ["git", "show", "HEAD:" + path.relative_to(ROOT).as_posix()],
        cwd=ROOT,
        capture_output=True,
        check=False,
    )  # nosec B603 B607
    return result.returncode == 0 and result.stdout == path.read_bytes()


def summarize(rows):
    absent = sum(row["absent"]["pass"] for row in rows)
    installed = (
        "not run"
        if any(row["installed"] == "not run" for row in rows)
        else sum(row["installed"]["pass"] for row in rows)
    )
    return {
        "absent": absent,
        "installed": installed,
        "possible": len(rows),
        "delta": "not run" if installed == "not run" else installed - absent,
    }


def group_report(rows, private=False, private_input=None):
    summary = summarize(rows)
    if private:
        if private_input is None:
            raise ValueError("Private comparisons require undisclosed case material")
        return {
            **summary,
            "absent_outcomes_sha256": hmac.new(
                private_input,
                canonical([row["absent"]["pass"] for row in rows]),
                hashlib.sha256,
            ).hexdigest(),
            "evidence_sha256": digest(canonical(rows)),
        }
    return {"cases": rows, **summary}


def run(mode, output, artifact_root):
    if mode in {"baseline", "reference"} and output.exists():
        raise ValueError("Refusing to overwrite a frozen measurement")
    config, image, fingerprint = configuration(), image_identity(), identity()
    suites = {
        name: load_cases(HERE / folder)
        for name, folder in [("public", "cases"), ("heldout", "heldout")]
    }
    input_hash = digest(canonical(suites))
    baseline = None
    if mode != "baseline":
        if not BASELINE.is_file() or not committed(BASELINE):
            raise ValueError(
                "Record and commit the absent baseline before any paired comparison"
            )
        baseline = json.loads(BASELINE.read_text())
        if (
            baseline["judge_sha256"],
            baseline["cases_sha256"],
            baseline["image"],
            baseline["model"],
        ) != (fingerprint, input_hash, image, config):
            raise ValueError(
                "Evaluation inputs drifted; review before replacing the baseline"
            )
    reference = None
    if mode == "run":
        if not REFERENCE.is_file() or not committed(REFERENCE):
            raise ValueError("Commit an installed reference before regression checks")
        reference = json.loads(REFERENCE.read_text())
        if (
            reference["judge_sha256"],
            reference["cases_sha256"],
            reference["image"],
            reference["model"],
        ) != (fingerprint, input_hash, image, config):
            raise ValueError("Installed reference inputs drifted")
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()  # nosec B603 B607
    report = {
        "schema": 1,
        "mode": mode,
        "repository_commit": revision,
        "scope": "verification and reporting on reduced repository fixtures",
        "network": {
            "model_inference": "allowed by explicit user approval",
            "task_execution": "none",
            "grading": "none",
        },
        "judge_sha256": fingerprint,
        "cases_sha256": input_hash,
        "skill_sha256": digest(canonical(skill_context())),
        "image": image,
        "model": config,
        "resolved_provider_revision": "not run",
        "groups": {},
        "regressions": [],
    }
    for name, cases in suites.items():
        rows = []
        for index, case in enumerate(cases):
            row = {
                "case": case["id"] if name == "public" else index,
                "installed": "not run",
            }
            for installed in [False] if mode == "baseline" else [False, True]:
                condition = "installed" if installed else "absent"
                episode = perform(case, installed, image, config)
                measured = grade(case, episode, image)
                # Detailed held-out traces belong to the independent judge, never the editor.
                artifact = artifact_root / name / str(index) / (condition + ".json")
                write_json(artifact, episode)
                row[condition] = {
                    "pass": measured["pass"],
                    "evidence_sha256": digest(canonical(episode)),
                }
                if name == "public":
                    row[condition]["assertions"] = measured["assertions"]
                if name == "public":
                    print(
                        f"{name} case {index + 1}: {condition}={'PASS' if measured['pass'] else 'FAIL'}",
                        flush=True,
                    )
            rows.append(row)
        report["groups"][name] = group_report(
            rows,
            private=name == "heldout",
            private_input=canonical(cases) if name == "heldout" else None,
        )
    if identity() != fingerprint:
        raise ValueError("Judge changed during measurement; comparison invalid")
    if digest(canonical(skill_context())) != report["skill_sha256"]:
        raise ValueError("Skill changed during measurement; comparison invalid")
    if baseline:
        for name, group in report["groups"].items():
            if name == "heldout":
                if (
                    group["absent_outcomes_sha256"]
                    != baseline["groups"][name]["absent_outcomes_sha256"]
                ):
                    report["regressions"].append("heldout: absent baseline drift")
                if group["installed"] != group["possible"]:
                    report["regressions"].append("heldout: failed")
                continue
            old = baseline["groups"][name]["cases"]
            for index, (row, prior) in enumerate(zip(group["cases"], old, strict=True)):
                if prior["absent"]["pass"] != row["absent"]["pass"]:
                    report["regressions"].append(
                        f"{name} case {index + 1}: absent baseline drift"
                    )
                if row["absent"]["pass"] and not row["installed"]["pass"]:
                    report["regressions"].append(
                        f"{name} case {index + 1}: skill regression"
                    )
    if reference:
        for name, group in report["groups"].items():
            if name == "heldout":
                continue
            for index, (row, old) in enumerate(
                zip(group["cases"], reference["groups"][name]["cases"], strict=True)
            ):
                if old["installed"]["pass"] and not row["installed"]["pass"]:
                    report["regressions"].append(
                        f"{name} case {index + 1}: installed-reference regression"
                    )
    report["status"] = (
        "recorded"
        if mode == "baseline"
        else "fail"
        if report["regressions"]
        else "pass"
    )
    write_json(output, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["baseline", "reference", "run"])
    parser.add_argument(
        "--allow-model-network",
        action="store_true",
        help="Explicit opt-in: only model inference may use the existing Codex connection",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--artifacts", type=Path)
    args = parser.parse_args()
    output = args.output or (
        BASELINE
        if args.mode == "baseline"
        else REFERENCE
        if args.mode == "reference"
        else ROOT / ".cache/skill-eval/maintenance/report.json"
    )
    artifacts = (
        args.artifacts or ROOT / ".cache/skill-eval/maintenance" / uuid.uuid4().hex
    )
    try:
        if not args.allow_model_network:
            raise ValueError(
                "Model inference needs explicit network opt-in; task score not run"
            )
        report = run(args.mode, output, artifacts)
        for name, group in report["groups"].items():
            print(
                f"{name}: absent={group['absent']}/{group['possible']} installed={group['installed']}/{group['possible']} delta={group['delta']}"
            )
        print("status=" + report["status"])
        return int(report["status"] == "fail")
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as exc:
        parser.exit(2, f"maintenance evaluation not run: {exc}\n")


if __name__ == "__main__":
    sys.exit(main())
