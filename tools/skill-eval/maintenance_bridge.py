#!/usr/bin/env python3
"""Trusted candidate-input bridge; the frozen maintenance judge stays unchanged."""

import argparse
import json
import re
import subprocess  # nosec B404
import sys
from pathlib import Path

# Never import Python or evaluation data from the candidate worktree.
sys.path.insert(0, str(Path(__file__).resolve().parent / "maintenance"))
import common  # noqa: E402
import run as evaluator  # noqa: E402


def measure(candidate, output, artifacts, reuse_reference=False):
    cache = common.ROOT / ".cache/skill-loop/reviewed"
    output, artifacts = output.absolute(), artifacts.absolute()
    if (
        output.parent.parent != cache
        or not re.fullmatch(r"[a-f0-9]{32}", output.parent.name)
        or output.name not in {"before.json", "after.json"}
        or artifacts != output.parent / (output.stem + "-evidence")
        or output.exists()
        or artifacts.exists()
        or any(p.is_symlink() for p in [output, artifacts, *output.parents])
    ):
        raise ValueError("Bridge outputs must be fresh controller-owned cache paths")
    if any(p.is_symlink() for p in [candidate, *candidate.parents]):
        raise ValueError("Symlinked candidate input")
    candidate = candidate.resolve(strict=True)
    worktree = candidate.parents[2]
    if (
        candidate.relative_to(worktree).as_posix()
        != ".agents/skills/daedalus-review-and-remediate"
    ):
        raise ValueError("Only the registered maintenance skill is measurable")
    registered = subprocess.run(
        ["git", "worktree", "list", "--porcelain"],
        cwd=common.ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout  # nosec B603 B607
    if worktree == common.ROOT or f"worktree {worktree}\n" not in registered:
        raise ValueError("A separate registered candidate worktree is required")
    common.SKILL = candidate.resolve(strict=True)
    context = common.skill_context()
    if not context.get("SKILL.md") or len(common.canonical(context)) > 200_000:
        raise ValueError("Missing or oversized candidate skill context")
    reference = json.loads(evaluator.REFERENCE.read_text())
    if not evaluator.committed(evaluator.REFERENCE):
        raise ValueError("Installed reference must be committed")
    if reference["status"] != "pass":
        raise ValueError("Installed reference must be passing")
    if reuse_reference and reference["skill_sha256"] == common.digest(
        common.canonical(context)
    ):
        suites = {
            name: common.load_cases(common.HERE / folder)
            for name, folder in [("public", "cases"), ("heldout", "heldout")]
        }
        expected = (
            common.identity(),
            common.digest(common.canonical(suites)),
            evaluator.image_identity(),
            evaluator.configuration(),
        )
        actual = tuple(
            reference[key] for key in ("judge_sha256", "cases_sha256", "image", "model")
        )
        if actual != expected:
            raise ValueError("Reference inputs changed; establish a reviewed baseline")
        reference["measurement_source"] = "committed installed reference"
        common.write_json(output, reference)
    else:
        evaluator.run("run", output, artifacts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--reuse-reference", action="store_true")
    parser.add_argument("--allow-model-network", action="store_true")
    args = parser.parse_args()
    if not args.allow_model_network:
        parser.error("Model inference requires explicit opt-in; score not run")
    try:
        measure(args.candidate, args.output, args.artifacts, args.reuse_reference)
        print("Maintenance measurement recorded")
    except (ValueError, OSError, RuntimeError) as exc:
        parser.exit(2, f"Maintenance measurement not run: {exc}\n")


if __name__ == "__main__":
    main()
