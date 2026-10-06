"""Feed de-duplication for the autonomous worker.

The worker runs on a schedule, so the agent keeps re-discovering the same
durable signal (e.g. "NVIDIA announced a new GPU") on every cycle and, without
guardrails, re-emits it to the feed each time. This module provides:

* ``dedupe_feed_items`` — a deterministic safety net that classifies newly
  produced feed items as redundant repeats, material updates to a prior thread,
  or fresh findings.
* ``summarize_recent_feed`` — a compact digest of what was recently surfaced,
  fed back into the prompt so the agent avoids the redundant research entirely.

Everything here is a pure function (no Redis, no clock) so it is unit-testable
against the builder mock harness — callers pass ``now``/``window_ms`` in.
"""

from __future__ import annotations

import hashlib
import re
import time
from typing import Any, Literal
from urllib.parse import parse_qsl, urlsplit, urlunsplit

# Wording overlap can reject a repeat, but low overlap is not evidence of news.
# Repeated sources/threads also need an explicit prior item and a sourced change.
TITLE_SIMILARITY = 0.6
CONTENT_SIMILARITY = 0.5

DEFAULT_WINDOW_DAYS = 14
MIN_WINDOW_DAYS = 1
MAX_WINDOW_DAYS = 90

# Query params that identify a tracking/campaign decoration rather than the
# resource itself — stripped before comparing URLs.
_TRACKING_PARAM_RE = re.compile(r"^(utm_|mc_|mkt_|ga_|_hs|hsa_)", re.IGNORECASE)
_TRACKING_PARAMS = {
    "fbclid",
    "gclid",
    "gclsrc",
    "dclid",
    "msclkid",
    "igshid",
    "ref",
    "ref_src",
    "ref_url",
    "source",
    "spm",
    "cmpid",
    "campaign",
    "yclid",
    "_ga",
}

_WORD_RE = re.compile(r"[a-z0-9]+")
_MS_PER_DAY = 86_400_000
FeedClassification = Literal["duplicate", "linked_update", "fresh"]


def normalize_url(raw: str | None) -> str:
    """Canonicalize a URL for equality comparison.

    Lowercases scheme/host, drops ``www.``, a default port, the fragment, and
    tracking query params, and trims a trailing slash from the path. Returns an
    empty string for falsy/unparseable input so callers can treat "no URL" as
    "no URL match".
    """

    if not raw or not isinstance(raw, str):
        return ""
    text = raw.strip()
    if not text:
        return ""
    # Accept our own canonical output ("//example.com/x") on later runs as
    # well as scheme-less URLs ("example.com/x").
    if text.startswith("//"):
        text = f"https:{text}"
    elif "://" not in text:
        text = f"https://{text}"
    try:
        parts = urlsplit(text)
    except ValueError:
        return ""
    if not parts.netloc:
        return ""

    host = (parts.hostname or "").lower()
    # Reject arbitrary text that merely lacked a scheme ("not a url"): a real
    # host has no whitespace and is either dotted or bare localhost.
    if not host or any(ch.isspace() for ch in host):
        return ""
    if host != "localhost" and "." not in host:
        return ""
    if host.startswith("www."):
        host = host[4:]
    # Preserve a non-default port if one was given.
    if parts.port and parts.port not in (80, 443):
        host = f"{host}:{parts.port}"

    path = parts.path.rstrip("/")

    kept_query = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if k.lower() not in _TRACKING_PARAMS and not _TRACKING_PARAM_RE.match(k)
    ]
    kept_query.sort()
    query = "&".join(f"{k}={v}" for k, v in kept_query)

    return urlunsplit(("", host, path, query, ""))


def url_domain(raw: str | None) -> str:
    """Return the bare normalized host for a URL (for compact digests)."""

    normalized = normalize_url(raw)
    if not normalized:
        return ""
    # normalize_url returns "//host/path?..."; strip the leading slashes.
    host = normalized.lstrip("/")
    return host.split("/", 1)[0]


def normalize_text(raw: str | None) -> str:
    """Lowercase, drop punctuation, and collapse whitespace for comparison."""

    if not raw or not isinstance(raw, str):
        return ""
    lowered = raw.lower()
    return " ".join(_WORD_RE.findall(lowered))


