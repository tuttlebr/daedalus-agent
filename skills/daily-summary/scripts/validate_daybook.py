#!/usr/bin/env python3
"""Validate a Daily Daedalus HTML document using only Python's stdlib."""

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
DAYBOOK_VERSION = "3"
DESK_KEY = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
COVERAGE_STATUSES = frozenset({"covered", "quiet", "unavailable"})
LEAD_LAYOUTS = frozenset({"feature", "two-column", "three-column"})
SOURCE_KINDS = frozenset({"tool", "web"})
TOOL_SOURCE_REF = re.compile(r"^[a-z0-9_-]+(?:\s*,\s*[a-z0-9_-]+)*$")
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


def _tool_source_refs(value: str) -> list[str]:
    if not TOOL_SOURCE_REF.fullmatch(value):
        return []
    return [item.strip() for item in value.split(",")]


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


@dataclass
class DeskManifest:
    policy_version: str = ""
    lead_desk: str = ""
    desks: list[dict[str, str]] = field(default_factory=list)


@dataclass
class EditionPolicy:
    policy_version: str = ""
    title: str = ""
    tagline: str = ""
    lead_desk: str = ""
    desks: list[dict[str, str]] = field(default_factory=list)


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
        self.title_count = 0
        self.title_text: list[str] = []
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
        self.lead_story_attrs: list[dict[str, str]] = []
        self.edition_strap_count = 0
        self.edition_tagline_count = 0
        self.edition_tagline_text: list[str] = []
        self._tagline_depth: int | None = None
        self.department_rail_count = 0
        self.lead_grid_count = 0
        self.lead_story_count = 0
        self.lead_layouts: list[str] = []
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
        if "data-edition-tagline" in values:
            self.edition_tagline_count += 1
            self._tagline_depth = len(self.stack)
        if "data-department-rail" in values:
            self.department_rail_count += 1
        if "data-lead-grid" in values:
            self.lead_grid_count += 1
            self.lead_layouts.append(values.get("data-lead-layout", ""))
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
        elif tag == "title":
            self.title_count += 1
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
                self.lead_story_attrs.append(values)
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
        elif tag == "li" and "data-desk-key" in values:
            record = CoverageRecord(values)
            self.coverage.append(record)
            self._coverage_stack.append(record)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        closes_tagline = (
            self._tagline_depth is not None
            and len(self.stack) >= self._tagline_depth
            and self.stack[self._tagline_depth - 1] == tag
        )
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
        if closes_tagline:
            self._tagline_depth = None

    def handle_data(self, data: str) -> None:
        if self._in_style:
            self.style_chunks.append(data)
            return
        stripped = data.strip()
        if not stripped:
            return
        self.text_chunks.append(stripped)
        if "title" in self.stack:
            self.title_text.append(stripped)
        if "h1" in self.stack:
            self.h1_text.append(stripped)
        if self._tagline_depth is not None:
            self.edition_tagline_text.append(stripped)
        if self._figure_stack and "figcaption" in self.stack:
            self._figure_stack[-1].caption_text.append(stripped)
        if "sources" in self._section_stack:
            self.source_chunks.append(stripped)
        for record in self._coverage_stack:
            record.text.append(stripped)


def _read_json_object(path: Path, label: str, errors: list[str]) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        errors.append(f"{label} is unreadable: {exc}")
        return {}
    if not isinstance(value, dict):
        errors.append(f"{label} must be a JSON object")
        return {}
    return value


