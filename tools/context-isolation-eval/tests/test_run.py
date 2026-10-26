"""The real-model runner must stay bounded and must not manufacture evidence."""

import concurrent.futures
import contextlib
import copy
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
SPEC = importlib.util.spec_from_file_location("context_isolation_run", ROOT / "run.py")
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)

# Deliberate credential marker and variable name for the leak regression.
TOKEN = "SYNTHETIC_PRIVATE_CREDENTIAL_7391"  # nosec B105
TOKEN_VARIABLE = "CONTEXT_EVAL_SYNTHETIC_TOKEN"  # nosec B105


def route_configuration():
    return {
        "schema_version": 1,
        "routes": {
            role: {
                "base_url": (
                    "http://127.0.0.1:19001/v1"
                    if role == "local"
                    else "https://provider.example.invalid/v1"
                ),
                "api_type": "responses",
                "model_name": "synthetic-" + role,
                "api_key_env": TOKEN_VARIABLE,
                "trust": "trusted_local" if role == "local" else "approved_cloud",
            }
            for role in ("baseline", "local", "medium", "high", "xhigh")
        },
    }


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.routes_file = self.root / "routes.json"

    def load(self, configuration=None, environ=None):
        self.routes_file.write_text(
            json.dumps(configuration or route_configuration()), encoding="utf-8"
        )
        return runner.load_routes(
            self.routes_file,
            {TOKEN_VARIABLE: TOKEN} if environ is None else environ,
        )

    def test_route_artifacts_and_representations_never_contain_credential_values(self):
        routes = self.load()
        self.assertEqual(set(routes), {"baseline", "local", "medium", "high", "xhigh"})
        for route in routes.values():
            self.assertNotIn(TOKEN, repr(route))
            public = json.dumps(route.public())
            self.assertNotIn(TOKEN, public)
            self.assertNotIn('"secret"', public)

    def test_routes_reject_forged_trust_inline_credentials_and_prompt_overrides(self):
        invalid = []
        config = route_configuration()
        config["routes"]["local"]["trust"] = "approved_cloud"
        invalid.append(config)
        config = route_configuration()
        config["routes"]["medium"]["api_key"] = TOKEN
        invalid.append(config)
        config = route_configuration()
        del config["routes"]["high"]
        invalid.append(config)
        config = route_configuration()
        config["schema_version"] = 2
        invalid.append(config)
        for value in (
            "https://user:secret@provider.example.invalid/v1",
            "https://provider.example.invalid/v1?private=marker",
            "https://provider.example.invalid/v1#private",
            "file:///tmp/model",
        ):
            config = route_configuration()
            config["routes"]["medium"]["base_url"] = value
            invalid.append(config)
        for field in (
            "model",
            "input",
            "messages",
            "tools",
            "metadata",
            "previous_response_id",
            "user",
            "store",
        ):
            config = route_configuration()
            config["routes"]["medium"]["extra_body"] = {field: "forged"}
            invalid.append(config)
        for config in invalid:
            with self.subTest(configuration_index=invalid.index(config)):
                with self.assertRaises(runner.RunnerError) as failure:
                    self.load(config)
                self.assertNotIn(TOKEN, str(failure.exception))

    def test_attempt_budget_counts_every_reservation_and_is_atomic(self):
        budget = runner.AttemptBudget(7, 60)

        def reserve(_):
            try:
                return budget.reserve()
            except runner.RunnerError:
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            attempts = list(pool.map(reserve, range(64)))
        admitted = [attempt for attempt in attempts if attempt is not None]
        self.assertEqual(len(admitted), 7)
        self.assertEqual(len(set(admitted)), 7)
        self.assertTrue(
            all(isinstance(attempt, str) and attempt for attempt in admitted)
        )
        self.assertEqual(budget.count, 7)
        self.assertGreaterEqual(budget.remaining(), 0)
        self.assertLessEqual(budget.remaining(), 60)
        with self.assertRaises(runner.RunnerError):
            budget.reserve()

    def test_root_thinking_token_budget_is_a_bounded_integer_capability_option(self):
        for value in (0, 256, 8192):
            configuration = route_configuration()
            configuration["routes"]["local"]["api_type"] = "chat"
            configuration["routes"]["local"]["extra_body"] = {
                "thinking_token_budget": value,
                "chat_template_kwargs": {"enable_thinking": True},
            }
            with self.subTest(value=value):
                route = self.load(configuration)["local"]
                self.assertEqual(route.extra_body["thinking_token_budget"], value)
                self.assertEqual(
                    route.public()["extra_body"]["thinking_token_budget"], value
                )
        for value in (None, True, False, -1, 8193, 2**31, 256.0, "256", [], {}):
            configuration = route_configuration()
            configuration["routes"]["local"]["api_type"] = "chat"
            configuration["routes"]["local"]["extra_body"] = {
                "thinking_token_budget": value
            }
            with self.subTest(value=value), self.assertRaises(runner.RunnerError):
                self.load(configuration)
        for extra in (
            {"chat_template_kwargs": {"thinking_token_budget": 256}},
            {"thinking_token_budget": 256, "messages": []},
            {"thinking_token_budget": 256, "metadata": {}},
            {"reasoning_effort": "medium_effort", "thinking_token_budget": 256},
        ):
            configuration = route_configuration()
            configuration["routes"]["local"]["api_type"] = "chat"
            configuration["routes"]["local"]["extra_body"] = extra
            with self.subTest(extra=extra), self.assertRaises(runner.RunnerError):
                self.load(configuration)

    def test_responses_routes_cannot_request_chat_only_thinking_budgets(self):
        for value in (0, 256, 8192):
            configuration = route_configuration()
            configuration["routes"]["local"]["extra_body"] = {
                "thinking_token_budget": value
            }
            with self.subTest(value=value), self.assertRaisesRegex(
                runner.RunnerError, "requires the Chat API"
            ):
                self.load(configuration)

    def test_chat_template_medium_effort_is_boolean_without_a_required_token_cut(self):
        for enable_thinking in (True, False):
            for medium_effort in (True, False):
                configuration = route_configuration()
                configuration["routes"]["local"].update(
                    api_type="chat",
                    extra_body={
                        "chat_template_kwargs": {
                            "enable_thinking": enable_thinking,
                            "medium_effort": medium_effort,
                        }
                    },
                )
                with self.subTest(
                    enable_thinking=enable_thinking, medium_effort=medium_effort
                ):
                    options = self.load(configuration)["local"].extra_body
                    self.assertIs(
                        options["chat_template_kwargs"]["medium_effort"], medium_effort
                    )
                    self.assertIs(
                        options["chat_template_kwargs"]["enable_thinking"],
                        enable_thinking,
                    )
                    self.assertNotIn("thinking_token_budget", options)
        invalid = [
            {},
            {"medium_effort": True},
            {"enable_thinking": True, "reasoning_effort": "medium"},
            {"enable_thinking": True, "private_context": "forged"},
            *(
                {"enable_thinking": True, "medium_effort": value}
                for value in (None, 0, 1, 1.0, "true", [], {})
            ),
            *(
                {"enable_thinking": value, "medium_effort": True}
                for value in (None, 0, 1, "true")
            ),
        ]
        for kwargs in invalid:
            configuration = route_configuration()
            configuration["routes"]["local"].update(
                api_type="chat", extra_body={"chat_template_kwargs": kwargs}
            )
            with self.subTest(kwargs=kwargs), self.assertRaises(runner.RunnerError):
                self.load(configuration)

    def test_responses_rejects_all_template_kwargs_instead_of_dropping_them(self):
        for kwargs in (
            None,
            {},
            {"enable_thinking": False},
            {"enable_thinking": True, "medium_effort": True},
        ):
            configuration = route_configuration()
            configuration["routes"]["local"]["extra_body"] = {
                "chat_template_kwargs": kwargs
            }
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(
                runner.RunnerError, "require the Chat API"
            ):
                self.load(configuration)

    def test_attempt_budget_rejects_unbounded_limits_and_expired_deadlines(self):
        for calls in (0, -1, True, 1.0):
            with self.subTest(calls=calls):
                with self.assertRaises(runner.RunnerError):
                    runner.AttemptBudget(calls, 60)
        for timeout in (0, -1, True, float("inf"), float("nan")):
            with self.subTest(timeout=timeout):
                with self.assertRaises(runner.RunnerError):
                    runner.AttemptBudget(3, timeout)
        budget = runner.AttemptBudget(3, 1e-12)
        with self.assertRaises(runner.RunnerError):
            budget.reserve()
        self.assertEqual(budget.count, 0)

    def test_candidate_scanner_checks_private_meaning_and_structured_fields(self):
        fragments = [
            "PRIVATE_MESSAGE_7391",
            "The reader has a confidential medical follow-up and laboratory results.",
        ]
        public = {
            "model": "synthetic-public",
            "input": [
                {"role": "user", "content": "Compare the supplied public sources."}
            ],
            "user": "a" * 64,
            "store": False,
        }
        self.assertFalse(runner.scan_external_request(public, fragments))
        for fragment in fragments:
            private = copy.deepcopy(public)
            private["input"][0]["content"] += " " + fragment
            diagnostics = runner.scan_external_request(private, fragments)
            self.assertTrue(diagnostics)
            self.assertNotIn(fragment, json.dumps(diagnostics))
        for field in (
            "chat_history",
            "previous_response_id",
            "conversation",
            "attachments",
            "private_profile",
            "credentials",
        ):
            for embedded_json in (False, True):
                private = copy.deepcopy(public)
                value = {field: "prohibited state"}
                if embedded_json:
                    private["input"][0]["content"] = json.dumps(value)
                else:
                    private["unrelated"] = value
                with self.subTest(field=field, embedded_json=embedded_json):
                    self.assertTrue(runner.scan_external_request(private, fragments))

    def test_synthetic_bundle_preserves_renderer_and_removes_real_personalization(self):
        destination = self.root / "synthetic-skills"
        manifest = runner.make_synthetic_bundle(destination)
        self.assertIsInstance(manifest, dict)
        self.assertTrue(manifest)
        canonical = REPOSITORY / "skills/daily-summary"
        for relative in (
            "scripts/edition_contract.py",
            "scripts/render_daybook.py",
            "scripts/validate_daybook.py",
            "assets/daybook-v4.html",
            "references/edition-schema.json",
        ):
            matches = list(destination.rglob(Path(relative).name))
            self.assertEqual(len(matches), 1, relative)
            self.assertEqual(
                matches[0].read_bytes(), (canonical / relative).read_bytes()
            )
        original_policy = json.loads(
            (canonical / "references/edition-policy.json").read_text()
        )
        corpus = "\n".join(
            path.read_text()
            for path in destination.rglob("*")
            if path.is_file() and path.suffix in {".md", ".json"}
        )
        for private in (
            original_policy["reader"]["home"],
            original_policy["reader"]["work"],
            original_policy["edition"]["home_location"],
        ):
            self.assertNotIn(private, corpus)
        for relative in (
            "SKILL.md",
            "references/editorial-spec.md",
            "references/edition-format.md",
            "references/research-and-sourcing.md",
        ):
            matches = list(destination.rglob(Path(relative).name))
            for path in matches:
                self.assertNotEqual(
                    path.read_bytes(), (canonical / relative).read_bytes()
                )

    def test_default_dry_run_never_starts_subprocess_or_model_transport(self):
        self.load()
        for arguments in ([], ["--routes", str(self.routes_file)]):
            output = io.StringIO()
            with (
                self.subTest(arguments=arguments),
                mock.patch.dict(os.environ, {TOKEN_VARIABLE: TOKEN}),
                mock.patch(
                    "subprocess.run",
                    side_effect=AssertionError("dry-run executed a process"),
                ),
                mock.patch(
                    "socket.create_connection",
                    side_effect=AssertionError("dry-run used a network"),
                ),
                contextlib.redirect_stdout(output),
            ):
                self.assertEqual(runner.main(arguments), 0)
            self.assertIsInstance(json.loads(output.getvalue()), dict)
            self.assertNotIn(TOKEN, output.getvalue())
            plan = json.loads(output.getvalue())
            self.assertEqual(plan["runs"], 48)
            self.assertEqual(plan["maximum_coordinator_iterations"], 48 * 128)
            self.assertIsNone(plan["provider_attempt_ceiling"])
            self.assertFalse(plan["generation_enabled"])

    def test_execute_requires_explicit_finite_global_stop_limits(self):
        self.load()
        common = [
            "--execute",
            "--routes",
            str(self.routes_file),
            "--image",
            "synthetic-image",
            "--max-output-tokens-per-attempt",
            "8192",
        ]
        for limits in (
            [],
            ["--max-model-attempts", "10"],
            ["--timeout-seconds", "60"],
            ["--max-model-attempts", "0", "--timeout-seconds", "60"],
            ["--max-model-attempts", "10", "--timeout-seconds", "inf"],
            ["--max-model-attempts", "10", "--timeout-seconds", "nan"],
        ):
            with (
                self.subTest(limits=limits),
                mock.patch.dict(os.environ, {TOKEN_VARIABLE: TOKEN}),
                mock.patch(
                    "subprocess.run", side_effect=AssertionError("unbounded execution")
                ),
                mock.patch(
                    "socket.create_connection",
                    side_effect=AssertionError("unbounded network"),
                ),
                contextlib.redirect_stdout(io.StringIO()),
                contextlib.redirect_stderr(io.StringIO()),
            ):
                try:
                    status = runner.main(common + limits)
                except (runner.RunnerError, SystemExit) as error:
                    if isinstance(error, SystemExit):
                        self.assertNotEqual(error.code, 0)
                else:
                    self.assertNotEqual(status, 0)

    def test_execute_cannot_omit_or_disable_the_output_token_ceiling(self):
        self.load()
        common = [
            "--execute",
            "--routes",
            str(self.routes_file),
            "--image",
            "synthetic-image",
            "--max-model-attempts",
            "10",
            "--timeout-seconds",
            "60",
        ]
        for cap in (
            [],
            ["--max-output-tokens-per-attempt", "0"],
            ["--max-output-tokens-per-attempt", "-1"],
        ):
            with (
                self.subTest(cap=cap),
                mock.patch.dict(os.environ, {TOKEN_VARIABLE: TOKEN}),
                mock.patch(
                    "subprocess.run", side_effect=AssertionError("uncapped execution")
                ),
                contextlib.redirect_stdout(io.StringIO()),
                contextlib.redirect_stderr(io.StringIO()),
            ):
                self.assertNotEqual(runner.main(common + cap), 0)

    def test_explicit_dotenv_is_data_and_existing_environment_takes_precedence(self):
        path = self.root / "fixture.env"
        side_effect = self.root / "must-not-exist"
        literal = "$(touch " + str(side_effect) + ")"
        path.write_text(
            f"EXISTING=from-file\nLITERAL='{literal}'\nexport NEW_VALUE=fixture\n"
        )
        with mock.patch(
            "subprocess.run", side_effect=AssertionError("dotenv executed shell code")
        ):
            result = runner.load_credential_environment(
                [path], {"EXISTING": "from-environment"}
            )
        self.assertEqual(result["EXISTING"], "from-environment")
        self.assertEqual(result["LITERAL"], literal)
        self.assertEqual(result["NEW_VALUE"], "fixture")
        self.assertFalse(side_effect.exists())

    def test_review_cannot_approve_measurements_with_a_wrong_evidence_binding(self):
        measurements = {"schema_version": 1, "cases": []}
        with self.assertRaises(runner.RunnerError):
            runner.apply_reviews(measurements, {"measurements_sha256": "wrong"})

    def reviewed_fixture(self):
        measurements = {
            "schema_version": 1,
            "variant": "candidate",
            "review_status": "pending",
            "privacy_evidence": {"artifact_sha256": "synthetic-reviewed-capture"},
            "automatic_privacy": {"violation_count": 0},
            "cases": [
                {
                    "case_id": "synthetic-case",
                    "repetition": 0,
                    "output_sha256": "synthetic-output-hash",
                    "required_facts": ["The batch mode is opt-in"],
                    "evidence_refs": ["public-1", "local.email"],
                    "source_urls": ["https://example.org/release"],
                    "tool_refs": ["tool:clock"],
                    "automatic_output_contract": {"passed": True},
                }
            ],
        }
        review = runner.review_template(measurements)
        review.update(
            reviewer="synthetic-test-reviewer", all_claims_and_citations_reviewed=True
        )
        review["privacy_evidence"].update(dict.fromkeys(runner.PRIVACY_CHECKS, True))
        case = review["cases"][0]
        case.update(
            claims=[
                {
                    "text": "The batch mode is opt-in.",
                    "supported": True,
                    "evidence_refs": ["public-1"],
                    "reason": "The frozen source explicitly says so.",
                }
            ],
            citations=[
                {
                    "url": "https://example.org/release",
                    "correct": True,
                    "reason": "The cited frozen source supports this sentence.",
                }
            ],
            required_facts=[
                {
                    "fact": "The batch mode is opt-in",
                    "present": True,
                    "reason": "The exact qualification is retained.",
                }
            ],
            output_contract_passed=True,
            output_contract_reason="Synthetic unit-test canonical validation fixture.",
        )
        return measurements, review

    def test_independent_review_derives_counts_without_mutating_observations(self):
        measurements, review = self.reviewed_fixture()
        reviewed = runner.apply_reviews(measurements, review)
        case = reviewed["cases"][0]
        self.assertEqual(reviewed["review_status"], "reviewed")
        self.assertEqual(case["factuality"], {"supported_claims": 1, "total_claims": 1})
        self.assertEqual(
            case["omissions"], {"missing_required": 0, "total_required": 1}
        )
        self.assertEqual(
            case["sources"], {"correct_citations": 1, "total_citations": 1}
        )
        self.assertNotIn("factuality", measurements["cases"][0])

    def test_review_rejects_changed_outputs_missing_facts_and_unknown_provenance(self):
        for mutation in ("output", "fact", "source", "citation", "scope"):
            measurements, review = self.reviewed_fixture()
            case = review["cases"][0]
            if mutation == "output":
                case["output_sha256"] = "changed"
            elif mutation == "fact":
                case["required_facts"][0]["fact"] = "A different unfrozen fact"
            elif mutation == "source":
                case["claims"][0]["evidence_refs"] = ["private-unknown-source"]
            elif mutation == "citation":
                case["citations"][0]["url"] = "https://unobserved.example.org/claim"
            else:
                review["all_claims_and_citations_reviewed"] = None
            with self.subTest(mutation=mutation), self.assertRaises(runner.RunnerError):
                runner.apply_reviews(measurements, review)

    def test_review_cannot_override_observed_contract_or_privacy_failures(self):
        for failure in ("canonical", "privacy"):
            measurements, review = self.reviewed_fixture()
            if failure == "canonical":
                measurements["cases"][0]["automatic_output_contract"]["passed"] = False
            else:
                measurements["automatic_privacy"]["violation_count"] = 1
            review["measurements_sha256"] = runner.digest(measurements)
            with self.subTest(failure=failure), self.assertRaises(runner.RunnerError):
                runner.apply_reviews(measurements, review)


if __name__ == "__main__":
    unittest.main()
