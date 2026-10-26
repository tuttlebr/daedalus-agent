"""Delivery evidence must come from complete captured requests, not markers alone."""

import copy
import importlib.util
import json
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "delivery_test_preflight", HERE / "delivery_preflight.py"
)
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)


def fixture_capture():
    inputs = {
        "message": "synthetic request",
        "attachment": "LC0000 | PRIVATE_L0000 | current fact",
        "email": "synthetic mail revision",
    }
    attachment = inputs["attachment"]
    workload = {
        "cases": [
            {
                "id": "long-context",
                "local_inputs": inputs,
                "fixture_integrity": {"local_inputs_sha256": preflight.digest(inputs)},
                "delivery_contract": {
                    "first_coordinator_fields": ["message", "attachment"],
                    "later_coordinator_fields": ["email"],
                },
                "anchor_records": [
                    {
                        "record_index": 0,
                        "source_id": "LC0000",
                        "char_offset": 0,
                        "char_end": len(attachment),
                        "text_sha256": preflight.text_digest(attachment),
                        "normalized_char_position": 0.0,
                    }
                ],
            }
        ]
    }
    first = {
        "messages": [
            {"role": "user", "content": inputs["message"] + "\n" + attachment}
        ],
        "truncation": "disabled",
    }
    second = {
        "input": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": json.dumps({"body": inputs["email"]}),
                    }
                ],
            }
        ],
        "truncation": "disabled",
    }
    rows = []
    attempts = []
    for index, body in enumerate((first, second)):
        rows.append(
            {
                "kind": "provider",
                "role": "local",
                "attempt_id": str(index),
                "runtime_request": body,
                "forwarded_request": copy.deepcopy(body),
                "provider_status": 200,
                "outcome": "completed",
            }
        )
        attempts.append(
            {
                "id": str(index),
                "outcome": "completed",
                "usage": {"input_tokens": 100 + index},
            }
        )
    capture = {
        "image_id": "sha256:" + "a" * 64,
        "captures": rows,
        "attempts": attempts,
        "result": {"done": True, "errors": []},
    }
    return workload, capture


class DeliveryPreflightTests(unittest.TestCase):
    def check(self, workload, capture):
        return preflight.check_delivery(workload, capture, "long-context", "local")

    def test_full_request_and_later_json_tool_envelope_are_verified(self):
        workload, capture = fixture_capture()
        report = self.check(workload, capture)
        self.assertTrue(report["delivery_passed"])
        self.assertTrue(report["empirical_workload_fit"])
        self.assertEqual(report["observed_max_input_tokens"], 101)
        anchor = report["requests"][0]["bodies"]["forwarded_request"]["anchors"][0]
        self.assertTrue(anchor["present"])
        self.assertEqual(anchor["field_path"], "$.messages[0].content")
        serialized = json.dumps(report)
        self.assertNotIn(workload["cases"][0]["local_inputs"]["attachment"], serialized)
        self.assertNotIn("synthetic mail revision", serialized)

    def test_missing_middle_text_fails_even_if_all_markers_survive(self):
        workload, capture = fixture_capture()
        capture["captures"][0]["forwarded_request"]["messages"][0]["content"] = (
            "synthetic request\nLC0000 | PRIVATE_L0000 | clipped fact"
        )
        report = self.check(workload, capture)
        self.assertFalse(report["delivery_passed"])
        self.assertFalse(report["empirical_workload_fit"])

    def test_missing_later_private_source_is_explicit_not_assumed_delivered(self):
        workload, capture = fixture_capture()
        capture["captures"].pop()
        report = self.check(workload, capture)
        self.assertFalse(report["later_source_delivery"]["email"])
        self.assertFalse(report["delivery_passed"])

    def test_first_capture_must_include_corpus_even_if_a_later_one_does(self):
        workload, capture = fixture_capture()
        empty = copy.deepcopy(capture["captures"][0])
        empty["runtime_request"] = {"input": "clipped"}
        empty["forwarded_request"] = {"input": "clipped"}
        capture["captures"].insert(0, empty)
        self.assertFalse(self.check(workload, capture)["delivery_passed"])

    def test_incorrect_anchor_manifest_and_fixture_integrity_are_rejected(self):
        for mutation in ("anchor", "source"):
            workload, capture = fixture_capture()
            if mutation == "anchor":
                workload["cases"][0]["anchor_records"][0]["text_sha256"] = "f" * 64
            else:
                workload["cases"][0]["local_inputs"]["message"] += " changed"
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.check(workload, capture)

    def test_remote_session_and_unrecognized_truncation_prevent_delivery_pass(self):
        for field, value in (
            ("previous_response_id", "opaque-old-session"),
            ("truncation", "invalid"),
        ):
            workload, capture = fixture_capture()
            capture["captures"][0]["forwarded_request"][field] = value
            self.assertFalse(self.check(workload, capture)["delivery_passed"])

    def test_automatic_truncation_is_a_limitation_not_proof_of_actual_clipping(self):
        workload, capture = fixture_capture()
        capture["captures"][0]["forwarded_request"]["truncation"] = "auto"
        report = self.check(workload, capture)
        self.assertTrue(report["delivery_passed"])
        self.assertEqual(
            report["remote_context_truncation"],
            "automatic_requested_actual_remote_truncation_unknown",
        )

    def test_unknown_remote_default_stays_unknown_without_inventing_capacity(self):
        workload, capture = fixture_capture()
        for row in capture["captures"]:
            row["forwarded_request"].pop("truncation")
        report = self.check(workload, capture)
        self.assertTrue(report["delivery_passed"])
        self.assertEqual(
            report["remote_context_truncation"],
            "unknown_unless_verified_from_provider_contract",
        )
        self.assertIn("unknown", " ".join(report["limits"]))

    def test_mock_capture_or_failed_provider_cannot_establish_empirical_fit(self):
        for condition in ("mock", "provider", "workflow", "image"):
            workload, capture = fixture_capture()
            if condition == "mock":
                capture["mock_only"] = True
            elif condition == "provider":
                capture["captures"][0]["provider_status"] = 400
            elif condition == "workflow":
                capture["result"]["done"] = False
            else:
                capture["image_id"] = None
            with self.subTest(condition=condition):
                report = self.check(workload, capture)
                self.assertTrue(report["delivery_passed"])
                self.assertFalse(report["empirical_workload_fit"])

    def test_first_coordinator_selection_ignores_public_worker_requests(self):
        workload, capture = fixture_capture()
        capture["captures"].insert(
            0,
            {
                "kind": "provider",
                "role": "high",
                "runtime_request": {"input": "public evidence"},
            },
        )
        self.assertTrue(self.check(workload, capture)["delivery_passed"])
        with self.assertRaises(ValueError):
            preflight.check_delivery(workload, capture, "long-context", "high")


if __name__ == "__main__":
    unittest.main()
