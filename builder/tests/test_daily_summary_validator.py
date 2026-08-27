"""Behavioral tests for the sandboxed Daily Daedalus HTML quality gate."""

import copy
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "skills" / "daily-summary"
VALIDATOR = SKILL / "scripts" / "validate_daybook.py"
RENDERER = SKILL / "scripts" / "render_daybook.py"
POLICY = SKILL / "references" / "edition-policy.json"
TEMPLATE = SKILL / "assets" / "daybook-v4.html"
DENSE_EDITION = Path(__file__).parent / "fixtures" / "daily_summary_dense_edition.json"
FONT_STYLESHEET = (
    "https://g1.nyt.com/fonts/css/"
    "web-fonts.c851560786173ad206e1f76c1901be7e096e8f8b.css"
)

_spec = importlib.util.spec_from_file_location("daily_summary_renderer", RENDERER)
assert _spec and _spec.loader
_renderer = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _renderer
_spec.loader.exec_module(_renderer)


def _policy() -> dict:
    return json.loads(POLICY.read_text(encoding="utf-8"))


def _edition(*, with_figure: bool = True) -> dict:
    edition = json.loads(DENSE_EDITION.read_text(encoding="utf-8"))
    if with_figure:
        edition["departments"][0]["stories"][0]["blocks"].append(
            {
                "type": "figure",
                "url": "https://images.example/photo.jpg",
                "source_page": "https://images.example/source-page",
                "credit": "A. Photographer / Publisher",
                "alt": "Engineers examining a data center system",
                "caption": "A sourced view of the reported system.",
            }
        )
    return edition


def _render(*, with_figure: bool = True) -> tuple[str, dict]:
    document, manifest, _ = _renderer.render_daybook(
        _edition(with_figure=with_figure),
        _policy(),
        TEMPLATE.read_text(encoding="utf-8"),
    )
    return document, manifest


