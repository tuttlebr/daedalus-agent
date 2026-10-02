"""Canonical edition structure, complete diagnostics, and standalone execution."""

import copy
import json
import runpy
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[2] / "skills" / "daily-summary"
CONTRACT = runpy.run_path(str(SKILL / "scripts" / "edition_contract.py"))
FIXTURE = Path(__file__).parent / "fixtures" / "daily_summary_dense_edition.json"


def edition():
    return json.loads(FIXTURE.read_text())


def malformed_blocks():
    """Synthetic versions of the distinct shape failures seen in production."""
    value = edition()
    value["operations_details"][0]["blocks"] = [
        {"paragraph": "A verified operational update."},
        {"table": {"columns": ["Scope"], "rows": [["Current"]]}},
    ]
    value["departments"][0]["stories"][0]["blocks"] = [
        {
            "type": "figure",
            "figure": {
                "data_url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
                "url": "https://images.example/source.jpg",
                "source_page": "https://primary.example/report",
                "credit": "Example Publisher",
                "alt": "A reported event",
                "caption": "The source image.",
            },
        },
        {
            "type": "briefs",
            "briefs": [{"title": "A verified update", "body": "Supported reporting."}],
        },
    ]
    value["departments"][1]["stories"][0]["blocks"] = [
        {"type": "briefs", "briefs": [{"title": "Another update", "body": "Facts."}]}
    ]
    value["departments"][2]["stories"][0]["blocks"] = [
        {"type": "briefs", "briefs": [{"title": "A third update", "body": "Facts."}]}
    ]
    return value


def test_aggregate_diagnostics_cover_every_malformed_block_without_mutation():
    value = malformed_blocks()
    original = copy.deepcopy(value)

    errors = CONTRACT["validate_edition"](value)

    for path in (
        "edition.operations_details[0].blocks[0].type",
        "edition.operations_details[0].blocks[1].type",
        "edition.departments[0].stories[0].blocks[0]",
        "edition.departments[0].stories[0].blocks[1]",
        "edition.departments[1].stories[0].blocks[0]",
        "edition.departments[2].stories[0].blocks[0]",
    ):
        assert any(path in error for error in errors), (path, errors)
    assert any("unsupported field(s): figure" in error for error in errors)
    assert sum("unsupported field(s): briefs" in error for error in errors) == 3
    assert sum(".items is required" in error for error in errors) == 3
    assert errors.error_count == len(errors)
    assert errors.errors_truncated is False
    assert value == original


def test_twenty_six_distinct_errors_remain_complete():
    value = edition()
    value["operations_details"] = [{}] * 8
    value["lead"]["verdict"] = {}

    errors = CONTRACT["validate_edition"](value)

    assert errors.error_count == len(errors) == 26
    assert errors.errors_truncated is False
    assert "edition.lead.verdict.label is required" in errors
    assert "edition.lead.verdict.tone is required" in errors
    for index in range(8):
        assert (
            sum(f"edition.operations_details[{index}]." in error for error in errors)
            == 3
        )


def test_canonical_nested_schema_is_finite_and_has_no_dangling_references():
    schema = CONTRACT["resolved_schema"]()
    serialized = json.dumps(schema, separators=(",", ":"))

    assert len(serialized.encode()) < 16_000
    assert '"$ref"' not in serialized
    assert '"$defs"' not in serialized
    blocks = schema["properties"]["operations_details"]["items"]["properties"]["blocks"]
    briefs = next(
        branch
        for branch in blocks["items"]["anyOf"]
        if branch["properties"]["type"]["enum"] == ["briefs"]
    )
    assert set(briefs["properties"]) == {"type", "items"}
    assert set(briefs["required"]) == {"type", "items"}
    assert briefs["additionalProperties"] is False
    assert not CONTRACT["validate_edition"](edition(), schema)


@pytest.mark.parametrize(
    "keyword", ["pattern", "oneOf", "minimum", "unevaluatedProperties"]
)
def test_unsupported_validation_keywords_fail_closed_at_nested_nodes(keyword):
    schema = CONTRACT["load_schema"]()
    schema["$defs"]["block"]["anyOf"][0]["properties"]["text"][keyword] = 1

    with pytest.raises(ValueError, match="Unsupported edition schema keywords"):
        CONTRACT["validate_edition"](edition(), schema)


@pytest.mark.parametrize(
    "fragment",
    [
        {"type": "integer"},
        {"additionalProperties": True},
        {"anyOf": []},
        {"required": ["undeclared"]},
        {"minItems": -1},
        {"minItems": 4, "maxItems": 2},
        {"$ref": "https://example.com/schema"},
        {"$ref": "#/$defs/missing"},
        {"$ref": "#/$defs/recursive", "$defs": {}},
    ],
)
def test_unsupported_or_invalid_schema_forms_fail_closed(fragment):
    with pytest.raises(ValueError):
        CONTRACT["validate_edition"]({}, fragment)


