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
MEMORY_SPEC = importlib.util.spec_from_file_location(
    "delivery_test_private_memory", HERE / "private_memory_fixture.py"
)
memory_fixture = importlib.util.module_from_spec(MEMORY_SPEC)
MEMORY_SPEC.loader.exec_module(memory_fixture)


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


def private_memory_capture(case_id="personal-heavy", *, chat=False):
    """Use frozen evidence and separately observed native memory read receipts."""
    frozen = json.loads((HERE / "workload.json").read_text())
    source = next(case for case in frozen["cases"] if case["id"] == case_id)
    workload, capture = fixture_capture()
    case = workload["cases"][0]
    inputs = case["local_inputs"]
    for name in ("memory", "derived_summary"):
        inputs[name] = source["local_inputs"][name]
    case["fixture_integrity"]["local_inputs_sha256"] = preflight.digest(inputs)
    case["delivery_contract"]["later_coordinator_fields"].extend(
        ["memory", "derived_summary"]
    )
    payload = {
        "source": "automatic_hindsight",
        "session_brief": None,
        "knowledge_pages": memory_fixture.memory_pages(source),
        "precise_facts": memory_fixture.recall_records(source, frozen["as_of"]),
    }
    content = "[MEMORY_CONTEXT]\n" + json.dumps(payload)
    for kind in ("runtime_request", "forwarded_request"):
        body = capture["captures"][1][kind]
        if chat:
            body["messages"] = body.pop("input")
            body["messages"].append({"role": "user", "content": content})
        else:
            body["input"].append(
                {"role": "user", "content": [{"type": "input_text", "text": content}]}
            )
    bank = "/v1/default/banks/synthetic-local"
    capture["source_calls"] = [
        {
            "kind": "memory",
            "method": "GET",
            "path": bank + "/knowledge-base/pages/" + page["id"],
        }
        for page in payload["knowledge_pages"]
    ] + [{"kind": "memory", "method": "POST", "path": bank + "/memories/recall"}]
    capture["mock_only"] = True
    return workload, capture


