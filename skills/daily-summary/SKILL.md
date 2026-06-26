---
name: daily-summary
description: >-
  Generate a standalone, NVIDIA-styled daily summary webpage using Bootstrap
  layout primitives while preserving the visual design of the provided daily
  summary render. This skill is for producing a polished HTML daily briefing
  where an LLM inserts the latest calendar, weather, operations, sports, and
  action-item updates into a consistent template.
---

# Daily Summary Bootstrap Template Skill

## Output Contract

Return **only** a complete standalone HTML document.

Do not include:

- Markdown fences
- JSON
- Prose before or after the HTML
- Screenshots or generated media
- JavaScript unless explicitly requested
- Images, video, canvas, or SVG unless explicitly requested

Use Bootstrap for layout and responsive behavior, but keep the custom NVIDIA-inspired visual system.

## Design System

### Brand

- Primary accent: NVIDIA Green `#76B900`
- Dark background with layered panels
- Alternating dark and light cards
- Rounded cards and hero section
- Compact executive-summary tone
- Clear “Next Best Actions” section
- Strong headline / BLUF at the top

### Typography

Use this font stack:

```css
"NVIDIA Sans", "Segoe UI", Arial, sans-serif
```

### Layout

Use Bootstrap grid classes:

- `.container-lg` for the page shell
- `.row.g-3` for section grids
- `.col-12`, `.col-lg-8`, `.col-lg-6`, `.col-lg-4` for responsive card placement

### Required Sections When Data Is Available

Include these sections when reliable data exists:

1. Hero / Daily Summary
2. Calendar And Commitments
3. Local Weather And Logistics
4. Work And AI Infrastructure
5. Sports Watch
6. Must Know
7. Next Best Actions
8. Sources Checked

Omit any section that has no reliable or relevant data.

## Content Rules

### Hero

The hero should include:

- Eyebrow label: `Daily Summary`
- A concise headline summarizing the day
- Date and generated time
- One short paragraph explaining the overall posture of the day
- Three to five status pills

Example pill types:

- Healthy / OK
- Warning
- Danger
- Informational

### Calendar

Calendar items should be chronological.

Each item should include:

- Time
- Title
- Optional location
- Optional end time
- RSVP / status note when relevant
- Practical conflict or logistics note when useful

### Weather

Weather should be local and practical.

Include:

- High / low or current key condition
- Short forecast
- Evening risk if relevant
- Practical recommendation

### Operations / Infrastructure

Include read-only operational status when available.

Prefer:

- Overall health statement
- Node readiness
- Pod counts
- Notable warnings
- Specific namespace / pod names only when useful
- Suggested next inspection step, not destructive actions

### Sports

Include only relevant sports the user tracks.

Prefer:

- Matchup
- Time
- Venue
- Broadcast
- Probables / key context if available
- Calendar conflicts

### Must Know

Use this section for the most important cross-cutting facts.

Keep bullets short and decision-oriented.

### Next Best Actions

Always make this section actionable.

Use up to three actions.

Each action should include:

- Imperative title
- One short reason
- Optional timing cue

### Sources Checked

List the sources used.

For links, always include:

```html
target="_blank" rel="noopener noreferrer"
```

## Placeholder Convention

Use double-curly placeholders for values an LLM or rendering step should replace.

Examples:

- `{{summary.date_display}}`
- `{{summary.generated_time}}`
- `{{hero.headline}}`
- `{{weather.high}}`
- `{{#each calendar.items}} ... {{/each}}`

If the runtime does not support templating, replace placeholders directly before returning final HTML.

