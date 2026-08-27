# The Daily Daedalus editorial specification

Use this reference while composing a full daily-summary edition.

## Identity and approved typography

The masthead is the text **The Daily Daedalus**. Directly beneath it, include
the standing line **One reader. One editor. No filler.** The title and line are
editorial identity, not a story headline or decorative rail.

Include this one external stylesheet in `<head>`:

```html
<link
  rel="stylesheet"
  href="https://g1.nyt.com/fonts/css/web-fonts.c851560786173ad206e1f76c1901be7e096e8f8b.css"
/>
```

All other edition CSS belongs in one inline `<style>` block. Use only
`nyt-cheltenham`, `nyt-cheltenham-small`, or `nyt-cheltenham-text-cond` as the
primary families. End each stack with Georgia, `Times New Roman`, Times, and
serif fallbacks. Do not use the NYT nameplate font or reproduce its logo.

- masthead and display headlines: `nyt-cheltenham`, weight 700 or 800;
- story headlines and body copy: `nyt-cheltenham`, weight 400 to 700;
- captions, labels, tables, and desk ledger: `nyt-cheltenham-small` or
  `nyt-cheltenham-text-cond`.

## Page system

- Use white or subtle warm-white newsprint, near-black `#121212` ink, muted
  `#5a5a5a` secondary text, `#d3d3d3` hairlines, and black section rules.
- Reserve red near `#d0021b` for a genuinely urgent or live condition.
- Set `box-sizing: border-box` globally. Use a centered page with
  `max-width: 1200px`, modest horizontal padding, and no outer card.
- Constrain source media with `max-width: 100%` and `height: auto`.
- Avoid rounded cards, pills as the dominant vocabulary, gradients, glow,
  ornamental shadows, large ad-like voids, dark dashboard panels, and
  corporate-brand treatments.
- Use fluid type with `clamp()`, compact headline line-height, readable body
  measure, and square crops only when the source composition tolerates them.
- Use whitespace to express rank, not to preserve empty grid tracks. Never use
  fixed heights, spacer elements, or `min-height` to equalize columns.

This is an edited newspaper page, not an observability dashboard. Operational
facts may use compact tables, status lines, or timelines, but the lead still
needs a headline, a clear verdict, context, and human-readable consequence.

## Front-page order

1. A compact utility strap with real date, generation time, timezone, and issue
   label. Mark it `data-edition-strap`.
2. The centered text masthead **The Daily Daedalus**, followed by the standing
   line marked `data-edition-tagline`. Center the line in a restrained italic
   or small-text treatment so it reads as an editorial motto, not body copy.
3. A short department rail derived from sections that actually contain
   material, followed by a double black rule. Mark it `data-department-rail`
   and give it an `aria-label`.
4. One content-aware opening package led by Cluster & Infrastructure. Mark the
   grid `data-lead-grid`, its selected layout `data-lead-layout`, and the lead
   article `data-lead-story data-desk-key="cluster-infrastructure"`.
5. A compact day-ahead group for Saline weather and actionable Email & Calendar
   material. These may serve as opening rails when substantive.
6. Supporting departments ranked by the day's material: AI & Inference,
   Science & Technology, Outdoors & Field, Sports, Markets & Finance, and
   Culture & Leisure. A quiet desk belongs only in the ledger.
7. A concise editor's note or analysis block, then the complete desk ledger.
   Give the note `id="editors-note"`.
8. A final sources and image-credits section.

Do not force all desks into equal panels or repeat one card grid. Vary section
composition according to rank: split feature, narrow dispatch, ruled brief,
timeline, pull quote with context, forecast strip, scoreboard, or compact table.

## Lead layout utilization

Inventory the substantive opening modules before writing CSS. Put one of these
values on the same element as `data-lead-grid`:

- `data-lead-layout="feature"` when the operations lead has no substantive
  secondary rail. Use the available width for its verdict, headline, dek,
  evidence, media, and opening copy.
- `data-lead-layout="two-column"` when one substantive day-ahead or secondary
  rail exists. A roughly two-thirds/one-third split is a useful starting point.
- `data-lead-layout="three-column"` only when both flanking rails contain
  substantive modules. The 25/45/30 ratio is a starting point, not a quota.

A substantive rail contains a complete secondary story, an explained compact
table or timeline, or at least two useful briefs. A label, live badge, dateline,
rule, context-free pull quote, or one-line status does not justify a column.

Treat the opening grid as a bounded package, not a scaffold for the entire lead
article. When a rail ends, close the grid or let the next lead figure, body
block, or supporting group span freed columns. At a desktop preview around
1200 pixels wide, every active opening column must contain useful content. If a
column ends after a label or badge, choose a simpler layout.

## Reporting density and voice

- Begin the operations lead with a plain verdict such as stable, degraded, or
  action required, supported by current evidence. Avoid alarmist language.
