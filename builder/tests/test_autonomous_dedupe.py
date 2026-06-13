"""Tests for autonomous feed de-duplication (redundant-feed guardrail)."""

from autonomous_agent.dedupe import (
    DEFAULT_WINDOW_DAYS,
    MAX_WINDOW_DAYS,
    classify_feed_item,
    dedupe_feed_items,
    feed_fingerprint,
    feed_thread_key,
    is_duplicate,
    normalize_url,
    summarize_recent_feed,
    url_domain,
    window_ms_for_days,
)

DAY_MS = 86_400_000
NOW = 1_700_000_000_000


def _item(**overrides):
    base = {
        "id": "feed_x",
        "title": "Title",
        "bluf": "A takeaway.",
        "body": "Some body text describing why it matters.",
        "sourceUrl": "",
        "createdAt": NOW,
    }
    base.update(overrides)
    return base


def test_normalize_url_strips_www_scheme_tracking_and_trailing_slash():
    a = normalize_url("https://www.NVIDIA.com/news/gpu/?utm_source=x&ref=y")
    b = normalize_url("http://nvidia.com/news/gpu")
    assert a == b
    assert "utm_source" not in a
    assert a.endswith("/news/gpu")


def test_normalize_url_keeps_meaningful_query_and_handles_scheme_less():
    assert normalize_url("example.com/a?id=7") == normalize_url(
        "https://example.com/a?id=7"
    )
    assert normalize_url("") == ""
    assert normalize_url(None) == ""
    assert normalize_url("not a url") == ""


def test_url_domain_returns_bare_host():
    assert url_domain("https://www.nvidia.com/news/gpu") == "nvidia.com"
    assert url_domain("") == ""


def test_is_duplicate_same_url_rereport_is_dropped():
    # Same source, re-summarized on a later cron cycle — the user's exact case.
    a = _item(
        title="NVIDIA announces Blackwell Ultra GPU",
        bluf="NVIDIA unveiled the Blackwell Ultra today.",
        body="It targets AI training.",
        sourceUrl="https://nvidia.com/x",
    )
    b = _item(
        title="NVIDIA announces Blackwell Ultra GPU",
        bluf="NVIDIA unveiled Blackwell Ultra today.",
        body="It targets AI training workloads.",
        sourceUrl="https://www.nvidia.com/x/",
    )
    assert is_duplicate(a, b)


def test_is_duplicate_same_url_material_update_is_kept():
    # Same source URL, but the wording has materially diverged (a genuine
    # follow-up) — it must NOT be suppressed.
    original = _item(
        title="NVIDIA announces Blackwell Ultra GPU",
        bluf="NVIDIA unveiled a new data center GPU today.",
        body="General availability is expected later this year.",
        sourceUrl="https://nvidia.com/x",
    )
    update = _item(
        title="Blackwell Ultra benchmarks published",
        bluf="Independent MLPerf results show 2x H100 throughput.",
        body="Numbers posted for both training and inference runs.",
        sourceUrl="https://nvidia.com/x",
    )
    assert not is_duplicate(update, original)


def test_is_duplicate_matches_cross_source_repeat_of_same_story():
    # Different URLs but the same story re-reported — caught only when BOTH the
    # title and body align, keeping the check conservative.
    a = _item(
        title="NVIDIA announces new Blackwell GPU",
        bluf="NVIDIA unveiled a new data center GPU today.",
        body="The chip targets AI training workloads.",
        sourceUrl="https://nvidia.com/x",
    )
    b = _item(
        title="NVIDIA announces new Blackwell GPU",
        bluf="NVIDIA unveiled a new data center GPU today.",
        body="The chip targets AI training workloads.",
        sourceUrl="https://theverge.com/nvidia-blackwell",
    )
    assert is_duplicate(a, b)


def test_is_duplicate_matches_paraphrase_without_url():
    a = _item(
        title="NVIDIA announces new Blackwell GPU",
        bluf="NVIDIA unveiled a new data center GPU today.",
        body="The chip targets AI training workloads.",
    )
    b = _item(
        title="NVIDIA unveils new Blackwell GPU",
        bluf="NVIDIA announced a new data center GPU today.",
        body="The chip targets AI training workloads at scale.",
    )
    assert is_duplicate(a, b)


def test_is_duplicate_keeps_genuinely_different_items():
    a = _item(
        title="NVIDIA announces new Blackwell GPU",
        bluf="A new data center GPU shipped.",
        body="Targets AI training.",
    )
    b = _item(
        title="AMD reports quarterly earnings beat",
        bluf="AMD revenue rose on server demand.",
        body="Data center segment grew.",
    )
    assert not is_duplicate(a, b)


