import importlib.util
import tempfile
import unittest
from pathlib import Path

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
