"""Reject misleading lifecycle accounting in the disposable HTTP proof."""

import hashlib
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from context_isolation_http_check import (  # noqa: E402
    delivered_memory_hashes,
    require_budget_progress,
    workflow_budget_rows,
)


def budget_row():
    return {
        "schema_version": "1",
        "context_class": "LOCAL_ONLY",
        "status": "active",
        "research_closed": "0",
        "research_deadline": "300000",
        "total_deadline": "375000",
        "max_calls": "32",
        "max_tokens": str(32 * 8192),
        "research_ms": "300000",
        "total_ms": "375000",
        "calls_used": "2",
        "tokens_used": str(2 * 8192),
    }


class Ledger:
    """Static synthetic observations, never an acknowledgement of real writes."""

    def __init__(self, row, ttl=-1):
        self.row = {key.encode(): value.encode() for key, value in row.items()}
        self.expiry = ttl

    def scan_iter(self, **_kwargs):
        yield b"daedalus:workflow-budget:v2:synthetic"

    def hgetall(self, _key):
        return self.row

    def ttl(self, _key):
        return self.expiry


class LifecycleAccountingTests(unittest.TestCase):
    def test_progress_matches_observed_attempts_and_preserves_original_limits(self):
        original = budget_row()
        current = original | {"calls_used": "5", "tokens_used": str(5 * 8192)}
        require_budget_progress(original, current, 3)
        for field in (
            "calls_used",
            "tokens_used",
            "research_deadline",
            "total_deadline",
            "max_calls",
            "max_tokens",
            "research_ms",
            "total_ms",
            "research_closed",
        ):
            with self.subTest(field=field):
                invalid = current | {field: str(int(current[field]) + 1)}
                with self.assertRaises(AssertionError):
                    require_budget_progress(original, invalid, 3)
        with self.assertRaises(AssertionError):
            require_budget_progress(original, current, 2)

    def test_memory_delivery_requires_native_user_context_and_completed_page(self):
        text = "[MEMORY_CONTEXT]\nRuntime data\n" + json.dumps(
            {
                "source": "automatic_hindsight",
                "knowledge_pages": [
                    {
                        "name": "Fixture project",
                        "body": "Synthetic project context: 雪🌲.",
                    }
                ],
            }
        )
        message = {"role": "user", "content": [{"type": "input_text", "text": text}]}
        request = {"body": {"input": [message]}}
        self.assertEqual(
            delivered_memory_hashes([request]),
            [hashlib.sha256(text.encode()).hexdigest()],
        )
        for invalid in (
            {"role": "assistant", "content": message["content"]},
            {"role": "user", "content": "The model claims memory was read."},
            {
                "role": "user",
                "content": '[MEMORY_CONTEXT]\n{"source":"automatic_hindsight","knowledge_pages":[]}',
            },
        ):
            with self.subTest(invalid=invalid), self.assertRaises(AssertionError):
                delivered_memory_hashes([{"body": {"input": [invalid]}}])

    def test_ledger_rejects_missing_labels_unknown_status_and_expiring_budgets(self):
        row = budget_row()
        self.assertEqual(len(workflow_budget_rows(Ledger(row))), 1)
        for change in (
            {"context_class": "EXTERNAL_ALLOWED"},
            {"schema_version": "future"},
            {"status": "unknown"},
        ):
            with self.subTest(change=change), self.assertRaises(AssertionError):
                workflow_budget_rows(Ledger(row | change))
        del row["context_class"]
        with self.assertRaises(AssertionError):
            workflow_budget_rows(Ledger(row))
        with self.assertRaises(AssertionError):
            workflow_budget_rows(Ledger(budget_row(), ttl=30))


if __name__ == "__main__":
    unittest.main()
