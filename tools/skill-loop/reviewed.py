"""One bounded maintenance candidate, measured before exact-diff owner review."""

import fcntl
import importlib.util
import json
import os
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "reviewed_gate", ROOT / "tools/skill-eval/reviewed_gate.py"
)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


@contextmanager
def locked(root):
    path = root / ".cache/skill-loop/reviewed/.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def directory(root, identifier):
    if (
        not isinstance(identifier, str)
        or len(identifier) != 32
        or any(c not in "0123456789abcdef" for c in identifier)
    ):
        raise ValueError("Use the exact round ID returned by the loop")
    path = root / ".cache/skill-loop/reviewed" / identifier
    if any(p.is_symlink() for p in [path, *path.parents]):
        raise ValueError("Symlinked review state")
    return path


def rollback(path, root=ROOT):
    state = json.loads((path / "state.json").read_text())
    if state["phase"] == "accepted":
        raise ValueError("Accepted commits roll back with git revert COMMIT")
    candidate = gate.worktree(root, state)
    if gate.git(candidate, "rev-parse", "HEAD").decode().strip() != state["base"]:
        raise ValueError("Candidate HEAD changed; inspect before rollback")
    # Preserve unexpected hook output, then restore the isolated Git snapshot.
    (path / "rollback.patch").write_bytes(
        gate.git(
            candidate,
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--binary",
            state["base"],
        )
    )
    for name in (
        gate.git(candidate, "ls-files", "--others", "--exclude-standard", "-z")
        .decode()
        .strip("\0")
        .split("\0")
    ):
        if not name:
            continue
        destination = path / "quarantine" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.replace(candidate / name, destination)
    gate.git(
        candidate,
        "restore",
        "--source",
        state["base"],
        "--staged",
        "--worktree",
        "--",
        ".",
    )
    if gate.git(candidate, "status", "--porcelain"):
        raise ValueError("Candidate snapshot restoration incomplete")
    state["phase"] = "reverted"
    gate.write(path / "state.json", state)


