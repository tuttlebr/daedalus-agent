#!/usr/bin/env python3
"""Render a Daily Daedalus v4 document from structured edition JSON."""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from html import escape
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

FORMAT_VERSION = "daily-daedalus/v1"
DAYBOOK_VERSION = "4"
TEMPLATE_VERSION = "daybook-v4"
DESK_KEY = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
TOOL_REF = re.compile(r"^[a-z0-9_-]+$")
SENTINEL = re.compile(r"@@[A-Z_]+@@")
WORD = re.compile(r"\b[\w'’-]+\b")
STATUSES = frozenset({"covered", "quiet", "unavailable"})
VERDICT_TONES = frozenset({"stable", "watch", "urgent"})
BLOCK_TYPES = frozenset({"paragraph", "subhead", "list", "table", "briefs", "figure"})


class RenderError(ValueError):
    """Raised when structured edition data violates the rendering contract."""


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RenderError(f"{label} is unreadable: {exc}") from exc
    if not isinstance(value, dict):
        raise RenderError(f"{label} must be a JSON object")
    return value


def _object(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RenderError(f"{path} must be an object")
    return value


def _array(
    value: Any, path: str, *, minimum: int = 0, maximum: int | None = None
) -> list[Any]:
    if not isinstance(value, list):
        raise RenderError(f"{path} must be an array")
    if len(value) < minimum:
        raise RenderError(f"{path} must contain at least {minimum} item(s)")
    if maximum is not None and len(value) > maximum:
        raise RenderError(f"{path} must contain at most {maximum} item(s)")
    return value


def _keys(value: dict[str, Any], allowed: set[str], path: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise RenderError(f"{path} contains unsupported field(s): {', '.join(unknown)}")


def _text(value: Any, path: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise RenderError(f"{path} must be a string")
    normalized = " ".join(value.split())
    if not normalized and not allow_empty:
        raise RenderError(f"{path} must not be empty")
    if "```" in value or SENTINEL.search(value):
        raise RenderError(f"{path} contains markup or a template token")
    return normalized


def _optional_text(value: Any, path: str) -> str:
    if value is None:
        return ""
    return _text(value, path)


def _https(value: Any, path: str) -> str:
    url = _text(value, path)
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username:
        raise RenderError(f"{path} must be an HTTPS URL without embedded credentials")
    return url


def _words(values: list[str]) -> int:
    return len(WORD.findall(" ".join(values)))


def _external_link(url: str, label: str) -> str:
    return (
        f'<a href="{escape(url, quote=True)}" target="_blank" '
        f'rel="noopener noreferrer">{escape(label)}</a>'
    )


@dataclass(frozen=True)
class Source:
    kind: str
    label: str
    url: str = ""
    refs: tuple[str, ...] = ()
    detail: str = ""


def _source(value: Any, path: str) -> Source:
    item = _object(value, path)
    _keys(item, {"kind", "label", "url", "refs", "detail"}, path)
    kind = _text(item.get("kind"), f"{path}.kind")
    label = _text(item.get("label"), f"{path}.label")
    detail = _optional_text(item.get("detail"), f"{path}.detail")
    if kind == "web":
        if "refs" in item:
            raise RenderError(f"{path}.refs is not valid for a web source")
        return Source(
            kind, label, url=_https(item.get("url"), f"{path}.url"), detail=detail
        )
    if kind == "tool":
        if "url" in item:
            raise RenderError(f"{path}.url is not valid for a tool source")
        refs_value = _array(item.get("refs"), f"{path}.refs", minimum=1, maximum=12)
        refs: list[str] = []
        for index, raw in enumerate(refs_value):
            ref = _text(raw, f"{path}.refs[{index}]")
            if not TOOL_REF.fullmatch(ref):
                raise RenderError(f"{path}.refs[{index}] is invalid")
            refs.append(ref)
        if len(refs) != len(set(refs)):
            raise RenderError(f"{path}.refs contains duplicates")
        return Source(kind, label, refs=tuple(refs), detail=detail)
    raise RenderError(f"{path}.kind must be web or tool")


def _source_attrs(source: Source) -> str:
    if source.kind == "web":
        return (
            ' data-source-kind="web"'
            f' data-source-url="{escape(source.url, quote=True)}"'
        )
    return (
        ' data-source-kind="tool"'
        f' data-source-ref="{escape(",".join(source.refs), quote=True)}"'
    )


class SourceRegistry:
    def __init__(self) -> None:
        self._items: list[Source] = []
        self._seen: set[tuple[Any, ...]] = set()

    def add(self, source: Source) -> None:
        key = (source.kind, source.label, source.url, source.refs, source.detail)
        if key not in self._seen:
            self._seen.add(key)
            self._items.append(source)

    def render(self) -> str:
        rendered: list[str] = []
        for source in self._items:
            detail = f" — {escape(source.detail)}" if source.detail else ""
            if source.kind == "web":
                body = _external_link(source.url, source.label) + detail
            else:
                refs = ", ".join(escape(ref) for ref in source.refs)
                body = f"<strong>{escape(source.label)}</strong>: {refs}{detail}"
            rendered.append(f"<li>{body}</li>")
        return "\n".join(rendered)

    @property
    def count(self) -> int:
        return len(self._items)


def _table(columns: Any, rows: Any, path: str, *, maximum_rows: int = 20) -> str:
    column_values = _array(columns, f"{path}.columns", minimum=1, maximum=8)
    labels = [
        _text(item, f"{path}.columns[{index}]")
        for index, item in enumerate(column_values)
    ]
    row_values = _array(rows, f"{path}.rows", minimum=1, maximum=maximum_rows)
    rendered_rows: list[str] = []
    for row_index, raw_row in enumerate(row_values):
        row = _array(
            raw_row,
            f"{path}.rows[{row_index}]",
            minimum=len(labels),
            maximum=len(labels),
        )
        cells = [
            _text(cell, f"{path}.rows[{row_index}][{cell_index}]", allow_empty=True)
            for cell_index, cell in enumerate(row)
        ]
        rendered_rows.append(
            "<tr>" + "".join(f"<td>{escape(cell)}</td>" for cell in cells) + "</tr>"
        )
    header = "".join(f"<th>{escape(label)}</th>" for label in labels)
    return f"<table><thead><tr>{header}</tr></thead><tbody>{''.join(rendered_rows)}</tbody></table>"


def _render_figure(block: dict[str, Any], path: str, registry: SourceRegistry) -> str:
    _keys(block, {"type", "url", "source_page", "credit", "alt", "caption"}, path)
    url = _https(block.get("url"), f"{path}.url")
    source_page = _https(block.get("source_page"), f"{path}.source_page")
    credit = _text(block.get("credit"), f"{path}.credit")
    alt = _text(block.get("alt"), f"{path}.alt")
    caption = _text(block.get("caption"), f"{path}.caption")
    registry.add(
        Source(
            "web", f"Image: {credit}", url=source_page, detail=f"Image credit: {credit}"
        )
    )
    return (
        f'<figure data-image-source-url="{escape(url, quote=True)}" '
        f'data-source-page="{escape(source_page, quote=True)}" '
        f'data-image-credit="{escape(credit, quote=True)}">'
        f'<img src="{escape(url, quote=True)}" alt="{escape(alt, quote=True)}" '
        'loading="lazy" decoding="async" referrerpolicy="no-referrer">'
        f"<figcaption>{escape(caption)} "
        f"{_external_link(source_page, credit)}</figcaption></figure>"
    )


def _render_blocks(value: Any, path: str, registry: SourceRegistry) -> str:
    blocks = _array(value, path, minimum=1, maximum=20)
    rendered: list[str] = []
    for index, raw_block in enumerate(blocks):
        block_path = f"{path}[{index}]"
        block = _object(raw_block, block_path)
        block_type = _text(block.get("type"), f"{block_path}.type")
        if block_type not in BLOCK_TYPES:
            raise RenderError(f"{block_path}.type is unsupported")
        if block_type == "paragraph":
            _keys(block, {"type", "text"}, block_path)
            rendered.append(
                f"<p>{escape(_text(block.get('text'), f'{block_path}.text'))}</p>"
            )
        elif block_type == "subhead":
            _keys(block, {"type", "text"}, block_path)
            rendered.append(
                f'<h4 class="subhead">{escape(_text(block.get("text"), f"{block_path}.text"))}</h4>'
            )
        elif block_type == "list":
            _keys(block, {"type", "items"}, block_path)
            items = _array(
                block.get("items"), f"{block_path}.items", minimum=1, maximum=20
            )
            body = "".join(
                f"<li>{escape(_text(item, f'{block_path}.items[{item_index}]'))}</li>"
                for item_index, item in enumerate(items)
            )
            rendered.append(f'<ul class="story-list">{body}</ul>')
        elif block_type == "table":
            _keys(block, {"type", "columns", "rows"}, block_path)
            rendered.append(_table(block.get("columns"), block.get("rows"), block_path))
        elif block_type == "figure":
            rendered.append(_render_figure(block, block_path, registry))
        else:
            _keys(block, {"type", "items"}, block_path)
            items = _array(
                block.get("items"), f"{block_path}.items", minimum=1, maximum=8
            )
            briefs: list[str] = []
            for item_index, raw_item in enumerate(items):
                item_path = f"{block_path}.items[{item_index}]"
                item = _object(raw_item, item_path)
                _keys(item, {"title", "body", "source"}, item_path)
                title = _text(item.get("title"), f"{item_path}.title")
                body = _text(item.get("body"), f"{item_path}.body")
                source_markup = ""
                if item.get("source") is not None:
                    source = _source(item.get("source"), f"{item_path}.source")
                    registry.add(source)
                    if source.kind == "web":
                        source_markup = (
                            f" <span>{_external_link(source.url, source.label)}</span>"
                        )
                    else:
                        source_markup = f" <span>Source: {escape(source.label)}</span>"
                briefs.append(
                    f'<div class="brief"><h4>{escape(title)}</h4><p>{escape(body)}{source_markup}</p></div>'
                )
            rendered.append("".join(briefs))
    return "\n".join(rendered)


def _load_policy(value: dict[str, Any]) -> dict[str, Any]:
    policy_version = _text(value.get("policy_version"), "policy.policy_version")
    edition = _object(value.get("edition"), "policy.edition")
    title = _text(edition.get("title"), "policy.edition.title")
    tagline = _text(edition.get("tagline"), "policy.edition.tagline")
    home = _text(edition.get("home_location"), "policy.edition.home_location")
    lead_desk = _text(edition.get("lead_desk"), "policy.edition.lead_desk")
    desks_raw = _array(value.get("desks"), "policy.desks", minimum=1)
    desks: list[dict[str, str]] = []
    for index, raw in enumerate(desks_raw):
        item = _object(raw, f"policy.desks[{index}]")
        key = _text(item.get("key"), f"policy.desks[{index}].key")
        label = _text(item.get("label"), f"policy.desks[{index}].label")
        if not DESK_KEY.fullmatch(key):
            raise RenderError(f"policy.desks[{index}].key is invalid")
        desks.append({"key": key, "label": label})
    if len(desks) != len({item["key"] for item in desks}):
        raise RenderError("policy.desks contains duplicate keys")
    if lead_desk not in {item["key"] for item in desks}:
        raise RenderError("policy lead desk is missing from policy desks")
    return {
        "policy_version": policy_version,
        "title": title,
        "tagline": tagline,
        "home": home,
        "lead_desk": lead_desk,
        "desks": desks,
    }


def _render_lead(value: Any, lead_desk: str, registry: SourceRegistry) -> str:
    lead = _object(value, "edition.lead")
    _keys(
        lead,
        {"headline", "dek", "verdict", "paragraphs", "snapshot", "source"},
        "edition.lead",
    )
    headline = _text(lead.get("headline"), "edition.lead.headline")
    dek = _text(lead.get("dek"), "edition.lead.dek")
    verdict = _object(lead.get("verdict"), "edition.lead.verdict")
    _keys(verdict, {"label", "tone"}, "edition.lead.verdict")
    verdict_label = _text(verdict.get("label"), "edition.lead.verdict.label")
    verdict_tone = _text(verdict.get("tone"), "edition.lead.verdict.tone")
    if verdict_tone not in VERDICT_TONES:
        raise RenderError("edition.lead.verdict.tone must be stable, watch, or urgent")
    paragraphs_raw = _array(
        lead.get("paragraphs"), "edition.lead.paragraphs", minimum=1, maximum=2
    )
    paragraphs = [
        _text(item, f"edition.lead.paragraphs[{index}]")
        for index, item in enumerate(paragraphs_raw)
    ]
    if _words(paragraphs) > 220:
        raise RenderError("edition.lead.paragraphs exceeds the 220-word opening budget")
    source = _source(lead.get("source"), "edition.lead.source")
    registry.add(source)
    snapshot = ""
    if lead.get("snapshot") is not None:
        item = _object(lead.get("snapshot"), "edition.lead.snapshot")
        _keys(item, {"columns", "rows"}, "edition.lead.snapshot")
        snapshot = _table(
            item.get("columns"),
            item.get("rows"),
            "edition.lead.snapshot",
            maximum_rows=5,
        )
    paragraphs_html = "".join(f"<p>{escape(item)}</p>" for item in paragraphs)
    return (
        f'<article class="lead-story" data-story data-lead-story data-layout-slot="lead" '
        f'data-desk-key="{escape(lead_desk, quote=True)}"{_source_attrs(source)}>'
        f'<h2>{escape(headline)}</h2><p class="dek">{escape(dek)}</p>'
        f'<p><span class="verdict verdict-{escape(verdict_tone, quote=True)}">{escape(verdict_label)}</span></p>'
        f'<div class="lead-copy">{paragraphs_html}</div>{snapshot}</article>'
    )


def _render_day_ahead(value: Any, registry: SourceRegistry) -> tuple[str, str]:
    day_ahead = _object(value, "edition.day_ahead")
    _keys(day_ahead, {"weather", "email_calendar"}, "edition.day_ahead")
    weather = _object(day_ahead.get("weather"), "edition.day_ahead.weather")
    _keys(
        weather,
        {"status", "title", "rows", "note", "source"},
        "edition.day_ahead.weather",
    )
    weather_status = _text(weather.get("status"), "edition.day_ahead.weather.status")
    if weather_status not in {"covered", "unavailable"}:
        raise RenderError(
            "edition.day_ahead.weather.status must be covered or unavailable"
        )
    weather_title = _text(weather.get("title"), "edition.day_ahead.weather.title")
    weather_note = _text(weather.get("note"), "edition.day_ahead.weather.note")
    weather_attrs = ""
    weather_body: str
    if weather_status == "covered":
        source = _source(weather.get("source"), "edition.day_ahead.weather.source")
        registry.add(source)
        weather_attrs = _source_attrs(source)
        rows = _array(
            weather.get("rows"), "edition.day_ahead.weather.rows", minimum=4, maximum=4
        )
        rendered_rows: list[list[str]] = []
        expected = {"day", "conditions", "high", "low", "wind", "precip"}
        for index, raw in enumerate(rows):
            row = _object(raw, f"edition.day_ahead.weather.rows[{index}]")
            _keys(row, expected, f"edition.day_ahead.weather.rows[{index}]")
            rendered_rows.append(
                [
                    _text(
                        row.get(key),
                        f"edition.day_ahead.weather.rows[{index}].{key}",
                        allow_empty=True,
                    )
                    for key in ("day", "conditions", "high", "low", "wind", "precip")
                ]
            )
        weather_body = _table(
            ["Day", "Conditions", "High", "Low", "Wind", "Precip"],
            rendered_rows,
            "edition.day_ahead.weather",
            maximum_rows=4,
        )
    else:
        if weather.get("source") is not None:
            source = _source(weather.get("source"), "edition.day_ahead.weather.source")
            registry.add(source)
            weather_attrs = _source_attrs(source)
        if _array(weather.get("rows"), "edition.day_ahead.weather.rows", maximum=0):
            raise RenderError("unavailable weather must not contain rows")
        weather_body = '<p class="status status-unavailable">Unavailable</p>'
    weather_html = (
        f'<section class="day-ahead-section" id="weather"{weather_attrs}>'
        f"<h2>{escape(weather_title)}</h2>{weather_body}<p>{escape(weather_note)}</p></section>"
    )

    personal = _object(
        day_ahead.get("email_calendar"), "edition.day_ahead.email_calendar"
    )
    _keys(
        personal,
        {"status", "agenda", "actions", "lookahead", "source"},
        "edition.day_ahead.email_calendar",
    )
    personal_status = _text(
        personal.get("status"), "edition.day_ahead.email_calendar.status"
    )
    if personal_status not in {"covered", "unavailable"}:
        raise RenderError(
            "edition.day_ahead.email_calendar.status must be covered or unavailable"
        )
    personal_attrs = ""
    if personal.get("source") is not None:
        source = _source(
            personal.get("source"), "edition.day_ahead.email_calendar.source"
        )
        registry.add(source)
        personal_attrs = _source_attrs(source)
    elif personal_status == "covered":
        raise RenderError("covered email and calendar needs a source")
    agenda_raw = _array(
        personal.get("agenda"), "edition.day_ahead.email_calendar.agenda", maximum=20
    )
    actions_raw = _array(
        personal.get("actions"), "edition.day_ahead.email_calendar.actions", maximum=20
    )
    lookahead_raw = _array(
        personal.get("lookahead"),
        "edition.day_ahead.email_calendar.lookahead",
        maximum=20,
    )
    agenda: list[dict[str, str]] = []
    for index, raw in enumerate(agenda_raw):
        item = _object(raw, f"edition.day_ahead.email_calendar.agenda[{index}]")
        _keys(
            item,
            {"time", "event", "location"},
            f"edition.day_ahead.email_calendar.agenda[{index}]",
        )
        agenda.append(
            {
                key: _text(
                    item.get(key),
                    f"edition.day_ahead.email_calendar.agenda[{index}].{key}",
                    allow_empty=key == "location",
                )
                for key in ("time", "event", "location")
            }
        )
    actions: list[dict[str, str]] = []
    for index, raw in enumerate(actions_raw):
        item = _object(raw, f"edition.day_ahead.email_calendar.actions[{index}]")
        _keys(
            item,
            {"title", "body"},
            f"edition.day_ahead.email_calendar.actions[{index}]",
        )
        actions.append(
            {
                "title": _text(
                    item.get("title"),
                    f"edition.day_ahead.email_calendar.actions[{index}].title",
                ),
                "body": _text(
                    item.get("body"),
                    f"edition.day_ahead.email_calendar.actions[{index}].body",
                ),
            }
        )
    lookahead = [
        _text(item, f"edition.day_ahead.email_calendar.lookahead[{index}]")
        for index, item in enumerate(lookahead_raw)
    ]

    def agenda_table(items: list[dict[str, str]]) -> str:
        if not items:
            return "<p>No scheduled items.</p>"
        return _table(
            ["Time", "Event", "Location"],
            [[item["time"], item["event"], item["location"]] for item in items],
            "edition.day_ahead.email_calendar.agenda",
        )

    def actions_html(items: list[dict[str, str]]) -> str:
        if not items:
            return "<p>No action-needed mail.</p>"
        return "".join(
            f'<div class="brief"><h4>{escape(item["title"])}</h4><p>{escape(item["body"])}</p></div>'
            for item in items
        )

    if personal_status == "unavailable":
        personal_body = '<p class="status status-unavailable">Unavailable</p>'
    else:
        personal_body = (
            f"<h3>Today’s agenda</h3>{agenda_table(agenda[:4])}"
            f"<h3>Action needed</h3>{actions_html(actions[:2])}"
        )
    personal_html = (
        f'<section class="day-ahead-section" id="email-calendar"{personal_attrs}>'
        f"<h2>Email &amp; Calendar</h2>{personal_body}</section>"
    )

    overflow: list[str] = []
    if agenda[4:]:
        overflow.append(
            f"<div><h3>More on today’s agenda</h3>{agenda_table(agenda[4:])}</div>"
        )
    if actions[2:]:
        overflow.append(
            f"<div><h3>More action-needed mail</h3>{actions_html(actions[2:])}</div>"
        )
    if lookahead:
        items = "".join(f"<li>{escape(item)}</li>" for item in lookahead)
        overflow.append(
            f'<div><h3>Three-day look-ahead</h3><ul class="story-list">{items}</ul></div>'
        )
    continuation = ""
    if overflow:
        continuation = (
            '<section class="continuation" id="day-ahead-continuation" '
            'aria-labelledby="day-ahead-continuation-heading">'
            '<h2 id="day-ahead-continuation-heading">The Day Ahead</h2>'
            f'<div class="day-ahead-continuation-grid">{"".join(overflow)}</div></section>'
        )
    return weather_html + personal_html, continuation


def _render_operations(value: Any, registry: SourceRegistry) -> str:
    modules = _array(value, "edition.operations_details", minimum=1, maximum=8)
    rendered: list[str] = []
    for index, raw in enumerate(modules):
        path = f"edition.operations_details[{index}]"
        item = _object(raw, path)
        _keys(item, {"title", "source", "blocks"}, path)
        title = _text(item.get("title"), f"{path}.title")
        source = _source(item.get("source"), f"{path}.source")
        registry.add(source)
        blocks = _render_blocks(item.get("blocks"), f"{path}.blocks", registry)
        rendered.append(
            f'<div class="report-block"{_source_attrs(source)}><h3>{escape(title)}</h3>{blocks}</div>'
        )
    return (
        '<section class="continuation" id="operations-continuation" data-lead-continuation '
        'aria-labelledby="operations-continuation-heading">'
        '<h2 id="operations-continuation-heading">Operations Briefing</h2>'
        f'<div class="operations-flow">{"".join(rendered)}</div></section>'
    )


def _render_departments(
    value: Any, registry: SourceRegistry
) -> tuple[str, list[tuple[str, str]]]:
    departments = _array(value, "edition.departments", maximum=20)
    rendered: list[str] = []
    navigation: list[tuple[str, str]] = []
    seen: set[str] = set()
    for index, raw in enumerate(departments):
        path = f"edition.departments[{index}]"
        department = _object(raw, path)
        _keys(department, {"desk_key", "title", "stories"}, path)
        key = _text(department.get("desk_key"), f"{path}.desk_key")
        if not DESK_KEY.fullmatch(key):
            raise RenderError(f"{path}.desk_key is invalid")
        if key in seen:
            raise RenderError(f"edition.departments contains duplicate desk key {key}")
        seen.add(key)
        title = _text(department.get("title"), f"{path}.title")
        stories_raw = _array(
            department.get("stories"), f"{path}.stories", minimum=1, maximum=8
        )
        stories: list[str] = []
        for story_index, raw_story in enumerate(stories_raw):
            story_path = f"{path}.stories[{story_index}]"
            story = _object(raw_story, story_path)
            _keys(story, {"headline", "dek", "source", "blocks"}, story_path)
            headline = _text(story.get("headline"), f"{story_path}.headline")
            dek = _optional_text(story.get("dek"), f"{story_path}.dek")
            source = _source(story.get("source"), f"{story_path}.source")
            registry.add(source)
            body = _render_blocks(story.get("blocks"), f"{story_path}.blocks", registry)
            dek_html = f'<p class="dek">{escape(dek)}</p>' if dek else ""
            stories.append(
                f'<article class="department-story" data-story data-desk-key="{escape(key, quote=True)}"'
                f"{_source_attrs(source)}><h3>{escape(headline)}</h3>{dek_html}"
                f'<div class="story-body">{body}</div></article>'
            )
        rendered.append(
            f'<section class="department" data-department="{escape(key, quote=True)}" id="{escape(key, quote=True)}" '
            f'aria-labelledby="{escape(key, quote=True)}-heading"><h2 id="{escape(key, quote=True)}-heading">'
            f'{escape(title)}</h2><div class="department-stories">{"".join(stories)}</div></section>'
        )
        navigation.append((key, title))
    return "\n".join(rendered), navigation


def _render_coverage(
    value: Any,
    policy: dict[str, Any],
    registry: SourceRegistry,
) -> tuple[str, dict[str, Any], dict[str, str]]:
    items = _array(value, "edition.coverage", minimum=len(policy["desks"]), maximum=40)
    policy_labels = {item["key"]: item["label"] for item in policy["desks"]}
    rendered: list[str] = []
    manifest_desks: list[dict[str, str]] = []
    statuses: dict[str, str] = {}
    for index, raw in enumerate(items):
        path = f"edition.coverage[{index}]"
        item = _object(raw, path)
        _keys(item, {"desk_key", "label", "status", "explanation", "source"}, path)
        key = _text(item.get("desk_key"), f"{path}.desk_key")
        if not DESK_KEY.fullmatch(key):
            raise RenderError(f"{path}.desk_key is invalid")
        if key in statuses:
            raise RenderError(f"edition.coverage contains duplicate desk key {key}")
        label = _text(item.get("label"), f"{path}.label")
        if key in policy_labels and label != policy_labels[key]:
            raise RenderError(f"{path}.label must match the edition policy")
        status = _text(item.get("status"), f"{path}.status")
        if status not in STATUSES:
            raise RenderError(f"{path}.status must be covered, quiet, or unavailable")
        explanation = _text(item.get("explanation"), f"{path}.explanation")
        attrs = ""
        if item.get("source") is not None:
            source = _source(item.get("source"), f"{path}.source")
            registry.add(source)
            attrs = _source_attrs(source)
        elif status == "covered":
            raise RenderError(f"{path}.source is required when status is covered")
        statuses[key] = status
        manifest_desks.append({"key": key, "label": label})
        rendered.append(
            f'<li data-desk-key="{escape(key, quote=True)}" data-coverage-status="{escape(status, quote=True)}"{attrs}>'
            f"<strong>{escape(label)}</strong><span>{escape(explanation)}</span>"
            f'<span class="status status-{escape(status, quote=True)}">{escape(status)}</span></li>'
        )
    missing = sorted(set(policy_labels) - set(statuses))
    if missing:
        raise RenderError(
            f"edition.coverage omits policy desk(s): {', '.join(missing)}"
        )
    manifest = {
        "policy_version": policy["policy_version"],
        "lead_desk": policy["lead_desk"],
        "desks": manifest_desks,
    }
    return "\n".join(rendered), manifest, statuses


def render_daybook(
    edition_value: dict[str, Any],
    policy_value: dict[str, Any],
    template: str,
) -> tuple[str, dict[str, Any], dict[str, int]]:
    policy = _load_policy(policy_value)
    edition = _object(edition_value, "edition")
    _keys(
        edition,
        {
            "format",
            "policy_version",
            "generated_at",
            "description",
            "lead",
            "day_ahead",
            "operations_details",
            "departments",
            "editors_note",
            "coverage",
        },
        "edition",
    )
    if _text(edition.get("format"), "edition.format") != FORMAT_VERSION:
        raise RenderError(f"edition.format must be {FORMAT_VERSION}")
    if (
        _text(edition.get("policy_version"), "edition.policy_version")
        != policy["policy_version"]
    ):
        raise RenderError("edition.policy_version must match the edition policy")
    generated = _object(edition.get("generated_at"), "edition.generated_at")
    _keys(generated, {"iso", "display", "issue_label"}, "edition.generated_at")
    generated_iso = _text(generated.get("iso"), "edition.generated_at.iso")
    try:
        generated_timestamp = datetime.fromisoformat(
            generated_iso.replace("Z", "+00:00")
        )
    except ValueError as exc:
        raise RenderError(
            "edition.generated_at.iso must be an ISO 8601 timestamp"
        ) from exc
    if generated_timestamp.tzinfo is None:
        raise RenderError("edition.generated_at.iso must include a UTC offset")
    generated_display = _text(generated.get("display"), "edition.generated_at.display")
    issue_label = _text(
        generated.get("issue_label"), "edition.generated_at.issue_label"
    )
    description = _text(edition.get("description"), "edition.description")
    editors_note = _text(edition.get("editors_note"), "edition.editors_note")

    registry = SourceRegistry()
    lead_html = _render_lead(edition.get("lead"), policy["lead_desk"], registry)
    day_ahead_html, day_ahead_continuation = _render_day_ahead(
        edition.get("day_ahead"), registry
    )
    operations_html = _render_operations(edition.get("operations_details"), registry)
    departments_html, navigation = _render_departments(
        edition.get("departments"), registry
    )
    coverage_html, manifest, statuses = _render_coverage(
        edition.get("coverage"), policy, registry
    )

    if statuses.get(policy["lead_desk"]) not in {"covered", "unavailable"}:
        raise RenderError("the policy lead desk must be covered or unavailable")
    if statuses.get("weather") != _text(
        _object(edition["day_ahead"]["weather"], "edition.day_ahead.weather").get(
            "status"
        ),
        "edition.day_ahead.weather.status",
    ):
        raise RenderError("weather coverage status must match day_ahead.weather.status")
    if statuses.get("email-calendar") != _text(
        _object(
            edition["day_ahead"]["email_calendar"], "edition.day_ahead.email_calendar"
        ).get("status"),
        "edition.day_ahead.email_calendar.status",
    ):
        raise RenderError(
            "email-calendar coverage status must match day_ahead.email_calendar.status"
        )
    for key, _ in navigation:
        if statuses.get(key) != "covered":
            raise RenderError(f"department {key} must have covered status")

    rail_items = [
        ("operations-continuation", "Operations"),
        (
            "day-ahead-continuation" if day_ahead_continuation else "weather",
            "The Day Ahead",
        ),
    ]
    rail_items.extend(navigation)
    department_rail = "\n".join(
        f'<a href="#{escape(anchor, quote=True)}">{escape(label)}</a>'
        for anchor, label in rail_items
    )
    strap = (
        f'<time datetime="{escape(generated_iso, quote=True)}">{escape(generated_display)}</time>'
        f"<span>{escape(issue_label)}</span>"
    )
    footer = f'{policy["title"]} · {issue_label} · {policy["home"]}'
    replacements = {
        "@@POLICY_VERSION@@": escape(policy["policy_version"], quote=True),
        "@@DESCRIPTION@@": escape(description, quote=True),
        "@@TITLE@@": escape(policy["title"]),
        "@@TAGLINE@@": escape(policy["tagline"]),
        "@@EDITION_STRAP@@": strap,
        "@@DEPARTMENT_RAIL@@": department_rail,
        "@@LEAD_STORY@@": lead_html,
        "@@DAY_AHEAD@@": day_ahead_html,
        "@@DAY_AHEAD_CONTINUATION@@": day_ahead_continuation,
        "@@OPERATIONS_CONTINUATION@@": operations_html,
        "@@DEPARTMENTS@@": departments_html,
        "@@EDITORS_NOTE@@": escape(editors_note),
        "@@COVERAGE@@": coverage_html,
        "@@SOURCES@@": registry.render(),
        "@@FOOTER@@": escape(footer),
    }
    document = template
    for token, replacement in replacements.items():
        if document.count(token) == 0:
            raise RenderError(f"template is missing required token {token}")
        document = document.replace(token, replacement)
    leftovers = sorted(set(SENTINEL.findall(document)))
    if leftovers:
        raise RenderError(
            f"rendered document contains unresolved token(s): {', '.join(leftovers)}"
        )
    if f'data-daybook-version="{DAYBOOK_VERSION}"' not in document:
        raise RenderError("template has the wrong daybook version")
    if f'data-template-version="{TEMPLATE_VERSION}"' not in document:
        raise RenderError("template has the wrong template version")
    visible_document = re.sub(
        r"<(?:style|script)\b[^>]*>.*?</(?:style|script)>",
        " ",
        document,
        flags=re.DOTALL | re.IGNORECASE,
    )
    metrics = {
        "coverage_items": len(manifest["desks"]),
        "departments": len(navigation),
        "sources": registry.count,
        "words": _words([re.sub(r"<[^>]+>", " ", visible_document)]),
    }
    return document.rstrip() + "\n", manifest, metrics


def main(argv: list[str]) -> int:
    if len(argv) != 6:
        print(
            json.dumps(
                {
                    "passed": False,
                    "errors": [
                        "usage: render_daybook.py EDITION_JSON EDITION_POLICY_JSON "
                        "TEMPLATE_HTML OUTPUT_HTML COVERAGE_JSON"
                    ],
                }
            )
        )
        return 2
    try:
        edition = _read_json(Path(argv[1]), "edition JSON")
        policy = _read_json(Path(argv[2]), "edition policy")
        template = Path(argv[3]).read_text(encoding="utf-8")
        document, manifest, metrics = render_daybook(edition, policy, template)
        Path(argv[4]).write_text(document, encoding="utf-8")
        Path(argv[5]).write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    except (OSError, UnicodeError, RenderError) as exc:
        print(
            json.dumps(
                {"passed": False, "errors": [str(exc)]}, indent=2, sort_keys=True
            )
        )
        return 1
    print(
        json.dumps(
            {"passed": True, "errors": [], "metrics": metrics}, indent=2, sort_keys=True
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