def test_is_duplicate_keeps_same_title_different_body_fallbacks():
    # Two distinct unstructured fallbacks share a generic title but differ in
    # body — they must NOT collapse into one.
    a = _item(title="Autonomy Run Completed", bluf="", body="First error context.")
    b = _item(title="Autonomy Run Completed", bluf="", body="Totally separate issue.")
    assert not is_duplicate(a, b)


def test_dedupe_drops_repeat_of_recent_existing_item():
    existing = [
        _item(
            id="old",
            title="NVIDIA announces new GPU",
            sourceUrl="https://nvidia.com/gpu",
            createdAt=NOW - DAY_MS,
        )
    ]
    new = [
        _item(
            id="new",
            title="NVIDIA announces new GPU",
            sourceUrl="https://www.nvidia.com/gpu/",
        )
    ]
    kept, dropped = dedupe_feed_items(new, existing, now=NOW)
    assert kept == []
    assert len(dropped) == 1


def test_dedupe_drops_exact_url_repeat_even_when_prior_is_outside_window():
    existing = [
        _item(
            id="stale",
            title="NVIDIA announces new GPU",
            sourceUrl="https://nvidia.com/gpu",
            createdAt=NOW - 40 * DAY_MS,
        )
    ]
    new = [_item(id="fresh", sourceUrl="https://nvidia.com/gpu")]
    kept, dropped = dedupe_feed_items(new, existing, now=NOW, window_ms=14 * DAY_MS)
    assert kept == []
    assert [item["id"] for item in dropped] == ["fresh"]


def test_dedupe_keeps_material_same_source_update_as_linked_update():
    existing = [
        _item(
            id="old",
            title="NVIDIA announces Blackwell Ultra GPU",
            bluf="NVIDIA unveiled a new data center GPU.",
            body="General availability is expected later this year.",
            sourceUrl="https://nvidia.com/gpu",
            createdAt=NOW - 40 * DAY_MS,
        )
    ]
    new = [
        _item(
            id="update",
            title="Blackwell Ultra benchmarks published",
            bluf="MLPerf results now show 2x H100 throughput.",
            body="Numbers were posted for training and inference runs.",
            sourceUrl="https://nvidia.com/gpu",
        )
    ]
    kept, dropped = dedupe_feed_items(new, existing, now=NOW, window_ms=14 * DAY_MS)
    assert dropped == []
    assert [item["id"] for item in kept] == ["update"]
    assert kept[0]["threadKey"] == feed_thread_key(existing[0])
    assert kept[0]["updateOfFeedItemId"] == "old"
    assert kept[0]["updateOfTitle"] == "NVIDIA announces Blackwell Ultra GPU"
    assert "materially different" in kept[0]["updateReason"]


def test_dedupe_drops_repeated_material_update_within_same_batch():
    existing = [
        _item(
            id="old",
            title="NVIDIA announces Blackwell Ultra GPU",
            bluf="NVIDIA unveiled a new data center GPU.",
            body="General availability is expected later this year.",
            sourceUrl="https://nvidia.com/gpu",
            createdAt=NOW - 40 * DAY_MS,
        )
    ]
    update = _item(
        id="update-a",
        title="Blackwell Ultra benchmarks published",
        bluf="MLPerf results now show 2x H100 throughput.",
        body="Numbers were posted for training and inference runs.",
        sourceUrl="https://nvidia.com/gpu",
    )
    repeat = dict(update, id="update-b")

    kept, dropped = dedupe_feed_items(
        [update, repeat],
        existing,
        now=NOW,
        window_ms=14 * DAY_MS,
    )

    assert [item["id"] for item in kept] == ["update-a"]
    assert [item["id"] for item in dropped] == ["update-b"]


def test_dedupe_collapses_duplicates_within_the_same_batch():
    new = [
        _item(id="a", sourceUrl="https://nvidia.com/gpu"),
        _item(id="b", sourceUrl="https://www.nvidia.com/gpu/"),
        _item(id="c", title="Different", sourceUrl="https://amd.com/news"),
    ]
    kept, dropped = dedupe_feed_items(new, [], now=NOW)
    kept_ids = {item["id"] for item in kept}
    assert kept_ids == {"a", "c"}
    assert [item["id"] for item in dropped] == ["b"]


def test_dedupe_stamps_fingerprint_on_kept_items():
    new = [_item(sourceUrl="https://nvidia.com/gpu")]
    kept, _ = dedupe_feed_items(new, [], now=NOW)
    assert kept[0]["fingerprint"].startswith("url:")


def test_feed_fingerprint_url_vs_text():
    assert feed_fingerprint(_item(sourceUrl="https://nvidia.com/gpu")).startswith(
        "url:"
    )
    assert feed_fingerprint(_item(sourceUrl="")).startswith("txt:")