## Bootstrap HTML Template

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Daily Summary — {{summary.date_display}}</title>

    <link
      href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css"
      rel="stylesheet"
      integrity="sha384-QWTKZyjpPEjISv5WaRU9Oer+R6jIEaFfC6R8t9eI13F2oh5dY4g6F7Y4j5f5f5f5"
      crossorigin="anonymous"
    />

    <style>
      :root {
        --nv-green: #76b900;
        --nv-green-dark: #5c9400;
        --bg: #0f1115;
        --panel: #191c22;
        --panel-2: #22262e;
        --text: #f5f7fa;
        --muted: #b7beca;
        --line: #343944;

        --light-bg: #f6f7f9;
        --light-panel: #ffffff;
        --light-text: #151922;
        --light-muted: #4f5968;

        --warn: #ffcc66;
        --danger: #ff7a7a;
        --ok: #76b900;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: 'NVIDIA Sans', 'Segoe UI', Arial, sans-serif;
        background: var(--bg);
        color: var(--text);
        line-height: 1.45;
      }

      .page {
        max-width: 1180px;
        padding-top: 32px;
        padding-bottom: 48px;
      }

      .hero {
        border: 1px solid var(--line);
        background: linear-gradient(
            135deg,
            rgba(118, 185, 0, 0.18),
            rgba(118, 185, 0, 0.02) 38%
          ), linear-gradient(180deg, #1a1e25, #11141a);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 18px 45px rgba(0, 0, 0, 0.28);
      }

      .eyebrow {
        display: inline-flex;
        gap: 10px;
        align-items: center;
        color: var(--nv-green);
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        font-size: 12px;
        margin-bottom: 14px;
      }

      .eyebrow::before {
        content: '';
        width: 34px;
        height: 4px;
        border-radius: 999px;
        background: var(--nv-green);
        display: inline-block;
      }

      h1 {
        margin: 0;
        font-size: clamp(34px, 5vw, 58px);
        line-height: 1.02;
        letter-spacing: -0.04em;
        font-weight: 800;
      }

      h2 {
        margin: 0 0 12px;
        font-size: 18px;
        letter-spacing: -0.01em;
        font-weight: 800;
      }

      .subtitle {
        color: var(--muted);
        font-size: 17px;
        max-width: 780px;
        margin: 16px 0 0;
      }

      .summary-card {
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 20px;
        padding: 20px;
        min-height: 100%;
        color: var(--text);
      }

      .summary-card.light {
        background: var(--light-panel);
        color: var(--light-text);
        border-color: #dde2ea;
      }

      .summary-card.light .meta,
      .summary-card.light .muted,
      .summary-card.light li span {
        color: var(--light-muted);
      }

      .big {
        font-size: 28px;
        font-weight: 800;
        letter-spacing: -0.03em;
        margin: 0 0 8px;
      }

      .meta,
      .muted {
        color: var(--muted);
        font-size: 13px;
      }

      .summary-list {
        margin: 12px 0 0;
        padding: 0;
        list-style: none;
      }

      .summary-list > li {
        padding: 10px 0;
        border-top: 1px solid rgba(128, 139, 154, 0.22);
      }

      .summary-list > li:first-child {
        border-top: 0;
        padding-top: 0;
      }

      .pill-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }

      .summary-pill {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        border: 1px solid rgba(118, 185, 0, 0.35);
        background: rgba(118, 185, 0, 0.1);
        color: #dff5bf;
        padding: 7px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
      }

      .light .summary-pill {
        color: var(--light-text);
        background: rgba(118, 185, 0, 0.12);
      }

      .status {
        display: inline-block;
        width: 9px;
        height: 9px;
        border-radius: 999px;
        background: var(--ok);
        flex: 0 0 auto;
      }

      .status.warn {
        background: var(--warn);
      }

      .status.danger {
        background: var(--danger);
      }

      .schedule-item {
        display: grid;
        grid-template-columns: 96px 1fr;
        gap: 12px;
        align-items: start;
      }

      .time {
        font-weight: 800;
        color: var(--nv-green);
      }

      code {
        color: inherit;
        background: rgba(128, 139, 154, 0.16);
        padding: 0.12rem 0.28rem;
        border-radius: 0.35rem;
        font-size: 0.9em;
      }

      .source-list a {
        color: var(--nv-green);
        text-decoration: none;
      }

      .source-list a:hover {
        text-decoration: underline;
      }

      .actions {
        counter-reset: action;
      }

      .actions > li {
        counter-increment: action;
        display: grid;
        grid-template-columns: 34px 1fr;
        gap: 12px;
        align-items: start;
      }

      .actions > li::before {
        content: counter(action);
        width: 28px;
        height: 28px;
        border-radius: 8px;
        background: var(--nv-green);
        color: #081000;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-weight: 900;
      }

      @media (max-width: 820px) {
        .schedule-item {
          grid-template-columns: 78px 1fr;
        }

        .hero {
          padding: 22px;
        }
      }
    </style>
  </head>

  <body>
    <main class="container-lg page">
      <section class="hero">
        <div class="eyebrow">Daily Summary</div>

        <h1>{{hero.headline}}</h1>

        <p class="subtitle">
          {{summary.weekday}}, {{summary.date_display}} · Generated at
          {{summary.generated_time}} {{summary.timezone}}.
          {{hero.summary_paragraph}}
        </p>

        <div class="pill-row">
          {{#each hero.pills}}
          <span class="summary-pill">
            <span class="status {{this.status_class}}"></span>
            {{this.label}}
          </span>
          {{/each}}
        </div>
      </section>

      <section class="row g-3 mt-1">
        {{#if calendar.items}}
        <article class="col-12 col-lg-8">
          <div class="summary-card light">
            <h2>Calendar And Commitments</h2>

            <ul class="summary-list">
              {{#each calendar.items}}
              <li class="schedule-item">
                <div class="time">{{this.time}}</div>
                <div>
                  <strong>{{this.title}}</strong>
                  <div class="muted">{{this.detail}}</div>
                </div>
              </li>
              {{/each}}
            </ul>
          </div>
        </article>
        {{/if}} {{#if weather}}
        <article class="col-12 col-lg-4">
          <div class="summary-card">
            <h2>Local Weather And Logistics</h2>

            <p class="big">{{weather.headline}}</p>

            <p class="muted">{{weather.current_conditions}}</p>

            <ul class="summary-list">
              {{#each weather.bullets}}
              <li>{{this}}</li>
              {{/each}}
            </ul>
          </div>
        </article>
        {{/if}} {{#if infrastructure}}
        <article class="col-12 col-lg-6">
          <div class="summary-card">
            <h2>Work And AI Infrastructure</h2>

            <p class="big">{{infrastructure.headline}}</p>

            <ul class="summary-list">
              {{#each infrastructure.bullets}}
              <li>{{this}}</li>
              {{/each}}
            </ul>
          </div>
        </article>
        {{/if}} {{#if sports}}
        <article class="col-12 col-lg-6">
          <div class="summary-card light">
            <h2>Sports Watch</h2>

            <p class="big">{{sports.headline}}</p>

            <ul class="summary-list">
              {{#each sports.bullets}}
              <li>{{this}}</li>
              {{/each}}
            </ul>
          </div>
        </article>
        {{/if}} {{#if must_know.items}}
        <article class="col-12 col-lg-6">
          <div class="summary-card light">
            <h2>Must Know</h2>

            <ul class="summary-list">
              {{#each must_know.items}}
              <li>{{this}}</li>
              {{/each}}
            </ul>
          </div>
        </article>
        {{/if}} {{#if actions.items}}
        <article class="col-12 col-lg-6">
          <div class="summary-card">
            <h2>Next Best Actions</h2>

            <ul class="summary-list actions">
              {{#each actions.items}}
              <li>
                <div>
                  <strong>{{this.title}}</strong>
                  <div class="muted">{{this.reason}}</div>
                </div>
              </li>
              {{/each}}
            </ul>
          </div>
        </article>
        {{/if}} {{#if sources.items}}
        <article class="col-12">
          <div class="summary-card">
            <h2>Sources Checked</h2>

            <ul class="summary-list source-list">
              {{#each sources.items}}
              <li>
                {{this.label}} {{#if this.url}} ·
                <a href="{{this.url}}" target="_blank" rel="noopener noreferrer"
                  >{{this.display_url}}</a
                >
                {{/if}}
              </li>
              {{/each}}
            </ul>
          </div>
        </article>
        {{/if}}
      </section>
    </main>
  </body>
</html>
```

## Example Data Shape

```json
{
  "summary": {
    "weekday": "Wednesday",
    "date_display": "June 24, 2026",
    "generated_time": "12:03 PM",
    "timezone": "EDT"
  },
  "hero": {
    "headline": "Storms later, commitments stacked, cluster mostly healthy.",
    "summary_paragraph": "Your day is concentrated from early afternoon through evening, with weather risk increasing tonight.",
    "pills": [
      {
        "label": "4/4 Kubernetes nodes ready",
        "status_class": ""
      },
      {
        "label": "Thunderstorms likely tonight",
        "status_class": "warn"
      },
      {
        "label": "Yankees at Tigers · 6:40 PM",
        "status_class": "warn"
      }
    ]
  },
  "calendar": {
    "items": [
      {
        "time": "1:30 PM",
        "title": "Confirmed lawyer meeting",
        "detail": "Ann Arbor · ends 2:30 PM · RSVP still shows needs action."
      }
    ]
  },
  "weather": {
    "headline": "79°F high · storms tonight",
    "current_conditions": "Nearby conditions: fair, 72°F, south wind 7 mph.",
    "bullets": [
      "<strong>This afternoon:</strong> Partly sunny with a slight storm chance.",
      "<strong>Tonight:</strong> Showers and thunderstorms likely.",
      "<strong>Practical read:</strong> Keep an umbrella or rain layer handy."
    ]
  },
  "infrastructure": {
    "headline": "Cluster: healthy control plane, one noisy image pull issue.",
    "bullets": [
      "<strong>Control plane:</strong> healthy.",
      "<strong>Nodes:</strong> 4 ready of 4 total.",
      "<strong>Top warning:</strong> <code>nvca-system/image-cred-updater</code> has repeated <code>ImagePullBackOff</code> warnings."
    ]
  },
  "sports": {
    "headline": "Yankees @ Tigers · 6:40 PM EDT",
    "bullets": [
      "<strong>Venue:</strong> Comerica Park.",
      "<strong>TV:</strong> Amazon Prime Video and Detroit SportsNet.",
      "<strong>Conflict note:</strong> First pitch overlaps evening commitments."
    ]
  },
  "must_know": {
    "items": [
      "<strong>Weather risk is later, not immediate:</strong> afternoon is mostly usable.",
      "<strong>RSVP cleanup:</strong> one meeting still needs a response."
    ]
  },
  "actions": {
    "items": [
      {
        "title": "Pack for rain before leaving.",
        "reason": "Evening thunderstorms are likely."
      },
      {
        "title": "Confirm or respond to the 1:30 PM meeting.",
        "reason": "The event still shows needs action."
      }
    ]
  },
  "sources": {
    "items": [
      {
        "label": "Calendar: authenticated Google Calendar for the day.",
        "url": null,
        "display_url": null
      },
      {
        "label": "Weather: National Weather Service point forecast.",
        "url": "https://forecast.weather.gov/",
        "display_url": "forecast.weather.gov"
      }
    ]
  }
}
```

## Rendering Guidance

When converting the template into final HTML:

1. Replace all placeholders with fresh, verified data.
2. Remove any section whose backing data is missing or low confidence.
3. Keep the hero concise and useful.
4. Keep bullet lists skimmable.
5. Use `<strong>` for labels inside bullets.
6. Use `<code>` only for technical identifiers.
7. Keep “Next Best Actions” to three items or fewer.
8. Use links only in the Sources section unless a section genuinely benefits from a source link.
9. All links must open in a new tab with `target="_blank" rel="noopener noreferrer"`.
10. Return only the final HTML document.
