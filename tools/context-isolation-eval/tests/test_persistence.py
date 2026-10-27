"""Charged synthetic attempts must survive fixture teardown and interruption."""

import argparse
import contextlib
import hashlib
import importlib.util
import json
import subprocess  # nosec B404
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


core = load("persistence_test_runner", "run.py")
fixture = load("persistence_test_adapter", "runtime_fixture.py")
CREDENTIAL = "SYNTHETIC_PRIVATE_CREDENTIAL"  # nosec B105


class EmptyPeers:
    pass


class PersistenceTests(unittest.TestCase):
    def test_cleanup_failure_preserves_the_already_reserved_attempt(self):
        self.execute_failure(measure_failure=False)

    def test_failure_before_result_assignment_records_actual_elapsed_time(self):
        self.execute_failure(measure_failure=True)

    def execute_failure(self, *, measure_failure):
        """Exercise actual execute_case cleanup and the outer runner fallback."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backing = root / "fixture"
            backing.mkdir()
            (backing / "config.yaml").write_text("{}\n")
            (backing / "backend.log").write_text("synthetic runtime\n")
            selected = {}
            original = fixture._peers_class

            def peer_class(base):
                class BrokenCleanup(original(base)):
                    def stop(self):
                        super().stop()
                        raise OSError("synthetic teardown failure")

                return BrokenCleanup

            @contextlib.contextmanager
            def secure(peers):
                selected["peers"] = peers
                yield {"root": backing, "endpoint": "synthetic", "environment": {}}

            @contextlib.contextmanager
            def environment(*_args, **_kwargs):
                yield {
                    "root": backing,
                    "container": "owned-synthetic-container",
                    "readiness_ms": 1,
                }

            def measure(_env, **_kwargs):
                peers = selected["peers"]
                capture = {
                    "handler_id": "synthetic-handler",
                    "kind": "provider",
                    "role": "local",
                    "runtime_request": {"messages": []},
                    "outcome": "fixture_preparation_pending",
                }
                peers.captures.append(capture)
                attempt, status = peers.admit(capture, "coordinator", "local", "local")
                self.assertEqual(status, 200)
                peers.publish(
                    capture,
                    attempt=attempt,
                    capture_fields={"outcome": "completed", "provider_status": 200},
                    attempt_fields={"outcome": "completed", "latency_ms": 1},
                )
                if measure_failure:
                    raise OSError("synthetic fixture failure before result assignment")
                return {
                    "answer": "Partial synthetic output",
                    "done": False,
                    "errors": [],
                    "starts": [],
                    "ends": [],
                    "latency_ms": 1,
                }

            def bundle(path):
                path.mkdir()
                (path / "fixture-environment.json").write_text(
                    json.dumps(
                        {
                            "schema_version": 2,
                            "scope": "synthetic",
                            "unavailable_mapped_skills": [],
                        }
                    )
                )
                return {"schema_version": 2, "synthetic_only": True}

            modules = {
                "runtime_fixture": fixture,
                "context_isolation_http_check": types.SimpleNamespace(
                    configuration=None, register_redis=None
                ),
                "image_check": types.SimpleNamespace(
                    MemoryPeers=EmptyPeers,
                    environment=environment,
                    run=lambda *_args, **_kwargs: types.SimpleNamespace(
                        stdout="sha256:" + "a" * 64
                    ),
                ),
                "nvidia_docs_check": types.SimpleNamespace(secure_peer=secure),
            }
            args = argparse.Namespace(
                output=root / "evaluation",
                image="sha256:" + "a" * 64,
                redis_image="synthetic-no-docker",
                gateway_version="synthetic-no-provider",
                case=["sparse-sources"],
                repetitions=1,
                variant="candidate",
                max_iterations=1,
                max_output_tokens_per_attempt=8192,
                per_run_timeout=1,
            )
            route = core.Route(
                role="local",
                base_url="http://127.0.0.1:1/v1",
                api_type="chat",
                model_name="synthetic",
                api_key_env="SYNTHETIC_ONLY",
                trust="trusted_local",
                secret=CREDENTIAL,
            )
            budget = core.AttemptBudget(1, 60)
            with (
                mock.patch.dict(sys.modules, modules),
                mock.patch.object(fixture, "_peers_class", peer_class),
                mock.patch.object(fixture, "_measure_runtime", measure),
                mock.patch.object(
                    fixture, "_canonical_contract", return_value={"passed": None}
                ),
                mock.patch.object(core, "make_synthetic_bundle", bundle),
            ):
                core.execute(
                    args,
                    core.load_workload(HERE / "workload.json"),
                    {"local": route},
                    budget,
                )
            measured = json.loads((args.output / "candidate.raw.json").read_text())
            capture = json.loads(
                (args.output / "candidate-sparse-sources-0/capture.json").read_text()
            )
            self.assertEqual(budget.count, 1)
            self.assertEqual(measured["cases"][0]["attempt_count"], 1)
            self.assertEqual(len(capture["attempts"]), 1)
            self.assertEqual(capture["attempts"][0]["outcome"], "completed")
            self.assertFalse(measured["cases"][0]["successful"])
            if measure_failure:
                self.assertGreater(capture["result"]["latency_ms"], 0)
                self.assertNotEqual(capture["result"]["latency_ms"], 0.001)
                self.assertIn("observed fixture elapsed", capture["latency_scope"])
            case_path = args.output / "candidate-sparse-sources-0"
            marker = json.loads((case_path / "case.complete.json").read_text())
            self.assertEqual(marker["state"], "finalized_observation")
            self.assertEqual(marker["review_status"], "pending")
            self.assertIn("capture.journal.jsonl", marker["files"])
            artifacts = json.loads((args.output / "artifacts.json").read_text())
            for name, checksum in marker["files"].items():
                self.assertEqual(
                    hashlib.sha256((case_path / name).read_bytes()).hexdigest(),
                    checksum,
                )
                self.assertEqual(
                    artifacts["files"]["candidate-sparse-sources-0/" + name], checksum
                )
            progress = json.loads((args.output / "progress.json").read_text())
            self.assertEqual(progress["state"], "observations_complete")
            self.assertEqual(progress["reservations"], 1)
            self.assertEqual(len(progress["observed_rows"]["candidate"]), 1)

    def identity(self):
        return {
            "case_id": "fixture",
            "variant": "candidate",
            "repetition": 0,
            "workload_sha256": "synthetic",
            "requested_image": "synthetic",
        }

    def journal(self, path):
        return fixture.CaseJournal(
            path,
            self.identity(),
            redact=core.redact,
            secrets=["SYNTHETIC_PRIVATE_CREDENTIAL"],
        )

    def peers(self, journal, maximum=1):
        return fixture._peers_class(EmptyPeers)(
            variant="candidate",
            case={"id": "fixture", "local_inputs": {}},
            workload={"as_of": "2026-10-26T12:00:00Z"},
            routes={},
            budget=core.AttemptBudget(maximum, 60),
            timeout=1,
            max_output_tokens_per_attempt=8192,
            journal=journal,
        )

    def capture(self):
        return {
            "handler_id": "synthetic-handler",
            "kind": "provider",
            "runtime_request": {
                "text": "SYNTHETIC_PRIVATE_CREDENTIAL",
                "SYNTHETIC_PRIVATE_CREDENTIAL": "value",
            },
            "outcome": "fixture_preparation_pending",
        }

    def test_admission_is_durable_and_redacted_before_any_provider_dispatch(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "case"
            journal = self.journal(path)
            peers = self.peers(journal)
            capture = self.capture()
            attempt, status = peers.admit(capture, "coordinator", "local", "local")
            self.assertEqual(status, 200)

            @contextlib.contextmanager
            def stream(*_args, **_kwargs):
                recovered = fixture.recover_case_journal(
                    path, self.identity(), failure_kind="simulated interruption"
                )
                self.assertEqual(recovered["attempts"][0]["id"], attempt["id"])
                self.assertEqual(
                    recovered["attempts"][0]["outcome"], "unknown_after_interruption"
                )
                self.assertIsNone(recovered["attempts"][0]["latency_ms"])
                yield types.SimpleNamespace()

            with peers.dispatch(
                attempt["id"],
                types.SimpleNamespace(stream=stream),
                "synthetic",
                {},
                "SYNTHETIC_PRIVATE_CREDENTIAL",
            ):
                pass
            data = journal.path.read_text()
            self.assertNotIn("SYNTHETIC_PRIVATE_CREDENTIAL", data)
            self.assertIn("[credential omitted]", data)
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
            self.assertEqual(journal.path.stat().st_mode & 0o777, 0o600)

    def test_failed_durable_admission_never_reaches_dispatch(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = self.journal(Path(directory) / "case")
            peers = self.peers(journal)
            with mock.patch.object(
                fixture.os, "fsync", side_effect=OSError("synthetic disk fault")
            ):
                with self.assertRaises(OSError):
                    peers.admit(self.capture(), "coordinator", "local", "local")
            self.assertEqual(peers.budget.count, 1)
            self.assertTrue(peers.stop_requested.is_set())
            self.assertEqual(peers.budget.remaining(), 0)
            client = types.SimpleNamespace(stream=mock.Mock())
            attempt = peers.attempts[0]
            with self.assertRaises(TimeoutError), peers.dispatch(
                attempt["id"], client, "synthetic", {}, "synthetic"
            ):
                pass
            client.stream.assert_not_called()

    def test_truncated_journal_preserves_prefix_partial_output_and_unknown_attempt(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "case"
            journal = self.journal(path)
            peers = self.peers(journal)
            peers.admit(self.capture(), "coordinator", "local", "local")
            journal.record(
                "runtime_line",
                'data: {"choices":[{"delta":{"content":"Partial synthetic text"}}]}',
            )
            with journal.path.open("ab") as stream:
                stream.write(b'{"sequence":')
            recovered = fixture.recover_case_journal(
                path, self.identity(), failure_kind="synthetic forced termination"
            )
            self.assertEqual(recovered["result"]["answer"], "Partial synthetic text")
            self.assertFalse(recovered["result"]["done"])
            self.assertTrue(recovered["journal_recovery"]["incomplete_tail"])
            self.assertFalse(recovered["automatic_output_contract"]["passed"])
            self.assertEqual(len(recovered["attempts"]), 1)
            with self.assertRaises(ValueError):
                fixture.recover_case_journal(
                    path,
                    self.identity() | {"case_id": "other"},
                    failure_kind="synthetic",
                )

    def test_forced_process_kill_keeps_the_durable_admitted_attempt(self):
        script = """
