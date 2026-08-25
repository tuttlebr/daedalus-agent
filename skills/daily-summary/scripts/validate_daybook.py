#!/usr/bin/env python3
"""Validate a Daedalus Daybook HTML document using only Python's stdlib."""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

FONT_STYLESHEET = (
    "https://g1.nyt.com/fonts/css/"
    "web-fonts.c851560786173ad206e1f76c1901be7e096e8f8b.css"
)
INTEREST_KEY = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
COVERAGE_STATUSES = frozenset({"covered", "quiet", "unavailable"})
PLACEHOLDER_PATTERN = re.compile(
    r"(?:\bTODO\b|\bTBD\b|lorem ipsum|\[placeholder\]|\{\{[^}]+\}\})",
    re.IGNORECASE,
)
BANNED_IMAGE_PATTERN = re.compile(
    r"(?:AI-generated|generated[-_ ]image|/api/generated-image/)",
    re.IGNORECASE,
)


def _attrs(values: list[tuple[str, str | None]]) -> dict[str, str]:
    return {key.lower(): value or "" for key, value in values}


def _is_https(value: str) -> bool:
    parsed = urlsplit(value)
    return parsed.scheme == "https" and bool(parsed.netloc) and not parsed.username


@dataclass
class FigureRecord:
    attrs: dict[str, str]
    images: list[dict[str, str]] = field(default_factory=list)
    has_caption: bool = False
    caption_text: list[str] = field(default_factory=list)
    caption_links: list[str] = field(default_factory=list)


@dataclass
class CoverageRecord:
    attrs: dict[str, str]
    text: list[str] = field(default_factory=list)


class DaybookParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.html_attrs: dict[str, str] = {}
        self.meta: list[dict[str, str]] = []
        self.stylesheets: list[str] = []
        self.style_chunks: list[str] = []
        self._in_style = False
        self.script_count = 0
        self.main_count = 0
        self.header_count = 0
        self.footer_count = 0
        self.nav_labels: list[str] = []
        self.h1_count = 0
        self.h1_text: list[str] = []
        self.heading_levels: list[int] = []
        self.links: list[dict[str, str]] = []
        self.figures: list[FigureRecord] = []
        self._figure_stack: list[FigureRecord] = []
        self.orphan_images: list[dict[str, str]] = []
        self.coverage: list[CoverageRecord] = []
        self._coverage_stack: list[CoverageRecord] = []
        self.story_attrs: list[dict[str, str]] = []
        self.edition_strap_count = 0
        self.department_rail_count = 0
        self.lead_grid_count = 0
        self.lead_story_count = 0
        self.department_count = 0
        self.ids: set[str] = set()
        self.text_chunks: list[str] = []
        self.source_chunks: list[str] = []
        self._section_stack: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        values = _attrs(attrs)
        self.stack.append(tag)
        element_id = values.get("id")
        if element_id:
            self.ids.add(element_id)
        if "data-edition-strap" in values:
            self.edition_strap_count += 1
        if "data-department-rail" in values:
            self.department_rail_count += 1
        if "data-lead-grid" in values:
            self.lead_grid_count += 1
        if tag == "section":
            self._section_stack.append(element_id or "")
            if "data-department" in values:
                self.department_count += 1

        if tag == "html":
            self.html_attrs = values
        elif tag == "meta":
            self.meta.append(values)
        elif tag == "link" and "stylesheet" in values.get("rel", "").lower():
            self.stylesheets.append(values.get("href", ""))
        elif tag == "style":
            self._in_style = True
        elif tag == "script":
            self.script_count += 1
        elif tag == "main":
            self.main_count += 1
        elif tag == "header":
            self.header_count += 1
        elif tag == "footer":
            self.footer_count += 1
        elif tag == "nav":
            self.nav_labels.append(values.get("aria-label", ""))
        elif tag == "h1":
            self.h1_count += 1
            self.heading_levels.append(1)
        elif re.fullmatch(r"h[2-6]", tag):
            self.heading_levels.append(int(tag[1]))
        elif tag == "a":
            link = dict(values)
            link["_section-id"] = self._section_stack[-1] if self._section_stack else ""
            self.links.append(link)
            if self._figure_stack and "figcaption" in self.stack:
                self._figure_stack[-1].caption_links.append(values.get("href", ""))
        elif tag == "article" and "data-story" in values:
            self.story_attrs.append(values)
            if "data-lead-story" in values:
                self.lead_story_count += 1
        elif tag == "figure":
            record = FigureRecord(values)
            self.figures.append(record)
            self._figure_stack.append(record)
        elif tag == "figcaption" and self._figure_stack:
            self._figure_stack[-1].has_caption = True
        elif tag == "img":
            if self._figure_stack:
                self._figure_stack[-1].images.append(values)
            else:
                self.orphan_images.append(values)
        elif tag == "li" and "data-interest-key" in values:
            record = CoverageRecord(values)
            self.coverage.append(record)
            self._coverage_stack.append(record)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "style":
            self._in_style = False
        elif tag == "figure" and self._figure_stack:
            self._figure_stack.pop()
        elif tag == "li" and self._coverage_stack:
            self._coverage_stack.pop()
        elif tag == "section" and self._section_stack:
            self._section_stack.pop()

        if tag in self.stack:
            reverse_index = self.stack[::-1].index(tag)
            del self.stack[len(self.stack) - reverse_index - 1 :]

    def handle_data(self, data: str) -> None:
        if self._in_style:
            self.style_chunks.append(data)
            return
        stripped = data.strip()
        if not stripped:
            return
        self.text_chunks.append(stripped)
        if "h1" in self.stack:
            self.h1_text.append(stripped)
        if self._figure_stack and "figcaption" in self.stack:
            self._figure_stack[-1].caption_text.append(stripped)
        if "sources" in self._section_stack:
            self.source_chunks.append(stripped)
        for record in self._coverage_stack:
            record.text.append(stripped)


