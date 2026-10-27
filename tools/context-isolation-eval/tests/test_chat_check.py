"""The built-image Chat check must verify the exact registered budget namespace."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "native_budget_chat_check", ROOT / "builder/context_isolation_chat_check.py"
)
chat = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(chat)


class ChatCheckTests(unittest.TestCase):
    def test_fixture_keeps_canonical_and_native_profiles_distinct(self):
        for control in ("canonical", "nvext"):
            config = {"llms": {"main": {}}, "workflow": {}}
            chat.configuration(config, 19001, 19002, budget_control=control)
            options = config["workflow"]["context_isolation"]["destinations"]["local"][
                "extra_body"
            ]
            with self.subTest(control=control):
                self.assertTrue(chat.thinking_budget_matches(options, True, control))
                self.assertFalse(
                    chat.thinking_budget_matches(
                        options, True, "canonical" if control == "nvext" else "nvext"
                    )
                )
                self.assertIs(options["chat_template_kwargs"]["enable_thinking"], True)
                if control == "nvext":
                    self.assertEqual(options["nvext"], {"max_thinking_tokens": 256})
                    self.assertNotIn("thinking_token_budget", options)
                else:
                    self.assertEqual(options["thinking_token_budget"], 256)
                    self.assertNotIn("nvext", options)
        config = {"llms": {"main": {}}, "workflow": {}}
        chat.configuration(config, 19001, 19002, include_hard_budget=False)
        options = config["workflow"]["context_isolation"]["destinations"]["local"][
            "extra_body"
        ]
        self.assertTrue(chat.thinking_budget_matches(options, False, "canonical"))

    def test_capture_assertion_rejects_corrupt_or_ambiguous_native_fields(self):
        for body in (
            {},
            {"nvext": None},
            {"nvext": {}},
            {"nvext": {"max_thinking_tokens": "256"}},
            {"nvext": {"max_thinking_tokens": 256.0}},
            {"nvext": {"max_thinking_tokens": True}},
            {"nvext": {"max_thinking_tokens": 256, "metadata": {}}},
            {"nvext": {"max_thinking_tokens": 256}, "thinking_token_budget": 256},
        ):
            with self.subTest(body=body):
                self.assertFalse(chat.thinking_budget_matches(body, True, "nvext"))
        self.assertFalse(
            chat.thinking_budget_matches(
                {"nvext": {"max_thinking_tokens": 256}}, False, "canonical"
            )
        )

    def test_invalid_check_modes_fail_before_starting_any_container(self):
        for kwargs in (
            {"budget_control": "unknown"},
            {"budget_control": "nvext", "include_hard_budget": False},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                chat.check("sha256:" + "0" * 64, "unused-redis", **kwargs)
