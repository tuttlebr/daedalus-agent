"""Tests for the deterministic Daily Daedalus v4 renderer."""

import copy
import hashlib
import importlib.util
import json
import runpy
import sys
from html.parser import HTMLParser
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
validator = runpy.run_path(str(SKILL / "scripts" / "validate_daybook.py"))


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


class _Anchors(HTMLParser):
    def __init__(self, document):
        super().__init__()
        self.ids = []
        self.targets = []
        self.departments = {}
        self.feed(document)

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if "id" in values:
            self.ids.append(values["id"])
        if values.get("href", "").startswith("#"):
            self.targets.append(values["href"][1:])
        self.targets.extend(values.get("aria-labelledby", "").split())
        if "data-department" in values:
            self.departments[values["data-department"]] = values


def _append_department(edition, key):
    story = copy.deepcopy(edition["departments"][0]["stories"][0])
    story["headline"] = f"Synthetic reporting for {key}"
    edition["departments"].append(
        {"desk_key": key, "title": key.title(), "stories": [story]}
    )
    coverage = next(
        (item for item in edition["coverage"] if item["desk_key"] == key), None
    )
    if coverage is None:
        edition["coverage"].append(
            {"desk_key": key, "label": key.title(), "status": "covered"}
        )
    else:
        coverage["status"] = "covered"


def _validate(tmp_path, document, manifest):
    html_path = tmp_path / "daybook.html"
    manifest_path = tmp_path / "coverage.json"
    html_path.write_text(document, encoding="utf-8")
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return validator["validate_daybook"](html_path, manifest_path, POLICY)


@pytest.mark.parametrize(
    "key",
    [
        "email-calendar",
        "weather",
        "lead",
        "daybook",
        "day-ahead-continuation",
        "day-ahead-continuation-heading",
        "operations-continuation",
        "operations-continuation-heading",
        "business-heading",
        "health-heading",
        "opinion-heading",
    ],
)
def test_department_keys_cannot_duplicate_emitted_ids(tmp_path, key):
    edition = _edition()
    _append_department(edition, key)

    document, manifest, _ = _render(edition)

    result = _validate(tmp_path, document, manifest)
    assert result["passed"], result["errors"]
    anchors = _Anchors(document)
    assert len(anchors.ids) == len(set(anchors.ids))
    assert set(anchors.targets) <= set(anchors.ids)
    for desk, values in anchors.departments.items():
        anchor = values["id"]
        assert values["aria-labelledby"] == f"{anchor}-heading"
        assert f'id="{anchor}-heading"' in document
        if desk != edition["lead"]["desk_key"]:
            assert f'href="#{anchor}"' in document
        assert f'data-desk-key="{desk}"' in document
    assert 'href="#weather">The Day Ahead</a>' in document
    assert 'href="#lead">Technology</a>' in document


def test_department_anchor_fallback_avoids_other_department_slugs(tmp_path):
    edition = _edition()
    for key in ("department-email-calendar", "email-calendar"):
        _append_department(edition, key)

    document, manifest, _ = _render(edition)

    result = _validate(tmp_path, document, manifest)
    assert result["passed"], result["errors"]
    anchors = _Anchors(document)
    assert anchors.departments["department-email-calendar"]["id"] == (
        "department-email-calendar"
    )
    assert anchors.departments["email-calendar"]["id"] == (
        "department-email-calendar-2"
    )
    assert len(anchors.ids) == len(set(anchors.ids))
    assert set(anchors.targets) <= set(anchors.ids)


@pytest.mark.parametrize("variant", ["dense", "ordinary", "weather_unavailable"])
def test_previously_valid_html_bytes_remain_identical(variant):
    edition = _edition()
    if variant == "ordinary":
        edition["operations_details"] = []
        next(
            item
            for item in edition["coverage"]
            if item["desk_key"] == "cluster-infrastructure"
        )["status"] = "quiet"
    elif variant == "weather_unavailable":
        weather = edition["day_ahead"]["weather"]
        weather.update(
            {"status": "unavailable", "rows": [], "note": "Weather source unavailable."}
        )
        weather.pop("source")
        next(item for item in edition["coverage"] if item["desk_key"] == "weather")[
            "status"
        ] = "unavailable"
    prior = {
        "dense": "01479186b357043cbe30b8b6d594558ecf0d2058d40d81a251bbda7c81545094",
        "ordinary": "46ed7b8956176e70ac9fee4ea6f8224c7363d75065c7220206c8f5f03fb7bb42",
        "weather_unavailable": "10632aa1b84100ccb09f7c8c293bf89d1bb607e06963e1f3829b296fd7a5a61d",
    }

    document, _, _ = _render(edition)

    assert hashlib.sha256(document.encode()).hexdigest() == prior[variant]


def test_absent_optional_sections_do_not_reserve_department_ids():
    edition = _edition()
    edition["operations_details"] = []
    next(
        item
        for item in edition["coverage"]
        if item["desk_key"] == "cluster-infrastructure"
    )["status"] = "quiet"
    personal = edition["day_ahead"]["email_calendar"]
    personal["agenda"] = personal["agenda"][:4]
    personal["actions"] = personal["actions"][:2]
    personal["lookahead"] = []
    for key in ("operations-continuation", "day-ahead-continuation"):
        _append_department(edition, key)

    document, _, _ = _render(edition)

    anchors = _Anchors(document)
    for key in ("operations-continuation", "day-ahead-continuation"):
        assert anchors.departments[key]["id"] == key