import importlib.util,json,sys,time
from pathlib import Path
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module
    spec.loader.exec_module(module);return module
core=load("kill_test_runner",sys.argv[1])
fixture=load("kill_test_adapter",sys.argv[2])
identity=json.loads(sys.argv[4])
journal=fixture.CaseJournal(Path(sys.argv[3]),identity,redact=core.redact,secrets=[])
peers=fixture._peers_class(type("EmptyPeers",(),{}))(variant="candidate",case={"id":"fixture","local_inputs":{}},workload={"as_of":"2026-10-26T12:00:00Z"},routes={},budget=core.AttemptBudget(1,60),timeout=1,max_output_tokens_per_attempt=8192,journal=journal)
peers.admit({"handler_id":"killed-handler","kind":"provider","outcome":"fixture_preparation_pending"},"coordinator","local","local")
print(peers.budget.count,flush=True)
time.sleep(30)
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "case"
            process = subprocess.Popen(  # nosec B603 - fixed synthetic Python script; no network or model
                [
                    sys.executable,
                    "-c",
                    script,
                    str(HERE / "run.py"),
                    str(HERE / "runtime_fixture.py"),
                    str(path),
                    json.dumps(self.identity()),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                self.assertEqual(process.stdout.readline().strip(), "1")
                process.kill()
                process.communicate(timeout=5)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=5)
            recovered = fixture.recover_case_journal(
                path, self.identity(), failure_kind="synthetic SIGKILL"
            )
            self.assertEqual(len(recovered["attempts"]), 1)
            self.assertEqual(
                recovered["attempts"][0]["outcome"], "unknown_after_interruption"
            )
            self.assertFalse(recovered["result"]["done"])


if __name__ == "__main__":
    unittest.main()
