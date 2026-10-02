# Daily Daedalus structured edition format

Use this reference when composing the data consumed by
`scripts/render_daybook.py`. The format discriminator is
`daily-daedalus/v1`. Supply structured text and provenance only; never put HTML,
CSS, Markdown, or template tokens in a field. Pass this structure as the `edition`
object to `briefing_renderer_tool`; the backend performs JSON serialization. The
renderer is the authoritative validator and returns field-specific errors.

Apply [the editorial voice](editorial-spec.md#reporting-density-and-voice) to
every text field, including headlines, deks, briefs, and `editors_note`.
Lead with a supported conclusion and its consequence; preserve evidence scope
and uncertainty. Structured provenance supports the reporting but does not
replace explaining whether a result is observed, reported, estimated, or proposed.

## Root object

```json
{
  "format": "daily-daedalus/v1",
  "policy_version": "2026-10-02",
  "generated_at": {
    "iso": "2026-10-02T08:11:00-04:00",
    "display": "Friday, October 2, 2026 · 8:11 a.m. EDT",
    "issue_label": "Morning Edition"
  },
  "description": "A current personalized daily briefing.",
  "lead": {},
  "day_ahead": { "weather": {}, "email_calendar": {} },
  "operations_details": [],
  "departments": [],
  "editors_note": "The supported implication of reported facts and any decision or validation needed.",
  "coverage": []
}
```

Unknown keys are errors. `policy_version` must match the loaded policy.

## Sources

A web source has `kind`, `label`, `url`, and optional `detail`:

```json
{
  "kind": "web",
  "label": "NVIDIA Developer Blog",
  "url": "https://developer.nvidia.com/example",
  "detail": "Published October 2, 2026"
}
```

A live tool source uses `refs` instead of `url`:

```json
{
  "kind": "tool",
  "label": "Live Kubernetes and UniFi reads",
  "refs": ["k8s_mcp_server", "unifi_mcp_server"]
}
```

Web URLs must be HTTPS. Tool references contain only lowercase letters,
digits, underscores, and hyphens. The renderer links public headlines to their
source pages and keeps tool references in validation attributes. There is no
separate Sources section. Image credits appear only in their figure captions.

## Lead and front page

`lead` requires `desk_key` for the selected policy news desk, `headline`, `dek`,
one or two `paragraphs`, and a `source`. `verdict` and `snapshot` are optional.
Choose the strongest current news; Opinion, Weather and Email & Calendar cannot
be the reported-news lead. The paragraph total is at most 220
words. The snapshot has `columns` and at most five same-width `rows`.

```json
{
  "desk_key": "technology",
  "headline": "A serving change reduces cache-transfer work in a controlled test",
  "dek": "The measured workload supports a narrower claim than a production cost reduction.",
  "paragraphs": [
    "Describe the sourced capability, workload, version, measurement date and constraint here. This format example is not a report of a real result."
  ],
  "source": {
    "kind": "web",
    "label": "Primary technical report",
    "url": "https://example.org/technical-report",
    "detail": "Format example only; replace with verified source and date"
  }
}
```

Verdict tones are `stable`, `watch`, and `urgent`.

`day_ahead.weather` has `status`, `title`, `rows`, `note`, and an optional
`source` (required when covered). Covered weather contains exactly four rows—today plus three days—with
`day`, `conditions`, `high`, `low`, `wind`, and `precip` fields.

`day_ahead.email_calendar` has `status`, `agenda`, `actions`, `lookahead`, and
a `source` required when covered (optional when unavailable). Agenda items contain `time`, `event`, and `location`;
actions contain `title` and `body`; look-ahead items are plain strings. The
renderer keeps the first four agenda entries and first two actions at the top
of the right rail, then puts all remaining items and the look-ahead in a
continuation within that same rail. Nothing is silently dropped.

## Operations and departments

The tool exposes the nested field shapes from [edition-schema.json](edition-schema.json).
The same contract checks all structural errors before rendering; correct every
reported path in the one allowed correction. The source and HTML quality gates
still run after structural validation.

`operations_details` is required; supply `[]` for an ordinary news edition. When a current operational
exception or explicit request warrants it, supply an array of independent modules with `title`,
`source`, and `blocks`. It is reserved for warranted operational evidence, never routine healthy
counts. A non-empty array requires covered `cluster-infrastructure` coverage.
Continue ordinary news in the matching department, not here.

Each supporting department contains `desk_key`, `title`, and one or more
`stories`. A story has `headline`, optional `dek`, `source`, and `blocks`. The
renderer makes the first of three or more main-column stories the feature and
lays later stories out as compact pairs. Policy-designated rail desks stack
stories in a single column; Health opens that rail.

Supported block shapes:

- `{"type":"paragraph","text":"..."}`
- `{"type":"subhead","text":"..."}`
- `{"type":"list","items":["...","..."]}`
- `{"type":"table","columns":["..."],"rows":[["..."]]}`
- `{"type":"briefs","items":[{"title":"...","body":"...","source":{...}}]}`
- `{"type":"figure","url":"https://...","data_url":"data:image/png;base64,...","source_page":"https://...","credit":"Publisher","alt":"...","caption":"..."}`

The renderer escapes every text value. Figures always use source imagery and
the renderer supplies safe loading and referrer attributes. The `url` remains
original image provenance; `data_url` contains verified PNG/JPEG/GIF/WebP bytes
(maximum 100,000 characters per data URL, within the whole-edition tool budget).
Do not invent or manually transcribe base64. Omit a figure if bytes cannot be
obtained economically through an authorized read. The renderer never downloads
an image, font or stylesheet.

## Coverage

`coverage` is internal validation data and is never rendered as a desk ledger.
Every policy desk appears exactly once with only `desk_key` and `status`:

```json
{ "desk_key": "cluster-infrastructure", "status": "quiet" }
```

Valid statuses are `covered`, `quiet`, and `unavailable`. For a conditional
desk, `quiet` also means no timely trigger required a check; it does not assert
operational health. The selected lead desk must be `covered`. The renderer derives
policy labels; include `label` only for an additional remembered desk. Do not
include `explanation` or duplicate `source` objects here. Covered desks must
have sourced reporting elsewhere in the edition. Quiet desks are omitted from
the page; material unavailable-source limitations belong beside affected
reporting or in `editors_note`.