def _run_validator(
    tmp_path: Path,
    html: str,
    manifest: dict | None = None,
    policy: dict | None = None,
):
    html_path = tmp_path / "daybook.html"
    manifest_path = tmp_path / "coverage.json"
    policy_path = tmp_path / "edition-policy.json"
    _, generated_manifest = _render()
    html_path.write_text(html, encoding="utf-8")
    manifest_path.write_text(
        json.dumps(manifest or generated_manifest), encoding="utf-8"
    )
    policy_path.write_text(json.dumps(policy or _policy()), encoding="utf-8")

    result = subprocess.run(
        [
            sys.executable,
            str(VALIDATOR),
            str(html_path),
            str(manifest_path),
            str(policy_path),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    return result, json.loads(result.stdout)


def test_validator_accepts_renderer_output_with_source_image(tmp_path):
    html, _ = _render()
    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 0
    assert report["passed"] is True
    assert report["errors"] == []
    assert report["metrics"]["coverage_items"] == 9
    assert report["metrics"]["manifest_desks"] == 9
    assert report["metrics"]["required_policy_desks"] == 9
    assert report["metrics"]["source_images"] == 1
    assert report["metrics"]["stories"] == 11
    assert report["metrics"]["words"] > 500


def test_validator_rejects_desk_coverage_drift(tmp_path):
    html, _ = _render()
    html = html.replace('data-desk-key="culture-leisure"', 'data-desk-key="baseball"')

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any(
        "coverage ledger does not match manifest" in error for error in report["errors"]
    )


def test_validator_rejects_an_incomplete_policy_manifest(tmp_path):
    html, manifest = _render()
    incomplete = copy.deepcopy(manifest)
    incomplete["desks"] = incomplete["desks"][:-1]

    result, report = _run_validator(tmp_path, html, manifest=incomplete)

    assert result.returncode == 1
    assert any(
        "coverage manifest omits required policy desks" in error
        for error in report["errors"]
    )


def test_validator_rejects_identity_policy_or_fixed_lead_drift(tmp_path):
    html, _ = _render()
    html = (
        html.replace(
            '<h1 class="masthead">The Daily Daedalus</h1>',
            '<h1 class="masthead">A Generic Briefing</h1>',
        )
        .replace("One reader. One editor. No filler.", "Everything, every day.")
        .replace(
            'data-desk-key="cluster-infrastructure"',
            'data-desk-key="culture-leisure"',
            1,
        )
        .replace('data-policy-version="2026-08-27"', 'data-policy-version="old"')
    )

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any("masthead must match" in error for error in report["errors"])
    assert any("tagline must match" in error for error in report["errors"])
    assert any("lead story desk must match" in error for error in report["errors"])
    assert any("data-policy-version must match" in error for error in report["errors"])


def test_validator_accepts_live_tool_provenance_for_operations(tmp_path):
    html, _ = _render()
    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 0
    assert 'data-source-ref="k8s_mcp_server,unifi_mcp_server"' in html
    assert report["passed"] is True


def test_validator_rejects_an_unlisted_tool_source(tmp_path):
    html, _ = _render()
    html = html.replace(
        'data-source-ref="k8s_mcp_server,unifi_mcp_server"',
        'data-source-ref="missing_mcp_server"',
        1,
    )

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any("must name each source" in error for error in report["errors"])


def test_validator_rejects_generated_or_uncredited_images(tmp_path):
    html, _ = _render()
    html = html.replace(
        "https://images.example/photo.jpg", "/api/generated-image/example"
    ).replace(' data-image-credit="A. Photographer / Publisher"', "")

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any("generated-image" in error for error in report["errors"])
    assert any(
        "needs HTTPS provenance and a credit" in error for error in report["errors"]
    )


def test_validator_rejects_missing_editorial_and_accessibility_contracts(tmp_path):
    html, _ = _render()
    html = (
        html.replace("max-width: 1200px", "max-width: 900px")
        .replace("a:focus-visible", "a:hover")
        .replace("text-align: center;", "text-align: left;")
        .replace(' alt="Engineers examining a data center system"', "")
    )

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any("1200px page width" in error for error in report["errors"])
    assert any("visible focus treatment" in error for error in report["errors"])
    assert any("center the edition tagline" in error for error in report["errors"])
    assert any("meaningful alt text" in error for error in report["errors"])


def test_validator_rejects_unbounded_source_images(tmp_path):
    html, _ = _render()
    html = html.replace("max-width: 100%;", "max-width: 90%;")

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any("constrain source images" in error for error in report["errors"])


def test_validator_rejects_an_unapproved_stylesheet(tmp_path):
    html, _ = _render()
    html = html.replace(FONT_STYLESHEET, "https://fonts.example/style.css")

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any("approved Cheltenham stylesheet" in error for error in report["errors"])


def test_validator_rejects_missing_canonical_class_wiring(tmp_path):
    html, _ = _render()
    html = html.replace(
        'class="edition-strap" data-edition-strap', "data-edition-strap"
    )
    html = html.replace('class="departments"', 'class="unstyled"', 1)

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any("canonical edition-strap class" in error for error in report["errors"])
    assert any("canonical departments class" in error for error in report["errors"])


def test_validator_rejects_weak_hierarchy_and_non_chelt_primary_type(tmp_path):
    html, _ = _render()
    html = (
        html.replace(" data-edition-strap", "", 1)
        .replace(" data-lead-story", "", 1)
        .replace("font-family: nyt-cheltenham,", "font-family: Arial,", 1)
    )

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any("exactly one edition strap" in error for error in report["errors"])
    assert any(
        "exactly one lead grid and lead story" in error for error in report["errors"]
    )
    assert any(
        "Cheltenham as its primary family" in error for error in report["errors"]
    )


def test_validator_rejects_an_undeclared_lead_layout(tmp_path):
    html, _ = _render()
    html = html.replace(' data-lead-layout="split"', "")

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any("data-lead-layout must be split" in error for error in report["errors"])


def test_validator_requires_operations_continuation_outside_lead_grid(tmp_path):
    html, _ = _render()
    html = html.replace(" data-lead-continuation", "", 1)

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any(
        "exactly one operations lead continuation" in error
        for error in report["errors"]
    )


def test_validator_requires_canonical_front_page_ratio(tmp_path):
    html, _ = _render()
    html = html.replace(
        "grid-template-columns: minmax(0, 7fr) minmax(19rem, 5fr)",
        "grid-template-columns: 25% 45% 30%",
    )

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any("canonical 7/5 front-page split" in error for error in report["errors"])


def test_validator_requires_story_and_image_provenance_in_sources(tmp_path):
    html, _ = _render()
    html = html.replace(
        'href="https://images.example/source-page"',
        'href="https://images.example/other"',
    )

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any(
        "caption must link its source page" in error for error in report["errors"]
    )
    assert any("source and credit must appear" in error for error in report["errors"])
