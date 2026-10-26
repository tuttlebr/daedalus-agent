"""Synthetic clock/fault transforms preserve identities and unreported usage."""

import copy
import importlib.util
import json
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "context_fixture_transforms",
    Path(__file__).resolve().parents[1] / "fixture_transforms.py",
)
transforms = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(transforms)

CLOCK = "2026-10-26T12:00:00Z"
ORIGINAL_CLOCK = "2026-10-26T12:41:59+00:00"
ARGS = json.dumps(
    {
        "edition": {
            "format": "daily-daedalus/v1",
            "lead": {"headline": "Synthetic 雪🌲"},
        },
        "keep": {"format": "public-source"},
    }
)


def event(value, prefix=b"", ending=b"\n"):
    return (
        prefix
        + b"data: "
        + json.dumps(value, ensure_ascii=False).encode()
        + ending
        + ending
    )


def documents(raw):
    output = []
    for block in raw.replace(b"\r\n", b"\n").split(b"\n\n"):
        data = b"\n".join(
            line[5:].strip() for line in block.split(b"\n") if line.startswith(b"data:")
        )
        if data and data != b"[DONE]":
            output.append(json.loads(data))
    return output


class ClockTests(unittest.TestCase):
    def test_daily_skill_clock_freezes_only_the_matched_trusted_runtime_section(self):
        clock = {
            "source": "daily_summary_runtime_clock",
            "utc": ORIGINAL_CLOCK,
            "local": "2026-10-26T08:41:59-04:00",
            "timezone": "America/Detroit",
        }
        suffix = "\n\n---\n\n## Bundled resource: `references/edition-policy.json`\n\nPublic source date: 2026-10-20."
        text = (
            "# Daily Summary\n\n"
            + transforms.DAILY_CLOCK_SECTION
            + json.dumps(clock, indent=2)
            + suffix
        )
        args = json.dumps({"operation": "load_skill", "skill_name": "daily-summary"})
        body = {
            "input": [
                {"role": "user", "content": text},
                {
                    "type": "function_call",
                    "name": "agent_skills_tool",
                    "call_id": "skill",
                    "arguments": args,
                },
                {
                    "type": "function_call",
                    "name": "webscrape_tool",
                    "call_id": "public",
                    "arguments": "{}",
                },
                {"type": "function_call_output", "call_id": "skill", "output": text},
                {"type": "function_call_output", "call_id": "public", "output": text},
            ]
        }
        frozen, records = transforms.freeze_clock(body, CLOCK)
        self.assertEqual(frozen["input"][0], body["input"][0])
        self.assertEqual(frozen["input"][4], body["input"][4])
        self.assertTrue(frozen["input"][3]["output"].endswith(suffix))
        self.assertEqual(len(records), 1)
        self.assertEqual(
            records[0]["frozen_output"],
            {
                "source": "daily_summary_runtime_clock",
                "utc": CLOCK,
                "local": CLOCK,
                "timezone": "UTC",
            },
        )
        body["input"][1]["arguments"] = json.dumps(
            {
                "operation": "load_skill",
                "skill_name": "daily-summary",
                "resource": "references/research-and-sourcing.md",
            }
        )
        self.assertEqual(transforms.freeze_clock(body, CLOCK), (body, []))

    def test_responses_clock_ids_do_not_replace_matching_public_or_user_text(self):
        body = {
            "input": [
                {"role": "user", "content": ORIGINAL_CLOCK},
                {
                    "type": "function_call",
                    "name": "current_datetime_tool",
                    "call_id": "clock",
                },
                {"type": "function_call", "name": "webscrape_tool", "call_id": "web"},
                {
                    "type": "function_call_output",
                    "call_id": "web",
                    "output": ORIGINAL_CLOCK,
                },
                {
                    "type": "function_call_output",
                    "call_id": "clock",
                    "output": ORIGINAL_CLOCK,
                },
                {
                    "type": "function_call_output",
                    "call_id": "clock",
                    "output": '{"error":"unavailable"}',
                },
            ]
        }
        original = copy.deepcopy(body)
        frozen, records = transforms.freeze_clock(body, CLOCK)
        self.assertEqual(body, original)
        self.assertEqual(frozen["input"][0]["content"], ORIGINAL_CLOCK)
        self.assertEqual(frozen["input"][3]["output"], ORIGINAL_CLOCK)
        self.assertEqual(frozen["input"][4]["output"], CLOCK)
        self.assertEqual(frozen["input"][5], original["input"][5])
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["call_id"], "clock")

    def test_chat_clock_only_changes_matching_tool_results(self):
        body = {
            "messages": [
                {
                    "role": "assistant",
                    "tool_calls": [
                        {"id": "clock", "function": {"name": "current_datetime_tool"}},
                        {"id": "article", "function": {"name": "webscrape_tool"}},
                    ],
                },
                {"role": "tool", "tool_call_id": "article", "content": ORIGINAL_CLOCK},
                {
                    "role": "tool",
                    "tool_call_id": "clock",
                    "content": [{"type": "text", "text": ORIGINAL_CLOCK}],
                },
                {"role": "user", "tool_call_id": "clock", "content": ORIGINAL_CLOCK},
            ]
        }
        frozen, records = transforms.freeze_clock(body, CLOCK)
        self.assertEqual(frozen["messages"][1], body["messages"][1])
        self.assertEqual(frozen["messages"][2]["content"][0]["text"], CLOCK)
        self.assertEqual(frozen["messages"][3], body["messages"][3])
        self.assertEqual(len(records), 1)

    def test_naive_or_invalid_fixture_clock_rejected(self):
        for value in ("2026-10-26", "private instruction", None):
            with self.assertRaises(ValueError):
                transforms.freeze_clock({}, value)


