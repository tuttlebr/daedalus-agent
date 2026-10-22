"""The executor's process status cannot come from a task output file."""

import importlib.util
import json
import subprocess  # nosec B404
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "evaluate", Path(__file__).resolve().parents[1] / "evaluate.py"
)
evaluate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evaluate)


class ProcessStatusTests(unittest.TestCase):
    def test_workspace_output_cannot_override_process_exit(self):
        def executor(argv, **kwargs):
            if argv[1] == "rm":
                return subprocess.CompletedProcess(argv, 0, "", "")
            mount = next(item for item in argv if "target=/work" in item)
            work = Path(mount.split("source=", 1)[1].split(",", 1)[0])
            (work / "execution.json").write_text(json.dumps({"exit_code": 0}))
            envelope = {"exit_code": 7, "stdout": "{}\n", "stderr": ""}
            return subprocess.CompletedProcess(argv, 0, json.dumps(envelope), "")

        case = {
            "id": "status-channel",
            "prompt": "Task",
            "input": {},
            "assertions": [
                {
                    "claim": "Preserve observed process status",
                    "kind": "exit_code",
                    "equals": 7,
                }
            ],
        }
        with patch.object(evaluate.subprocess, "run", side_effect=executor):
            result = evaluate.execute(case, None, "unused-in-this-unit-test")
        self.assertEqual(result["exit_code"], 7)
        self.assertTrue(result["pass"])

    def test_real_helper_nonzero_exit_is_preserved(self):
        image = json.loads((evaluate.ENGINE / "runtime.json").read_text())["image"]
        with tempfile.TemporaryDirectory() as directory:
            skill = Path(directory)
            (skill / "scripts").mkdir()
            (skill / "scripts/check_scoreboard.py").write_text(
                "import json, sys\nfrom pathlib import Path\n"
                'Path("/work/execution.json").write_text(json.dumps({"exit_code": 0}))\n'
                'print(json.dumps({"result": "observed"}))\nsys.exit(7)\n'
            )
            case = {
                "id": "real-status",
                "prompt": "Task",
                "input": {},
                "assertions": [
                    {
                        "claim": "Preserve observed process status",
                        "kind": "exit_code",
                        "equals": 7,
                    }
                ],
            }
            result = evaluate.execute(case, skill, image)
            self.assertEqual(result["exit_code"], 7)
            self.assertTrue(result["pass"])


if __name__ == "__main__":
    unittest.main()
