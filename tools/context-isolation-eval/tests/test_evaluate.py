"""The release comparison rejects incomplete or misleading measurements."""

import copy
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "context_isolation_evaluate", ROOT / "evaluate.py"
)
evaluate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evaluate)


def measurement(workload):
    return {
        "schema_version": 1,
        "workload_sha256": evaluate.workload_digest(workload),
        "configuration": {
            "runtime_image": "synthetic-runtime@sha256:fixture",
            "gateway_image": "direct-provider-path-v1",
            "model_versions": {"local": "synthetic-v1", "public": "synthetic-v1"},
            "config_sha256": "synthetic-config-fixture",
        },
        "privacy_evidence": {
            "artifact_sha256": "synthetic-capture-fixture",
            "reviewer": "test-only-reviewer",
            **dict.fromkeys(evaluate.REQUIRED_PRIVACY_CHECKS, True),
        },
        "cases": [
            {
                "case_id": case["id"],
                "repetition": repetition,
                "successful": True,
                "output_contract_passed": True,
                "latency_ms": 1000,
                "factuality": {"supported_claims": 2, "total_claims": 2},
                "omissions": {
                    "missing_required": 0,
                    "total_required": len(case["required_facts"]),
                },
                "sources": {"correct_citations": 1, "total_citations": 1},
                "attempt_count": 1,
                "attempts": [
                    {
                        "id": "one",
                        "phase": "public_retrieval",
                        "profile": "medium",
                        "target": "synthetic",
                        "outcome": "success",
                        "latency_ms": 800,
                        "cost_usd": 0.1,
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 50,
                            "cached_input_tokens": None,
                        },
                    }
                ],
            }
            for case in workload["cases"]
            for repetition in range(workload["repetitions"])
        ],
    }


class EvaluationTests(unittest.TestCase):
    def setUp(self):
        self.workload = json.loads((ROOT / "workload.json").read_text())
        self.baseline = measurement(self.workload)
        self.candidate = copy.deepcopy(self.baseline)
        for case in self.candidate["cases"]:
            case["latency_ms"] = 800

    def compare(self):
        return evaluate.compare(self.baseline, self.candidate, self.workload)

    def test_passes_only_with_measured_benefit(self):
        self.assertTrue(self.compare()["passed"])
        self.candidate = copy.deepcopy(self.baseline)
        self.assertFalse(self.compare()["passed"])

    def test_exact_ten_percent_benefit_is_accepted(self):
        for case in self.candidate["cases"]:
            case["latency_ms"] = 900
        self.assertTrue(self.compare()["passed"])

    def test_missing_failed_attempt_and_missing_case_rejected(self):
        self.candidate["cases"][0]["attempt_count"] = 2
        with self.assertRaises(ValueError):
            self.compare()
        self.candidate = copy.deepcopy(self.baseline)
        self.candidate["cases"].pop()
        with self.assertRaises(ValueError):
            self.compare()

    def test_unknown_cost_and_cache_usage_remain_unknown(self):
        self.candidate["cases"][0]["attempts"][0]["cost_usd"] = None
        report = self.compare()
        self.assertIsNone(report["candidate"]["cost_usd"])
        self.assertIsNone(report["candidate"]["usage"]["cached_input_tokens"])
        self.assertIsNone(report["cost_reduction"])
        self.assertTrue(report["passed"])
        for case in self.candidate["cases"]:
            case["latency_ms"] = 1000
        self.assertFalse(self.compare()["passed"])

    def test_private_candidate_or_unreviewed_capture_rejected(self):
        self.candidate["privacy_evidence"]["AC-01"] = False
        with self.assertRaises(ValueError):
            self.compare()
        self.candidate["privacy_evidence"]["AC-01"] = True
        del self.candidate["privacy_evidence"]["reviewer"]
        with self.assertRaises(ValueError):
            self.compare()

    def test_legacy_baseline_privacy_failure_is_visible(self):
        self.baseline["privacy_evidence"]["AC-01"] = False
        report = self.compare()
        self.assertFalse(report["baseline"]["privacy_checks"]["AC-01"])
        self.assertTrue(report["passed"])

    def test_failed_briefings_are_counted_and_candidate_contract_failure_rejects(self):
        self.baseline["cases"][0]["successful"] = False
        self.baseline["cases"][0]["output_contract_passed"] = False
        report = self.compare()
        self.assertLess(report["baseline"]["completion_rate"], 1)
        self.assertTrue(report["passed"])
        self.candidate["cases"][0]["output_contract_passed"] = False
        self.assertFalse(self.compare()["passed"])

    def test_frozen_cases_cannot_be_replaced(self):
        self.workload["cases"][0]["required_facts"].pop()
        with self.assertRaises(ValueError):
            self.compare()

    def test_omitted_fact_rejects_even_with_cheaper_faster_run(self):
        self.candidate["cases"][0]["omissions"]["missing_required"] = 1
        report = self.compare()
        self.assertFalse(report["passed"])
        self.assertFalse(report["checks"]["per_case_quality"])

    def test_retry_cost_and_usage_are_included(self):
        retry = copy.deepcopy(self.candidate["cases"][0]["attempts"][0])
        retry.update(id="two", outcome="timeout", cost_usd=0.2)
        self.candidate["cases"][0]["attempts"].append(retry)
        self.candidate["cases"][0]["attempt_count"] = 2
        report = self.compare()
        self.assertAlmostEqual(report["candidate"]["cost_usd"], 2.6)
        self.assertEqual(report["candidate"]["usage"]["input_tokens"], 2500)

    def test_unavailable_source_can_have_no_citations(self):
        for run in (self.baseline, self.candidate):
            run["cases"][0]["sources"] = {"correct_citations": 0, "total_citations": 0}
        self.assertTrue(self.compare()["passed"])


if __name__ == "__main__":
    unittest.main()