def mutate_native_memory(capture, mutation, *, kinds=None):
    for kind in kinds or ("runtime_request", "forwarded_request"):
        message = capture["captures"][1][kind]["input"][-1]
        payload = json.loads(message["content"][0]["text"].split("\n", 1)[1])
        mutation(payload)
        message["content"][0]["text"] = "[MEMORY_CONTEXT]\n" + json.dumps(payload)


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

    def test_frozen_memory_pages_and_existing_recall_are_verified_without_empirical_claim(
        self,
    ):
        for case_id, chat in (("personal-heavy", False), ("long-context", True)):
            with self.subTest(case=case_id, chat=chat):
                workload, capture = private_memory_capture(case_id, chat=chat)
                original_workload = copy.deepcopy(workload)
                original_capture = copy.deepcopy(capture)
                report = self.check(workload, capture)
                self.assertTrue(report["delivery_passed"])
                self.assertFalse(report["empirical_workload_fit"])
                self.assertTrue(report["later_source_delivery"]["memory"])
                self.assertTrue(report["later_source_delivery"]["derived_summary"])
                for kind in ("runtime_request", "forwarded_request"):
                    fields = report["requests"][1]["bodies"][kind]["fields"]
                    memory = fields["memory"]
                    self.assertEqual(memory["method"], "ordered_existing_memory_pages")
                    self.assertTrue(memory["source_reads_verified"])
                    self.assertEqual(
                        memory["reconstructed_sha256"],
                        preflight.text_digest(
                            workload["cases"][0]["local_inputs"]["memory"]
                        ),
                    )
                    parts = memory["parts"]
                    self.assertEqual(
                        len(parts), 2 if case_id == "personal-heavy" else 1
                    )
                    self.assertEqual(
                        [part["part"] for part in parts], list(range(1, len(parts) + 1))
                    )
                    self.assertEqual(
                        fields["derived_summary"]["method"],
                        "existing_summary_pure_recall",
                    )
                serialized = json.dumps(report)
                for field in ("memory", "derived_summary"):
                    self.assertNotIn(
                        workload["cases"][0]["local_inputs"][field], serialized
                    )
                self.assertNotIn("PRIVATE_MEMORY_01", serialized)
                self.assertNotIn("PRIVATE_DERIVED_HEAVY", serialized)
                self.assertEqual(workload, original_workload)
                self.assertEqual(capture, original_capture)

    def test_memory_parts_must_be_complete_ordered_unique_and_contiguous(self):
        def overlap(pages):
            start = pages[1]["name"].split("chars=", 1)[1].split(":", 1)[0]
            pages[1]["name"] = pages[1]["name"].replace(
                f"chars={start}:", f"chars={int(start) - 1}:"
            )

        mutations = {
            "missing": lambda pages: pages.pop(),
            "reversed": lambda pages: pages.reverse(),
            "duplicate": lambda pages: pages.__setitem__(1, copy.deepcopy(pages[0])),
            "overlap": overlap,
        }
        for label, mutation in mutations.items():
            with self.subTest(mutation=label):
                workload, capture = private_memory_capture()
                mutate_native_memory(
                    capture, lambda payload: mutation(payload["knowledge_pages"])
                )
                report = self.check(workload, capture)
                self.assertFalse(report["later_source_delivery"]["memory"])
                self.assertFalse(report["delivery_passed"])
                self.assertFalse(report["empirical_workload_fit"])

    def test_native_trim_preserves_framed_pages_and_original_memory_bytes(self):
        workload, capture = private_memory_capture()

        def strip_page_edges(payload):
            for page in payload["knowledge_pages"]:
                self.assertEqual(page["body"].strip(), page["body"])
                page["body"] = page["body"].strip()

        mutate_native_memory(capture, strip_page_edges)
        report = self.check(workload, capture)
        self.assertTrue(report["later_source_delivery"]["memory"])
        self.assertTrue(report["delivery_passed"])
        self.assertFalse(report["empirical_workload_fit"])

    def test_missing_frame_or_inner_whitespace_clipping_cannot_claim_reconstruction(
        self,
    ):
        for label in ("missing_frame", "inner_whitespace", "unknown_framing"):
            workload, capture = private_memory_capture()

            def alter(payload):
                for page in payload["knowledge_pages"]:
                    raw = memory_fixture.page_text(page["body"])
                    if label == "missing_frame":
                        page["body"] = raw
                    elif label == "inner_whitespace":
                        page["body"] = "|" + raw.strip() + "|"
                    else:
                        page["name"] = page["name"].replace(
                            "framing=pipe-v1", "framing=unknown"
                        )

            mutate_native_memory(capture, alter)
            report = self.check(workload, capture)
            with self.subTest(mutation=label):
                self.assertFalse(report["later_source_delivery"]["memory"])
                self.assertFalse(report["delivery_passed"])

    def test_memory_body_and_chunk_hash_must_match_frozen_expected_source(self):
        for label in ("hash", "changed_body", "changed_body_and_hash"):
            workload, capture = private_memory_capture()

            def alter(payload):
                page = payload["knowledge_pages"][0]
                raw = memory_fixture.page_text(page["body"])
                old_hash = preflight.text_digest(raw)
                if label == "hash":
                    page["name"] = page["name"].replace(old_hash, "0" * 64)
                else:
                    changed_raw = "X" + raw[1:]
                    page["body"] = "|" + changed_raw + "|"
                    if label == "changed_body_and_hash":
                        page["name"] = page["name"].replace(
                            old_hash, preflight.text_digest(changed_raw)
                        )

            with self.subTest(mutation=label):
                mutate_native_memory(capture, alter)
                report = self.check(workload, capture)
                self.assertFalse(report["later_source_delivery"]["memory"])
                self.assertFalse(report["delivery_passed"])

    def test_every_page_requires_its_actual_get_receipt_with_matching_method_and_kind(
        self,
    ):
        for label in ("missing", "method", "kind", "different_page"):
            workload, capture = private_memory_capture()
            receipt = capture["source_calls"][1]
            if label == "missing":
                capture["source_calls"].remove(receipt)
            elif label == "method":
                receipt["method"] = "POST"
            elif label == "kind":
                receipt["kind"] = "model"
            else:
                receipt["path"] = receipt["path"].replace("part-2", "part-3")
            with self.subTest(receipt=label):
                report = self.check(workload, capture)
                self.assertFalse(report["later_source_delivery"]["memory"])
                self.assertTrue(report["later_source_delivery"]["derived_summary"])
                self.assertFalse(report["delivery_passed"])

    def test_existing_summary_requires_pure_recall_receipt_and_exact_experience_fact(
        self,
    ):
        for label in (
            "missing_recall",
            "reflect_only",
            "wrong_method",
            "no_fact",
            "wrong_type",
            "changed_fact",
            "brief_only",
        ):
            workload, capture = private_memory_capture()
            if label in {"missing_recall", "reflect_only", "wrong_method"}:
                receipt = capture["source_calls"][-1]
                if label == "missing_recall":
                    capture["source_calls"].pop()
                elif label == "reflect_only":
                    receipt["path"] = receipt["path"].replace(
                        "/memories/recall", "/reflect"
                    )
                else:
                    receipt["method"] = "GET"
            else:

                def alter(payload):
                    if label == "no_fact":
                        payload["precise_facts"] = []
                    elif label == "wrong_type":
                        payload["precise_facts"][0]["type"] = "world"
                    elif label == "changed_fact":
                        payload["precise_facts"][0]["text"] += " invented"
                    else:
                        payload["session_brief"] = payload["precise_facts"][0]["text"]
                        payload["precise_facts"] = []

                mutate_native_memory(capture, alter)
            with self.subTest(recall=label):
                report = self.check(workload, capture)
                self.assertTrue(report["later_source_delivery"]["memory"])
                self.assertFalse(report["later_source_delivery"]["derived_summary"])
                self.assertFalse(report["delivery_passed"])

    def test_model_assistant_forgery_and_wrong_source_do_not_count_as_native_memory(
        self,
    ):
        for label in ("assistant", "system", "wrong_source", "plain_text"):
            workload, capture = private_memory_capture()
            for kind in ("runtime_request", "forwarded_request"):
                message = capture["captures"][1][kind]["input"][-1]
                if label in {"assistant", "system"}:
                    message["role"] = label
                elif label == "plain_text":
                    inputs = workload["cases"][0]["local_inputs"]
                    message["content"][0]["text"] = (
                        inputs["memory"] + "\n" + inputs["derived_summary"]
                    )
            if label == "wrong_source":
                mutate_native_memory(
                    capture,
                    lambda payload: payload.__setitem__("source", "model_generated"),
                )
            with self.subTest(forgery=label):
                report = self.check(workload, capture)
                self.assertFalse(report["later_source_delivery"]["memory"])
                self.assertFalse(report["later_source_delivery"]["derived_summary"])
                self.assertFalse(report["delivery_passed"])

    def test_native_memory_must_survive_both_runtime_and_forwarded_requests(self):
        for kind in ("runtime_request", "forwarded_request"):
            workload, capture = private_memory_capture()
            mutate_native_memory(
                capture,
                lambda payload: payload.__setitem__("knowledge_pages", []),
                kinds=(kind,),
            )
            with self.subTest(body=kind):
                report = self.check(workload, capture)
                self.assertFalse(report["later_source_delivery"]["memory"])
                self.assertFalse(report["delivery_passed"])


if __name__ == "__main__":
    unittest.main()
