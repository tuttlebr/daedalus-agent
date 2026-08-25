"""Behavioral tests for the sandboxed Daily Summary HTML quality gate."""

import json
import subprocess
import sys
from pathlib import Path

VALIDATOR = (
    Path(__file__).resolve().parents[2]
    / "skills"
    / "daily-summary"
    / "scripts"
    / "validate_daybook.py"
)
FONT_STYLESHEET = (
    "https://g1.nyt.com/fonts/css/"
    "web-fonts.c851560786173ad206e1f76c1901be7e096e8f8b.css"
)


def _valid_html() -> str:
    return f"""<!DOCTYPE html>
<html lang="en" data-daybook-version="2">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="A current personalized daily briefing">
  <title>Daedalus Daybook</title>
  <link rel="stylesheet" href="{FONT_STYLESHEET}">
  <style>
    *, *::before, *::after {{ box-sizing: border-box; }}
    body {{ margin: 0; background: #fdfdfc; font-family: nyt-cheltenham, Georgia, 'Times New Roman', Times, serif; color: #121212; }}
    #daybook {{ max-width: 1200px; margin: 0 auto; padding: 12px 24px 28px; }}
    .edition-strap {{ display: flex; justify-content: space-between; gap: 16px; margin: 0; padding: 8px 0; border-bottom: 1px solid #d3d3d3; font-family: nyt-cheltenham-small, Georgia, 'Times New Roman', Times, serif; font-size: 0.78rem; }}
    .masthead {{ margin: 18px 0 14px; font-size: clamp(3rem, 7vw, 5.8rem); line-height: 0.9; text-align: center; }}
    .departments {{ padding: 8px 0; border-top: 1px solid #121212; border-bottom: 4px double #121212; text-align: center; font-family: nyt-cheltenham-small, Georgia, 'Times New Roman', Times, serif; }}
    .lead {{ display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px; padding: 22px 0 28px; border-bottom: 1px solid #121212; }}
    .lead > * {{ min-width: 0; }}
    .lead h2 {{ margin: 0; font-size: clamp(1.65rem, 3vw, 2.7rem); line-height: 1.02; }}
    .lead p {{ margin: 0; font-size: 1.12rem; line-height: 1.45; }}
    figure {{ margin: 0; }}
    img {{ display: block; max-width: 100%; height: auto; }}
    figcaption {{ margin-top: 6px; font-family: nyt-cheltenham-small, Georgia, 'Times New Roman', Times, serif; font-size: 0.78rem; color: #5a5a5a; }}
    section {{ padding: 22px 0; }}
    .department {{ border-bottom: 1px solid #d3d3d3; }}
    .editor-note {{ border-top: 1px solid #121212; border-bottom: 1px solid #121212; }}
    h2 {{ margin: 0 0 10px; }}
    ul {{ margin: 0; padding-left: 1.2rem; }}
    a {{ color: #121212; text-decoration-thickness: 1px; overflow-wrap: anywhere; }}
    a:focus-visible {{ outline: 2px solid #121212; outline-offset: 2px; }}
    footer {{ padding-top: 18px; border-top: 4px double #121212; font-family: nyt-cheltenham-small, Georgia, 'Times New Roman', Times, serif; }}
    @media (max-width: 740px) {{ #daybook {{ padding-inline: 16px; }} .edition-strap {{ display: block; }} .edition-strap span {{ display: block; }} .masthead {{ font-size: clamp(2.45rem, 13vw, 4rem); }} .lead {{ grid-template-columns: minmax(0, 1fr); gap: 16px; }} }}
    @media print {{ body {{ background: #fff; }} article, figure, section {{ break-inside: avoid; }} }}
  </style>
</head>
<body>
  <main id="daybook">
    <header>
      <p class="edition-strap" data-edition-strap><span>Tuesday, August 25, 2026</span><span>12:35 p.m. EDT · Morning Edition</span></p>
      <h1 class="masthead">Daedalus Daybook</h1>
      <nav class="departments" data-department-rail aria-label="Edition departments">Technology · Culture · The Day Ahead</nav>
    </header>
    <article class="lead" data-story data-lead-grid data-lead-layout="feature" data-lead-story data-interest-key="ai-infrastructure" data-source-url="https://primary.example/story">
      <h2>Inference systems move into a new operating phase</h2>
      <p>The verified primary source describes a material development for today's edition.</p>
      <figure data-image-source-url="https://images.example/photo.jpg" data-source-page="https://primary.example/story" data-image-credit="A. Photographer / Publisher">
        <img src="https://images.example/photo.jpg" alt="Engineers examining a data center system" loading="eager" fetchpriority="high" decoding="async" referrerpolicy="no-referrer">
        <figcaption><a href="https://primary.example/story" target="_blank" rel="noopener noreferrer">A sourced view of the reported system.</a> A. Photographer / Publisher</figcaption>
      </figure>
    </article>
    <section class="department" data-department="technology" aria-labelledby="technology-heading">
      <h2 id="technology-heading">Technology</h2>
      <p>The lead development is the material update on today's technology desk.</p>
    </section>
    <section class="editor-note" id="editors-note" aria-labelledby="editors-note-heading">
      <h2 id="editors-note-heading">Editor's note</h2>
      <p>Today's verified change matters most; the culture desk is quiet rather than padded.</p>
    </section>
    <section id="coverage" aria-labelledby="coverage-heading">
      <h2 id="coverage-heading">Interest coverage</h2>
      <ul>
        <li data-interest-key="ai-infrastructure" data-coverage-status="covered" data-source-url="https://primary.example/story">AI infrastructure: a verified material update leads today's edition.</li>
        <li data-interest-key="classical-music" data-coverage-status="quiet">Classical music: checked today; no material new item warranted a story.</li>
      </ul>
    </section>
    <section id="sources" aria-labelledby="sources-heading">
      <h2 id="sources-heading">Sources and image credits</h2>
      <p><a href="https://primary.example/story" target="_blank" rel="noopener noreferrer">Primary source and image credit</a>: A. Photographer / Publisher.</p>
    </section>
    <footer>Generated from current, verified sources.</footer>
  </main>
</body>
</html>"""


