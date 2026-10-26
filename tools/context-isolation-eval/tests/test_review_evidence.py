"""Fixture availability needs archive provenance rather than an unrelated article."""

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("review_evidence_runner", HERE / "run.py")
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)


class ReviewEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.capture_path = self.root / "candidate-synthetic-case-0/capture.json"
        self.capture_path.parent.mkdir()
        self.workload = {
            "schema_version": 1,
            "repetitions": 3,
            "cases": [
                {
                    "id": "synthetic-case",
                    "local_inputs": {},
                    "required_facts": ["Quiet desks do not contain filler"],
                    "public_sources": [
                        {"id": "public-1", "text": "An unrelated minor release."}
                    ],
                }
            ],
        }
        (self.root / "workload.json").write_text(json.dumps(self.workload))
        self.capture_path.write_text(
            json.dumps(
                {
                    "source_calls": [{"kind": "personal_read", "name": "list_events"}],
                    "captures": [
                        {"tool_result": {"status": "not_supplied", "evidence": ""}}
                    ],
                }
            )
        )
        self.manifest = {
            "workload_sha256": runner.digest(self.workload),
            "files": {
                str(path.relative_to(self.root)): hashlib.sha256(
                    path.read_bytes()
                ).hexdigest()
                for path in (self.root / "workload.json", self.capture_path)
            },
        }
        (self.root / "artifacts.json").write_text(json.dumps(self.manifest))
        self.measurements = {
            "schema_version": 1,
            "variant": "candidate",
            "review_status": "pending",
            "workload_sha256": runner.digest(self.workload),
            "configuration": {"config_sha256": "unchanged-observed-config"},
            "privacy_evidence": {"artifact_sha256": runner.digest(self.manifest)},
            "automatic_privacy": {"violation_count": 0},
            "cases": [
                {
                    "case_id": "synthetic-case",
                    "repetition": 0,
                    "output_sha256": "unchanged-observed-output",
                    "required_facts": self.workload["cases"][0]["required_facts"],
                    "evidence_refs": ["public-1"],
                    "source_urls": [],
                    "capture_file": "candidate-synthetic-case-0/capture.json",
                    "attempts": [
                        {"outcome": "completed", "usage": {"input_tokens": 11}}
                    ],
                    "latency_ms": 17.5,
                    "automatic_output_contract": {"passed": True},
                }
            ],
        }

    def bound(self):
        return runner.bind_review_evidence(self.measurements, self.root)

    def review(self, measurements):
        review = runner.review_template(measurements)
        review.update(
            reviewer="independent-synthetic-review",
            all_claims_and_citations_reviewed=True,
        )
        review["privacy_evidence"].update(dict.fromkeys(runner.PRIVACY_CHECKS, True))
        review["cases"][0].update(
            claims=[
                {
                    "text": "No frozen calendar evidence was supplied.",
                    "supported": True,
                    "reason": "The fixture omits it and the captured result is not_supplied; this is not an empty-account claim.",
                    "evidence_refs": ["fixture.manifest", "capture.source_calls"],
                }
            ],
            citations=[],
            required_facts=[
                {
                    "fact": "Quiet desks do not contain filler",
                    "present": True,
                    "reason": "Reviewed the complete delivered synthetic output.",
                }
            ],
            output_contract_passed=True,
            output_contract_reason="Independent synthetic unit-test observation.",
        )
        return review

    def test_binding_preserves_observations_and_names_only_verified_evidence(self):
        before = copy.deepcopy(self.measurements)
        capture_bytes = self.capture_path.read_bytes()
        bound = self.bound()
        self.assertEqual(self.measurements, before)
        self.assertEqual(self.capture_path.read_bytes(), capture_bytes)
        self.assertEqual(runner._unbound_measurements(bound), before)
        self.assertEqual(bound["configuration"], before["configuration"])
        self.assertEqual(bound["cases"][0]["attempts"], before["cases"][0]["attempts"])
        self.assertEqual(bound["cases"][0]["latency_ms"], 17.5)
        self.assertEqual(bound["review_status"], "pending")
        refs = bound["cases"][0]["evidence_refs"]
        self.assertEqual(refs, ["public-1", "fixture.manifest", "capture.source_calls"])
        evidence = bound["cases"][0]["review_evidence"]
        self.assertEqual(
            evidence["fixture.manifest"]["case_sha256"],
            runner.digest(self.workload["cases"][0]),
        )
        self.assertEqual(evidence["capture.source_calls"]["source_call_count"], 1)
        self.assertEqual(
            evidence["capture.source_calls"]["artifact_sha256"],
            hashlib.sha256(capture_bytes).hexdigest(),
        )
        runner.verify_review_evidence(bound, self.root)

    def test_availability_claim_can_be_reviewed_without_article_misattribution(self):
        bound = self.bound()
        review = self.review(bound)
        self.assertNotIn("public-1", review["cases"][0]["claims"][0]["evidence_refs"])
        reviewed = runner.apply_reviews(bound, review)
        self.assertEqual(
            reviewed["cases"][0]["factuality"],
            {"supported_claims": 1, "total_claims": 1},
        )

    def test_empty_source_calls_are_explicit_without_invented_observations(self):
        self.capture_path.write_text(json.dumps({"source_calls": []}))
        self.refresh_capture_manifest()
        evidence = self.bound()["cases"][0]["review_evidence"]["capture.source_calls"]
        self.assertEqual(evidence["source_call_count"], 0)
        self.assertIn("not", evidence["scope"])
        self.assertNotIn("passed", evidence)

    def refresh_capture_manifest(self):
        self.manifest["files"]["candidate-synthetic-case-0/capture.json"] = (
            hashlib.sha256(self.capture_path.read_bytes()).hexdigest()
        )
        (self.root / "artifacts.json").write_text(json.dumps(self.manifest))
        self.measurements["privacy_evidence"]["artifact_sha256"] = runner.digest(
            self.manifest
        )

    def test_changed_capture_manifest_or_workload_is_rejected(self):
        for target in (
            self.capture_path,
            self.root / "workload.json",
            self.root / "artifacts.json",
        ):
            original = target.read_bytes()
            try:
                target.write_text("{}")
                with self.subTest(target=target.name), self.assertRaises(
                    runner.RunnerError
                ):
                    self.bound()
            finally:
                target.write_bytes(original)

    def test_missing_or_malformed_source_call_array_is_not_assumed_empty(self):
        for capture in ({}, {"source_calls": None}, {"source_calls": ["invented"]}):
            self.capture_path.write_text(json.dumps(capture))
            self.refresh_capture_manifest()
            with self.subTest(capture=capture), self.assertRaises(runner.RunnerError):
                self.bound()

    def test_wrong_case_capture_and_path_traversal_are_rejected(self):
        for relative in ("baseline-synthetic-case-0/capture.json", "../capture.json"):
            changed = copy.deepcopy(self.measurements)
            changed["cases"][0]["capture_file"] = relative
            with self.subTest(relative=relative), self.assertRaises(runner.RunnerError):
                runner.bind_review_evidence(changed, self.root)

    def test_manual_reserved_or_unknown_identity_is_rejected(self):
        for identity in ("fixture.manifest", "fixture.arbitrary", "capture.unknown"):
            changed = copy.deepcopy(self.measurements)
            changed["cases"][0]["evidence_refs"].append(identity)
            review = self.review(changed)
            with self.subTest(identity=identity), self.assertRaises(runner.RunnerError):
                runner.apply_reviews(changed, review)

    def test_tampered_binding_or_observation_does_not_survive_review(self):
        for target in ("descriptor", "observation", "workload"):
            bound = self.bound()
            if target == "descriptor":
                bound["cases"][0]["review_evidence"]["capture.source_calls"][
                    "source_call_count"
                ] = 99
            elif target == "observation":
                bound["cases"][0]["latency_ms"] = 1
            else:
                bound["workload_sha256"] = "forged"
            with self.subTest(target=target), self.assertRaises(runner.RunnerError):
                runner.apply_reviews(bound, self.review(bound))

    def test_archive_reverification_catches_changes_after_annotation(self):
        bound = self.bound()
        self.capture_path.write_text(json.dumps({"source_calls": []}))
        with self.assertRaises(runner.RunnerError):
            runner.verify_review_evidence(bound, self.root)

    def test_recomputed_descriptor_hash_cannot_override_actual_captured_calls(self):
        bound = self.bound()
        bound["cases"][0]["review_evidence"]["capture.source_calls"][
            "source_call_count"
        ] = 99
        bound["review_evidence_binding"]["descriptors_sha256"] = runner.digest(
            [row["review_evidence"] for row in bound["cases"]]
        )
        with self.assertRaises(runner.RunnerError):
            runner.verify_review_evidence(bound, self.root)

    def test_review_template_does_not_share_mutable_evidence_with_observations(self):
        bound = self.bound()
        template = runner.review_template(bound)
        template["cases"][0]["evidence_refs"].append("arbitrary")
        template["cases"][0]["review_evidence"].clear()
        runner.verify_review_evidence(bound, self.root)

    def test_old_raw_cli_creates_new_bound_report_and_template_without_network(self):
        raw = self.root / "candidate.raw.json"
        raw.write_text(json.dumps(self.measurements))
        before = raw.read_bytes()
        output = self.root / "candidate.bound.raw.json"
        arguments = [
            "--bind-review-evidence",
            "--measurements",
            str(raw),
            "--output",
            str(output),
        ]
        with mock.patch(
            "socket.create_connection", side_effect=AssertionError("unexpected network")
        ), mock.patch(
            "subprocess.run", side_effect=AssertionError("unexpected process")
        ), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(runner.main(arguments), 0)
        self.assertEqual(raw.read_bytes(), before)
        bound = json.loads(output.read_text())
        self.assertEqual(
            bound["review_evidence_binding"]["original_measurements_sha256"],
            runner.digest(self.measurements),
        )
        template = json.loads(output.with_suffix(".review.json").read_text())
        self.assertEqual(template["measurements_sha256"], runner.digest(bound))
        self.assertEqual(
            template["cases"][0]["evidence_refs"], bound["cases"][0]["evidence_refs"]
        )
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertNotEqual(runner.main(arguments), 0)

    def test_cli_rejects_detached_output_or_mixed_review_execution(self):
        raw = self.root / "candidate.raw.json"
        raw.write_text(json.dumps(self.measurements))
        for extra in (
            ["--execute"],
            ["--review", "unused"],
            ["--output", str(self.root / "nested/out.json")],
        ):
            with self.subTest(extra=extra), contextlib.redirect_stderr(io.StringIO()):
                self.assertNotEqual(
                    runner.main(
                        ["--bind-review-evidence", "--measurements", str(raw), *extra]
                    ),
                    0,
                )


if __name__ == "__main__":
    unittest.main()
