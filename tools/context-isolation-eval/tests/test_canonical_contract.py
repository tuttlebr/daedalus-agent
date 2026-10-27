"""Score delivered output against actual renderer outcomes, never proposals alone."""

import copy
import hashlib
import importlib.util
import json
import runpy
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


fixture = load("canonical_contract_fixture", HERE / "runtime_fixture.py")
preflight = load("canonical_contract_preflight", HERE / "preflight_runtime_delivery.py")


class CanonicalContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name)
        cls.original_bundle = cls.root / "original-bundle"
        preflight.run.make_synthetic_bundle(cls.original_bundle)
        cls.workload = json.loads((HERE / "workload.json").read_text())
        cls.case = next(
            item for item in cls.workload["cases"] if item["id"] == "personal-heavy"
        )

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=self.root)
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name)
        self.bundle = self.output / "bundle"
        shutil.copytree(self.original_bundle, self.bundle)
        self.skill = self.bundle / "daily-summary"
        self.policy = json.loads(
            (self.skill / "references/edition-policy.json").read_text()
        )
        self.edition = preflight._edition(self.case, self.workload, self.policy)

    def rendered(self):
        renderer = runpy.run_path(str(self.skill / "scripts/render_daybook.py"))
        document, _, _ = renderer["render_daybook"](
            self.edition,
            self.policy,
            (self.skill / "assets/daybook-v4.html").read_text(),
        )
        return f"```html\n{document}\n```"

    def events(self, value, *, identity="renderer-1", parent="workflow-1"):
        start = {
            "id": identity,
            "parent_id": parent,
            "name": "Function Start: briefing_renderer_tool",
            "payload": {"edition": copy.deepcopy(self.edition)},
        }
        end = {
            "id": identity,
            "parent_id": parent,
            "name": "Function Complete: briefing_renderer_tool",
            "payload": json.dumps(value) if isinstance(value, dict) else value,
        }
        return start, end

    def result(self, answer, *pairs):
        return {
            "answer": answer,
            "done": True,
            "terminal": "stop",
            "errors": [],
            "starts": [start for start, _ in pairs],
            "ends": [end for _, end in pairs],
        }

    def check(self, result):
        before = copy.deepcopy(result)
        checked = fixture._canonical_contract(result, self.bundle, self.output)
        self.assertEqual(result, before)
        return checked

    def failure(self):
        return {
            "passed": False,
            "stage": "validate_daybook.py",
            "failure_type": "validation",
            "errors": ["document contains active content"],
            "attempts_remaining": 1,
            "next_step": "Retry once, or deliver sourced text with honest gaps.",
        }

    def test_failed_unpublished_document_defers_text_fallback_to_manual_review(self):
        # An independently regenerated rejected document must remain diagnostic;
        # only the sourced text was delivered. Use the real HTML validator.
        template = self.skill / "assets/daybook-v4.html"
        template.write_text(template.read_text() + "<script>unsafe()</script>\n")
        start, end = self.events(self.failure())
        checked = self.check(
            self.result("Sourced findings: https://example.org/evidence", (start, end))
        )
        self.assertIsNone(checked["passed"])
        self.assertIn("sourced text fallback", checked["reason"])
        self.assertFalse(checked["canonical_validation"]["passed"])
        self.assertFalse(checked["exact_inline_match"])
        self.assertEqual(checked["renderer_executions"], 1)
        self.assertEqual(checked["renderer_outcomes"][0]["outcome"], "failed")
        self.assertEqual(
            checked["renderer_outcomes"][0]["proposal_sha256"],
            hashlib.sha256(
                json.dumps(
                    start["payload"], sort_keys=True, separators=(",", ":")
                ).encode()
            ).hexdigest(),
        )

    def test_successful_canonical_result_requires_exact_html_publication(self):
        html = self.rendered()
        pair = self.events(html)
        checked = self.check(self.result(html, pair))
        self.assertTrue(checked["passed"])
        self.assertTrue(checked["canonical_validation"]["passed"])
        self.assertTrue(checked["exact_inline_match"])
        self.assertFalse(
            self.check(self.result("Sourced text instead of available HTML.", pair))[
                "passed"
            ]
        )
        self.assertFalse(self.check(self.result(html + "changed", pair))["passed"])

    def test_proposal_without_successful_execution_cannot_approve_html(self):
        html = self.rendered()
        for value in (
            self.failure(),
            {"executed": False, "error": "context_policy_rejected"},
        ):
            with self.subTest(value=value):
                self.assertFalse(
                    self.check(self.result(html, self.events(value)))["passed"]
                )

    def test_unsafe_or_noncanonical_html_is_not_plain_text_fallback(self):
        for answer in (
            "<script>unsafe()</script>",
            '<img src="https://example.invalid/image" onerror="unsafe()">',
            "<!doctype html><html>hand-authored</html>",
            "```html\nA purported HTML output without canonical bytes.\n```",
        ):
            with self.subTest(answer=answer):
                self.assertFalse(
                    self.check(self.result(answer, self.events(self.failure())))[
                        "passed"
                    ]
                )

    def test_three_actual_executions_fail_even_with_sourced_text(self):
        pairs = [self.events(self.failure(), identity=str(i)) for i in range(3)]
        checked = self.check(self.result("Sourced text with explicit gaps.", *pairs))
        self.assertIs(checked["passed"], False)
        self.assertEqual(checked["renderer_executions"], 3)

    def test_policy_rejections_do_not_consume_execution_budget(self):
        pairs = [
            self.events(
                {"executed": False, "error": "context_policy_rejected"},
                identity=str(i),
            )
            for i in range(4)
        ]
        pairs.append(self.events(self.failure()))
        checked = self.check(self.result("Sourced text with explicit gaps.", *pairs))
        self.assertIsNone(checked["passed"])
        self.assertEqual(checked["renderer_executions"], 1)
        self.assertEqual(len(checked["renderer_outcomes"]), 5)
        self.assertEqual(
            [item["outcome"] for item in checked["renderer_outcomes"]],
            ["not_executed"] * 4 + ["failed"],
        )

    def test_latest_failed_proposal_does_not_replace_successful_rendered_html(self):
        html = self.rendered()
        success = self.events(html)
        failed = self.events(self.failure(), identity="renderer-2")
        del failed[0]["payload"]["edition"]["lead"]["dek"]
        checked = self.check(self.result(html, success, failed))
        self.assertTrue(checked["passed"])
        self.assertEqual(checked["renderer_executions"], 2)
        self.assertEqual(checked["renderer_outcomes"][-1]["outcome"], "failed")

    def test_success_must_pair_with_its_own_start_and_workflow(self):
        html = self.rendered()
        start, end = self.events(html)
        end["parent_id"] = "different-workflow"
        self.assertFalse(self.check(self.result(html, (start, end)))["passed"])
        # Reusing a call ID cannot make the last result apply to every start.
        success = self.events(html)
        failure = self.events(self.failure())
        checked = self.check(self.result(html, success, failure))
        self.assertTrue(checked["passed"])
        self.assertEqual(checked["renderer_executions"], 2)
        self.assertEqual(
            [item["outcome"] for item in checked["renderer_outcomes"]],
            ["succeeded", "failed"],
        )

    def test_incomplete_runtime_and_errors_remain_failures(self):
        for change in (
            {"done": False},
            {"terminal": "length"},
            {"errors": [{"kind": "TimeoutError"}]},
            {"answer": ""},
        ):
            result = self.result("Sourced findings with explicit source gaps.")
            result.update(change)
            with self.subTest(change=change):
                self.assertIs(self.check(result)["passed"], False)

    def test_plain_sourced_output_without_renderer_is_never_automatic_success(self):
        checked = self.check(
            self.result("Sourced findings: https://example.org/evidence")
        )
        self.assertIsNone(checked["passed"])


if __name__ == "__main__":
    unittest.main()
