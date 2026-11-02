"""Offline text measurements must not hide config changes or expose values."""

import importlib.util
import json
from copy import deepcopy
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[2]
    / ".agents/skills/daedalus-optimize-tool-config/scripts/measure_config_text.py"
)
SPEC = importlib.util.spec_from_file_location("tool_config_text_metrics", SCRIPT)
metrics = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(metrics)


def test_counts_unicode_nested_prose_without_emitting_content():
    config = {
        "workflow": {"instructions": "Résumé now", "tools": ["clock"]},
        "functions": {"a/b~c": {"description": "Two words"}},
        "registry": [{"description": "Read"}],
        "api_key": "private-canary",
    }
    original = deepcopy(config)
    report = metrics.measure(config)
    assert report["fields"]["/workflow/instructions"] == {
        "characters": 10,
        "utf8_bytes": 12,
        "words": 2,
    }
    assert report["fields"]["/functions/a~1b~0c/description"]["words"] == 2
    assert report["fields"]["/registry/0/description"]["words"] == 1
    assert report["totals"] == {"characters": 23, "utf8_bytes": 25, "words": 5}
    assert report["token_count"] is None
    assert "private-canary" not in json.dumps(report)
    assert "Résumé" not in json.dumps(report, ensure_ascii=False)
    assert config == original


def test_prose_deltas_and_removed_fields_do_not_change_other_config():
    before = {"workflow": {"instructions": "Read the clock", "tools": ["clock"]}}
    after = {"workflow": {"instructions": "Read clock", "tools": ["clock"]}}
    report = metrics.measure(after, before)
    assert report["delta"] == {"characters": -4, "utf8_bytes": -4, "words": -1}
    assert not report["other_config_changed"]
    del after["workflow"]["instructions"]
    report = metrics.measure(after, before)
    assert report["removed_fields"] == ["/workflow/instructions"]
    assert report["field_deltas"]["/workflow/instructions"]["characters"] == -14


@pytest.mark.parametrize(
    "changed",
    [
        {"instructions": "Read", "tools": []},
        {"instructions": "Read", "enabled": 1, "tools": ["clock"]},
        {"instructions": False, "enabled": True, "tools": ["clock"]},
    ],
)
def test_exposure_and_scalar_type_changes_are_detected(changed):
    before = {"workflow": {"instructions": "Read", "enabled": True, "tools": ["clock"]}}
    assert metrics.measure({"workflow": changed}, before)["other_config_changed"]


def test_aliases_and_environment_references_are_not_expanded(tmp_path, monkeypatch):
    monkeypatch.setenv("METRICS_TEST_CANARY", "must-not-appear")
    path = tmp_path / "config.yaml"
    source = (
        "base: base.yaml\n"
        "functions:\n"
        "  a: &shared\n"
        "    description: ${METRICS_TEST_CANARY}\n"
        "  b: *shared\n"
    )
    path.write_text(source)
    report = metrics.measure(metrics.load_config(path))
    assert report["has_base"]
    assert report["fields"]["/functions/a/description"]["characters"] == 22
    assert len(report["fields"]) == 2
    assert "must-not-appear" not in json.dumps(report)
    assert path.read_text() == source


@pytest.mark.parametrize(
    "source",
    ["api_key: [private-canary", "[]", "root: &loop [*loop]", "1: private-canary"],
)
def test_invalid_inputs_fail_without_source_lines(
    tmp_path, monkeypatch, capsys, source
):
    path = tmp_path / "config.yaml"
    path.write_text(source)
    monkeypatch.setattr("sys.argv", [str(SCRIPT), str(path)])
    assert metrics.main() == 2
    output = capsys.readouterr()
    assert not output.out
    assert "Cannot measure config" in output.err
    assert "private-canary" not in output.err
