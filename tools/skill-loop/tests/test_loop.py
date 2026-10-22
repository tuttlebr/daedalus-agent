import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "loop", Path(__file__).resolve().parents[1] / "loop.py"
)
loop = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(loop)


class LoopTests(unittest.TestCase):
    def test_editor_requires_unambiguous_local_replacement(self):
        self.assertEqual(
            loop.edit_text("one two", [{"old": "two", "new": "three"}]), "one three"
        )
        with self.assertRaises(ValueError):
            loop.edit_text("one one", [{"old": "one", "new": "two"}])

    def test_invalid_python_is_restored_and_logged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = []

            def fake_git(*args, **kwargs):
                if args[:2] == ("worktree", "add"):
                    candidate = (
                        Path(args[4])
                        / "skills/fantasy-football-recap/scripts/check_scoreboard.py"
                    )
                    candidate.parent.mkdir(parents=True)
                    candidate.write_text("x = 1\n")
                    paths.append(candidate)
                return ""

            proposal = {
                "skill": "fantasy-football-recap",
                "idea": "invalid-syntax",
                "edits": [
                    {
                        "path": "scripts/check_scoreboard.py",
                        "old": "x = 1",
                        "new": "x = (",
                    }
                ],
            }
            with patch.object(loop, "git", side_effect=fake_git), patch.object(
                loop.gate, "evaluate", return_value={"score": 1}
            ), patch.object(loop.tempfile, "mkdtemp", return_value=str(root)):
                result = loop.run([proposal], root / "history.jsonl")
            self.assertEqual(paths[0].read_text(), "x = 1\n")
            self.assertEqual(result["rounds"][0]["decision"], "rejected")
            self.assertEqual(result["rounds"][0]["after"], "not run")

    def test_repeated_rejection_never_runs_another_evaluation(self):
        with tempfile.TemporaryDirectory() as directory:
            history = Path(directory) / "history.jsonl"
            loop.append_log(
                history,
                {
                    "skill": "fantasy-football-recap",
                    "idea": "bad-idea",
                    "decision": "reverted",
                },
            )
            proposal = {
                "skill": "fantasy-football-recap",
                "idea": "bad-idea",
                "edits": [
                    {
                        "path": "scripts/check_scoreboard.py",
                        "old": "before",
                        "new": "after",
                    }
                ],
            }
            with patch.object(loop, "git", return_value=""), patch.object(
                loop.gate, "evaluate"
            ) as judge:
                result = loop.run([proposal], history)
            self.assertEqual(result["stop"], "repeated_rejection")
            judge.assert_not_called()

    def test_history_detects_tampering_and_retains_rejections(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rounds.jsonl"
            loop.append_log(
                path, {"decision": "reverted", "skill": "example", "idea": "discarded"}
            )
            loop.append_log(
                path, {"decision": "accepted", "skill": "example", "idea": "kept"}
            )
            self.assertEqual(loop.read_log(path)[0]["idea"], "discarded")
            path.write_text(path.read_text().replace("discarded", "changed"))
            with self.assertRaises(ValueError):
                loop.read_log(path)


if __name__ == "__main__":
    unittest.main()
