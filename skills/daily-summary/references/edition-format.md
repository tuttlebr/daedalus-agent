# Daily Daedalus structured edition format

Use this reference when composing the data consumed by
`scripts/render_daybook.py`. The format discriminator is
`daily-daedalus/v1`. Supply structured text and provenance only; never put HTML,
CSS, Markdown, or template tokens in a field.

## Root object

```json
{
  "format": "daily-daedalus/v1",
  "policy_version": "2026-08-27",
  "generated_at": {
    "iso": "2026-08-27T08:11:00-04:00",
    "display": "Thursday, August 27, 2026 · 8:11 a.m. EDT",
    "issue_label": "Morning Edition"
  },
  "description": "A current personalized daily briefing.",
  "lead": {},
  "day_ahead": { "weather": {}, "email_calendar": {} },
  "operations_details": [],
  "departments": [],
  "editors_note": "One concise synthesis grounded in reported facts.",
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
  "detail": "Published August 27, 2026"
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
digits, underscores, and hyphens. The renderer creates the Sources section and
all validation attributes from these objects.

## Lead and front page

`lead` requires `headline`, `dek`, `verdict`, one or two `paragraphs`, a
`source`, and an optional `snapshot` table. The paragraph total is at most 220
words. The snapshot has `columns` and at most five same-width `rows`.

```json
{
  "headline": "Cluster Returns to Steady State",
  "dek": "A concise statement of current consequence.",
  "verdict": { "label": "Stable, watching", "tone": "watch" },
  "paragraphs": ["Verified opening context."],
  "snapshot": {
    "columns": ["Scope", "Current state"],
    "rows": [["Nodes", "5 of 5 Ready"]]
  },
  "source": {
    "kind": "tool",
    "label": "Live Kubernetes read",
    "refs": ["k8s_mcp_server"]
  }
}
```

Verdict tones are `stable`, `watch`, and `urgent`.

`day_ahead.weather` has `status`, `title`, `rows`, `note`, and an optional
`source`. Covered weather contains exactly four rows—today plus three days—with
`day`, `conditions`, `high`, `low`, `wind`, and `precip` fields.

`day_ahead.email_calendar` has `status`, `agenda`, `actions`, `lookahead`, and
an optional `source`. Agenda items contain `time`, `event`, and `location`;
actions contain `title` and `body`; look-ahead items are plain strings. The
renderer keeps the first four agenda entries and first two actions in the
right rail, then moves all remaining items and the look-ahead into a full-width
continuation. Nothing is silently dropped.

## Operations and departments

`operations_details` is a non-empty array of independent modules with `title`,
`source`, and `blocks`. It contains GPU, Flux, UniFi, storage, incident, and
other detailed evidence that must not lengthen the opening grid.

Each supporting department contains `desk_key`, `title`, and one or more
`stories`. A story has `headline`, optional `dek`, `source`, and `blocks`. The
renderer makes the first of three or more stories the feature and lays later
stories out as compact pairs.

Supported block shapes:

- `{"type":"paragraph","text":"..."}`
- `{"type":"subhead","text":"..."}`
- `{"type":"list","items":["...","..."]}`
- `{"type":"table","columns":["..."],"rows":[["..."]]}`
- `{"type":"briefs","items":[{"title":"...","body":"...","source":{...}}]}`
- `{"type":"figure","url":"https://...","source_page":"https://...","credit":"Publisher","alt":"...","caption":"..."}`

The renderer escapes every text value. Figures always use source imagery and
the renderer supplies safe loading and referrer attributes.

## Coverage

Every policy desk appears exactly once in `coverage`, preserving its key and
label. Additional remembered desks are allowed when they have stable keys and
labels. Each item has `desk_key`, `label`, `status`, `explanation`, and an
optional `source`. Valid statuses are `covered`, `quiet`, and `unavailable`.
Covered items require a source. Quiet and unavailable items remain visible only
in the ledger.
