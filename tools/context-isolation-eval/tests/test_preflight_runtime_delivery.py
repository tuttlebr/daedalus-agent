"""Scripted delivery editions obey the actual canonical renderer contract."""

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
ROOT = HERE.parents[1]
CANONICAL = ROOT / "skills/daily-summary"
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


preflight = load("scripted_delivery_test", HERE / "preflight_runtime_delivery.py")
contract = load("scripted_delivery_contract", CANONICAL / "scripts/edition_contract.py")
renderer = load("scripted_delivery_renderer", CANONICAL / "scripts/render_daybook.py")
validator = load(
    "scripted_delivery_validator", CANONICAL / "scripts/validate_daybook.py"
)


class ScriptedDeliveryEditionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name)
        cls.bundle = cls.root / "synthetic-skills"
        preflight.run.make_synthetic_bundle(cls.bundle)
        cls.policy_path = cls.bundle / "daily-summary/references/edition-policy.json"
        cls.policy = json.loads(cls.policy_path.read_text())
        cls.workload = json.loads((HERE / "workload.json").read_text())
        cls.cases = {case["id"]: case for case in cls.workload["cases"]}
        cls.template = (CANONICAL / "assets/daybook-v4.html").read_text()

    def edition(self, case_id="personal-heavy"):
        return preflight._edition(self.cases[case_id], self.workload, self.policy)

    def test_editions_are_structurally_valid_without_input_mutation(self):
        initial = copy.deepcopy((self.cases, self.workload, self.policy))
        for case_id in ("personal-heavy", "long-context"):
            with self.subTest(case=case_id):
                edition = self.edition(case_id)
                self.assertEqual(list(contract.validate_edition(edition)), [])
                self.assertTrue(edition["lead"]["dek"].strip())
                self.assertEqual(edition["generated_at"]["iso"], self.workload["as_of"])
                self.assertEqual(
                    edition["policy_version"], self.policy["policy_version"]
                )
                self.assertEqual(
                    edition["lead"]["source"]["url"],
                    self.cases[case_id]["public_sources"][0]["url"],
                )
                self.assertIn("no editorial quality", edition["description"])
                serialized = json.dumps(edition)
                self.assertNotIn(
                    self.cases[case_id]["local_inputs"]["derived_summary"], serialized
                )
                self.assertNotIn(
                    self.cases[case_id]["local_inputs"]["memory"], serialized
                )
        self.assertEqual((self.cases, self.workload, self.policy), initial)

    def test_actual_canonical_renderer_and_html_validator_accept_both_editions(self):
        for case_id in ("personal-heavy", "long-context"):
            with self.subTest(case=case_id):
                edition = self.edition(case_id)
                document, manifest, metrics = renderer.render_daybook(
                    edition, self.policy, self.template
                )
                html_path = self.root / f"{case_id}.html"
                manifest_path = self.root / f"{case_id}-coverage.json"
                html_path.write_text(document)
                manifest_path.write_text(json.dumps(manifest))
                result = validator.validate_daybook(
                    html_path, manifest_path, self.policy_path
                )
                self.assertTrue(result["passed"], result["errors"])
                self.assertEqual(result["errors"], [])
                self.assertTrue(document.startswith("<!DOCTYPE html>"))
                self.assertEqual(manifest["lead_desk"], "technology")
                self.assertEqual(len(manifest["desks"]), len(self.policy["desks"]))
                self.assertEqual(metrics["departments"], 0)

    def test_missing_lead_dek_reproduces_structural_failure_before_rendering(self):
        edition = self.edition()
        del edition["lead"]["dek"]
        errors = contract.validate_edition(edition)
        self.assertTrue(any("edition.lead.dek" in error for error in errors))
        with self.assertRaisesRegex(renderer.RenderError, r"edition\.lead\.dek"):
            renderer.render_daybook(edition, self.policy, self.template)

    def test_coverage_mismatch_passes_shape_but_fails_renderer_semantics(self):
        edition = self.edition()
        next(item for item in edition["coverage"] if item["desk_key"] == "technology")[
            "status"
        ] = "unavailable"
        self.assertEqual(list(contract.validate_edition(edition)), [])
        with self.assertRaisesRegex(
            renderer.RenderError, "selected lead desk must be covered"
        ):
            renderer.render_daybook(edition, self.policy, self.template)

    def test_corrupted_html_cannot_pass_the_actual_validator(self):
        document, manifest, _ = renderer.render_daybook(
            self.edition(), self.policy, self.template
        )
        html_path = self.root / "corrupted.html"
        manifest_path = self.root / "corrupted-coverage.json"
        html_path.write_text(
            document.replace(
                'data-daybook-version="4"', 'data-daybook-version="invalid"'
            )
        )
        manifest_path.write_text(json.dumps(manifest))
        result = validator.validate_daybook(html_path, manifest_path, self.policy_path)
        self.assertFalse(result["passed"])
        self.assertTrue(any("version" in error for error in result["errors"]))


if __name__ == "__main__":
    unittest.main()
