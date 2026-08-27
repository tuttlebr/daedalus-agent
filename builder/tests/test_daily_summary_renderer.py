"""Tests for the deterministic Daily Daedalus v4 renderer."""

import copy
import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "skills" / "daily-summary"
RENDERER = SKILL / "scripts" / "render_daybook.py"
POLICY = SKILL / "references" / "edition-policy.json"
TEMPLATE = SKILL / "assets" / "daybook-v4.html"
DENSE_EDITION = Path(__file__).parent / "fixtures" / "daily_summary_dense_edition.json"

_spec = importlib.util.spec_from_file_location("daily_summary_renderer_tests", RENDERER)
assert _spec and _spec.loader
renderer = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = renderer
_spec.loader.exec_module(renderer)


def _edition() -> dict:
    return json.loads(DENSE_EDITION.read_text(encoding="utf-8"))


def _policy() -> dict:
    return json.loads(POLICY.read_text(encoding="utf-8"))


def _render(edition: dict | None = None):
    return renderer.render_daybook(
        edition or _edition(),
        _policy(),
        TEMPLATE.read_text(encoding="utf-8"),
    )


def test_renderer_builds_v4_split_layout_and_derived_manifest():
    document, manifest, metrics = _render()

    assert document.startswith("<!DOCTYPE html>")
    assert document.rstrip().endswith("</html>")
    assert 'data-daybook-version="4"' in document
    assert 'data-template-version="daybook-v4"' in document
    assert 'class="front-page"' in document
    assert "data-lead-grid" in document
    assert 'data-lead-layout="split"' in document
    assert 'class="edition-strap" data-edition-strap' in document
    assert 'class="departments"' in document
    assert "data-department-rail" in document
    assert document.index('id="day-ahead-continuation"') > document.index(
        'data-layout-slot="day-ahead"'
    )
    assert 'id="operations-continuation" data-lead-continuation' in document
    assert "More on today’s agenda" in document
    assert "Three-day look-ahead" in document
    assert len(manifest["desks"]) == 9
    assert manifest["lead_desk"] == "cluster-infrastructure"
    assert metrics["departments"] == 5


def test_renderer_escapes_all_editor_supplied_text():
    edition = _edition()
    edition["lead"]["headline"] = '<script>alert("x")</script> & recovery'
    edition["day_ahead"]["email_calendar"]["actions"][0]["body"] = (
        '<img src=x onerror="alert(1)"> & review'
    )

    document, _, _ = _render(edition)

    assert "<script>alert" not in document
    assert "<img src=x" not in document
    assert "&lt;script&gt;alert" in document
    assert "&lt;img src=x onerror=" in document
    assert "&amp; recovery" in document


def test_renderer_rejects_opening_copy_over_budget():
    edition = _edition()
    edition["lead"]["paragraphs"] = ["word " * 221]

    with pytest.raises(renderer.RenderError, match="220-word opening budget"):
        _render(edition)


def test_renderer_rejects_unknown_fields_and_raw_html_shortcuts():
    edition = _edition()
    edition["lead"]["raw_html"] = "<p>Bypass</p>"

    with pytest.raises(renderer.RenderError, match="unsupported field"):
        _render(edition)


def test_renderer_rejects_unsafe_source_urls_and_tool_refs():
    unsafe_url = _edition()
    unsafe_url["day_ahead"]["weather"]["source"]["url"] = "http://weather.example"
    with pytest.raises(renderer.RenderError, match="must be an HTTPS URL"):
        _render(unsafe_url)

    unsafe_ref = _edition()
    unsafe_ref["lead"]["source"]["refs"] = ["k8s; rm -rf data"]
    with pytest.raises(renderer.RenderError, match=r"refs\[0\] is invalid"):
        _render(unsafe_ref)


def test_renderer_emits_complete_source_figure_provenance():
    edition = _edition()
    edition["departments"][0]["stories"][0]["blocks"].append(
        {
            "type": "figure",
            "url": "https://images.example/recovery.jpg",
            "source_page": "https://primary.example/recovery",
            "credit": "Example Research Lab",
            "alt": "A recovery-time chart comparing two serving paths",
            "caption": "The pre-warmed path restores service sooner.",
        }
    )

    document, _, metrics = _render(edition)

    assert 'data-image-source-url="https://images.example/recovery.jpg"' in document
    assert 'data-source-page="https://primary.example/recovery"' in document
    assert 'data-image-credit="Example Research Lab"' in document
    assert 'loading="lazy" decoding="async" referrerpolicy="no-referrer"' in document
    assert "Image credit: Example Research Lab" in document
    assert metrics["sources"] == 19


def test_renderer_handles_unavailable_front_sources_without_filler():
    edition = copy.deepcopy(_edition())
    weather = edition["day_ahead"]["weather"]
    weather.update(
        {"status": "unavailable", "rows": [], "note": "Weather source unavailable."}
    )
    weather.pop("source")
    weather_coverage = next(
        item for item in edition["coverage"] if item["desk_key"] == "weather"
    )
    weather_coverage.update(
        {"status": "unavailable", "explanation": "The weather source was unavailable."}
    )
    weather_coverage.pop("source")

    document, _, _ = _render(edition)

    assert '<p class="status status-unavailable">Unavailable</p>' in document
    assert "Weather source unavailable." in document


def test_renderer_rejects_coverage_and_department_drift():
    edition = _edition()
    next(item for item in edition["coverage"] if item["desk_key"] == "sports")[
        "status"
    ] = "quiet"

    with pytest.raises(
        renderer.RenderError, match="department sports must have covered"
    ):
        _render(edition)
