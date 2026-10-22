"""Real Git/approval tests. Synthetic scores here are not model measurements."""

import copy
import importlib.util
import io
import json
import shutil
import subprocess  # nosec B404
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

REPOSITORY = Path(__file__).resolve().parents[3]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


loop = module("tested_loop", REPOSITORY / "tools/skill-loop/loop.py")
reviewed = module("tested_reviewed", REPOSITORY / "tools/skill-loop/reviewed.py")
gate = reviewed.gate
SKILL = "daedalus-review-and-remediate"
RELATIVE = ".agents/skills/" + SKILL
ORIGINAL = "---\nname: daedalus-review-and-remediate\ndescription: Use when reviewing repository defects.\n---\n\nVerify the fix.\n"


class ReviewedTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "repository"
        self.root.mkdir()
        self.worktrees = []
        gate.git(self.root, "init", "-q")
        gate.git(self.root, "config", "user.email", "test@example.invalid")
        gate.git(self.root, "config", "user.name", "Test Fixture")
        folder = self.root / RELATIVE
        folder.mkdir(parents=True)
        (folder / "SKILL.md").write_text(ORIGINAL)
        (self.root / ".gitignore").write_text(".cache/\n.learnings/rounds.jsonl\n")
        protected = self.root / "tools/skill-eval/fixed.txt"
        protected.parent.mkdir(parents=True)
        protected.write_text("fixed judge fixture\n")
        gate.git(self.root, "add", ".")
        gate.git(self.root, "commit", "-qm", "Initial fixture")
        self.base = gate.git(self.root, "rev-parse", "HEAD").decode().strip()
        self.proposal = {
            "skill": SKILL,
            "idea": "verification.regression",
            "dimension": "verification-reporting",
            "source": "session://unit-test/observation",
            "provenance": "agent",
            "edits": [
                {
                    "path": "SKILL.md",
                    "old": "Verify the fix.",
                    "new": "Reproduce the failure, then verify the fix.",
                }
            ],
        }

    def tearDown(self):
        for path in self.worktrees:
            shutil.rmtree(path.parent, ignore_errors=True)
        self.temporary.cleanup()

    def make_round(self, after_score=1, failure=None, hooks_effect=None):
        def measured(root, candidate, output, artifacts, reuse_reference=False):
            if failure and not reuse_reference:
                raise RuntimeError(failure)
            score = 0 if reuse_reference else after_score
            report = {
                "scope": "synthetic unit-test evidence; model measurement not run",
                "judge_sha256": "fixture-judge",
                "cases_sha256": "fixture-cases",
                "image": "fixture-image",
                "model": {"model": "fixture"},
                "skill_sha256": gate.sha(
                    gate.canonical(gate.context(candidate.parents[2], SKILL))
                ),
                "groups": {
                    "public": {
                        "absent": 0,
                        "installed": score,
                        "possible": 1,
                        "delta": score,
                    },
                    "heldout": {"absent": 1, "installed": 1, "possible": 1, "delta": 0},
                },
                "status": "pass",
                "regressions": [],
            }
            gate.write(output, report)
            return report

        with patch.object(gate, "evaluate", side_effect=measured), patch.object(
            gate, "hooks", side_effect=hooks_effect
        ):
            result = reviewed.run(
                [self.proposal],
                self.root / ".learnings/rounds.jsonl",
                loop.append_log,
                loop.read_log,
                loop.edit_text,
                True,
                self.root,
            )
        self.worktrees.append(Path(result["worktree"]))
        return result, reviewed.directory(self.root, result["round_id"])

    def approve_fixture(self, directory):
        identifier = gate.packet(directory)[2]
        with patch.object(sys.stdin, "isatty", return_value=True), patch(
            "builtins.input", return_value="APPROVE " + identifier
        ), redirect_stdout(io.StringIO()):
            gate.review(directory, "session://unit-test/human-approval", self.root)

    def test_positive_round_cannot_accept_without_exact_human_review(self):
        result, directory = self.make_round()
        self.assertEqual(result["stop"], "review_required")
        with self.assertRaises(FileNotFoundError):
            gate.accept(directory, self.root)
        self.assertEqual(
            gate.git(Path(result["worktree"]), "rev-parse", "HEAD").decode().strip(),
            self.base,
        )
        with patch.object(sys.stdin, "isatty", return_value=False):
            with self.assertRaisesRegex(ValueError, "interactive terminal"):
                gate.review(directory, "session://unit-test/review", self.root)
        self.assertFalse((directory / "approval.json").exists())

    def test_reviewed_acceptance_is_one_commit_passes_admission_and_reverts(self):
        result, directory = self.make_round()
        self.approve_fixture(directory)
        with patch.object(gate, "hooks"):
            commit = gate.accept(directory, self.root)
        candidate = Path(result["worktree"])
        self.assertEqual(
            gate.git(candidate, "rev-list", "--count", self.base + "..HEAD").strip(),
            b"1",
        )
        gate.check_commit_range(self.base, commit, self.root)
        self.assertEqual((self.root / RELATIVE / "SKILL.md").read_text(), ORIGINAL)
        gate.git(candidate, "revert", "--no-edit", commit)
        self.assertEqual((candidate / RELATIVE / "SKILL.md").read_text(), ORIGINAL)
        gate.check_commit_range(
            self.base,
            gate.git(candidate, "rev-parse", "HEAD").decode().strip(),
            self.root,
        )

    def test_zero_gain_restores_snapshot_and_blocks_renamed_repeat(self):
        result, directory = self.make_round(after_score=0)
        self.assertEqual((result["stop"], result["gain"]), ("reverted", 0))
        self.assertEqual(
            (Path(result["worktree"]) / RELATIVE / "SKILL.md").read_text(), ORIGINAL
        )
        self.assertEqual(
            gate.git(Path(result["worktree"]), "status", "--porcelain"), b""
        )
        self.proposal["idea"] = "different-name-same-rejected-edit"
        with patch.object(gate, "evaluate") as evaluate:
            repeated = reviewed.run(
                [self.proposal],
                self.root / ".learnings/rounds.jsonl",
                loop.append_log,
                loop.read_log,
                loop.edit_text,
                True,
                self.root,
            )
        self.assertEqual(repeated["stop"], "repeated_rejection")
        evaluate.assert_not_called()
        with self.assertRaises((ValueError, FileNotFoundError)):
            gate.accept(directory, self.root)

    def test_failed_measurement_has_no_invented_score_and_restores_files(self):
        result, _ = self.make_round(failure="inference failed")
        self.assertEqual(result["after"], "not run")
        self.assertEqual(result["gain"], "not run")
        self.assertEqual(
            (Path(result["worktree"]) / RELATIVE / "SKILL.md").read_text(), ORIGINAL
        )

    def test_approval_cannot_survive_changed_candidate_or_evidence(self):
        result, directory = self.make_round()
        self.approve_fixture(directory)
        target = Path(result["worktree"]) / RELATIVE / "SKILL.md"
        expected = target.read_text()
        target.write_text(expected + "Changed after review.\n")
        with self.assertRaises(ValueError):
            gate.accept(directory, self.root)
        target.write_text(expected)
        evidence = json.loads((directory / "after.json").read_text())
        evidence["status"] = "fail"
        gate.write(directory / "after.json", evidence)
        with self.assertRaisesRegex(ValueError, "evidence changed"):
            gate.accept(directory, self.root)

    def test_gate_or_base_change_invalidates_review(self):
        _, directory = self.make_round()
        self.approve_fixture(directory)
        protected = self.root / "tools/skill-eval/fixed.txt"
        protected.write_text("changed judge\n")
        with self.assertRaisesRegex(ValueError, "gate changed"):
            gate.accept(directory, self.root)
        protected.write_text("fixed judge fixture\n")
        gate.git(self.root, "commit", "--allow-empty", "-qm", "Advance base")
        with self.assertRaisesRegex(ValueError, "base changed"):
            gate.accept(directory, self.root)

    def test_unexpected_files_staging_modes_and_symlinks_are_rejected(self):
        result, directory = self.make_round()
        candidate = Path(result["worktree"])
        extra = candidate / "extra.py"
        extra.write_text("pass\n")
        with self.assertRaisesRegex(ValueError, "untracked"):
            gate.verify(directory, self.root)
        extra.unlink()
        target = candidate / RELATIVE / "SKILL.md"
        gate.git(candidate, "add", str(target))
        with self.assertRaisesRegex(ValueError, "index"):
            gate.verify(directory, self.root)
        gate.git(candidate, "restore", "--staged", "--", str(target))
        target.chmod(0o755)
        with self.assertRaises(ValueError):
            gate.verify(directory, self.root)
        target.chmod(0o644)
        text = target.read_text()
        target.unlink()
        target.symlink_to(self.root / RELATIVE / "SKILL.md")
        with self.assertRaises(ValueError):
            gate.verify(directory, self.root)
        target.unlink()
        target.write_text(text)

    def test_proposal_cannot_touch_judge_or_exceed_edit_budget(self):
        for path in [
            "../../tools/skill-eval/gate.py",
            "evals/eval.yaml",
            "/outside/escape",
            "agents/openai.yaml",
        ]:
            proposal = copy.deepcopy(self.proposal)
            proposal["edits"][0]["path"] = path
            with self.assertRaises(ValueError):
                gate.validate(proposal)
        proposal = copy.deepcopy(self.proposal)
        proposal["edits"] *= 4
        with self.assertRaises(ValueError):
            gate.validate(proposal)

    def test_unreviewed_commit_is_rejected_by_ci_admission(self):
        target = self.root / RELATIVE / "SKILL.md"
        target.write_text(ORIGINAL + "Unreviewed.\n")
        gate.git(self.root, "add", ".")
        gate.git(self.root, "commit", "-qm", "Unreviewed skill edit")
        with self.assertRaisesRegex(ValueError, "approval receipt"):
            gate.check_commit_range(self.base, root=self.root)

    def test_bridge_cannot_overwrite_frozen_measurements(self):
        baseline = REPOSITORY / "tools/skill-eval/maintenance/baseline.json"
        original = baseline.read_bytes()
        result = subprocess.run(
            [
                sys.executable,
                "-I",
                str(REPOSITORY / "tools/skill-eval/maintenance_bridge.py"),
                "--candidate",
                str(REPOSITORY / RELATIVE),
                "--output",
                str(baseline),
                "--artifacts",
                str(self.root / "artifacts"),
                "--reuse-reference",
                "--allow-model-network",
            ],
            capture_output=True,
            text=True,
            check=False,
        )  # nosec B603
        self.assertEqual(result.returncode, 2)
        self.assertIn("controller-owned", result.stderr)
        self.assertEqual(baseline.read_bytes(), original)

    def test_net_zero_unreviewed_history_still_fails_admission(self):
        target = self.root / RELATIVE / "SKILL.md"
        target.write_text(ORIGINAL + "Unreviewed.\n")
        gate.git(self.root, "add", ".")
        gate.git(self.root, "commit", "-qm", "Unreviewed edit")
        target.write_text(ORIGINAL)
        gate.git(self.root, "add", ".")
        gate.git(self.root, "commit", "-qm", "Restore without review")
        self.assertFalse(gate.changed(self.root, self.base, "HEAD"))
        with self.assertRaisesRegex(ValueError, "approval receipt"):
            gate.check_commit_range(self.base, root=self.root)

    def test_hook_side_effects_are_preserved_and_snapshot_is_clean(self):
        def side_effect(candidate, files):
            (candidate / ".gitignore").write_text("unexpected hook change\n")
            (candidate / "unexpected.txt").write_text("retained hook output\n")

        result, directory = self.make_round(hooks_effect=side_effect)
        candidate = Path(result["worktree"])
        self.assertEqual(result["stop"], "rejected")
        self.assertEqual(gate.git(candidate, "status", "--porcelain"), b"")
        self.assertEqual(
            (directory / "quarantine/unexpected.txt").read_text(),
            "retained hook output\n",
        )
        self.assertIn(
            "unexpected hook change", (directory / "rollback.patch").read_text()
        )

    def test_rejection_matches_result_even_when_edits_are_split(self):
        self.make_round(after_score=0)
        self.proposal["idea"] = "renamed-split-edit"
        self.proposal["edits"] = [
            {
                "path": "SKILL.md",
                "old": "Verify the fix.",
                "new": "Verify the fix and reproduce.",
            },
            {
                "path": "SKILL.md",
                "old": "Verify the fix and reproduce.",
                "new": "Reproduce the failure, then verify the fix.",
            },
        ]
        with patch.object(gate, "evaluate") as evaluate:
            result = reviewed.run(
                [self.proposal],
                self.root / ".learnings/rounds.jsonl",
                loop.append_log,
                loop.read_log,
                loop.edit_text,
                True,
                self.root,
            )
        self.assertEqual(result["stop"], "repeated_rejection")
        evaluate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