def _manifest() -> dict:
    return {
        "interests": [
            {"key": "ai-infrastructure", "label": "AI infrastructure"},
            {"key": "classical-music", "label": "Classical music"},
        ]
    }


def _run_validator(tmp_path: Path, html: str, manifest: dict | None = None):
    html_path = tmp_path / "daybook.html"
    manifest_path = tmp_path / "coverage.json"
    html_path.write_text(html, encoding="utf-8")
    manifest_path.write_text(json.dumps(manifest or _manifest()), encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(VALIDATOR), str(html_path), str(manifest_path)],
        check=False,
        capture_output=True,
        text=True,
    )
    return result, json.loads(result.stdout)


def test_validator_accepts_a_complete_source_image_daybook(tmp_path):
    result, report = _run_validator(tmp_path, _valid_html())

    assert result.returncode == 0
    assert report["passed"] is True
    assert report["errors"] == []
    assert report["metrics"]["coverage_items"] == 2
    assert report["metrics"]["manifest_interests"] == 2
    assert report["metrics"]["source_images"] == 1
    assert report["metrics"]["stories"] == 1
    assert report["metrics"]["words"] > 50


def test_validator_rejects_interest_coverage_drift(tmp_path):
    html = _valid_html().replace(
        'data-interest-key="classical-music"',
        'data-interest-key="baseball"',
    )

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert report["passed"] is False
    assert any(
        "coverage ledger does not match manifest" in error for error in report["errors"]
    )


def test_validator_rejects_generated_or_uncredited_images(tmp_path):
    html = (
        _valid_html()
        .replace(
            "https://images.example/photo.jpg",
            "/api/generated-image/example",
        )
        .replace(
            ' data-image-credit="A. Photographer / Publisher"',
            "",
        )
    )

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any("generated-image" in error for error in report["errors"])
    assert any(
        "needs HTTPS provenance and a credit" in error for error in report["errors"]
    )


def test_validator_rejects_missing_editorial_and_accessibility_contracts(tmp_path):
    html = (
        _valid_html()
        .replace("max-width: 1200px", "max-width: 900px")
        .replace("a:focus-visible", "a:hover")
        .replace(' alt="Engineers examining a data center system"', "")
    )

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any("1200px page width" in error for error in report["errors"])
    assert any("visible focus treatment" in error for error in report["errors"])
    assert any("meaningful alt text" in error for error in report["errors"])


def test_validator_rejects_unbounded_source_images(tmp_path):
    html = _valid_html().replace("max-width: 100%; height: auto;", "")

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any("constrain source images" in error for error in report["errors"])


def test_validator_rejects_an_unapproved_stylesheet(tmp_path):
    html = _valid_html().replace(FONT_STYLESHEET, "https://fonts.example/style.css")

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any("approved Cheltenham stylesheet" in error for error in report["errors"])


def test_validator_rejects_weak_hierarchy_and_non_chelt_primary_type(tmp_path):
    html = (
        _valid_html()
        .replace(" data-edition-strap", "")
        .replace(' data-lead-grid data-lead-layout="feature" data-lead-story', "")
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
    html = _valid_html().replace(' data-lead-layout="feature"', "")

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any("data-lead-layout must be one of" in error for error in report["errors"])


def test_validator_requires_story_and_image_provenance_in_sources(tmp_path):
    source_link = (
        '<a href="https://primary.example/story" target="_blank" '
        'rel="noopener noreferrer">Primary source and image credit</a>'
    )
    html = _valid_html().replace(
        source_link,
        '<a href="https://primary.example/other" target="_blank" '
        'rel="noopener noreferrer">Primary source and image credit</a>',
    )

    result, report = _run_validator(tmp_path, html)

    assert result.returncode == 1
    assert any("story 1 source must be linked" in error for error in report["errors"])
    assert any(
        "figure 1 source and credit must appear" in error for error in report["errors"]
    )