def test_cycles_fail_closed_instead_of_recursing():
    schema = {"$defs": {"recursive": {"$ref": "#/$defs/recursive"}}}
    schema["properties"] = {"x": {"$ref": "#/$defs/recursive"}}

    with pytest.raises(ValueError, match="Missing or cyclic"):
        CONTRACT["expanded_schema"](schema)


def test_schema_enforces_nested_required_unknown_type_enum_and_array_limits():
    value = edition()
    value["lead"]["verdict"] = {"label": "Test", "tone": "invented"}
    value["day_ahead"]["email_calendar"]["actions"][0]["body"] = []
    value["departments"][0]["stories"][0]["source"]["secret"] = "unused"
    value["operations_details"][0]["blocks"] = [
        {"type": "table", "columns": [], "rows": [["one"]] * 21},
        {"type": "list"},
    ]

    errors = CONTRACT["validate_edition"](value)

    assert any(".tone must be one of" in error for error in errors)
    assert any(".body must be string" in error for error in errors)
    assert any("unsupported field(s): secret" in error for error in errors)
    assert any(".columns must contain at least 1" in error for error in errors)
    assert any(".rows must contain at most 20" in error for error in errors)
    assert any(".items is required" in error for error in errors)


@pytest.mark.parametrize("malformation", ["many_errors", "long_unicode_field"])
def test_renderer_diagnostics_stay_within_transport_budget(tmp_path, malformation):
    value = edition()
    if malformation == "many_errors":
        value["operations_details"] = [{}] * 1000
        expected_count = 3001
    else:
        value["unexpected_" + "\U0001f680" * 5000] = "unused"
        expected_count = 1
    serialized = json.dumps(value, ensure_ascii=False)
    assert len(serialized.encode()) < 200_000
    original = copy.deepcopy(value)
    errors = CONTRACT["validate_edition"](value)
    assert errors.error_count == expected_count
    assert errors.errors_truncated is True
    assert len(errors) <= 100
    assert all(len(json.dumps(error)) <= 500 for error in errors)
    assert value == original

    edition_path = tmp_path / "edition.json"
    edition_path.write_text(serialized)
    failed = subprocess.run(
        [
            sys.executable,
            "-I",
            "-S",
            str(SKILL / "scripts" / "render_daybook.py"),
            str(edition_path),
            str(SKILL / "references" / "edition-policy.json"),
            str(SKILL / "assets" / "daybook-v4.html"),
            str(tmp_path / "edition.html"),
            str(tmp_path / "coverage.json"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert failed.returncode == 1, failed.stderr
    assert len(failed.stdout.encode()) < 65_536
    report = json.loads(failed.stdout)
    assert report["passed"] is False
    assert report["errors"] == errors
    assert report["error_count"] == expected_count
    assert report["errors_truncated"] is True
    assert not (tmp_path / "edition.html").exists()


def test_staged_stdlib_renderer_reports_all_errors_then_accepts_one_correction(
    tmp_path,
):
    for destination, source in {
        "render_daybook.py": "scripts/render_daybook.py",
        "edition_contract.py": "scripts/edition_contract.py",
        "edition-schema.json": "references/edition-schema.json",
        "edition-policy.json": "references/edition-policy.json",
        "daybook-v4.html": "assets/daybook-v4.html",
    }.items():
        shutil.copyfile(SKILL / source, tmp_path / destination)
    command = [
        sys.executable,
        "-I",
        "-S",
        "render_daybook.py",
        "edition.json",
        "edition-policy.json",
        "daybook-v4.html",
        "edition.html",
        "coverage.json",
    ]
    invalid = malformed_blocks()
    (tmp_path / "edition.json").write_text(json.dumps(invalid))
    failed = subprocess.run(
        command, cwd=tmp_path, capture_output=True, text=True, check=False
    )
    assert failed.returncode == 1, failed.stderr
    assert json.loads(failed.stdout)["errors"] == CONTRACT["validate_edition"](invalid)
    assert not (tmp_path / "edition.html").exists()

    corrected = copy.deepcopy(invalid)
    blocks = corrected["operations_details"][0]["blocks"]
    blocks[0] = {"type": "paragraph", "text": blocks[0]["paragraph"]}
    blocks[1] = {"type": "table", **blocks[1]["table"]}
    for department in corrected["departments"]:
        for story in department["stories"]:
            for index, block in enumerate(story["blocks"]):
                if "figure" in block:
                    story["blocks"][index] = {"type": "figure", **block["figure"]}
                if "briefs" in block:
                    block["items"] = block.pop("briefs")
    (tmp_path / "edition.json").write_text(json.dumps(corrected))
    passed = subprocess.run(
        command, cwd=tmp_path, capture_output=True, text=True, check=False
    )
    assert passed.returncode == 0, passed.stdout + passed.stderr
    assert json.loads(passed.stdout)["passed"] is True
    document = (tmp_path / "edition.html").read_text()
    assert "Supported reporting." in document
    assert "Another update" in document
    assert document.startswith("<!DOCTYPE html>")