def test_summarize_recent_feed_shape_window_and_limit():
    # 50 recent items (spaced an hour apart, all inside the 14d window) — the
    # limit should cap the digest at 40.
    items = [
        _item(id=f"i{n}", title=f"Item {n}", createdAt=NOW - n * 3_600_000)
        for n in range(50)
    ]
    # One stale item outside the 14d window should be excluded.
    items.append(_item(id="stale", title="Stale", createdAt=NOW - 40 * DAY_MS))
    digest = summarize_recent_feed(items, now=NOW, window_ms=14 * DAY_MS, limit=40)
    assert len(digest) == 40
    assert all(
        set(row) == {"date", "title", "bluf", "source", "threadKey"} for row in digest
    )
    assert all(row["title"] != "Stale" for row in digest)


def test_summarize_recent_feed_truncates_long_titles_and_skips_untitled():
    long_title = "x" * 200
    items = [_item(title=long_title), _item(title="")]
    digest = summarize_recent_feed(items, now=NOW)
    assert len(digest) == 1
    assert digest[0]["title"].endswith("…")
    assert len(digest[0]["title"]) <= 120


def test_dedupe_undated_text_only_existing_item_does_not_suppress_forever():
    # An undated history entry has unknown age; it must not permanently block
    # fuzzy text-only matches once the real window would have expired.
    existing = [_item(id="undated", sourceUrl="", createdAt=None)]
    new = [_item(id="fresh", sourceUrl="")]
    kept, dropped = dedupe_feed_items(new, existing, now=NOW, window_ms=14 * DAY_MS)
    assert [item["id"] for item in kept] == ["fresh"]
    assert dropped == []


def test_classify_feed_item_reports_linked_update_for_explicit_thread_key():
    existing = [
        _item(
            id="old",
            title="CUDA roadmap update",
            bluf="CUDA 13 was previewed.",
            body="The original item covered a preview.",
            threadKey="cuda-roadmap",
            createdAt=NOW - 30 * DAY_MS,
        )
    ]
    candidate = _item(
        id="new",
        title="CUDA toolkit release candidate ships",
        bluf="CUDA 13 now has an RC with migration details.",
        body="The new item covers the RC and compatibility notes.",
        threadKey="cuda-roadmap",
    )

    classification, matched, reason = classify_feed_item(
        candidate,
        existing,
        now=NOW,
        window_ms=14 * DAY_MS,
    )

    assert classification == "linked_update"
    assert matched == existing[0]
    assert "Same source or thread" in reason


def test_dedupe_mixed_batch_url_and_text_only():
    existing = [
        _item(
            id="seen-url",
            title="NVIDIA data center GPU launch",
            bluf="NVIDIA launched a new data center GPU.",
            body="It targets AI training workloads.",
            sourceUrl="https://nvidia.com/a",
            createdAt=NOW - DAY_MS,
        ),
        _item(
            id="seen-text",
            title="Recurring textual finding",
            bluf="A recurring textual finding.",
            body="No source link was available for it.",
            sourceUrl="",
            createdAt=NOW - DAY_MS,
        ),
    ]
    new = [
        # Same URL, re-summarized with overlapping wording → re-report.
        _item(
            id="dup-url",
            title="NVIDIA data center GPU launch",
            bluf="NVIDIA launched a new data center GPU.",
            body="It targets AI training workloads at scale.",
            sourceUrl="https://nvidia.com/a",
        ),
        # No URL, identical text → re-report.
        _item(
            id="dup-text",
            title="Recurring textual finding",
            bluf="A recurring textual finding.",
            body="No source link was available for it.",
            sourceUrl="",
        ),
        _item(id="fresh", title="Brand new finding", sourceUrl="https://amd.com/b"),
    ]
    kept, dropped = dedupe_feed_items(new, existing, now=NOW)
    assert [item["id"] for item in kept] == ["fresh"]
    assert {item["id"] for item in dropped} == {"dup-url", "dup-text"}


def test_dedupe_skips_non_dict_existing_entries():
    existing = ["corrupt", None, 42, _item(sourceUrl="https://nvidia.com/gpu")]
    new = [_item(id="fresh", sourceUrl="https://amd.com/news", title="Other")]
    kept, _dropped = dedupe_feed_items(new, existing, now=NOW)
    assert [item["id"] for item in kept] == ["fresh"]


def test_window_ms_for_days_clamps_and_defaults():
    assert window_ms_for_days(7) == 7 * DAY_MS
    assert window_ms_for_days(0) == DEFAULT_WINDOW_DAYS * DAY_MS
    assert window_ms_for_days(-5) == DEFAULT_WINDOW_DAYS * DAY_MS
    assert window_ms_for_days(None) == DEFAULT_WINDOW_DAYS * DAY_MS
    assert window_ms_for_days("nonsense") == DEFAULT_WINDOW_DAYS * DAY_MS
    assert window_ms_for_days(9999) == MAX_WINDOW_DAYS * DAY_MS
