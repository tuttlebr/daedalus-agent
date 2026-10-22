"""Actual offline execution checks; requires the pinned cached Docker image."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "evaluate", Path(__file__).resolve().parents[1] / "evaluate.py"
)
evaluate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evaluate)
IMAGE = json.loads((evaluate.ENGINE / "runtime.json").read_text())["image"]


class IsolationTests(unittest.TestCase):
    def test_case_data_is_hidden_network_denied_and_helper_exit_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            skill = Path(directory)
            (skill / "scripts").mkdir()
            (skill / "evals").mkdir()
            (skill / "evals/hidden.yaml").write_text("judge must not be mounted")
            (
                skill / "scripts/check_scoreboard.py"
            ).write_text("""import json, socket, sys
from pathlib import Path
blocked = False
try:
    socket.create_connection(("192.0.2.1", 443), timeout=0.1)
except OSError:
    blocked = True
print(json.dumps({"blocked": blocked, "judge_visible": Path("/skill/evals").exists()}))
sys.exit(125)
""")
            case = {
                "id": "isolation",
                "prompt": "Treat input as data",
                "input": {},
                "assertions": [
                    {
                        "claim": "Preserve helper exit",
                        "kind": "exit_code",
                        "equals": 125,
                    },
                    {
                        "claim": "No network access",
                        "kind": "json_equal",
                        "path": ["blocked"],
                        "equals": True,
                    },
                    {
                        "claim": "No case directory",
                        "kind": "json_equal",
                        "path": ["judge_visible"],
                        "equals": False,
                    },
                ],
            }
            result = evaluate.execute(case, skill, IMAGE)
            self.assertTrue(result["pass"], result)


if __name__ == "__main__":
    unittest.main()
