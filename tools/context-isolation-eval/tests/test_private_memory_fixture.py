"""Bounded private evidence keeps frozen memory intact without generating facts."""

import copy
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "private_memory_fixture_test", HERE / "private_memory_fixture.py"
)
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class PrivateMemoryFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workload_bytes = (HERE / "workload.json").read_bytes()
        cls.workload = json.loads(cls.workload_bytes)
        cls.cases = {case["id"]: case for case in cls.workload["cases"]}

    def test_frozen_memory_reconstructs_byte_for_byte_and_matches_original_hashes(self):
        expected = {
            "personal-heavy": (
                2822,
                "277d478962dc2db1d3a0294711abf02b1e383de932a51d9bb83ee96c487bc47a",
            ),
            "long-context": (
                171,
                "5df7fe0854a47bbb9f6baa9c9c784b43d70ed17efc37945085ab873976c1f15b",
            ),
        }
        for case_id, (length, expected_hash) in expected.items():
            with self.subTest(case=case_id):
                case = self.cases[case_id]
                original = case["local_inputs"]["memory"]
                pages = fixture.memory_pages(case)
                reconstructed = "".join(
                    fixture.page_text(page["body"]) for page in pages
                )
                self.assertEqual(len(original), length)
                self.assertEqual(reconstructed.encode(), original.encode())
                self.assertEqual(sha256(reconstructed), expected_hash)
                self.assertEqual(len(pages), 2 if case_id == "personal-heavy" else 1)
        self.assertEqual((HERE / "workload.json").read_bytes(), self.workload_bytes)
        self.assertEqual(len(self.workload["cases"]), 8)
        self.assertEqual(self.workload["repetitions"], 3)

    def test_pages_are_bounded_and_identify_original_field_parts_offsets_and_hash(self):
        for case_id in ("personal-heavy", "long-context"):
            with self.subTest(case=case_id):
                pages = fixture.memory_pages(self.cases[case_id])
                self.assertLessEqual(len(pages), 2)
                self.assertEqual(len({page["id"] for page in pages}), len(pages))
                offset = 0
                for index, page in enumerate(pages, start=1):
                    self.assertEqual(set(page), {"id", "name", "body"})
                    self.assertEqual(page["id"], f"synthetic-memory-part-{index}")
                    self.assertGreater(len(page["body"]), 0)
                    self.assertLessEqual(len(page["body"]), 1800)
                    raw = fixture.page_text(page["body"])
                    self.assertEqual(page["body"], "|" + raw + "|")
                    self.assertEqual(page["body"].strip(), page["body"])
                    self.assertLessEqual(len(raw), 1798)
                    self.assertLessEqual(len(page["name"]), 200)
                    self.assertIn("local.memory", page["name"])
                    self.assertIn(f"part={index}/{len(pages)}", page["name"])
                    self.assertIn("framing=pipe-v1", page["name"])
                    end = offset + len(raw)
                    self.assertIn(f"chars={offset}:{end}", page["name"])
                    self.assertIn(f"sha256={sha256(raw)}", page["name"])
                    if index < len(pages):
                        self.assertTrue(raw.endswith("\n"))
                    offset = end

    def test_recall_exposes_only_original_derived_experience_with_frozen_time(self):
        expected = {
            "personal-heavy": "498d22ec13d67b980ed877d37cb65b0a6ce3d123131b2195c004d15ba9d701fd",
            "long-context": "1e1fe52d0197c813b1b9c24e0427c00ed5b00a9b50d9123c72c2c44a75892b96",
        }
        for case_id, expected_hash in expected.items():
            with self.subTest(case=case_id):
                case = self.cases[case_id]
                records = fixture.recall_records(case, self.workload["as_of"])
                self.assertEqual(
                    records,
                    [
                        {
                            "text": case["local_inputs"]["derived_summary"],
                            "type": "experience",
                            "mentioned_at": self.workload["as_of"],
                        }
                    ],
                )
                self.assertEqual(sha256(records[0]["text"]), expected_hash)
                self.assertLessEqual(len(records[0]["text"]), 1000)
                self.assertNotEqual(records[0]["text"], case["local_inputs"]["memory"])

    def test_inputs_and_return_values_do_not_share_mutable_state(self):
        case = copy.deepcopy(self.cases["personal-heavy"])
        original = copy.deepcopy(case)
        pages = fixture.memory_pages(case)
        records = fixture.recall_records(case, self.workload["as_of"])
        first_pages = copy.deepcopy(pages)
        first_records = copy.deepcopy(records)
        pages[0]["body"] = "caller replacement"
        records[0]["text"] = "caller replacement"
        self.assertEqual(case, original)
        self.assertEqual(fixture.memory_pages(case), first_pages)
        self.assertEqual(
            fixture.recall_records(case, self.workload["as_of"]), first_records
        )

    def test_review_oracles_and_other_sources_cannot_supply_memory_or_recall(self):
        case = {
            "id": "synthetic-review-isolation",
            "local_inputs": {
                "memory": "Original memory only.\n",
                "derived_summary": "Existing derived record only.",
                "email": "SOURCE_MUST_NOT_BECOME_MEMORY",
                "attachment": "SOURCE_MUST_NOT_BECOME_MEMORY",
                "tool_result": "SOURCE_MUST_NOT_BECOME_MEMORY",
            },
            "required_facts": ["ORACLE_MUST_NOT_BECOME_EVIDENCE"],
            "review_oracles": {"answer": "ORACLE_MUST_NOT_BECOME_EVIDENCE"},
            "anchor_records": [{"text": "ORACLE_MUST_NOT_BECOME_EVIDENCE"}],
            "public_sources": [{"text": "SOURCE_MUST_NOT_BECOME_MEMORY"}],
        }
        pages = fixture.memory_pages(case)
        records = fixture.recall_records(case, self.workload["as_of"])
        self.assertEqual(
            "".join(fixture.page_text(page["body"]) for page in pages),
            "Original memory only.\n",
        )
        self.assertEqual(records[0]["text"], "Existing derived record only.")
        output = json.dumps([pages, records])
        self.assertNotIn("ORACLE_MUST_NOT_BECOME_EVIDENCE", output)
        self.assertNotIn("SOURCE_MUST_NOT_BECOME_MEMORY", output)
        del case["local_inputs"]["memory"]
        del case["local_inputs"]["derived_summary"]
        self.assertEqual(fixture.memory_pages(case), [])
        self.assertEqual(fixture.recall_records(case, self.workload["as_of"]), [])

    def test_unicode_character_limit_and_crlf_boundaries_preserve_all_bytes(self):
        first_line = "🌲" * 898 + "é" * 898 + "\r\n"
        memory = first_line + "終"
        self.assertEqual(len(first_line), 1798)
        self.assertGreater(len(first_line.encode()), 1800)
        pages = fixture.memory_pages({"local_inputs": {"memory": memory}})
        self.assertEqual(
            [fixture.page_text(page["body"]) for page in pages], [first_line, "終"]
        )
        self.assertTrue(all(page["body"].strip() == page["body"] for page in pages))
        self.assertEqual(
            "".join(fixture.page_text(page["body"].strip()) for page in pages).encode(),
            memory.encode(),
        )

    def test_no_newline_or_whitespace_normalization_is_added_to_short_memory(self):
        for memory in ("single line", "  preserved whitespace  ", "🌲" * 1798):
            with self.subTest(length=len(memory)):
                pages = fixture.memory_pages({"local_inputs": {"memory": memory}})
                self.assertEqual([page["body"] for page in pages], ["|" + memory + "|"])
                self.assertEqual(fixture.page_text(pages[0]["body"]), memory)

    def test_exact_memory_and_derived_limits_are_accepted(self):
        memory = "a" * 1797 + "\n" + "b" * 1798
        case = {"local_inputs": {"memory": memory, "derived_summary": "🌲" * 1000}}
        pages = fixture.memory_pages(case)
        self.assertEqual([len(page["body"]) for page in pages], [1800, 1800])
        self.assertEqual(
            "".join(fixture.page_text(page["body"]) for page in pages), memory
        )
        records = fixture.recall_records(case, self.workload["as_of"])
        self.assertEqual(records[0]["text"], "🌲" * 1000)

    def test_oversize_or_unsplittable_memory_fails_closed_instead_of_truncating(self):
        for memory in (
            "a" * 3601,
            "a" * 1799,
            ("a" * 1000 + "\n") * 3,
        ):
            with self.subTest(length=len(memory)):
                case = {"local_inputs": {"memory": memory}}
                original = copy.deepcopy(case)
                with self.assertRaises(ValueError):
                    fixture.memory_pages(case)
                self.assertEqual(case, original)
        case = {"local_inputs": {"derived_summary": "a" * 1001}}
        with self.assertRaises(ValueError):
            fixture.recall_records(case, self.workload["as_of"])
        self.assertEqual(len(case["local_inputs"]["derived_summary"]), 1001)

    def test_pipe_frame_unwraps_only_outer_pair_and_preserves_literal_contents(self):
        for raw in ("|inner|pipes||", "  leading and trailing  ", "\r\n雪🌲\n", "|"):
            with self.subTest(raw=raw):
                self.assertEqual(fixture.page_text("|" + raw + "|"), raw)
                pages = fixture.memory_pages({"local_inputs": {"memory": raw}})
                self.assertEqual(
                    "".join(fixture.page_text(page["body"]) for page in pages), raw
                )
        for body in (
            "missing frame",
            "|missing end",
            "missing start|",
            " |padded| ",
            "|" + "a" * 1799 + "|",
        ):
            with self.subTest(length=len(body)), self.assertRaises(ValueError):
                fixture.page_text(body)

    def test_missing_and_public_only_sources_never_invent_private_outputs(self):
        for case in (
            {},
            {"local_inputs": {}},
            {"local_inputs": {"memory": "", "derived_summary": ""}},
            {
                "id": "public-only",
                "local_inputs": {"memory": "", "derived_summary": ""},
            },
        ):
            with self.subTest(case=case):
                self.assertEqual(fixture.memory_pages(case), [])
                self.assertEqual(
                    fixture.recall_records(case, self.workload["as_of"]), []
                )
        for field in ("memory", "derived_summary"):
            public_only = {
                "id": "public-only",
                "local_inputs": {field: "unexpected private evidence"},
            }
            with self.subTest(public_only_field=field):
                with self.assertRaises(ValueError):
                    fixture.memory_pages(public_only)
                with self.assertRaises(ValueError):
                    fixture.recall_records(public_only, self.workload["as_of"])
        for case in self.workload["cases"]:
            if case["id"] not in {"personal-heavy", "long-context"}:
                with self.subTest(case=case["id"]):
                    self.assertEqual(fixture.memory_pages(case), [])
                    self.assertEqual(
                        fixture.recall_records(case, self.workload["as_of"]), []
                    )


if __name__ == "__main__":
    unittest.main()