def _tokens(raw: str | None) -> frozenset[str]:
    return frozenset(_WORD_RE.findall((raw or "").lower()))


def jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    """Token-set Jaccard similarity in [0, 1]; 0 when either side is empty."""

    if not a or not b:
        return 0.0
    intersection = len(a & b)
    if not intersection:
        return 0.0
    return intersection / len(a | b)


def _item_text(item: dict[str, Any], *keys: str) -> str:
    parts = [str(item.get(key) or "") for key in keys]
    return " ".join(part for part in parts if part)


def _source_url(item: dict[str, Any]) -> str:
    return str(item.get("sourceUrl") or item.get("source_url") or "").strip()


def normalize_thread_key(raw: Any) -> str:
    """Normalize model and already-stamped store keys identically."""

    if not isinstance(raw, str):
        return ""
    text = raw.strip()
    if not text:
        return ""
    if text.startswith("url:"):
        normalized_url = normalize_url(text[4:])
        return f"url:{normalized_url}" if normalized_url else ""
    # stamp_feed_item persists this namespace. Strip it before normalizing so
    # reading or re-stamping an existing key cannot add another "thread" token.
    # Only the explicit namespace is special: "thread safety" is a valid topic.
    if text.startswith("thread:"):
        text = text[len("thread:") :]
    normalized = normalize_text(text)
    return f"thread:{normalized}" if normalized else ""


def feed_thread_key(item: dict[str, Any]) -> str:
    """Return the stable thread key for a feed item, deriving it when needed.

    Newer items may carry ``threadKey`` directly. Older URL-backed feed entries
    are still matchable because their normalized source URL becomes the derived
    thread key. Text-only items intentionally do not get a derived key here:
    fuzzy text suppression remains bounded by the configured recency window.
    """

    explicit = normalize_thread_key(item.get("threadKey") or item.get("thread_key"))
    if explicit:
        return explicit
    fingerprint = str(item.get("fingerprint") or "").strip()
    if fingerprint.startswith("url:"):
        return fingerprint
    url = normalize_url(_source_url(item))
    return f"url:{url}" if url else ""


def _similarities(
    candidate: dict[str, Any],
    existing: dict[str, Any],
) -> tuple[float, float]:
    return (
        jaccard(_tokens(candidate.get("title")), _tokens(existing.get("title"))),
        jaccard(
            _tokens(_item_text(candidate, "bluf", "body")),
            _tokens(_item_text(existing, "bluf", "body")),
        ),
    )


def _same_thread(candidate: dict[str, Any], existing: dict[str, Any]) -> bool:
    candidate_thread = feed_thread_key(candidate)
    existing_thread = feed_thread_key(existing)
    if not candidate_thread or not existing_thread:
        return False
    if candidate_thread == existing_thread:
        return True
    if not all(
        key.startswith("thread:") for key in (candidate_thread, existing_thread)
    ):
        return False
    # Appending an angle ("benchmark claim") to an event key is still the same
    # story. Preserve distinct versions, dates, and numbered events, including
    # a patch release appended to a version key.
    candidate_parts = candidate_thread.removeprefix("thread:").split()
    existing_parts = existing_thread.removeprefix("thread:").split()
    shorter, longer = sorted((candidate_parts, existing_parts), key=len)
    return (
        len(shorter) >= 3
        and longer[: len(shorter)] == shorter
        and [part for part in shorter if any(char.isdigit() for char in part)]
        == [part for part in longer if any(char.isdigit() for char in part)]
    )


def _update_target(item: dict[str, Any]) -> str:
    return str(item.get("updateOfFeedItemId") or item.get("update_of") or "").strip()


def _change_summary(item: dict[str, Any]) -> str:
    return str(item.get("changeSummary") or item.get("change_summary") or "").strip()


def _has_update_details(item: dict[str, Any]) -> bool:
    """Require reviewable change details; an update flag alone proves nothing.

    This is a publication contract, not semantic verification of a source. The
    research step must verify the change; lexical distance cannot do that.
    """

    return bool(
        (item.get("isUpdate") is True or item.get("is_update") is True)
        and _update_target(item)
        and len(normalize_text(_change_summary(item))) >= 20
        and normalize_url(_source_url(item))
    )