def _load_manifest(path: Path, errors: list[str]) -> list[dict[str, str]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        errors.append(f"coverage manifest is unreadable: {exc}")
        return []
    interests = value.get("interests") if isinstance(value, dict) else None
    if not isinstance(interests, list) or not interests:
        errors.append("coverage manifest must contain a non-empty interests list")
        return []

    normalized: list[dict[str, str]] = []
    for index, item in enumerate(interests):
        if not isinstance(item, dict):
            errors.append(f"manifest interest {index} must be an object")
            continue
        key = item.get("key")
        label = item.get("label")
        if not isinstance(key, str) or not INTEREST_KEY.fullmatch(key):
            errors.append(f"manifest interest {index} has an invalid key")
            continue
        if not isinstance(label, str) or not label.strip():
            errors.append(f"manifest interest {key} has an empty label")
            continue
        normalized.append({"key": key, "label": label.strip()})

    keys = [item["key"] for item in normalized]
    if len(keys) != len(set(keys)):
        errors.append("coverage manifest contains duplicate interest keys")
    return normalized


def validate_daybook(html_path: Path, manifest_path: Path) -> dict[str, Any]:
    errors: list[str] = []
    try:
        document = html_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        return {"passed": False, "errors": [f"HTML is unreadable: {exc}"]}

    manifest = _load_manifest(manifest_path, errors)
    stripped = document.strip()
    if not stripped.startswith("<!DOCTYPE html>"):
        errors.append("HTML must begin with <!DOCTYPE html>")
    if not stripped.endswith("</html>"):
        errors.append("HTML must end with </html>")
    if "```" in document:
        errors.append("raw sandbox HTML must not contain Markdown fences")
    if PLACEHOLDER_PATTERN.search(document):
        errors.append("HTML contains a placeholder or unfinished token")
    if BANNED_IMAGE_PATTERN.search(document):
        errors.append("HTML contains generated-image language or an asset URL")

    parser = DaybookParser()
    try:
        parser.feed(document)
        parser.close()
    except Exception as exc:  # HTMLParser can surface malformed entities.
        errors.append(f"HTML parsing failed: {exc}")

    if parser.html_attrs.get("lang", "").lower() != "en":
        errors.append("<html> must declare lang=en")
    if parser.html_attrs.get("data-daybook-version") != "2":
        errors.append("<html> must declare data-daybook-version=2")
    if parser.main_count != 1 or "daybook" not in parser.ids:
        errors.append("document must contain exactly one <main id=daybook>")
    if parser.header_count < 1 or parser.footer_count < 1:
        errors.append("document must contain header and footer landmarks")
    if not parser.nav_labels or any(not value for value in parser.nav_labels):
        errors.append("every navigation landmark needs a non-empty aria-label")
    if parser.h1_count != 1:
        errors.append("document must contain exactly one h1")
    if " ".join(parser.h1_text).strip() != "Daedalus Daybook":
        errors.append("h1 masthead must read Daedalus Daybook")
    if parser.edition_strap_count != 1:
        errors.append("document must contain exactly one edition strap")
    if parser.department_rail_count != 1:
        errors.append("document must contain exactly one department rail")
    if parser.lead_grid_count != 1 or parser.lead_story_count != 1:
        errors.append("document must identify exactly one lead grid and lead story")
    if parser.department_count < 1:
        errors.append("document must contain at least one department section")
    for previous, current in zip(parser.heading_levels, parser.heading_levels[1:]):
        if current > previous + 1:
            errors.append("heading levels must not skip")
            break
    if parser.script_count:
        errors.append("Daybook HTML must not contain JavaScript")
    required_sections = {"editors-note", "coverage", "sources"}
    if not required_sections <= parser.ids:
        errors.append(
            "document must contain editor's note, coverage, and sources sections"
        )

    charset = any("charset" in item for item in parser.meta)
    viewport = any(item.get("name", "").lower() == "viewport" for item in parser.meta)
    description = any(
        item.get("name", "").lower() == "description" and item.get("content", "")
        for item in parser.meta
    )
    if not charset or not viewport or not description:
        errors.append("head must include charset, viewport, and description metadata")

    if parser.stylesheets != [FONT_STYLESHEET]:
        errors.append("document must load only the approved Cheltenham stylesheet")
    css = "\n".join(parser.style_chunks)
    compact_css = re.sub(r"\s+", " ", css.lower())
    css_requirements = {
        "Cheltenham font family": "nyt-cheltenham",
        "1200px page width": "max-width: 1200px",
        "lead story grid": "grid-template-columns",
        "740px responsive breakpoint": "740px",
        "print stylesheet": "@media print",
        "global border-box sizing": "box-sizing: border-box",
        "visible focus treatment": "focus-visible",
    }
    for label, token in css_requirements.items():
        if token not in compact_css:
            errors.append(f"CSS is missing {label}")
    font_declarations = re.findall(r"font-family\s*:\s*([^;}]+)", compact_css)
    if not font_declarations:
        errors.append("CSS must declare a Cheltenham font family")
    for declaration in font_declarations:
        primary = declaration.split(",", 1)[0].strip(" \"'")
        if not primary.startswith("nyt-cheltenham"):
            errors.append(
                "every inline font stack must use Cheltenham as its primary family"
            )
            break
    css_rules = re.findall(r"([^{}]+)\{([^{}]+)\}", compact_css)
    masthead_css = " ".join(
        declarations
        for selector, declarations in css_rules
        if ".masthead" in selector
        or re.search(r"(?:^|[\s,>])h1(?:[\s,:.#>]|$)", selector)
    )
    if "text-align: center" not in masthead_css or "clamp(" not in masthead_css:
        errors.append("CSS must center the masthead and size it fluidly with clamp")
    department_rail_css = " ".join(
        declarations
        for selector, declarations in css_rules
        if ".departments" in selector or "data-department-rail" in selector
    )
    if "double" not in department_rail_css:
        errors.append("CSS must give the department rail a double rule")
    if "min-width: 0" not in compact_css or "overflow-wrap:" not in compact_css:
        errors.append("CSS must prevent grid and long-text overflow")
    image_css = " ".join(
        declarations
        for selector, declarations in re.findall(
            r"([^{}]*\bimg\b[^{}]*)\{([^{}]*)\}", compact_css
        )
        if selector.strip()
    )
    if not re.search(r"max-width\s*:\s*100%", image_css) or not re.search(
        r"height\s*:\s*auto", image_css
    ):
        errors.append(
            "CSS must constrain source images to max-width 100% and auto height"
        )
    if not re.search(r"25fr\b.*45fr\b.*30fr\b", compact_css, re.DOTALL):
        errors.append("CSS is missing the 25/45/30 desktop lead ratio")
    if "gradient(" in compact_css:
        errors.append("CSS gradients are not permitted")
    if re.search(r"box-shadow\s*:\s*(?!none\b)[^;}]+", compact_css):
        errors.append("ornamental box shadows are not permitted")
    if re.search(r"border-radius\s*:\s*(?!0(?:px|rem|em|%)?\b)[^;}]+", compact_css):
        errors.append("rounded editorial cards are not permitted")

    expected_keys = {item["key"] for item in manifest}
    actual_keys = [item.attrs.get("data-interest-key", "") for item in parser.coverage]
    if len(actual_keys) != len(set(actual_keys)):
        errors.append("coverage ledger contains duplicate interest keys")
    if set(actual_keys) != expected_keys:
        missing = sorted(expected_keys - set(actual_keys))
        unexpected = sorted(set(actual_keys) - expected_keys)
        errors.append(
            "coverage ledger does not match manifest"
            f"; missing={missing}; unexpected={unexpected}"
        )
    for item in parser.coverage:
        key = item.attrs.get("data-interest-key", "")
        status = item.attrs.get("data-coverage-status", "")
        if status not in COVERAGE_STATUSES:
            errors.append(f"coverage item {key or '<empty>'} has invalid status")
        if len(" ".join(item.text).strip()) < 8:
            errors.append(f"coverage item {key or '<empty>'} needs visible explanation")
        source_url = item.attrs.get("data-source-url", "")
        if status == "covered" and not _is_https(source_url):
            errors.append(f"covered interest {key} needs an HTTPS source URL")
        if source_url and not _is_https(source_url):
            errors.append(f"coverage source for {key} must be HTTPS")

    for index, attrs in enumerate(parser.story_attrs, start=1):
        key = attrs.get("data-interest-key", "")
        if key not in expected_keys:
            errors.append(f"story {index} references an unknown interest key")
        if not _is_https(attrs.get("data-source-url", "")):
            errors.append(f"story {index} needs an HTTPS data-source-url")

    source_links = {
        link.get("href", "")
        for link in parser.links
        if link.get("_section-id") == "sources"
    }
    for index, attrs in enumerate(parser.story_attrs, start=1):
        if attrs.get("data-source-url", "") not in source_links:
            errors.append(f"story {index} source must be linked in the sources section")

    if parser.orphan_images:
        errors.append("every image must be inside a sourced figure")
    image_urls: list[str] = []
    for index, figure in enumerate(parser.figures, start=1):
        source_image = figure.attrs.get("data-image-source-url", "")
        source_page = figure.attrs.get("data-source-page", "")
        credit = figure.attrs.get("data-image-credit", "").strip()
        if not _is_https(source_image) or not _is_https(source_page) or not credit:
            errors.append(f"figure {index} needs HTTPS provenance and a credit")
        if not figure.has_caption:
            errors.append(f"figure {index} needs a visible figcaption")
        if source_page not in figure.caption_links:
            errors.append(f"figure {index} caption must link its source page")
        if credit and credit not in " ".join(figure.caption_text):
            errors.append(f"figure {index} caption must repeat its image credit")
        if source_page not in source_links or credit not in " ".join(
            parser.source_chunks
        ):
            errors.append(f"figure {index} source and credit must appear in sources")
        if len(figure.images) != 1:
            errors.append(f"figure {index} must contain exactly one image")
            continue
        image = figure.images[0]
        image_url = image.get("src", "")
        image_urls.append(image_url)
        if image_url != source_image:
            errors.append(f"figure {index} image URL must match its provenance URL")
        if not image.get("alt", "").strip():
            errors.append(f"figure {index} image needs meaningful alt text")
        if image.get("loading") not in {"eager", "lazy"}:
            errors.append(f"figure {index} image needs eager or lazy loading")
        if image.get("decoding") != "async":
            errors.append(f"figure {index} image needs decoding=async")
        if image.get("referrerpolicy") != "no-referrer":
            errors.append(f"figure {index} image needs referrerpolicy=no-referrer")
    if len(image_urls) != len(set(image_urls)):
        errors.append("source image URLs must not be duplicated")

    for index, link in enumerate(parser.links, start=1):
        href = link.get("href", "")
        if href.startswith(("http://", "https://")):
            if not _is_https(href):
                errors.append(f"external link {index} must use HTTPS")
            rel = set(link.get("rel", "").split())
            if link.get("target") != "_blank" or not {"noopener", "noreferrer"} <= rel:
                errors.append(
                    f"external link {index} needs target=_blank and safe rel values"
                )

    words = re.findall(r"\b[\w'’-]+\b", " ".join(parser.text_chunks))
    return {
        "passed": not errors,
        "errors": errors,
        "metrics": {
            "manifest_interests": len(expected_keys),
            "coverage_items": len(parser.coverage),
            "stories": len(parser.story_attrs),
            "source_images": len(image_urls),
            "words": len(words),
        },
    }


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(
            json.dumps(
                {
                    "passed": False,
                    "errors": ["usage: validate_daybook.py DAYBOOK_HTML COVERAGE_JSON"],
                }
            )
        )
        return 2
    result = validate_daybook(Path(argv[1]), Path(argv[2]))
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
