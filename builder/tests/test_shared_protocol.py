"""Ensure the checked-in protocol consumers cannot silently drift."""

import json
import subprocess
import sys
from pathlib import Path

import pytest
from nat_helpers.source_policy_types import SOURCE_POLICY_IDS, SourcePolicy
from source_verifier.source_verifier_function import _default_source_registry

ROOT = Path(__file__).resolve().parents[2]


def test_generated_protocol_files_are_current():
    subprocess.run(
        [sys.executable, str(ROOT / "scripts/generate_protocol_types.py"), "--check"],
        check=True,
        capture_output=True,
        text=True,
    )


def test_source_catalog_and_optional_fields_match_canonical_contract():
    schema = json.loads((ROOT / "protocol/source-policy.schema.json").read_text())
    assert set(SOURCE_POLICY_IDS) == {item["id"] for item in _default_source_registry()}
    assert SourcePolicy.__optional_keys__ == set(schema["properties"])
    assert not SourcePolicy.__required_keys__


@pytest.mark.parametrize(
    ("replacement", "error"),
    [
        ({}, "SourcePolicyId must define an enum"),
        ({"enum": None}, "SourcePolicyId enum must be a non-empty list of strings"),
        (
            {"enum": "curated_domains"},
            "SourcePolicyId enum must be a non-empty list of strings",
        ),
        ({"enum": []}, "SourcePolicyId enum must be a non-empty list of strings"),
        (
            {"enum": ["curated_domains", {}]},
            "SourcePolicyId enum must be a non-empty list of strings",
        ),
        (
            {"enum": ["curated_domains", 1]},
            "SourcePolicyId enum must be a non-empty list of strings",
        ),
        (
            {"enum": ["curated_domains", "curated_domains"]},
            "SourcePolicyId enum must contain unique IDs",
        ),
    ],
)
def test_invalid_ids_are_rejected_with_python_optimization(
    tmp_path, replacement, error
):
    schema = json.loads((ROOT / "protocol/source-policy.schema.json").read_text())
    schema["$defs"]["SourcePolicyId"] = replacement
    _assert_optimized_schema_rejection(tmp_path, schema, error)


@pytest.mark.parametrize(
    "items",
    [None, {"type": "string"}, {"$ref": "#/$defs/OtherPolicyId"}],
)
def test_unsupported_array_refs_are_rejected_with_python_optimization(tmp_path, items):
    schema = json.loads((ROOT / "protocol/source-policy.schema.json").read_text())
    if items is None:
        schema["properties"]["enabledSources"].pop("items")
    else:
        schema["properties"]["enabledSources"]["items"] = items
    _assert_optimized_schema_rejection(
        tmp_path, schema, "Unsupported array item schema for enabledSources"
    )


def _assert_optimized_schema_rejection(tmp_path, schema, error):
    schema_path = tmp_path / "schema.json"
    schema_path.write_text(json.dumps(schema))
    # Invoke render directly: stale checked-in output must not be the reason
    # the process fails. This also avoids writing generated files in the repo.
    probe = """
import importlib.util
import pathlib
import sys

spec = importlib.util.spec_from_file_location("generator", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.SCHEMA = pathlib.Path(sys.argv[2])
module.render()
"""
    result = subprocess.run(
        [
            sys.executable,
            "-O",
            "-c",
            probe,
            str(ROOT / "scripts/generate_protocol_types.py"),
            str(schema_path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert f"ValueError: {error}" in result.stderr
