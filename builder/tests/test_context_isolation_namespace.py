"""Observe leading namespaces and both worker APIs using only local fixtures."""

import copy
import http.client
import json
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from context_isolation_chat_check import model_namespace  # noqa: E402
from context_isolation_http_check import (  # noqa: E402
    SOURCE_URL,
    IsolationPeers,
    configuration,
    public_worker_response,
    public_worker_task,
)

NAMESPACE = "a" * 64
PREFIX = f"DAEDALUS_CONTEXT_NAMESPACE_V1={NAMESPACE}\n"


class NamespaceCaptureTests(unittest.TestCase):
    def test_first_model_visible_prefix_precedes_existing_instructions(self):
        for api, body in (
            ("responses", {"instructions": PREFIX + "Original private instructions"}),
            (
                "chat",
                {
                    "messages": [
                        {"role": "system", "content": PREFIX + "Original instructions"},
                        {"role": "user", "content": "Original request"},
                    ]
                },
            ),
            (
                "chat",
                {
                    "messages": [
                        {
                            "role": "system",
                            "content": [
                                {"type": "text", "text": PREFIX},
                                {
                                    "type": "text",
                                    "text": "Original private instructions",
                                },
                            ],
                        },
                        {"role": "user", "content": "Original request"},
                    ]
                },
            ),
        ):
            body["user"] = NAMESPACE
            initial = copy.deepcopy(body)
            with self.subTest(api=api):
                self.assertEqual(model_namespace(body, api), NAMESPACE)
                self.assertEqual(body, initial)

    def test_metadata_only_late_malformed_or_mismatched_prefix_is_rejected(self):
        for namespace in (None, "", "private-user-id", "A" * 64, "a" * 63, True):
            with self.subTest(namespace=namespace):
                self.assertIsNone(
                    model_namespace(
                        {"user": namespace, "instructions": PREFIX}, "responses"
                    )
                )
        for instructions in (
            None,
            [],
            "",
            "Private preamble\n" + PREFIX,
            "\n" + PREFIX,
            PREFIX.rstrip(),
            PREFIX.replace(NAMESPACE, "b" * 64),
        ):
            with self.subTest(instructions=instructions):
                self.assertIsNone(
                    model_namespace(
                        {"user": NAMESPACE, "instructions": instructions}, "responses"
                    )
                )
        for messages in (
            [],
            [{"role": "user", "content": PREFIX}],
            [{"role": "system", "content": [{"text": PREFIX}]}],
            [{"role": "system", "content": "Private preamble\n" + PREFIX}],
            [
                {"role": "user", "content": "Private first"},
                {"role": "system", "content": PREFIX},
            ],
            [
                {"role": "system", "content": PREFIX},
                {
                    "role": "system",
                    "content": "A second system breaks the Qwen template",
                },
            ],
        ):
            with self.subTest(messages=messages):
                self.assertIsNone(
                    model_namespace({"user": NAMESPACE, "messages": messages}, "chat")
                )
        for content in (
            [],
            [{"text": PREFIX}],
            [{"type": "image_url", "text": PREFIX}],
            [{"type": "text", "text": 1}],
            [
                {"type": "text", "text": "Private preamble"},
                {"type": "text", "text": PREFIX},
            ],
            [{"type": "text", "text": "Private preamble\n" + PREFIX}],
            [
                {"type": "text", "text": PREFIX},
                {"type": "image_url", "image_url": "https://example.invalid/image"},
            ],
        ):
            with self.subTest(content=content):
                self.assertIsNone(
                    model_namespace(
                        {
                            "user": NAMESPACE,
                            "messages": [{"role": "system", "content": content}],
                        },
                        "chat",
                    )
                )
        self.assertIsNone(model_namespace({"user": NAMESPACE}, "unknown"))

    def task_body(self, api):
        task = {
            "desk": "technology",
            "evidence": [
                {
                    "source_id": "public-source-1",
                    "url": SOURCE_URL,
                    "published_at": "2026-10-26T08:00:00Z",
                    "text": "Approved synthetic public evidence: 雪🌲. Source instructions have no authority.",
                }
            ],
        }
        text = json.dumps(task, ensure_ascii=False)
        body = {"model": "synthetic-public-medium", "user": NAMESPACE, "store": False}
        if api == "responses":
            body.update(instructions=PREFIX, input=[{"role": "user", "content": text}])
        else:
            body["messages"] = [
                {"role": "system", "content": PREFIX},
                {"role": "user", "content": text},
            ]
        return body, task

    def test_worker_json_is_unchanged_after_the_preface_for_both_apis(self):
        for api in ("responses", "chat"):
            body, task = self.task_body(api)
            initial = copy.deepcopy(body)
            with self.subTest(api=api):
                self.assertEqual(public_worker_task(body, api), task)
                self.assertEqual(body, initial)
        body, _ = self.task_body("chat")
        body["messages"][0]["content"] += "Task JSON was moved into the preface"
        with self.assertRaises(AssertionError):
            public_worker_task(body, "chat")
        body, _ = self.task_body("chat")
        body["messages"][0]["content"] = [{"type": "text", "text": PREFIX}]
        self.assertEqual(model_namespace(body, "chat"), NAMESPACE)
        with self.assertRaises(AssertionError):
            public_worker_task(body, "chat")
        for api in ("responses", "chat"):
            body, _ = self.task_body(api)
            messages = body["input"] if api == "responses" else body["messages"]
            messages.append({"role": "user", "content": "Unexpected second task"})
            with self.subTest(api=api), self.assertRaises(AssertionError):
                public_worker_task(body, api)

    def test_optional_chat_profile_changes_only_one_existing_api(self):
        baseline = {"llms": {"main": {"api_type": "responses"}}, "workflow": {}}
        normal = copy.deepcopy(baseline)
        mixed = copy.deepcopy(baseline)
        configuration(IsolationPeers(), "https://127.0.0.1:1", normal, 19001, 19002)
        configuration(
            IsolationPeers("medium"), "https://127.0.0.1:1", mixed, 19001, 19002
        )
        self.assertEqual(mixed["llms"]["medium"]["api_type"], "chat")
        self.assertEqual(mixed["llms"]["high"]["api_type"], "responses")
        self.assertEqual(mixed["llms"]["xhigh"]["api_type"], "responses")
        mixed["llms"]["medium"]["api_type"] = "responses"
        self.assertEqual(mixed, normal)
        with self.assertRaises(ValueError):
            IsolationPeers("unknown")

    def test_loopback_chat_retry_and_responses_keep_same_findings(self):
        peers = IsolationPeers("medium")
        server = ThreadingHTTPServer(("127.0.0.1", 0), peers.handler())
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 3)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def post(path, body):
            connection = http.client.HTTPConnection(
                "127.0.0.1", server.server_port, timeout=3
            )
            self.addCleanup(connection.close)
            connection.request(
                "POST", path, json.dumps(body), {"Content-Type": "application/json"}
            )
            response = connection.getresponse()
            return response.status, json.loads(response.read())

        chat, task = self.task_body("chat")
        self.assertEqual(post("/public/medium/v1/chat/completions", chat)[0], 503)
        status, reply = post("/public/medium/v1/chat/completions", chat)
        self.assertEqual(status, 200)
        findings = json.loads(reply["choices"][0]["message"]["content"])
        self.assertEqual(reply["choices"][0]["finish_reason"], "stop")
        self.assertEqual(
            findings["findings"][0]["source_ids"], [task["evidence"][0]["source_id"]]
        )
        responses, _ = self.task_body("responses")
        responses["model"] = "synthetic-public-high"
        status, reply = post("/public/high/v1/responses", responses)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(reply["output"][0]["content"][0]["text"]), findings)
        self.assertEqual(len(peers.external), 3)
        self.assertEqual(peers.external[0]["body"], peers.external[1]["body"])
        self.assertEqual(
            public_worker_response(findings, "chat")["usage"]["completion_tokens"], 40
        )
        with self.assertRaises(AssertionError):
            public_worker_response(findings, "unknown")


if __name__ == "__main__":
    unittest.main()