class RendererMutationTests(unittest.TestCase):
    def test_responses_json_mutates_only_first_renderer_complete_arguments(self):
        call = {
            "type": "function_call",
            "id": "item",
            "call_id": "call",
            "name": "briefing_renderer_tool",
            "arguments": ARGS,
        }
        body = {
            "status": "completed",
            "model": "actual-model-v1",
            "output": [
                dict(call, name="public_search", id="search", call_id="search"),
                call,
                dict(call, id="second", call_id="second"),
            ],
            "usage": {"input_tokens": 7},
        }
        raw = json.dumps(body).encode()
        mutated, record = transforms.mutate_renderer_response(raw, "responses")
        parsed = json.loads(mutated)
        self.assertTrue(record["mutated"])
        self.assertEqual(record["call_id"], "call")
        self.assertNotIn(
            "format", json.loads(parsed["output"][1]["arguments"])["edition"]
        )
        self.assertEqual(
            json.loads(parsed["output"][1]["arguments"])["keep"]["format"],
            "public-source",
        )
        self.assertEqual(parsed["output"][0], body["output"][0])
        self.assertEqual(parsed["output"][2], body["output"][2])
        self.assertEqual(parsed["usage"], body["usage"])

    def test_responses_sse_interleaved_arguments_and_all_terminal_snapshots_cohere(
        self,
    ):
        other = {
            "type": "function_call",
            "id": "other",
            "call_id": "other-call",
            "name": "public_search",
            "arguments": '{"query":"format stays public"}',
        }
        renderer = {
            "type": "function_call",
            "id": "renderer",
            "call_id": "renderer-call",
            "name": "briefing_renderer_tool",
            "arguments": ARGS,
        }
        untouched = event(
            {
                "type": "response.output_item.done",
                "output_index": 0,
                "sequence_number": 2,
                "item": other,
            },
            prefix=b": keep this comment\n",
        )
        raw = b"".join(
            [
                event(
                    {
                        "type": "response.output_item.added",
                        "output_index": 1,
                        "sequence_number": 1,
                        "item": dict(renderer, arguments=""),
                    }
                ),
                untouched,
                event(
                    {
                        "type": "response.function_call_arguments.delta",
                        "item_id": "renderer",
                        "output_index": 1,
                        "sequence_number": 3,
                        "delta": ARGS[:35],
                    },
                    prefix=b"id: fixed-event\nevent: response.function_call_arguments.delta\n",
                ),
                event(
                    {
                        "type": "response.function_call_arguments.delta",
                        "item_id": "renderer",
                        "output_index": 1,
                        "sequence_number": 4,
                        "delta": ARGS[35:],
                    },
                    ending=b"\r\n",
                ),
                event(
                    {
                        "type": "response.function_call_arguments.done",
                        "item_id": "renderer",
                        "output_index": 1,
                        "sequence_number": 5,
                        "arguments": ARGS,
                    }
                ),
                event(
                    {
                        "type": "response.output_item.done",
                        "output_index": 1,
                        "sequence_number": 6,
                        "item": renderer,
                    }
                ),
                event(
                    {
                        "type": "response.completed",
                        "sequence_number": 7,
                        "response": {
                            "status": "completed",
                            "output": [other, renderer],
                            "usage": {"input_tokens": 10, "output_tokens": 4},
                        },
                    }
                ),
                b"data: [DONE]\n\n",
            ]
        )
        mutated, record = transforms.mutate_renderer_response(raw, "responses")
        values = documents(mutated)
        self.assertIn(untouched, mutated)
        self.assertIn(
            b"id: fixed-event\nevent: response.function_call_arguments.delta\n", mutated
        )
        deltas = [
            item["delta"]
            for item in values
            if item["type"] == "response.function_call_arguments.delta"
        ]
        self.assertEqual(deltas, [record["faulted_arguments"], ""])
        self.assertEqual(
            json.loads("".join(deltas)), json.loads(record["faulted_arguments"])
        )
        self.assertEqual(values[0]["item"]["arguments"], "")
        self.assertEqual(values[-3]["arguments"], record["faulted_arguments"])
        self.assertEqual(values[-2]["item"]["arguments"], record["faulted_arguments"])
        self.assertEqual(
            values[-1]["response"]["output"][1]["arguments"],
            record["faulted_arguments"],
        )
        self.assertEqual(
            [value["sequence_number"] for value in values], list(range(1, 8))
        )

    def test_chat_json_top_level_format_and_chat_sse_fragmented_names(self):
        raw = json.dumps(
            {
                "choices": [
                    {
                        "message": {
                            "tool_calls": [
                                {
                                    "id": "chat-call",
                                    "function": {
                                        "name": "briefing_renderer_tool",
                                        "arguments": '{"format":"daily-daedalus/v1","lead":{}}',
                                    },
                                }
                            ]
                        }
                    }
                ]
            }
        ).encode()
        mutated, record = transforms.mutate_renderer_response(raw, "chat_completions")
        self.assertNotIn(
            "format",
            json.loads(
                json.loads(mutated)["choices"][0]["message"]["tool_calls"][0][
                    "function"
                ]["arguments"]
            ),
        )
        self.assertEqual(record["call_id"], "chat-call")
        raw = b"".join(
            [
                event(
                    {
                        "id": "stream",
                        "choices": [
                            {
                                "index": 0,
                                "delta": {
                                    "tool_calls": [
                                        {
                                            "index": 0,
                                            "id": "chat-call",
                                            "function": {
                                                "name": "briefing_",
                                                "arguments": ARGS[:12],
                                            },
                                        },
                                        {
                                            "index": 1,
                                            "id": "other",
                                            "function": {
                                                "name": "public_search",
                                                "arguments": '{"query":"public"}',
                                            },
                                        },
                                    ]
                                },
                            }
                        ],
                    }
                ),
                event(
                    {
                        "id": "stream",
                        "choices": [
                            {
                                "index": 0,
                                "delta": {
                                    "tool_calls": [
                                        {
                                            "index": 0,
                                            "function": {
                                                "name": "renderer_tool",
                                                "arguments": ARGS[12:],
                                            },
                                        }
                                    ]
                                },
                            }
                        ],
                    }
                ),
                event(
                    {
                        "id": "stream",
                        "choices": [
                            {"index": 0, "delta": {}, "finish_reason": "tool_calls"}
                        ],
                        "usage": {"prompt_tokens": 5, "completion_tokens": 9},
                    }
                ),
                b"data: [DONE]\n\n",
            ]
        )
        mutated, record = transforms.mutate_renderer_response(raw, "chat")
        values = documents(mutated)
        first, second = (
            value["choices"][0]["delta"]["tool_calls"][0] for value in values[:2]
        )
        self.assertEqual(first["function"]["arguments"], record["faulted_arguments"])
        self.assertEqual(second["function"]["arguments"], "")
        self.assertEqual(
            first["function"]["name"] + second["function"]["name"],
            "briefing_renderer_tool",
        )
        self.assertEqual(
            values[0]["choices"][0]["delta"]["tool_calls"][1]["function"]["arguments"],
            '{"query":"public"}',
        )

    def test_no_format_or_no_renderer_never_rewrites_response_bytes(self):
        raw = b'{ "status":"completed", "output":[{"type":"function_call","call_id":"first","name":"briefing_renderer_tool","arguments":"{}"}] }'
        mutated, record = transforms.mutate_renderer_response(raw, "responses")
        self.assertEqual(mutated, raw)
        self.assertFalse(record["mutated"])
        for raw in (b"not-json", b"data: [DONE]\n\n", b'{"output":[]}'):
            self.assertEqual(
                transforms.mutate_renderer_response(raw, "responses"), (raw, None)
            )

    def test_message_only_sse_and_multiline_data_keep_bookkeeping(self):
        chat = {
            "id": "chat-response",
            "choices": [
                {
                    "index": 2,
                    "message": {
                        "tool_calls": [
                            {
                                "id": "complete-call",
                                "function": {
                                    "name": "briefing_renderer_tool",
                                    "arguments": ARGS,
                                },
                            }
                        ]
                    },
                }
            ],
        }
        raw = (
            b"id: event-identity\nevent: completion\n"
            + b"\n".join(
                b"data: " + line
                for line in json.dumps(chat, indent=2).encode().splitlines()
            )
            + b"\n\n"
        )
        mutated, record = transforms.mutate_renderer_response(raw, "chat")
        self.assertEqual(record["call_id"], "complete-call")
        self.assertIn(b"id: event-identity\nevent: completion\n", mutated)
        function = documents(mutated)[0]["choices"][0]["message"]["tool_calls"][0][
            "function"
        ]
        self.assertEqual(function["arguments"], record["faulted_arguments"])

    def test_malformed_provider_envelopes_are_not_repaired(self):
        for raw in (
            b'{"output":false}',
            b'{"choices":[{"message":{"tool_calls":[null]}}]}',
            event({"type": "response.output_item.done", "item": "not an object"}),
        ):
            api = "chat" if b"choices" in raw else "responses"
            self.assertEqual(transforms.mutate_renderer_response(raw, api), (raw, None))