def _same_source(candidate: dict[str, Any], existing: dict[str, Any]) -> bool:
    candidate_url = normalize_url(_source_url(candidate))
    existing_url = normalize_url(_source_url(existing))
    return bool(candidate_url and existing_url and candidate_url == existing_url)


def feed_fingerprint(item: dict[str, Any]) -> str:
    """Stable content fingerprint for a feed item.

    URL-backed items fingerprint on the normalized URL (so the same source
    collapses regardless of wording); URL-less items fingerprint on a hash of
    the normalized title + body.
    """

    url = normalize_url(_source_url(item))
    if url:
        return f"url:{url}"
    basis = normalize_text(_item_text(item, "title", "bluf", "body"))
    digest = hashlib.sha1(basis.encode("utf-8"), usedforsecurity=False).hexdigest()[:16]
    return f"txt:{digest}"


def is_duplicate(candidate: dict[str, Any], existing: dict[str, Any]) -> bool:
    """True when ``candidate`` is a redundant re-report of ``existing``.

    A known source/thread needs explicit change details. Even then, overlapping
    content or a repeated change summary is redundant. A stable title alone is
    allowed for a documented change on recurring status pages or weekly reports.

    Different or missing URLs: redundant only when BOTH the title and the body
    overlap, so distinct findings — and same-title/different-body fallbacks —
    stay separate.
    """

    title_sim, content_sim = _similarities(candidate, existing)

    if (
        _same_source(candidate, existing)
        or _same_thread(candidate, existing)
        or (
            _update_target(candidate)
            and _update_target(candidate) == existing.get("id")
        )
    ):
        return (
            not _has_update_details(candidate)
            or content_sim >= CONTENT_SIMILARITY
            or bool(
                _change_summary(candidate)
                and normalize_text(_change_summary(candidate))
                == normalize_text(_change_summary(existing))
            )
        )
    return title_sim >= TITLE_SIMILARITY and content_sim >= CONTENT_SIMILARITY


def classify_feed_item(
    candidate: dict[str, Any],
    existing_items: list[dict[str, Any]],
    *,
    now: int,
    window_ms: int = DEFAULT_WINDOW_DAYS * _MS_PER_DAY,
) -> tuple[FeedClassification, dict[str, Any] | None, str]:
    """Classify one candidate against retained feed history.

    Source/thread matches are checked against the full retained history,
    regardless of the recency window. Fuzzy duplicate/update matching stays
    bounded by ``window_ms``. Check all duplicates before accepting an update:
    an older announcement cannot excuse repeating a newer follow-up.
    """

    if not isinstance(candidate, dict):
        return "duplicate", None, "Invalid feed item."

    valid_existing = [item for item in existing_items if isinstance(item, dict)]

    target = None
    target_id = _update_target(candidate)
    for existing in valid_existing:
        if target_id and target_id == existing.get("id"):
            target = existing
        related = (
            _same_source(candidate, existing)
            or _same_thread(candidate, existing)
            or (target_id and target_id == existing.get("id"))
        )
        if related or _within_window(existing, now=now, window_ms=window_ms):
            if is_duplicate(candidate, existing):
                return "duplicate", existing, "Repeated finding or undocumented change."

    if (
        candidate.get("isUpdate") is True
        or candidate.get("is_update") is True
        or target_id
        or _change_summary(candidate)
    ):
        if target is None or not _has_update_details(candidate):
            return (
                "duplicate",
                target,
                "Update needs a retained prior item and sourced change.",
            )
        return "linked_update", target, _change_summary(candidate)

    return "fresh", None, ""


def stamp_feed_item(
    item: dict[str, Any],
    *,
    update_of: dict[str, Any] | None = None,
    update_reason: str = "",
) -> dict[str, Any]:
    """Stamp a kept item with deterministic observability/linkage fields."""

    thread_key = feed_thread_key(update_of or {}) or feed_thread_key(item)
    if thread_key:
        item["threadKey"] = thread_key
    item.setdefault("fingerprint", feed_fingerprint(item))
    if update_of:
        update_id = str(update_of.get("id") or "").strip()
        update_title = str(update_of.get("title") or "").strip()
        if update_id:
            item["updateOfFeedItemId"] = update_id
        if update_title:
            item["updateOfTitle"] = update_title
        if update_reason:
            item["updateReason"] = update_reason
    return item