def run(
    proposals, history, append_log, read_log, edit_text, allow_model_network, root=ROOT
):
    proposal = proposals[0]
    selected = gate.validate(proposal)
    if any(item.get("skill") != proposal["skill"] for item in proposals):
        raise ValueError("One skill per run")
    if not allow_model_network:
        raise ValueError("Model inference needs --allow-model-network; score not run")
    if gate.git(root, "status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("Start from a clean committed tree")
    prior = read_log(history)
    edits_hash = gate.sha(gate.canonical(proposal["edits"]))
    initial = gate.context(root, proposal["skill"])
    proposed = dict(initial)
    for edit in proposal["edits"]:
        proposed[edit["path"]] = edit_text(proposed[edit["path"]], [edit])
    base_skill_hash = gate.sha(gate.canonical(initial))
    candidate_hash = gate.sha(gate.canonical(proposed))
    if any(
        row.get("skill") == proposal["skill"]
        and row.get("decision") in {"rejected", "reverted"}
        and (
            row.get("idea") == proposal["idea"]
            or row.get("edits_sha256") == edits_hash
            or (
                row.get("base_skill_sha256") == base_skill_hash
                and row.get("candidate_sha256") == candidate_hash
            )
        )
        for row in prior
    ):
        return {"stop": "repeated_rejection", "gain": "not run", "accepted": []}
    identifier = uuid.uuid4().hex
    path = directory(root, identifier)
    path.mkdir(parents=True)
    base = gate.git(root, "rev-parse", "HEAD").decode().strip()
    branch = "skill-loop/" + proposal["skill"] + "/" + identifier[:12]
    candidate = Path(tempfile.mkdtemp(prefix="reviewed-skill-")) / "candidate"
    gate.git(root, "worktree", "add", "-b", branch, str(candidate), base)
    files = {selected["root"] + "/" + edit["path"] for edit in proposal["edits"]}
    snapshot = {name: (candidate / name).read_text() for name in files}
    state = {
        "skill": proposal["skill"],
        "worktree": str(candidate),
        "branch": branch,
        "base": base,
        "snapshot": snapshot,
        "phase": "evaluating",
    }
    gate.write(path / "state.json", state)
    record = {
        "round_id": identifier,
        "round": 1,
        "skill": proposal["skill"],
        "idea": proposal["idea"],
        "edits_sha256": edits_hash,
        "base_skill_sha256": base_skill_hash,
        "candidate_sha256": candidate_hash,
        "proposal": proposal,
        "before": "not run",
        "after": "not run",
        "diff": "not run",
        "gain": "not run",
        "judge_sha256": gate.identity(root),
    }
    try:
        before = gate.evaluate(
            root,
            candidate / selected["root"],
            path / "before.json",
            path / "before-evidence",
            reuse_reference=True,
        )
        record["before"] = before["groups"]["public"]["installed"]
        for name, text in snapshot.items():
            relative = name.removeprefix(selected["root"] + "/")
            (candidate / name).write_text(
                edit_text(text, [e for e in proposal["edits"] if e["path"] == relative])
            )
        record["diff"] = gate.diff(candidate, base, proposal["skill"])
        if not record["diff"]:
            raise ValueError("Proposal made no change")
        gate.check_workspace(candidate, base, proposal["skill"], files)
        gate.hooks(candidate, sorted(files))
        gate.check_workspace(candidate, base, proposal["skill"], files)
        if gate.diff(candidate, base, proposal["skill"]) != record["diff"]:
            raise ValueError(
                "Hooks changed candidate bytes; re-propose formatted input"
            )
        after = gate.evaluate(
            root,
            candidate / selected["root"],
            path / "after.json",
            path / "after-evidence",
        )
        if gate.identity(root) != record["judge_sha256"]:
            raise ValueError("Protected judge changed during evaluation")
        current = gate.check_workspace(candidate, base, proposal["skill"], files)
        if after["skill_sha256"] != gate.sha(gate.canonical(current)):
            raise ValueError("Candidate changed during evaluation")
        gain, reason = gate.decision(before, after)
        record.update(
            after=after["groups"]["public"]["installed"],
            gain=gain,
            reason=reason,
            heldout={
                key: after["groups"]["heldout"][key]
                for key in ["absent", "installed", "possible", "delta"]
            },
        )
        if reason != "review_required":
            rollback(path, root)
            record["decision"] = "reverted"
        else:
            payload = {
                "schema": 1,
                "skill": proposal["skill"],
                "idea": proposal["idea"],
                "source": proposal["source"],
                "proposal": proposal,
                "base": base,
                "gate_sha256": record["judge_sha256"],
                "before": before,
                "after": after,
                "diff": record["diff"],
                "files": {
                    name: gate.sha((candidate / name).read_bytes())
                    for name in sorted(files)
                },
            }
            gate.write(path / "packet.json", payload)
            state.update(
                phase="review_required", packet_sha256=gate.sha(gate.canonical(payload))
            )
            gate.write(path / "state.json", state)
            record.update(
                decision="review_required", packet_sha256=state["packet_sha256"]
            )
    except Exception as exc:
        rollback(path, root)
        record.update(decision="rejected", reason=str(exc))
    append_log(history, record)
    return {
        "round_id": identifier,
        "stop": record["decision"],
        "reason": record["reason"],
        "before": record["before"],
        "after": record["after"],
        "gain": record["gain"],
        "branch": branch,
        "worktree": str(candidate),
        "accepted": [],
    }


def action(command, identifier, approval_source, append_log, root=ROOT):
    path = directory(root, identifier)
    with locked(root):
        if command == "review":
            gate.review(path, approval_source, root)
            return {"round_id": identifier, "status": "reviewed"}
        if command == "accept":
            commit = gate.accept(path, root)
            payload = json.loads((path / "packet.json").read_text())
            append_log(
                root / ".learnings/rounds.jsonl",
                {
                    "round_id": identifier,
                    "skill": payload["skill"],
                    "idea": payload["idea"],
                    "decision": "accepted",
                    "commit": commit,
                    "before": payload["before"]["groups"]["public"]["installed"],
                    "after": payload["after"]["groups"]["public"]["installed"],
                    "diff": payload["diff"],
                    "reason": "measured_gain_heldout_pass_and_exact_human_approval",
                },
            )
            return {"round_id": identifier, "status": "accepted", "commit": commit}
        rollback(path, root)
        payload = json.loads((path / "packet.json").read_text())
        append_log(
            root / ".learnings/rounds.jsonl",
            {
                "round_id": identifier,
                "skill": payload["skill"],
                "idea": payload["idea"],
                "edits_sha256": gate.sha(gate.canonical(payload["proposal"]["edits"])),
                "base_skill_sha256": payload["before"]["skill_sha256"],
                "candidate_sha256": payload["after"]["skill_sha256"],
                "decision": "reverted",
                "reason": "owner_rejected",
                "diff": payload["diff"],
            },
        )
        return {"round_id": identifier, "status": "reverted"}