class UsageTests(unittest.TestCase):
    def test_reported_zero_cache_is_preserved_and_missing_counts_are_unknown(self):
        raw = json.dumps(
            {
                "model": "actual-v1",
                "status": "completed",
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 3,
                    "input_tokens_details": {"cached_tokens": 0},
                },
            }
        ).encode()
        self.assertEqual(
            transforms.usage_from_response(raw, "responses"),
            {
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 3,
                    "cached_input_tokens": 0,
                },
                "model_versions": ["actual-v1"],
                "terminal_outcome": "completed",
            },
        )
        for usage in (
            {"total_tokens": 30},
            {"input_tokens": True, "output_tokens": -4},
            {},
        ):
            result = transforms.usage_from_response(
                json.dumps({"usage": usage}).encode(), "responses"
            )
            self.assertEqual(
                result["usage"],
                dict.fromkeys(["input_tokens", "output_tokens", "cached_input_tokens"]),
            )

    def test_responses_terminal_usage_and_chat_usage_chunk_are_selected(self):
        raw = event(
            {
                "type": "response.created",
                "response": {"model": "reported-alias", "usage": {"input_tokens": 999}},
            }
        ) + event(
            {
                "type": "response.completed",
                "response": {
                    "model": "actual-v2",
                    "usage": {"input_tokens": 7, "output_tokens": 8},
                },
            }
        )
        result = transforms.usage_from_response(raw, "responses")
        self.assertEqual(
            result["usage"],
            {"input_tokens": 7, "output_tokens": 8, "cached_input_tokens": None},
        )
        self.assertEqual(result["model_versions"], ["reported-alias", "actual-v2"])
        raw = event(
            {"type": "response.created", "response": {"usage": {"input_tokens": 999}}}
        ) + event({"type": "response.completed", "response": {}})
        self.assertIsNone(
            transforms.usage_from_response(raw, "responses")["usage"]["input_tokens"]
        )
        raw = (
            event(
                {
                    "model": "chat-v1",
                    "choices": [],
                    "usage": {
                        "prompt_tokens": 4,
                        "completion_tokens": 5,
                        "prompt_tokens_details": {"cached_tokens": 2},
                    },
                }
            )
            + b"data: [DONE]\n\n"
        )
        self.assertEqual(
            transforms.usage_from_response(raw, "chat_completions"),
            {
                "usage": {
                    "input_tokens": 4,
                    "output_tokens": 5,
                    "cached_input_tokens": 2,
                },
                "model_versions": ["chat-v1"],
                "terminal_outcome": "http_success_terminal_unknown",
            },
        )

    def test_malformed_usage_details_are_unknown(self):
        for details in (3, True, "private text", []):
            result = transforms.usage_from_response(
                json.dumps(
                    {
                        "usage": {
                            "input_tokens_details": details,
                            "prompt_tokens_details": details,
                        }
                    }
                ).encode(),
                "responses",
            )
            self.assertIsNone(result["usage"]["cached_input_tokens"])

    def test_terminal_failures_do_not_become_success_on_http_200(self):
        for status, expected in (
            ("completed", "completed"),
            ("failed", "provider_failed"),
            ("incomplete", "incomplete"),
            ("cancelled", "cancelled"),
        ):
            raw = json.dumps(
                {"status": status, "model": "actual", "usage": {"input_tokens": 7}}
            ).encode()
            result = transforms.usage_from_response(raw, "responses")
            self.assertEqual(result["terminal_outcome"], expected)
            self.assertEqual(result["usage"]["input_tokens"], 7)
            self.assertEqual(result["model_versions"], ["actual"])
        for reason, expected in (
            ("stop", "completed"),
            ("tool_calls", "completed"),
            ("function_call", "completed"),
            ("length", "incomplete"),
            ("content_filter", "filter"),
        ):
            raw = event(
                {
                    "model": "actual-chat",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": reason}],
                    "usage": {"prompt_tokens": 3},
                }
            )
            result = transforms.usage_from_response(raw, "chat")
            self.assertEqual(result["terminal_outcome"], expected)
            self.assertEqual(result["usage"]["input_tokens"], 3)
        error = event(
            {
                "type": "error",
                "error": {"message": "synthetic failure"},
                "usage": {"input_tokens": 4},
            }
        )
        self.assertEqual(
            transforms.usage_from_response(error, "responses")["terminal_outcome"],
            "provider_error",
        )
        self.assertEqual(
            transforms.usage_from_response(error, "responses")["usage"]["input_tokens"],
            4,
        )
        for raw in (
            b"not-json",
            b"{}",
            event({"type": "response.created", "response": {"status": "in_progress"}}),
        ):
            self.assertEqual(
                transforms.usage_from_response(raw, "responses")["terminal_outcome"],
                "http_success_terminal_unknown",
            )


if __name__ == "__main__":
    unittest.main()