def window_ms_for_days(
    days: Any,
    *,
    default: int = DEFAULT_WINDOW_DAYS,
    minimum: int = MIN_WINDOW_DAYS,
    maximum: int = MAX_WINDOW_DAYS,
) -> int:
    """Clamp a configured window (in days) to a sane range and return millis.

    Defends the worker against direct/legacy Redis writes that bypass the
    frontend sanitizer: non-numeric or non-positive values fall back to the
    default; everything is clamped to ``[minimum, maximum]`` days. Disabling
    dedup is done via ``feedDedupeEnabled``, not a zero window.
    """

    try:
        value = int(days)
    except (TypeError, ValueError):
        value = default
    if value <= 0:
        value = default
    return max(minimum, min(maximum, value)) * _MS_PER_DAY


def _within_window(item: dict[str, Any], *, now: int, window_ms: int) -> bool:
    if window_ms <= 0:
        return True
    created = item.get("createdAt")
    if not isinstance(created, (int, float)):
        # Undated entries have unknown age; do not let them suppress forever —
        # treat them as outside the window. (All worker-written items are dated.)
        return False
    return (now - int(created)) <= window_ms


def dedupe_feed_items(
    new_items: list[dict[str, Any]],
    existing_items: list[dict[str, Any]],
    *,
    now: int,
    window_ms: int = DEFAULT_WINDOW_DAYS * _MS_PER_DAY,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split ``new_items`` into (kept, dropped).

    An item is dropped when it duplicates either retained feed history, a
    recently surfaced fuzzy match, or an already-kept item from the same batch.
    Material changes to an existing source/thread are kept as linked updates.
    Kept items are stamped with ``fingerprint`` and, when available,
    ``threadKey`` for downstream observability. Order is preserved.
    """

    kept: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []

    for candidate in new_items:
        if not isinstance(candidate, dict):
            continue
        classification, matched, reason = classify_feed_item(
            candidate,
            kept + existing_items,
            now=now,
            window_ms=window_ms,
        )
        if classification == "duplicate":
            dropped.append(candidate)
            continue
        if classification == "linked_update":
            stamp_feed_item(candidate, update_of=matched, update_reason=reason)
        else:
            stamp_feed_item(candidate)
        kept.append(candidate)

    return kept, dropped


def _format_day(created: Any) -> str:
    if not isinstance(created, (int, float)):
        return "unknown"
    try:
        return time.strftime("%Y-%m-%d", time.localtime(int(created) / 1000))
    except (OverflowError, OSError, ValueError):
        return "unknown"


def summarize_recent_feed(
    items: list[dict[str, Any]],
    *,
    now: int,
    window_ms: int = DEFAULT_WINDOW_DAYS * _MS_PER_DAY,
    limit: int = 60,
    title_chars: int = 120,
    bluf_chars: int = 180,
    source_chars: int = 80,
    thread_key_chars: int = 96,
    include_older: bool = False,
) -> list[dict[str, str]]:
    """Compact digest of recently surfaced items for the prompt.

    Returns at most ``limit`` rows, most recent first. ``include_older`` keeps
    retained coverage visible even after quiet weeks with no new cards; the
    recency window is a fuzzy-match policy, not permission to rediscover news.
    """

    digest: list[dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if not include_older and not _within_window(item, now=now, window_ms=window_ms):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        if len(title) > title_chars:
            title = f"{title[: title_chars - 1].rstrip()}…"
        bluf = str(item.get("bluf") or "").strip()
        if len(bluf) > bluf_chars:
            bluf = f"{bluf[: bluf_chars - 1].rstrip()}…"
        source = url_domain(item.get("sourceUrl") or item.get("source_url"))
        if len(source) > source_chars:
            source = f"{source[: source_chars - 1].rstrip()}…"
        thread_key = feed_thread_key(item)
        if len(thread_key) > thread_key_chars:
            thread_key = f"{thread_key[: thread_key_chars - 1].rstrip()}…"
        digest.append(
            {
                "id": str(item.get("id") or "")[:128],
                "date": _format_day(item.get("createdAt")),
                "title": title,
                "bluf": bluf,
                "source": source,
                "threadKey": thread_key,
            }
        )
        if len(digest) >= limit:
            break
    return digest