- Give numbers denominators and scope: affected versus total, current versus
  historical, ready versus desired.
- Put the reader's next action or watch item near the fact that creates it.
- Use short declarative headlines, precise deks, and compact paragraphs. Avoid
  generic transitions, repeated summaries, and phrases like “in today's fast-
  paced world.”
- Keep private mail and calendar copy discreet. Prefer “prepare for” and “reply
  to” over unnecessary quotations from messages.
- The editor's note may connect two reported facts or name the day's priority;
  it must not introduce an unsupported claim.
- Aim for five to eight minutes only when the reporting earns that length. A
  quiet edition should be visibly shorter.

## Validation markup

Use these stable attributes. They are part of the daily-summary interface.

```html
<html lang="en" data-daybook-version="3" data-policy-version="2026-08-27">
  <main id="daybook">
    <p data-edition-strap>Thursday, August 27, 2026 · 8:00 a.m. EDT</p>
    <h1>The Daily Daedalus</h1>
    <p data-edition-tagline>One reader. One editor. No filler.</p>
    <nav data-department-rail aria-label="Edition departments">...</nav>
    <article
      data-story
      data-lead-grid
      data-lead-layout="two-column"
      data-lead-story
      data-desk-key="cluster-infrastructure"
      data-source-kind="tool"
      data-source-ref="k8s_mcp_server,unifi_mcp_server"
    >
      ...
      <figure
        data-image-source-url="https://images.example/photo.jpg"
        data-source-page="https://primary.example/status"
        data-image-credit="Photographer / Publisher"
      >
        <img
          src="https://images.example/photo.jpg"
          alt="Specific description of the sourced image"
          decoding="async"
          referrerpolicy="no-referrer"
        />
        <figcaption>Caption and linked source credit.</figcaption>
      </figure>
    </article>
    <section data-department="ai-inference">...</section>
    <section id="editors-note" aria-labelledby="editors-note-heading">
      ...
    </section>
    <section id="coverage" aria-labelledby="coverage-heading">
      <ul>
        <li
          data-desk-key="cluster-infrastructure"
          data-coverage-status="covered"
          data-source-kind="tool"
          data-source-ref="k8s_mcp_server,unifi_mcp_server"
        >
          ...
        </li>
      </ul>
    </section>
    <section id="sources" aria-labelledby="sources-heading">...</section>
  </main>
</html>
```

The HTML `data-policy-version` must match the loaded policy and coverage
manifest. Every manifest desk appears on exactly one ledger item. Valid statuses
are `covered`, `quiet`, and `unavailable`. Quiet and unavailable items require a
visible explanation, not an empty label. The lead story's desk key must match
the policy lead desk.

Mark the primary provenance of each story and covered ledger item:

- Public web reporting uses `data-source-kind="web"` and an HTTPS
  `data-source-url`; link that URL in the sources section.
- Live operational or personal reporting uses `data-source-kind="tool"` and a
  safe comma-separated `data-source-ref` such as `k8s_mcp_server`,
  `unifi_mcp_server`, `gmail_mcp_server`, or `calendar_mcp_server`. Name each
  tool source visibly in the sources section without exposing credentials,
  private identifiers, or raw messages.

A story may contain additional linked supporting sources, but its validation
attributes identify its primary evidence path. Do not fabricate a web URL for
tool-derived data.

Every `<img>` belongs inside a `<figure>` with all three provenance attributes.
The image URL must equal `data-image-source-url`. Link the visible caption to
`data-source-page` and repeat the credit in the sources section. Use
`loading="eager" fetchpriority="high"` for the lead image and `loading="lazy"`
for other images. All images use `decoding="async"` and
`referrerpolicy="no-referrer"`.

## Responsive, accessible, and print behavior

- Use semantic `header`, labeled `nav`, `main`, `article`, `section`, `figure`,
  and `footer` landmarks with one `<h1>` and logical heading order.
- Add charset, viewport, title, description, and color-scheme metadata.
- Give links visible focus styles. External links use
  `target="_blank" rel="noopener noreferrer"`.
- Use meaningful alt text and visible captions. Do not encode meaning only
  through color or icons.
- At or below 740px, collapse to one ranked column: utility strap, masthead,
  tagline, lead headline, lead image, day ahead, departments, ledger, sources.
  Prevent horizontal scrolling; do not merely shrink desktop columns.
- Remove desktop-only rail borders and gaps when columns collapse. Do not leave
  empty wrappers before the lead or between ranked mobile modules.
- Include `@media print` rules that remove nonessential controls, keep ink
  black, preserve captions, and avoid breaking a story or figure across pages.
- Use no JavaScript. Motion is unnecessary for a newspaper edition.

The raw file sent to validation starts at `<!DOCTYPE html>` and ends at
`</html>`. Return that exact validated document inside one `html` fence with no
surrounding prose.
