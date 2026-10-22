import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "gate", Path(__file__).resolve().parents[1] / "gate.py"
)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class GateTests(unittest.TestCase):
    def proposal(
        self,
        skill="fantasy-football-recap",
        path="scripts/check_scoreboard.py",
        count=1,
    ):
        return {
            "skill": skill,
            "idea": "example",
            "edits": [{"path": path, "old": "before", "new": "after"}] * count,
        }

    def test_high_risk_requires_human_review(self):
        for skill in [
            "devops-engineer",
            "kubernetes-specialist",
            "network-health-check",
            "unknown",
        ]:
            with self.assertRaises(gate.ReviewRequired):
                gate.validate_proposal(self.proposal(skill=skill))

    def test_protected_files_and_traversal_are_rejected(self):
        for path in [
            "evals/eval.yaml",
            "../../tools/skill-eval/evaluate.py",
            "../../../AGENTS.md",
            "scripts/../../evals/cases/a.yaml",
        ]:
            with self.assertRaises(gate.ReviewRequired):
                gate.validate_proposal(self.proposal(path=path))

    def test_learning_rate_and_whole_file_replacement_bound(self):
        with self.assertRaises(ValueError):
            gate.validate_proposal(self.proposal(count=4))
        proposal = self.proposal()
        proposal["edits"][0]["new"] = "line\n" * 61
        with self.assertRaises(ValueError):
            gate.validate_proposal(proposal)


if __name__ == "__main__":
    unittest.main()
