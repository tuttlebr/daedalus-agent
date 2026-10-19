"""Ensure the checked-in protocol consumers cannot silently drift."""

import importlib.util
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


@pytest.mark.parametrize(
    ("label", "values"),
    [
        # Rust derives `Deep2x`, which serde reads only as "deep2x".
        ("SourcePolicyId", ["curated_domains", "deep_2x"]),
        ("SourcePolicyId", ["curated_domains", "Curated"]),
        ("ModelProfile", ["default", "deep__max"]),
        ("ModelProfile", ["default", "deep-max"]),
    ],
)
def test_enum_values_rust_cannot_round_trip_are_rejected(tmp_path, label, values):
    schema = json.loads((ROOT / "protocol/source-policy.schema.json").read_text())
    profiles = json.loads((ROOT / "protocol/model-profile.schema.json").read_text())
    if label == "SourcePolicyId":
        schema["$defs"]["SourcePolicyId"]["enum"] = values
    else:
        profiles["enum"] = values
    _assert_optimized_schema_rejection(
        tmp_path,
        schema,
        f"{label} value {values[-1]!r} must round-trip as snake_case",
        profiles,
    )


@pytest.mark.parametrize("profiles", [None, "default", [], ["default", "default"]])
def test_invalid_model_profiles_are_rejected_with_python_optimization(
    tmp_path, profiles
):
    schema = json.loads((ROOT / "protocol/source-policy.schema.json").read_text())
    error = (
        "ModelProfile enum must contain unique IDs"
        if isinstance(profiles, list) and profiles
        else "ModelProfile enum must be a non-empty list of strings"
    )
    _assert_optimized_schema_rejection(tmp_path, schema, error, {"enum": profiles})


# frontend/prettier.config.js prints these statements at 80 columns: on one line
# when they fit, otherwise one quoted item per line with a trailing comma. The
# formatting hook and `--check` both run in CI, so any other layout deadlocks.
@pytest.mark.parametrize(
    ("source_ids", "profiles", "expected_ts"),
    [
        (
            None,
            ["default", "deep", "deep_max", "abcde"],
            {
                "frontend/types/modelProfile.ts": "export const MODEL_PROFILES = "
                "['default', 'deep', 'deep_max', 'abcde'] as const;"
            },
        ),
        (
            None,
            ["default", "deep", "deep_max", "abcdef"],
            {
                "frontend/types/modelProfile.ts": "export const MODEL_PROFILES = [\n"
                "  'default',\n  'deep',\n  'deep_max',\n  'abcdef',\n] as const;"
            },
        ),
        (
            ["web", "docs"],
            None,
            {
                "frontend/types/sourcePolicy.ts": "export const SOURCE_POLICY_IDS = "
                "['web', 'docs'] as const;"
            },
        ),
    ],
)
def test_generated_typescript_arrays_match_prettier_layout(
    tmp_path, source_ids, profiles, expected_ts
):
    (tmp_path / "protocol").mkdir()
    schema = json.loads((ROOT / "protocol/source-policy.schema.json").read_text())
    profile_schema = json.loads(
        (ROOT / "protocol/model-profile.schema.json").read_text()
    )
    if source_ids:
        schema["$defs"]["SourcePolicyId"]["enum"] = source_ids
    if profiles:
        profile_schema["enum"] = profiles
    (tmp_path / "protocol/source-policy.schema.json").write_text(json.dumps(schema))
    (tmp_path / "protocol/model-profile.schema.json").write_text(
        json.dumps(profile_schema)
    )
    generator = _load_generator()
    generator.ROOT = tmp_path
    generator.SCHEMA = tmp_path / "protocol/source-policy.schema.json"
    generator.MODEL_PROFILE_SCHEMA = tmp_path / "protocol/model-profile.schema.json"

    outputs = generator.render()

    for relative, statement in expected_ts.items():
        content = outputs[tmp_path / relative]
        assert statement in content
        assert all(len(line) <= 80 for line in content.splitlines()[1:])


def _load_generator():
    spec = importlib.util.spec_from_file_location(
        "generate_protocol_types", ROOT / "scripts/generate_protocol_types.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _assert_optimized_schema_rejection(tmp_path, schema, error, profiles=None):
    schema_path = tmp_path / "schema.json"
    schema_path.write_text(json.dumps(schema))
    profiles_path = tmp_path / "model-profile.schema.json"
    profiles_path.write_text(
        json.dumps(profiles)
        if profiles is not None
        else (ROOT / "protocol/model-profile.schema.json").read_text()
    )
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
module.MODEL_PROFILE_SCHEMA = pathlib.Path(sys.argv[3])
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
            str(profiles_path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert f"ValueError: {error}" in result.stderr
