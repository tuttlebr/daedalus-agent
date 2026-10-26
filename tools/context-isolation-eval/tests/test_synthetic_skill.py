"""A synthetic reader must retain the reviewed workflow and no private profile."""

import hashlib
import importlib.util
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parents[1]
ROOT = HERE.parents[1]
SPEC = importlib.util.spec_from_file_location(
    "synthetic_skill_test", HERE / "synthetic_skill.py"
)
synthetic = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(synthetic)
CANONICAL = ROOT / "skills/daily-summary"


class SyntheticSkillTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bundle = self.root / "bundle"
        self.manifest = synthetic.build_bundle(CANONICAL, self.bundle)
        self.skill = self.bundle / "daily-summary"
        self.original = json.loads(
            (CANONICAL / "references/edition-policy.json").read_text()
        )
        self.policy = json.loads(
            (self.skill / "references/edition-policy.json").read_text()
        )

    def test_preserves_canonical_schema_renderer_and_all_workflow_sections(self):
        immutable = (
            set(synthetic.REVIEWED_SOURCES)
            - set(synthetic.PROSE)
            - {"references/edition-policy.json"}
        )
        for relative in immutable:
            self.assertEqual(
                (self.skill / relative).read_bytes(),
                (CANONICAL / relative).read_bytes(),
            )
        for relative in synthetic.PROSE:
            original = (CANONICAL / relative).read_text()
            actual = (self.skill / relative).read_text()
            self.assertGreater(len(actual), len(original) * 0.95)
            self.assertIn(synthetic.NOTICE.strip(), actual)
            replacements = synthetic._personal_replacements(
                self.original, (CANONICAL / "SKILL.md").read_text()
            )
            expected = synthetic._replace(original, replacements)
            self.assertEqual(
                re.findall(r"(?m)^#{1,6} .+$", expected),
                re.findall(r"(?m)^#{1,6} .+$", actual),
            )
        skill = (self.skill / "SKILL.md").read_text()
        sourcing = (self.skill / "references/research-and-sourcing.md").read_text()
        for phrase in (
            "includes all four required",
            "source policy",
            "public_briefing_worker",
            "briefing_renderer_tool",
            "read-only",
            "authorization",
        ):
            self.assertIn(phrase.lower(), (skill + sourcing).lower())

    def test_replaces_private_identity_and_reader_interests_independently(self):
        corpus = "\n".join(
            (self.skill / relative).read_text()
            for relative in (*synthetic.PROSE, "references/edition-policy.json")
        )
        replacements = synthetic._personal_replacements(
            self.original, (CANONICAL / "SKILL.md").read_text()
        )
        for original, replacement in replacements:
            if original != replacement:
                pattern = (
                    r"\b"
                    + r"\s+".join(re.escape(part) for part in original.split())
                    + (r"\b" if original[-1:].isalnum() else "")
                )
                if original.startswith("/"):
                    pattern = re.escape(original)
                self.assertIsNone(re.search(pattern, corpus), original)
        for preference in (
            "birding",
            "vegetarian",
            "plant-forward",
            "NeMo",
            "semiconductor complex",
            "NVIDIA Developer Blog",
            "Daedalus project",
        ):
            self.assertNotIn(preference.casefold(), corpus.casefold())
        for fiction in (
            "stargazing",
            "bread fermentation",
            "civic-archive",
            "Mara Vale",
            "Example City",
            "SYN_A",
        ):
            self.assertIn(fiction, corpus)
        self.assertIn("nvidia_docs_tool", corpus)  # Real tool syntax remains usable.
        self.assertEqual(self.policy["edition"]["timezone"], "UTC")

    def test_removes_reader_history_while_preserving_current_policy_precedence(self):
        skill = (self.skill / "SKILL.md").read_text()
        sourcing = (self.skill / "references/research-and-sourcing.md").read_text()
        corpus = " ".join(
            (skill + sourcing + json.dumps(self.policy)).split()
        ).casefold()
        for history in (
            "superseded fixed cluster lead",
            "market-news ban",
            "newer explicit editorial direction",
            "superseded mandatory operations lead",
            "ban daily market reporting",
            "remembered stalled-mirror condition",
            "old example junction trip",
        ):
            self.assertNotIn(history, corpus)
        for value in (skill, self.policy["selection_rules"][-1]):
            self.assertIn("Current explicit requests", value)
            self.assertIn("current synthetic policy take precedence", value)
            self.assertIn("stale or dated memory", value)
        self.assertIn("Retain no raw private memory", skill)
        self.assertIn("reuse stale operational observations", sourcing)
        travel = next(desk for desk in self.policy["desks"] if desk["key"] == "travel")
        self.assertIn("Require confirmed current travel evidence", travel["rules"][0])
        self.assertIn("Date prices, quote conditions and schedules", travel["rules"][0])

    def test_keeps_policy_mechanics_desk_keys_and_independent_topic_counts(self):
        original = self.original
        current = self.policy
        self.assertEqual(set(original), set(current))
        self.assertEqual(len(original["desks"]), len(current["desks"]))
        for before, after in zip(original["desks"], current["desks"], strict=True):
            self.assertEqual(before["key"], after["key"])
            self.assertEqual(set(before), set(after))
            self.assertEqual(len(before["topics"]), len(after["topics"]))
            for key in set(before) - {"topics", "rules", "label"}:
                self.assertEqual(before[key], after[key])
        self.assertEqual(
            original["selection_rules"][:-1], current["selection_rules"][:-1]
        )
        for key in set(original) - {
            "policy_version",
            "edition",
            "reader",
            "desks",
            "selection_rules",
        }:
            self.assertEqual(original[key], current[key])

    def test_preserves_production_prompt_descriptions_and_runtime_defaults(self):
        context = json.loads((self.bundle / "fixture-environment.json").read_text())
        production = yaml.safe_load(
            (ROOT / "backend/tool-calling-config.yaml").read_text()
        )
        replacements = synthetic._personal_replacements(
            self.original, (CANONICAL / "SKILL.md").read_text()
        )
        self.assertEqual(
            context["workflow_instructions"],
            synthetic._replace(production["workflow"]["instructions"], replacements),
        )
        self.assertGreater(len(context["workflow_instructions"]), 1000)
        for name, settings in production["functions"].items():
            if isinstance(settings, dict) and isinstance(
                settings.get("description"), str
            ):
                self.assertEqual(
                    context["tool_descriptions"][name],
                    synthetic._replace(settings["description"], replacements),
                )
        self.assertEqual(context["max_history"], 50)
        self.assertEqual(context["max_history_tokens"], 32000)
        self.assertEqual(context["model_max_retries"], 3)
        self.assertEqual(context["workflow_defaults"]["max_iterations"], 128)
        self.assertTrue(context["workflow_defaults"]["tool_output_compaction_enabled"])
        self.assertEqual(
            context["tool_output_retriever"]["_type"],
            production["functions"]["tool_output_retriever_tool"]["_type"],
        )
        self.assertEqual(
            context["source_verifier"]["enabled_operations"],
            ["verify_claim", "plan_sources", "audit_citations"],
        )
        self.assertEqual(context["skill_model_profiles"], {"daily-summary": "deep"})
        self.assertEqual(
            set(context["unavailable_mapped_skills"]),
            set(production["workflow"]["skill_model_profiles"]) - {"daily-summary"},
        )

    def test_provenance_is_host_only_and_manifest_binds_every_export(self):
        self.assertFalse((self.skill / "fixture-environment.json").exists())
        self.assertFalse((self.skill / "fixture-provenance.json").exists())
        provenance = json.loads((self.bundle / "fixture-provenance.json").read_text())
        self.assertEqual(provenance["source_sha256"], synthetic.REVIEWED_SOURCES)
        self.assertEqual(len(self.manifest), len(synthetic.REVIEWED_SOURCES) + 2)
        for relative, digest in self.manifest.items():
            self.assertEqual(
                digest,
                hashlib.sha256((self.bundle / relative).read_bytes()).hexdigest(),
            )

    def test_changed_canonical_or_global_prompt_fails_before_export(self):
        source = self.root / "repository/skills/daily-summary"
        for relative in synthetic.REVIEWED_SOURCES:
            target = source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(CANONICAL / relative, target)
        config = source.parents[1] / "backend/tool-calling-config.yaml"
        config.parent.mkdir(parents=True)
        shutil.copyfile(ROOT / "backend/tool-calling-config.yaml", config)
        for target in (source / "SKILL.md", config):
            initial = target.read_bytes()
            target.write_bytes(initial + b"\nUnreviewed fixture export change\n")
            destination = self.root / "rejected"
            with self.assertRaisesRegex(ValueError, "changed; review"):
                synthetic.build_bundle(source, destination)
            self.assertFalse(destination.exists())
            target.write_bytes(initial)


if __name__ == "__main__":
    unittest.main()
