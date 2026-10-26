"""Fixture guards and concurrency use local peers with synthetic providers."""

import contextlib
import copy
import importlib.util
import json
import subprocess  # nosec B404: fixed local Python subprocess for module-identity regression
import sys
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

HERE = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


core = load("fixture_test_runner", "run.py")
fixture = load("fixture_test_adapter", "runtime_fixture.py")
CREDENTIAL = "SYNTHETIC_FORWARDING_CREDENTIAL"


class MinimalPeers:
    def __init__(self):
        # The built-image base peer owns a separate tool-call log.
        self.calls = []

    def handler(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                return

            def reply(self, value, status=200):
                payload = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        return Handler


class ProviderTimeout(Exception):
    pass


class InMemoryProvider:
    """No upstream socket is opened; tests still traverse the peer HTTP API."""

    TimeoutException = ProviderTimeout

    def __init__(self, fail=False):
        self.calls = []
        self.options = []
        self.transports = []
        self.fail = fail
        self.construction_gate = None

    def HTTPTransport(self, **options):
        self.transports.append(options)
        return object()

    def Client(self, **options):
        owner = self
        self.options.append(options)
        if self.construction_gate:
            entered, release = self.construction_gate
            entered.set()
            if not release.wait(3):
                raise AssertionError("test client construction was not released")

        class Client:
            def close(self):
                return

            @contextlib.contextmanager
            def stream(self, method, endpoint, **fields):
                owner.calls.append({"method": method, "endpoint": endpoint, **fields})
                if owner.fail:
                    raise ProviderTimeout(CREDENTIAL)
                response = {
                    "status": "completed",
                    "model": "observed-model-revision",
                    "output": [],
                    "usage": {"input_tokens": 12, "output_tokens": 3},
                }
                if endpoint.endswith("/chat/completions"):
                    response = {
                        "model": "observed-model-revision",
                        "choices": [
                            {
                                "index": 0,
                                "message": {
                                    "role": "assistant",
                                    "content": "Synthetic response",
                                },
                                "finish_reason": "stop",
                            }
                        ],
                        "usage": {"prompt_tokens": 12, "completion_tokens": 3},
                    }
                yield types.SimpleNamespace(
                    headers={"content-type": "application/json"},
                    status_code=200,
                    is_success=True,
                    iter_bytes=lambda: iter([json.dumps(response).encode()]),
                    close=lambda: None,
                )

        return Client()


class RuntimeFixtureTests(unittest.TestCase):
    def test_all_frozen_cases_enter_the_daily_runtime_profile(self):
        workload = json.loads((HERE / "workload.json").read_text())
        for case in workload["cases"]:
            self.assertIn("Produce my daily summary.", fixture._message(case, workload))

    def test_public_only_case_excludes_personal_sources_in_request_metadata(self):
        case = {
            "id": "public-only",
            "prompt": "Public sources only",
            "local_inputs": {},
        }
        metadata = fixture._request_metadata(case)
        self.assertEqual(
            metadata["sourcePolicy"]["disabledSources"], ["workspace_data"]
        )
        self.assertEqual(
            metadata["sourcePolicy"]["enabledSources"],
            ["perplexity_search", "known_url_scrape"],
        )
        self.assertIn(
            "skip all mail, calendar, and memory reads", fixture._message(case, {})
        )

    def test_output_cap_is_explicit_and_never_raises_a_smaller_runtime_cap(self):
        for api, request, expected in (
            ("responses", {}, {"max_output_tokens": 8192}),
            ("responses", {"max_output_tokens": 2048}, {"max_output_tokens": 2048}),
            ("chat", {}, {"max_tokens": 8192}),
            ("chat", {"max_completion_tokens": 1024}, {"max_completion_tokens": 1024}),
            (
                "chat",
                {"max_tokens": 4096, "max_completion_tokens": 2048},
                {"max_tokens": 2048, "max_completion_tokens": 2048},
            ),
        ):
            with self.subTest(api=api, request=request):
                original = dict(request)
                body, records = fixture._bounded_output(request, api, 8192)
                self.assertEqual(body, expected)
                self.assertEqual(request, original)
                self.assertTrue(records)
                self.assertTrue(all(record["applied"] <= 8192 for record in records))
        for invalid in (True, False, -1, 0, "8192", 2.5, None):
            with self.assertRaises(ValueError):
                fixture._bounded_output(
                    {"max_output_tokens": invalid}, "responses", 8192
                )

    def test_host_only_options_do_not_break_the_runtime_route_registry(self):
        settings = {
            "reasoning_effort": "high",
            "thinking_token_budget": 256,
            "verbosity": "low",
            "temperature": 0.1,
            "chat_template_kwargs": {
                "enable_thinking": True,
                "medium_effort": True,
            },
        }
        self.assertEqual(
            fixture._runtime_options(settings),
            {
                "reasoning_effort": "high",
                "thinking_token_budget": 256,
                "chat_template_kwargs": {
                    "enable_thinking": True,
                    "medium_effort": True,
                },
            },
        )
        self.assertIs(settings["chat_template_kwargs"]["medium_effort"], True)

    def test_registered_thinking_budget_survives_capture_without_weakening_caps(self):
        with self.peer(maximum=1) as (peers, provider, url):
            options = {
                "thinking_token_budget": 256,
                "chat_template_kwargs": {"enable_thinking": True},
            }
            peers.routes["high"] = replace(
                peers.routes["high"], api_type="chat", extra_body=options
            )
            body = {
                **self.public_body(),
                **fixture._runtime_options(options),
                "max_tokens": 128,
            }
            body["messages"] = body.pop("input")
            url = url.removesuffix("responses") + "chat/completions"
            self.assertEqual(self.post(url, body)[0], 200)
            self.assertEqual(provider.calls[0]["json"]["thinking_token_budget"], 256)
            self.assertEqual(provider.calls[0]["json"]["max_tokens"], 128)
            capture = peers.captures[0]
            self.assertEqual(capture["runtime_request"]["thinking_token_budget"], 256)
            self.assertFalse(
                any(
                    record["kind"] == "bounded_host_route_options"
                    for record in capture["fixture_transforms"]
                )
            )
            self.assertEqual(self.post(url, body)[0], 429)
            self.assertEqual(peers.budget.count, 1)
            self.assertEqual(len(provider.calls), 1)

    def test_registered_medium_effort_reaches_chat_without_adding_a_thinking_cut(self):
        for medium_effort in (True, False):
            with self.subTest(medium_effort=medium_effort), self.peer(maximum=1) as (
                peers,
                provider,
                url,
            ):
                options = {
                    "chat_template_kwargs": {
                        "enable_thinking": True,
                        "medium_effort": medium_effort,
                    }
                }
                peers.routes["high"] = replace(
                    peers.routes["high"], api_type="chat", extra_body=options
                )
                body = {**self.public_body(), **fixture._runtime_options(options)}
                body["messages"] = body.pop("input")
                url = url.removesuffix("responses") + "chat/completions"
                self.assertEqual(self.post(url, body)[0], 200)
                self.assertEqual(
                    provider.calls[0]["json"]["chat_template_kwargs"],
                    options["chat_template_kwargs"],
                )
                self.assertNotIn("thinking_token_budget", provider.calls[0]["json"])
                self.assertEqual(provider.calls[0]["json"]["max_tokens"], 8192)
                capture = peers.captures[0]
                self.assertIs(
                    capture["runtime_request"]["chat_template_kwargs"]["medium_effort"],
                    medium_effort,
                )
                self.assertFalse(
                    any(
                        record["kind"] == "bounded_host_route_options"
                        for record in capture["fixture_transforms"]
                    )
                )
                self.assertEqual(self.post(url, body)[0], 429)
                self.assertEqual(peers.budget.count, 1)
                self.assertEqual(len(provider.calls), 1)

    def test_policy_rejected_renderer_proposals_do_not_spend_execution_budget(self):
        starts = [
            {"id": str(index), "name": "Function Start: briefing_renderer_tool"}
            for index in range(4)
        ]
        values = [
            {"executed": False, "error": "context_policy_rejected"},
            {"executed": False, "error": "context_policy_rejected"},
            {"passed": False, "stage": "local_render", "attempts_remaining": 1},
            "```html\n<html>canonical fixture</html>\n```",
        ]
        ends = [
            {
                "id": str(index),
                "name": "Function Complete: briefing_renderer_tool",
                "payload": json.dumps(value) if isinstance(value, dict) else value,
            }
            for index, value in enumerate(values)
        ]
        self.assertEqual(
            fixture._renderer_executions({"starts": starts, "ends": ends}), 2
        )

    @contextlib.contextmanager
    def peer(
        self,
        *,
        maximum=4,
        fault=False,
        failing_provider=False,
        case=None,
        workload=None,
    ):
        provider = InMemoryProvider(fail=failing_provider)
        routes = {
            role: core.Route(
                role=role,
                base_url="https://provider.example.invalid/v1",
                api_type="responses",
                model_name="configured-model",
                api_key_env="FIXTURE_CREDENTIAL",
                trust="approved_cloud",
                secret=CREDENTIAL,
            )
            for role in ("high", "baseline")
        }
        if case is None:
            case = {
                "id": "fixture",
                "prompt": "Fixture request",
                "local_inputs": {"message": "PRIVATE_MARKER_7391"},
                "faults": ["first_public_provider_attempt_timeout"] if fault else [],
            }
        budget = core.AttemptBudget(maximum, 30)
        peers = fixture._peers_class(MinimalPeers)(
            variant="candidate",
            case=case,
            workload=workload or {"as_of": "2026-10-26T12:00:00Z"},
            routes=routes,
            budget=budget,
            timeout=10,
            max_output_tokens_per_attempt=8192,
        )
        server = ThreadingHTTPServer(("127.0.0.1", 0), peers.handler())
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with mock.patch.dict(sys.modules, {"httpx": provider}):
                yield (
                    peers,
                    provider,
                    f"http://127.0.0.1:{server.server_port}/model/high/v1/responses",
                )
        finally:
            peers.stop()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def post(self, url, body):
        request = urllib.request.Request(
            url, json.dumps(body).encode(), {"Content-Type": "application/json"}
        )
        try:
            # Requests use only the loopback peer created by this test helper.
            with urllib.request.urlopen(request, timeout=5) as response:  # nosec B310
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def get(self, url, headers=None):
        request = urllib.request.Request(url, headers=headers or {})
        try:
            # Only the loopback peer created by peer() is used here.
            with urllib.request.urlopen(request, timeout=5) as response:  # nosec B310
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def test_paged_memory_and_recall_match_frozen_sources_without_generation(self):
        workload = json.loads((HERE / "workload.json").read_text())
        path = "/v1/default/banks/synthetic/knowledge-base/search?" + urlencode(
            {"q": "remember synthetic current source context", "limit": "2"}
        )
        recall_path = "/v1/default/banks/synthetic/memories/recall"
        recall_request = {
            "query": "remember existing synthetic evidence",
            "budget": "low",
            "max_tokens": 600,
        }
        for case_id in ("personal-heavy", "long-context"):
            case = next(case for case in workload["cases"] if case["id"] == case_id)
            with self.subTest(case=case_id), self.peer(
                case=case, workload=workload
            ) as (peers, provider, url):
                origin = url.split("/model/", 1)[0]
                status, raw = self.get(origin + path)
                self.assertEqual(status, 200)
                results = json.loads(raw)["results"]
                self.assertEqual(
                    results, [{"id": page["id"]} for page in peers.memory_pages]
                )
                self.assertEqual(len(results), 2 if case_id == "personal-heavy" else 1)
                pages = []
                for result in results:
                    page_path = (
                        "/v1/default/banks/synthetic/knowledge-base/pages/"
                        + result["id"]
                    )
                    status, raw = self.get(origin + page_path)
                    self.assertEqual(status, 200)
                    pages.append(json.loads(raw))
                self.assertEqual(pages, peers.memory_pages)
                status, raw = self.post(origin + recall_path, recall_request)
                self.assertEqual(status, 200)
                self.assertEqual(
                    json.loads(raw)["results"],
                    [
                        {
                            "text": case["local_inputs"]["derived_summary"],
                            "type": "experience",
                            "mentioned_at": workload["as_of"],
                        }
                    ],
                )
                self.assertEqual(
                    peers.source_calls,
                    [{"kind": "memory", "method": "GET", "path": path}]
                    + [
                        {
                            "kind": "memory",
                            "method": "GET",
                            "path": "/v1/default/banks/synthetic/knowledge-base/pages/"
                            + result["id"],
                        }
                        for result in results
                    ]
                    + [
                        {
                            "kind": "memory",
                            "method": "POST",
                            "path": recall_path,
                            "body": recall_request,
                        }
                    ],
                )
                self.assertEqual(peers.budget.count, 0)
                self.assertEqual(peers.attempts, [])
                self.assertEqual(provider.calls, [])

    def test_memory_peer_preserves_standard_header_limit(self):
        with self.peer() as (peers, provider, url):
            origin = url.split("/model/", 1)[0]
            status, _ = self.get(origin + "/health", {"X-Test-Header": "x" * 65537})
            self.assertEqual(status, 431)
            self.assertEqual(peers.source_calls, [])
            self.assertEqual(peers.budget.count, 0)
            self.assertEqual(provider.calls, [])

    def public_body(self):
        return {
            "model": "runtime-model",
            "input": [{"role": "user", "content": "Compare public evidence."}],
            "user": "a" * 64,
            "store": False,
        }

    @contextlib.contextmanager
    def network_peer(self, *, maximum=2):
        """Use real httpx and two loopback servers, with no provider generation."""
        state = types.SimpleNamespace(
            lock=threading.Lock(),
            calls=[],
            headers_blocked=threading.Event(),
            body_blocked=threading.Event(),
            release=threading.Event(),
        )

        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *_):
                return

            def do_POST(self):
                request = json.loads(
                    self.rfile.read(int(self.headers["Content-Length"]))
                )
                text = request["input"][0]["content"]
                with state.lock:
                    state.calls.append(request)
                if text == "block_headers":
                    state.headers_blocked.set()
                    state.release.wait(5)
                payload = json.dumps(
                    {
                        "status": "completed",
                        "model": "loopback-provider",
                        "output": [],
                        "usage": {"input_tokens": 4, "output_tokens": 2},
                    }
                ).encode()
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    if text == "block_body":
                        state.body_blocked.set()
                        state.release.wait(5)
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        provider.daemon_threads = True
        provider_thread = threading.Thread(target=provider.serve_forever, daemon=True)
        provider_thread.start()
        routes = {
            "high": core.Route(
                role="high",
                base_url=f"http://127.0.0.1:{provider.server_port}/v1",
                api_type="responses",
                model_name="synthetic-loopback",
                api_key_env="FIXTURE",
                trust="approved_cloud",
                secret=CREDENTIAL,
            )
        }
        peers = fixture._peers_class(MinimalPeers)(
            variant="candidate",
            case={"id": "parallel-public", "local_inputs": {}},
            workload={"as_of": "2026-10-26T12:00:00Z"},
            routes=routes,
            budget=core.AttemptBudget(maximum, 30),
            timeout=10,
            max_output_tokens_per_attempt=8192,
        )
        server = ThreadingHTTPServer(("127.0.0.1", 0), peers.handler())
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield (
                peers,
                state,
                f"http://127.0.0.1:{server.server_port}/model/high/v1/responses",
            )
        finally:
            state.release.set()
            peers.stop()
            for service, worker in [(server, thread), (provider, provider_thread)]:
                service.shutdown()
                service.server_close()
                worker.join(timeout=2)

    def wait_for_handlers(self, peers):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            with peers.lock:
                if not peers.handlers:
                    return True
            time.sleep(0.005)
        return False

    def test_parallel_public_forwarding_does_not_wait_for_other_response_headers(self):
        with self.network_peer(maximum=2) as (peers, state, url):
            results, errors = {}, []
            ready_done = threading.Event()

            def request(name, done=None):
                body = self.public_body()
                body["input"][0]["content"] = name
                body["max_output_tokens"] = 128
                try:
                    results[name] = self.post(url, body)
                except Exception as error:
                    errors.append(type(error).__name__)
                finally:
                    if done:
                        done.set()

            blocked = threading.Thread(target=request, args=("block_headers",))
            blocked.start()
            self.assertTrue(state.headers_blocked.wait(2))
            ready = threading.Thread(target=request, args=("ready", ready_done))
            ready.start()
            try:
                self.assertTrue(
                    ready_done.wait(2),
                    "a blocked public provider must not delay an independent ready response",
                )
                self.assertEqual(results["ready"][0], 200)
                self.assertFalse(state.release.is_set())
                self.assertEqual(self.post(url, self.public_body())[0], 429)
                self.assertEqual(peers.budget.count, 2)
                self.assertEqual(len(state.calls), 2)
            finally:
                state.release.set()
                blocked.join(timeout=3)
                ready.join(timeout=3)
            self.assertFalse(blocked.is_alive())
            self.assertFalse(ready.is_alive())
            self.assertFalse(errors)
            self.assertEqual(results["block_headers"][0], 200)
            self.assertTrue(self.wait_for_handlers(peers))
            self.assertEqual(len(peers.attempts), 2)
            self.assertTrue(
                all(attempt["outcome"] == "completed" for attempt in peers.attempts)
            )
            self.assertTrue(
                all(call["max_output_tokens"] == 128 for call in state.calls)
            )
            self.assertFalse(peers.provider_calls)
            self.assertEqual(peers.calls, [])
            self.assertEqual(
                len(
                    {
                        capture.get("attempt_id")
                        for capture in peers.captures
                        if capture.get("attempt_id")
                    }
                ),
                2,
            )
            self.assertNotIn(CREDENTIAL, json.dumps(peers.captures))

    def test_cleanup_racing_real_headers_or_body_keeps_attempt_and_closes_late_response(
        self,
    ):
        for block in ("headers", "body"):
            with self.subTest(block=block), self.network_peer(maximum=1) as (
                peers,
                state,
                url,
            ):
                responses, errors = [], []
                body = self.public_body()
                body["input"][0]["content"] = "block_" + block

                def request():
                    try:
                        responses.append(self.post(url, body))
                    except Exception as error:
                        errors.append(type(error).__name__)

                thread = threading.Thread(target=request)
                thread.start()
                self.assertTrue(getattr(state, block + "_blocked").wait(2))
                with peers.lock:
                    call = next(iter(peers.provider_calls.values()))
                started = time.monotonic()
                peers.stop()
                self.assertLess(
                    time.monotonic() - started,
                    1.5,
                    "cleanup cannot block on a provider's headers/body/close",
                )
                with peers.lock:
                    frozen = copy.deepcopy(
                        [peers.attempts, peers.captures, peers.fault_records]
                    )
                self.assertEqual(peers.budget.count, 1)
                self.assertEqual(len(peers.attempts), 1)
                self.assertEqual(
                    peers.attempts[0]["outcome"], "cancelled_at_fixture_cleanup"
                )
                self.assertEqual(
                    peers.captures[0]["attempt_id"], peers.attempts[0]["id"]
                )
                self.assertEqual(self.post(url, self.public_body())[0], 503)
                self.assertEqual(len(state.calls), 1)
                state.release.set()
                thread.join(timeout=3)
                self.assertFalse(thread.is_alive())
                self.assertFalse(errors)
                self.assertNotEqual(responses[0][0], 200)
                self.assertTrue(self.wait_for_handlers(peers))
                self.assertTrue(call.closed.wait(1))
                self.assertFalse(peers.provider_calls)
                self.assertEqual(
                    [peers.attempts, peers.captures, peers.fault_records],
                    frozen,
                    "late transport outcomes cannot rewrite the cleanup snapshot",
                )

    def test_candidate_privacy_rejection_happens_before_any_model_reservation(self):
        with self.peer() as (peers, provider, url):
            body = self.public_body()
            body["input"][0]["content"] += " PRIVATE_MARKER_7391"
            status, _ = self.post(url, body)
            self.assertEqual(status, 403)
            self.assertEqual(peers.budget.count, 0)
            self.assertFalse(provider.calls)
            self.assertTrue(peers.captures[0]["privacy_violations"])

    def test_global_limit_and_provider_credential_separation_hold_at_the_http_boundary(
        self,
    ):
        with self.peer(maximum=1) as (peers, provider, url):
            self.assertEqual(self.post(url, self.public_body())[0], 200)
            self.assertEqual(self.post(url, self.public_body())[0], 429)
            self.assertEqual(len(provider.calls), 1)
            self.assertEqual(len(peers.attempts), 1)
            self.assertEqual(peers.attempts[0]["usage"]["input_tokens"], 12)
            self.assertIsNone(peers.attempts[0]["usage"]["cached_input_tokens"])
            self.assertIsNone(peers.attempts[0]["cost_usd"])
            self.assertNotIn(CREDENTIAL, json.dumps(peers.captures))
            self.assertEqual(
                provider.calls[0]["headers"]["Authorization"], "Bearer " + CREDENTIAL
            )
            self.assertEqual(provider.calls[0]["json"]["max_output_tokens"], 8192)
            self.assertEqual(provider.transports, [{"retries": 0, "trust_env": False}])
            self.assertFalse(provider.options[0]["trust_env"])
            self.assertFalse(provider.options[0]["follow_redirects"])

    def test_fault_and_timeout_attempts_are_recorded_without_zero_usage(self):
        with self.peer(fault=True) as (peers, provider, url):
            self.assertEqual(self.post(url, self.public_body())[0], 504)
            self.assertEqual(self.post(url, self.public_body())[0], 200)
            self.assertEqual(len(provider.calls), 1)
            self.assertEqual(len(peers.attempts), 2)
            self.assertEqual(peers.attempts[0]["outcome"], "injected_gateway_timeout")
            self.assertIsNone(peers.attempts[0]["usage"]["input_tokens"])
        with self.peer(failing_provider=True) as (peers, _, url):
            status, body = self.post(url, self.public_body())
            self.assertEqual(status, 504)
            self.assertNotIn(CREDENTIAL.encode(), body)
            self.assertEqual(peers.attempts[0]["outcome"], "timeout")
            self.assertIsNone(peers.attempts[0]["usage"]["output_tokens"])

    def test_stop_winning_before_admission_prevents_reservation_and_dispatch(self):
        entered, release = threading.Event(), threading.Event()
        original = fixture._helpers

        def blocked_helpers(budget=None):
            core_module, freeze, mutate, usage = original(budget)

            def blocked_clock(body, as_of):
                entered.set()
                if not release.wait(3):
                    raise AssertionError("test transform was not released")
                return freeze(body, as_of)

            return core_module, blocked_clock, mutate, usage

        with mock.patch.object(fixture, "_helpers", blocked_helpers):
            with self.peer() as (peers, provider, url):
                responses = []
                thread = threading.Thread(
                    target=lambda: responses.append(self.post(url, self.public_body()))
                )
                thread.start()
                self.assertTrue(entered.wait(2))
                peers.stop()
                self.assertEqual(peers.budget.count, 0)
                release.set()
                thread.join(timeout=3)
                self.assertFalse(thread.is_alive())
                self.assertEqual(responses[0][0], 503)
                self.assertFalse(provider.calls)
                self.assertFalse(peers.attempts)

    def test_stop_after_reservation_retains_cancelled_attempt_without_dispatch(self):
        entered, release = threading.Event(), threading.Event()
        with self.peer() as (peers, provider, url):
            provider.construction_gate = entered, release
            responses = []
            thread = threading.Thread(
                target=lambda: responses.append(self.post(url, self.public_body()))
            )
            thread.start()
            self.assertTrue(entered.wait(2))
            peers.stop()
            self.assertEqual(peers.budget.count, 1)
            self.assertEqual(len(peers.attempts), 1)
            self.assertEqual(
                peers.attempts[0]["outcome"], "cancelled_at_fixture_cleanup"
            )
            self.assertTrue(
                any(
                    row["kind"] == "handlers_pending_at_cleanup"
                    for row in peers.fault_records
                )
            )
            release.set()
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())
            self.assertEqual(responses[0][0], 504)
            self.assertFalse(provider.calls)
            self.assertEqual(len(peers.attempts), 1)

    def test_actual_main_module_budget_identity_enforces_http_ceiling(self):
        script = r"""
import ast, json, sys, threading, unittest
from pathlib import Path
from unittest import mock
from http.server import ThreadingHTTPServer
root = Path(sys.argv[1])
sys.path[:0] = [str(root), str(root / "tests")]
import test_runtime_fixture as fixtures
__file__ = str(root / "run.py")
tree = ast.parse(Path(__file__).read_text())
tree.body.pop()  # omit only the CLI invocation while keeping __main__ class identities
exec(compile(tree, __file__, "exec"), globals())
provider = fixtures.InMemoryProvider()
routes = {"high": Route(role="high", base_url="https://provider.example.invalid/v1", api_type="responses", model_name="fixture", api_key_env="FIXTURE", trust="approved_cloud", secret="fake-upstream-value")}
budget = AttemptBudget(1, 30)
peer = fixtures.fixture._peers_class(fixtures.MinimalPeers)(variant="candidate", case={"id":"test","local_inputs":{}}, workload={"as_of":"2026-10-26T12:00:00Z"}, routes=routes, budget=budget, timeout=10, max_output_tokens_per_attempt=8192)
server = ThreadingHTTPServer(("127.0.0.1",0), peer.handler()); server.daemon_threads=True
thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
test = fixtures.RuntimeFixtureTests()
url = f"http://127.0.0.1:{server.server_port}/model/high/v1/responses"
try:
    with mock.patch.dict(sys.modules, {"httpx": provider}):
        first = test.post(url, test.public_body())[0]
        second = test.post(url, test.public_body())[0]
    assert first == 200 and second == 429
    assert len(provider.calls) == len(peer.attempts) == budget.count == 1
    print(json.dumps({"first":first,"second":second,"attempts":len(peer.attempts)}))
finally:
    peer.stop(); server.shutdown(); server.server_close(); thread.join(timeout=2)
"""
        result = subprocess.run(
            [sys.executable, "-c", script, str(HERE)],
            check=True,
            capture_output=True,
            text=True,
        )  # nosec B603
        self.assertEqual(
            json.loads(result.stdout), {"first": 200, "second": 429, "attempts": 1}
        )


if __name__ == "__main__":
    unittest.main()