def _normalize_desks(
    value: Any, collection_label: str, errors: list[str]
) -> list[dict[str, str]]:
    if not isinstance(value, list) or not value:
        errors.append(f"{collection_label} must contain a non-empty desks list")
        return []

    normalized: list[dict[str, str]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            errors.append(f"{collection_label} desk {index} must be an object")
            continue
        key = item.get("key")
        desk_label = item.get("label")
        if not isinstance(key, str) or not DESK_KEY.fullmatch(key):
            errors.append(f"desk {index} has an invalid key")
            continue
        if not isinstance(desk_label, str) or not desk_label.strip():
            errors.append(f"desk {key} has an empty label")
            continue
        normalized.append({"key": key, "label": desk_label.strip()})

    keys = [item["key"] for item in normalized]
    if len(keys) != len(set(keys)):
        errors.append(f"{collection_label} contains duplicate desk keys")
    return normalized


def _load_manifest(path: Path, errors: list[str]) -> DeskManifest:
    value = _read_json_object(path, "coverage manifest", errors)
    policy_version = value.get("policy_version", "")
    lead_desk = value.get("lead_desk", "")
    if not isinstance(policy_version, str) or not policy_version.strip():
        errors.append("coverage manifest needs a non-empty policy_version")
        policy_version = ""
    if not isinstance(lead_desk, str) or not DESK_KEY.fullmatch(lead_desk):
        errors.append("coverage manifest has an invalid lead_desk")
        lead_desk = ""
    desks = _normalize_desks(value.get("desks"), "coverage manifest", errors)
    if lead_desk and lead_desk not in {desk["key"] for desk in desks}:
        errors.append("coverage manifest lead_desk is missing from manifest desks")
    return DeskManifest(policy_version.strip(), lead_desk, desks)


def _load_policy(path: Path, errors: list[str]) -> EditionPolicy:
    value = _read_json_object(path, "edition policy", errors)
    policy_version = value.get("policy_version", "")
    edition = value.get("edition")
    if not isinstance(policy_version, str) or not policy_version.strip():
        errors.append("edition policy needs a non-empty policy_version")
        policy_version = ""
    if not isinstance(edition, dict):
        errors.append("edition policy needs an edition object")
        edition = {}

    title = edition.get("title", "")
    tagline = edition.get("tagline", "")
    lead_desk = edition.get("lead_desk", "")
    for key, value_ in (("title", title), ("tagline", tagline)):
        if not isinstance(value_, str) or not value_.strip():
            errors.append(f"edition policy needs a non-empty {key}")
    if not isinstance(lead_desk, str) or not DESK_KEY.fullmatch(lead_desk):
        errors.append("edition policy has an invalid lead_desk")
        lead_desk = ""

    raw_desks = value.get("desks")
    desks = _normalize_desks(raw_desks, "edition policy", errors)
    if isinstance(raw_desks, list):
        for index, desk in enumerate(raw_desks):
            if not isinstance(desk, dict):
                continue
            for field_name in ("cadence", "placement"):
                field_value = desk.get(field_name)
                if not isinstance(field_value, str) or not field_value.strip():
                    errors.append(f"policy desk {index} needs {field_name}")
            for field_name in ("topics", "rules"):
                field_value = desk.get(field_name)
                if (
                    not isinstance(field_value, list)
                    or not field_value
                    or any(
                        not isinstance(item, str) or not item.strip()
                        for item in field_value
                    )
                ):
                    errors.append(
                        f"policy desk {index} needs non-empty {field_name} strings"
                    )

    desk_keys = {desk["key"] for desk in desks}
    if lead_desk and lead_desk not in desk_keys:
        errors.append("edition policy lead_desk is missing from policy desks")
    lead_placements = {
        desk.get("key")
        for desk in raw_desks or []
        if isinstance(desk, dict) and desk.get("placement") == "lead"
    }
    if lead_desk and lead_placements != {lead_desk}:
        errors.append("edition policy must mark only lead_desk with placement=lead")

    return EditionPolicy(
        policy_version.strip() if isinstance(policy_version, str) else "",
        title.strip() if isinstance(title, str) else "",
        tagline.strip() if isinstance(tagline, str) else "",
        lead_desk,
        desks,
    )


def validate_daybook(
    html_path: Path, manifest_path: Path, policy_path: Path
) -> dict[str, Any]:
    errors: list[str] = []
    try:
        document = html_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        return {"passed": False, "errors": [f"HTML is unreadable: {exc}"]}

    manifest = _load_manifest(manifest_path, errors)
    policy = _load_policy(policy_path, errors)
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
    if parser.html_attrs.get("data-daybook-version") != DAYBOOK_VERSION:
        errors.append(f"<html> must declare data-daybook-version={DAYBOOK_VERSION}")
    if parser.html_attrs.get("data-policy-version") != policy.policy_version:
        errors.append("HTML data-policy-version must match the edition policy")
    if manifest.policy_version != policy.policy_version:
        errors.append("coverage manifest policy_version must match the edition policy")
    if manifest.lead_desk != policy.lead_desk:
        errors.append("coverage manifest lead_desk must match the edition policy")

    policy_desks = {item["key"]: item["label"] for item in policy.desks}
    manifest_desks = {item["key"]: item["label"] for item in manifest.desks}
    missing_policy_desks = sorted(set(policy_desks) - set(manifest_desks))
    if missing_policy_desks:
        errors.append(
            "coverage manifest omits required policy desks"
            f"; missing={missing_policy_desks}"
        )
    changed_policy_labels = sorted(
        key
        for key in policy_desks.keys() & manifest_desks.keys()
        if policy_desks[key] != manifest_desks[key]
    )
    if changed_policy_labels:
        errors.append(
            "coverage manifest changes policy desk labels"
            f"; desks={changed_policy_labels}"
        )
    if parser.main_count != 1 or "daybook" not in parser.ids:
        errors.append("document must contain exactly one <main id=daybook>")
    if parser.header_count < 1 or parser.footer_count < 1:
        errors.append("document must contain header and footer landmarks")
    if not parser.nav_labels or any(not value for value in parser.nav_labels):
        errors.append("every navigation landmark needs a non-empty aria-label")
    if parser.title_count != 1 or " ".join(parser.title_text).strip() != policy.title:
        errors.append("document title must match the edition policy title")
    if parser.h1_count != 1:
        errors.append("document must contain exactly one h1")
    if " ".join(parser.h1_text).strip() != policy.title:
        errors.append("h1 masthead must match the edition policy title")
    if parser.edition_strap_count != 1:
        errors.append("document must contain exactly one edition strap")
    if parser.edition_tagline_count != 1:
        errors.append("document must contain exactly one edition tagline")
    if " ".join(parser.edition_tagline_text).strip() != policy.tagline:
        errors.append("edition tagline must match the edition policy")
    if parser.department_rail_count != 1:
        errors.append("document must contain exactly one department rail")
    if parser.lead_grid_count != 1 or parser.lead_story_count != 1:
        errors.append("document must identify exactly one lead grid and lead story")
    if parser.lead_story_attrs and (
        parser.lead_story_attrs[0].get("data-desk-key") != policy.lead_desk
    ):
        errors.append("lead story desk must match the edition policy lead_desk")
    if parser.lead_layouts and parser.lead_layouts[0] not in LEAD_LAYOUTS:
        allowed = ", ".join(sorted(LEAD_LAYOUTS))
        errors.append(f"lead grid data-lead-layout must be one of: {allowed}")
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
    color_scheme = any(
        item.get("name", "").lower() == "color-scheme" and item.get("content", "")
        for item in parser.meta
    )
    if not charset or not viewport or not description or not color_scheme:
        errors.append(
            "head must include charset, viewport, description, and color-scheme metadata"
        )

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
    tagline_css = " ".join(
        declarations
        for selector, declarations in css_rules
        if ".tagline" in selector or "data-edition-tagline" in selector
    )
    if "text-align: center" not in tagline_css:
        errors.append("CSS must center the edition tagline")
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
    if "gradient(" in compact_css:
        errors.append("CSS gradients are not permitted")
    if re.search(r"box-shadow\s*:\s*(?!none\b)[^;}]+", compact_css):
        errors.append("ornamental box shadows are not permitted")
    if re.search(r"border-radius\s*:\s*(?!0(?:px|rem|em|%)?\b)[^;}]+", compact_css):
        errors.append("rounded editorial cards are not permitted")

    expected_keys = {item["key"] for item in manifest.desks}
    actual_keys = [item.attrs.get("data-desk-key", "") for item in parser.coverage]
    source_links = {
        link.get("href", "")
        for link in parser.links
        if link.get("_section-id") == "sources"
    }
    source_text = " ".join(parser.source_chunks)
    if len(actual_keys) != len(set(actual_keys)):
        errors.append("coverage ledger contains duplicate desk keys")
    if set(actual_keys) != expected_keys:
        missing = sorted(expected_keys - set(actual_keys))
        unexpected = sorted(set(actual_keys) - expected_keys)
        errors.append(
            "coverage ledger does not match manifest"
            f"; missing={missing}; unexpected={unexpected}"
        )
    for item in parser.coverage:
        key = item.attrs.get("data-desk-key", "")
        status = item.attrs.get("data-coverage-status", "")
        if status not in COVERAGE_STATUSES:
            errors.append(f"coverage item {key or '<empty>'} has invalid status")
        if len(" ".join(item.text).strip()) < 8:
            errors.append(f"coverage item {key or '<empty>'} needs visible explanation")
        source_kind = item.attrs.get("data-source-kind", "")
        source_url = item.attrs.get("data-source-url", "")
        source_ref = item.attrs.get("data-source-ref", "")
        if status == "covered" and source_kind not in SOURCE_KINDS:
            errors.append(f"covered desk {key} needs data-source-kind=web or tool")
        if status == "covered" and source_kind == "web" and not _is_https(source_url):
            errors.append(f"web-sourced desk {key} needs an HTTPS source URL")
        if (
            status == "covered"
            and source_kind == "web"
            and _is_https(source_url)
            and source_url not in source_links
        ):
            errors.append(f"web-sourced desk {key} must be linked in sources")
        if status == "covered" and source_kind == "tool":
            refs = _tool_source_refs(source_ref)
            if not refs:
                errors.append(f"tool-sourced desk {key} needs a safe data-source-ref")
            elif any(ref not in source_text for ref in refs):
                errors.append(
                    f"tool-sourced desk {key} must name each source in the sources section"
                )
        if source_url and not _is_https(source_url):
            errors.append(f"coverage source for {key} must be HTTPS")
        if source_ref and not _tool_source_refs(source_ref):
            errors.append(f"coverage source ref for {key} is invalid")

    for index, attrs in enumerate(parser.story_attrs, start=1):
        key = attrs.get("data-desk-key", "")
        if key not in expected_keys:
            errors.append(f"story {index} references an unknown desk key")
        source_kind = attrs.get("data-source-kind", "")
        source_url = attrs.get("data-source-url", "")
        source_ref = attrs.get("data-source-ref", "")
        if source_kind not in SOURCE_KINDS:
            errors.append(f"story {index} needs data-source-kind=web or tool")
        if source_kind == "web" and not _is_https(source_url):
            errors.append(f"web-sourced story {index} needs an HTTPS data-source-url")
        if source_kind == "tool":
            refs = _tool_source_refs(source_ref)
            if not refs:
                errors.append(
                    f"tool-sourced story {index} needs a safe data-source-ref"
                )
            elif any(ref not in source_text for ref in refs):
                errors.append(
                    f"tool-sourced story {index} must name each source in the sources section"
                )
        if source_url and not _is_https(source_url):
            errors.append(f"story {index} source URL must be HTTPS")
        if source_ref and not _tool_source_refs(source_ref):
            errors.append(f"story {index} source ref is invalid")

    for index, attrs in enumerate(parser.story_attrs, start=1):
        source_url = attrs.get("data-source-url", "")
        if source_url and source_url not in source_links:
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
            "manifest_desks": len(expected_keys),
            "required_policy_desks": len(policy.desks),
            "coverage_items": len(parser.coverage),
            "stories": len(parser.story_attrs),
            "source_images": len(image_urls),
            "words": len(words),
        },
    }


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(
            json.dumps(
                {
                    "passed": False,
                    "errors": [
                        "usage: validate_daybook.py "
                        "DAILY_DAEDALUS_HTML COVERAGE_JSON EDITION_POLICY_JSON"
                    ],
                }
            )
        )
        return 2
    result = validate_daybook(Path(argv[1]), Path(argv[2]), Path(argv[3]))
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
