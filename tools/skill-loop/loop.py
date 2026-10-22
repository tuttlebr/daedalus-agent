#!/usr/bin/env python3
"""Bounded, data-only proposals; independent frozen judge; reversible Git rounds."""

import argparse
import hashlib
import importlib.util
import json
import os
import subprocess  # nosec B404
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "skill_gate", ROOT / "tools/skill-eval/gate.py"
)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


def git(*args, cwd=ROOT):
    # A task-created worktree may have different filesystem ownership mapping.
    return subprocess.run(  # nosec B603 B607
        ["git", "-c", f"safe.directory={cwd}", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
        env={
            **os.environ,
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "safe.directory",
            "GIT_CONFIG_VALUE_0": str(cwd),
        },
    ).stdout.strip()


def edit_text(original, edits):
    """The editor is a pure string transformation. No judge, files, or tools."""
    result = original
    for edit in edits:
        if result.count(edit["old"]) != 1:
            raise ValueError("Replacement must match exactly once")
        result = result.replace(edit["old"], edit["new"], 1)
    return result


def read_log(path):
    rows = (
        [json.loads(line) for line in path.read_text().splitlines()]
        if path.exists()
        else []
    )
    previous = "0" * 64
    for row in rows:
        identity = row["hash"]
        payload = {key: value for key, value in row.items() if key != "hash"}
        if (
            payload["previous"] != previous
            or hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
            != identity
        ):
            raise ValueError("Round history hash chain is invalid")
        previous = identity
    return rows


def append_log(path, record):
    rows = read_log(path)
    payload = {**record, "previous": rows[-1]["hash"] if rows else "0" * 64}
    payload["hash"] = hashlib.sha256(
        json.dumps(payload, sort_keys=True).encode()
    ).hexdigest()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as stream:
        stream.write(json.dumps(payload, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    return payload


def run(proposals, history, max_rounds=5):
    if not 1 <= max_rounds <= gate.POLICY["max_rounds"]:
        raise ValueError("max_rounds must be within the fixed policy cap")
    if git("status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Start from a clean committed repository")
    identity = gate.fingerprint()
    prior = read_log(history)
    rejected = {
        (row["skill"], row["idea"])
        for row in prior
        if row["decision"] in {"reverted", "rejected"}
    }
    result = {"accepted": [], "rounds": [], "stop": "max_rounds", "gain": 0}
    worktree = None
    skill = None
    previous = None
    no_gain = 0
    for number, proposal in enumerate(proposals[:max_rounds], 1):
        record = {
            "round": number,
            "skill": proposal.get("skill"),
            "idea": proposal.get("idea"),
            "before": "not run",
            "after": "not run",
            "diff": "not run",
            "proposal": proposal,
            "judge_sha256": identity,
        }
        snapshot = {}
        try:
            selected = gate.validate_proposal(proposal)
            if skill is not None and selected != skill:
                raise ValueError("One skill per optimization run")
            skill = selected
            if (skill, proposal["idea"]) in rejected:
                record.update(decision="rejected", reason="repeated_rejection")
                result["stop"] = "repeated_rejection"
                result["rounds"].append(append_log(history, record))
                break
            if worktree is None:
                branch = "skill-loop/" + skill + "/" + uuid.uuid4().hex[:12]
                worktree = Path(tempfile.mkdtemp(prefix="skill-loop-")) / "candidate"
                git("worktree", "add", "-b", branch, str(worktree), "HEAD")
                result.update(
                    branch=branch, worktree=str(worktree), base=git("rev-parse", "HEAD")
                )
                previous = gate.evaluate(skill, worktree / "skills" / skill)
            before = previous["score"]
            record["before"] = before
            grouped = {}
            for edit in proposal["edits"]:
                grouped.setdefault(edit["path"], []).append(edit)
            for relative, edits in grouped.items():
                path = worktree / "skills" / skill / relative
                if path.is_symlink():
                    raise ValueError("Symlinks cannot be edited")
                snapshot[path] = path.read_bytes()
                path.write_text(edit_text(path.read_text(), edits))
                gate.validate_code(path)
            record["diff"] = git("diff", "--", "skills", cwd=worktree)
            if not record["diff"]:
                raise ValueError("Proposal made no change")
            checked = subprocess.run(
                [
                    "uvx",
                    "--from",
                    "pre-commit==3.6.2",
                    "--python",
                    "3.12",
                    "pre-commit",
                    "run",
                    "--files",
                    *[str(path.relative_to(worktree)) for path in snapshot],
                ],
                cwd=worktree,
                capture_output=True,
                text=True,
                check=False,
                env={
                    **os.environ,
                    "GIT_CONFIG_COUNT": "1",
                    "GIT_CONFIG_KEY_0": "safe.directory",
                    "GIT_CONFIG_VALUE_0": str(worktree),
                },
            )  # nosec B603 B607
            if (
                checked.returncode
                or git("diff", "--", "skills", cwd=worktree) != record["diff"]
            ):
                raise ValueError(
                    "Required hooks failed or changed candidate; review formatting before evaluation"
                )
            if gate.fingerprint() != identity:
                raise ValueError("Frozen judge changed during the run")
            after = gate.evaluate(skill, worktree / "skills" / skill)
            record["after"] = after["score"]
            gain = after["score"] - before
            private = gate.evaluate(skill, worktree / "skills" / skill, private=True)
            record["heldout"] = private
            accepted = (
                after["status"] == private["status"] == "pass"
                and gain >= gate.POLICY["min_gain"]
            )
            if gate.fingerprint() != identity:
                raise ValueError("Frozen judge changed during the run")
            if accepted:
                git(
                    "add",
                    "--",
                    *[str(path.relative_to(worktree)) for path in snapshot],
                    cwd=worktree,
                )
                git(
                    "-c",
                    "core.hooksPath=/dev/null",
                    "commit",
                    "-m",
                    f"Improve {skill}: {proposal['idea']}",
                    cwd=worktree,
                )
                # Hooks may rewrite skill content. Only commit the evaluated bytes.
                if any(
                    path.read_text()
                    != edit_text(
                        content.decode(),
                        grouped[
                            path.relative_to(worktree / "skills" / skill).as_posix()
                        ],
                    )
                    for path, content in snapshot.items()
                ):
                    raise ValueError(
                        "Commit hooks changed evaluated bytes; review before accepting"
                    )
                commit = git("rev-parse", "HEAD", cwd=worktree)
                record.update(
                    decision="accepted",
                    reason="measured_gain_and_heldout_pass",
                    commit=commit,
                )
                result["accepted"].append(commit)
                result["gain"] += gain
                previous = after
                no_gain = 0
            else:
                # Snapshot swap: rejected candidate content never becomes a commit.
                for path, content in snapshot.items():
                    path.write_bytes(content)
                record.update(
                    decision="reverted",
                    reason="heldout_failure"
                    if private["status"] != "pass"
                    else "gain_below_minimum",
                )
                rejected.add((skill, proposal["idea"]))
                no_gain += 1
            result["rounds"].append(append_log(history, record))
            if gain < gate.POLICY["min_gain"] or no_gain >= 2:
                result["stop"] = (
                    "gain_below_minimum"
                    if no_gain < 2
                    else "two_rounds_without_improvement"
                )
                break
        except (
            gate.ReviewRequired,
            ValueError,
            SyntaxError,
            OSError,
            subprocess.SubprocessError,
        ) as exc:
            for path, content in snapshot.items():
                path.write_bytes(content)
            record.update(
                decision="review_required"
                if isinstance(exc, gate.ReviewRequired)
                else "rejected",
                reason=str(exc),
            )
            result["rounds"].append(append_log(history, record))
            result["stop"] = record["decision"]
            break
    else:
        if len(proposals) < max_rounds:
            result["stop"] = "proposals_exhausted"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("proposals", type=Path)
    parser.add_argument(
        "--history", type=Path, default=ROOT / ".learnings/rounds.jsonl"
    )
    parser.add_argument("--max-rounds", type=int, default=gate.POLICY["max_rounds"])
    args = parser.parse_args()
    try:
        proposals = json.loads(args.proposals.read_text())
        if not isinstance(proposals, list) or not proposals:
            raise ValueError("Supply a nonempty proposal list")
        result = run(proposals, args.history, args.max_rounds)
        print(json.dumps(result, indent=2))
        return (
            2
            if result["stop"] in {"rejected", "review_required"} or result["gain"] <= 0
            else 0
        )
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        parser.exit(2, f"loop stopped; score not run: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