def test_unrelated_duplicate_ids_still_fail_validation(tmp_path):
    template = TEMPLATE.read_text(encoding="utf-8").replace(
        "</footer>", '<span id="daybook"></span></footer>'
    )
    document, manifest, _ = renderer.render_daybook(_edition(), _policy(), template)

    result = _validate(tmp_path, document, manifest)

    assert not result["passed"]
    assert any("duplicate IDs" in error for error in result["errors"])


def test_duplicate_department_keys_are_still_invalid():
    edition = _edition()
    edition["departments"].append(copy.deepcopy(edition["departments"][0]))

    with pytest.raises(renderer.RenderError, match="duplicate desk key"):
        _render(edition)


def test_story_ids_are_not_accepted_as_an_anchor_override():
    edition = _edition()
    edition["departments"][0]["stories"][0]["id"] = "email-calendar"

    with pytest.raises(renderer.RenderError, match="unsupported field"):
        _render(edition)


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
    assert len(manifest["desks"]) == len(_policy()["desks"])
    assert manifest["lead_desk"] == "technology"
    assert metrics["departments"] == 8


def test_renderer_omits_sources_and_ledger_with_compact_internal_coverage():
    edition = _edition()
    assert all(set(item) == {"desk_key", "status"} for item in edition["coverage"])

    document, manifest, _ = _render(edition)

    assert 'id="sources"' not in document
    assert 'id="coverage"' not in document
    assert 'class="ledger"' not in document
    assert "Markets &amp; Finance" not in document
    assert manifest["desks"][0] == {
        "key": "technology",
        "label": "Technology",
        "status": "covered",
    }
    story = edition["departments"][0]["stories"][0]
    assert (
        renderer._external_link(story["source"]["url"], story["headline"]) in document
    )


def test_renderer_accepts_additional_desk_without_ledger_copy():
    edition = _edition()
    edition["coverage"].append(
        {"desk_key": "books", "label": "Books", "status": "quiet"}
    )

    document, manifest, _ = _render(edition)

    assert manifest["desks"][-1] == {
        "key": "books",
        "label": "Books",
        "status": "quiet",
    }
    assert 'data-desk-key="books"' not in document


def test_renderer_requires_reporting_for_a_covered_desk():
    edition = _edition()
    edition["departments"].pop()

    with pytest.raises(
        renderer.RenderError, match="covered desk opinion must have reporting"
    ):
        _render(edition)


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


@pytest.mark.parametrize(
    "url", ["http://weather.example", "https://[broken", "https://exam／ple.org"]
)
def test_renderer_rejects_unsafe_source_urls_and_tool_refs(url):
    unsafe_url = _edition()
    unsafe_url["day_ahead"]["weather"]["source"]["url"] = url
    with pytest.raises(renderer.RenderError, match="must be an HTTPS URL"):
        _render(unsafe_url)

    unsafe_ref = _edition()
    unsafe_ref["lead"]["source"] = {
        "kind": "tool",
        "label": "Bad refs",
        "refs": ["k8s; rm -rf data"],
    }
    with pytest.raises(renderer.RenderError, match=r"refs\[0\] is invalid"):
        _render(unsafe_ref)


def test_renderer_emits_complete_source_figure_provenance():
    edition = _edition()
    edition["departments"][0]["stories"][0]["blocks"].append(
        {
            "type": "figure",
            "data_url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
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
    assert (
        renderer._external_link(
            "https://primary.example/recovery", "Example Research Lab"
        )
        in document
    )
    assert metrics["sources"] == _render()[2]["sources"] + 1


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
    weather_coverage["status"] = "unavailable"

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


@pytest.mark.parametrize(
    "desk", ["technology", "business", "health", "sports", "world", "us"]
)
def test_editor_selects_lead_and_omits_routine_operations(desk):
    edition = _edition()
    edition["lead"]["desk_key"] = desk
    edition["operations_details"] = []
    for item in edition["coverage"]:
        if item["desk_key"] == desk:
            item["status"] = "covered"
        if item["desk_key"] == "cluster-infrastructure":
            item["status"] = "quiet"
    document, manifest, _ = _render(edition)
    assert manifest["lead_desk"] == desk
    assert 'id="operations-continuation"' not in document
    assert ">Operations</a>" not in document
    assert "verdict-" not in document.split("</style>")[1]
    assert "<link" not in document


@pytest.mark.parametrize("desk", ["opinion", "unknown", "email-calendar"])
def test_non_news_lead_is_rejected(desk):
    edition = _edition()
    edition["lead"]["desk_key"] = desk
    with pytest.raises(renderer.RenderError, match="policy news desk"):
        _render(edition)


def test_operations_cannot_claim_a_quiet_desk():
    edition = _edition()
    next(
        item
        for item in edition["coverage"]
        if item["desk_key"] == "cluster-infrastructure"
    )["status"] = "quiet"
    with pytest.raises(renderer.RenderError, match="requires covered"):
        _render(edition)


def test_editor_note_is_not_part_of_the_edition_contract():
    document, _, _ = _render()
    assert 'id="editors-note"' not in document
    value = _edition()
    value["editors_note"] = "Unwanted summary."
    with pytest.raises(renderer.RenderError, match="unsupported field"):
        _render(value)


def test_figure_without_source_description_uses_neutral_credit_label():
    value = _edition()
    value["lead"]["figure"] = {
        "type": "figure",
        "url": "https://images.example/photo.png",
        "source_page": "https://primary.example/article",
        "credit": "Publisher",
        "data_url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    }
    document, _, _ = _render(value)
    assert 'alt="Photo from Publisher"' in document
    assert "</figcaption>" in document
