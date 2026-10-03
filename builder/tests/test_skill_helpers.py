"""Offline checks for helpers shipped in the application skill catalog."""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

SKILLS = Path(__file__).resolve().parents[2] / "skills"
HUE = SKILLS / "use-hue-api"


def read_reference(*arguments):
    return subprocess.run(
        [sys.executable, str(HUE / "scripts/read_reference.py"), *arguments],
        capture_output=True,
        text=True,
        check=False,
    )


def importer():
    name = "hue_skill_import_reference"
    spec = importlib.util.spec_from_file_location(
        name, HUE / "scripts/import_reference.py"
    )
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[name] = loaded
    spec.loader.exec_module(loaded)
    return loaded


def export(response="Resource details"):
    return (
        '<div class="modal fade" id="resource_light_get">'
        '<h2 class="modal-title">GET /resource/light</h2>'
        '<div id="resource_light_get_response"><p>' + response + "</p></div>"
        '<div id="resource_light_get_securedby"><p>Application key</p></div>'
        "</div>"
    )


def test_hue_reader_lists_every_bundled_operation_once():
    reference = json.loads((HUE / "references/api-reference.json").read_text())
    result = read_reference("list")
    assert result.returncode == 0, result.stderr
    rows = [line.split("\t", 1) for line in result.stdout.splitlines()]
    assert rows == [
        [operation["anchor"], f"{operation['method']} {operation['path']}"]
        for operation in reference["operations"]
    ]
    assert len(rows) == len({row[0] for row in rows})


def test_hue_reader_bounds_output_and_exposes_continuation():
    result = read_reference("show", "resource_light__id__put", "--lines", "2")
    assert result.returncode == 0, result.stderr
    assert "Text lines 1-2 of" in result.stdout
    assert "--start-line 3" in result.stdout
    assert len(result.stdout.splitlines()) == 6


@pytest.mark.parametrize(
    "arguments,detail",
    [
        (("show", "missing"), "Unknown operation anchor"),
        (("show", "resource_light__id__put", "--lines", "0"), "positive integer"),
        (("show", "resource_light__id__put", "--start-line", "1000000"), "only"),
    ],
)
def test_hue_reader_rejects_unknown_or_unbounded_requests(arguments, detail):
    result = read_reference(*arguments)
    assert result.returncode != 0
    assert detail in result.stderr


def test_hue_reader_rejects_unsupported_reference_format(tmp_path):
    source = tmp_path / "reference.json"
    source.write_text('{"format_version": 2, "operations": []}')
    result = read_reference("--source", str(source), "list")
    assert result.returncode != 0
    assert "Unsupported reference format" in result.stderr


def test_hue_importer_deduplicates_matching_exports_and_rejects_conflicts():
    module = importer()
    result = module.compile_reference(export() + export())
    assert len(result["operations"]) == 1
    assert result["source"]["copies_per_operation"] == {"resource_light_get": 2}
    operation = result["operations"][0]
    assert (operation["method"], operation["path"]) == ("GET", "/resource/light")
    assert operation["sections"]["response"] == "Resource details"
    with pytest.raises(ValueError, match="Conflicting repeated operation"):
        module.compile_reference(export() + export("Conflicting details"))


def test_hue_importer_rejects_empty_or_incomplete_exports():
    module = importer()
    with pytest.raises(ValueError, match="No Hue operations"):
        module.compile_reference("<html>No operation export</html>")
    with pytest.raises(ValueError, match="Missing response or security"):
        module.compile_reference(
            export().replace("resource_light_get_securedby", "absent")
        )
