#!/usr/bin/env python3
"""Fixed admission gate. Proposal data never chooses verifier code or commands."""

import argparse
import ast
import hashlib
import json
import subprocess  # nosec B404
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
POLICY = json.loads((HERE / "policy.json").read_text())


class ReviewRequired(ValueError):
    """A human must review this exact diff; no automatic acceptance path."""


def validate_proposal(proposal):
    if set(proposal) != {"skill", "idea", "edits"}:
        raise ValueError("Proposal requires exactly skill, idea, edits")
    skill = proposal["skill"]
    if skill not in POLICY["automatic_surfaces"]:
        raise ReviewRequired(
            "High-risk or unclassified skill requires human diff review"
        )
    if not isinstance(proposal["idea"], str) or not proposal["idea"].strip():
        raise ValueError("A stable idea key is required for the rejected-edit buffer")
    edits = proposal["edits"]
    if (
        not isinstance(edits, list)
        or not 1 <= len(edits) <= POLICY["max_edits_per_round"]
    ):
        raise ValueError("Textual learning rate exceeded")
    changed = 0
    for edit in edits:
        if set(edit) != {"path", "old", "new"}:
            raise ValueError("Each edit requires path, old, new")
        if edit["path"] not in POLICY["automatic_surfaces"][skill]:
            raise ReviewRequired(
                "Protected or unapproved surface requires human review"
            )
        if not all(isinstance(edit[key], str) and edit[key] for key in edit):
            raise ValueError("Edit fields must be nonempty strings")
        changed += len(edit["old"].splitlines()) + len(edit["new"].splitlines())
    if changed > POLICY["max_changed_lines"]:
        raise ValueError("Changed-line budget exceeded")
    if not (HERE / "heldout" / skill).is_dir():
        raise ValueError("No held-out evaluation data; stop and request cases")
    return skill


def validate_code(path):
    tree = ast.parse(path.read_text())
    allowed_imports = {"argparse", "json", "sys", "decimal", "pathlib"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            modules = [node.module]
        else:
            modules = []
        if any(name not in allowed_imports for name in modules):
            raise ReviewRequired("New execution capability requires human review")
        if isinstance(node, ast.Name) and node.id in {
            "eval",
            "exec",
            "compile",
            "__import__",
            "globals",
            "locals",
            "getattr",
            "setattr",
        }:
            raise ReviewRequired("Dynamic execution requires human review")
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            raise ReviewRequired("Runtime introspection requires human review")


def fingerprint():
    # Integrity over all judge inputs, including the hidden suite; no contents
    # or individual fingerprints are sent to the proposal/editor process.
    digest = hashlib.sha256()
    for path in sorted(HERE.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts:
            digest.update(path.relative_to(HERE).as_posix().encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def evaluate(skill, candidate, private=False):
    if skill not in POLICY["automatic_surfaces"]:
        raise ReviewRequired("No automatic judge for this skill")
    with tempfile.TemporaryDirectory(prefix="skill-judge-report-") as directory:
        report_path = Path(directory) / "report.json"
        command = [
            sys.executable,
            str(HERE / "evaluate.py"),
            "run",
            "--skill",
            str(candidate),
            "--output",
            str(report_path),
        ]
        if private:
            command += ["--private", "--cases", str(HERE / "heldout" / skill)]
        run = subprocess.run(
            command, capture_output=True, text=True, check=False, timeout=900
        )  # nosec B603
        if run.returncode not in {0, 1} or not report_path.exists():
            raise ValueError(
                "Evaluation not run; inspect judge infrastructure separately"
            )
        report = json.loads(report_path.read_text())
        return {
            key: report[key]
            for key in (
                "score",
                "possible",
                "absent_score",
                "skill_sha256",
                "case_sha256",
                "status",
            )
        }


def check_changed_skills(base):
    revision = subprocess.run(
        ["git", "rev-parse", "--verify", "--end-of-options", base + "^{commit}"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()  # nosec B603 B607
    changed = subprocess.run(
        [
            "git",
            "diff",
            "--name-only",
            revision,
            "HEAD",
            "--",
            "skills",
            ".agents/skills",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()  # nosec B603 B607
    for name in changed:
        parts = Path(name).parts
        if parts[0] != "skills" or len(parts) < 3:
            raise ReviewRequired(
                "Changed maintenance instructions require independent review"
            )
        skill, resource = parts[1], Path(*parts[2:]).as_posix()
        if resource.startswith("evals/"):
            raise ReviewRequired(
                "Evaluation data changes require separate evaluator review"
            )
        if resource not in POLICY["automatic_surfaces"].get(skill, []):
            raise ReviewRequired(
                "Changed skill has no automatic evaluation; request independent review"
            )
        if not (ROOT / name).is_file():
            raise ReviewRequired("Skill deletion is forbidden; archive instead")
        validate_code(ROOT / name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skill", default="fantasy-football-recap")
    parser.add_argument(
        "--base", help="Reject changed skills without an approved evaluation surface"
    )
    args = parser.parse_args()
    try:
        if args.base:
            check_changed_skills(args.base)
        report = evaluate(args.skill, ROOT / "skills" / args.skill, private=True)
        print(json.dumps(report, sort_keys=True))
        return int(report["status"] != "pass")
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        parser.exit(2, f"gate blocked; score not run: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
