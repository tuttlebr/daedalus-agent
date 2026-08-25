# Daedalus Daybook editorial specification

Use this reference while composing a full daily-summary edition.

## Typography and approved external resource

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

Use Cheltenham as follows:

- masthead and display headlines: `nyt-cheltenham`, weight 700 or 800;
- story headlines and body copy: `nyt-cheltenham`, weight 400 to 700;
- captions, labels, and compact ledger text: `nyt-cheltenham-small` or
  `nyt-cheltenham-text-cond`.

## Page system

- Use a white or subtle warm-white canvas, near-black `#121212` ink, muted
  `#5a5a5a` secondary text, `#d3d3d3` hairlines, and black section rules.
- Reserve red near `#d0021b` for genuinely urgent or live labels.
- Set `box-sizing: border-box` globally. Use a centered page with
  `max-width: 1200px`, modest horizontal padding, and no outer card.
- Constrain source media with an `img` rule that includes `max-width: 100%` and
  `height: auto`; a large source image must never widen the page.
- Avoid rounded cards, gradients, glow, ornamental shadows, large empty ad
  spaces, dark dashboard panels, and corporate-brand visual treatments.
- Do not use fixed heights, decorative spacer elements, or `min-height` to make
  columns look equal. Let the amount and rank of verified material determine
  the page length.
- Use fluid type with `clamp()`, compact headline line-height, readable body
  measure, and square image crops only when the source composition tolerates it.

## Layout utilization

Inventory the actual opening modules before writing its CSS. Put one of these
values on the same element as `data-lead-grid`:

- `data-lead-layout="feature"` for a lead package with no substantive secondary
  rail. Use the available width for the lead headline, dek, media, and opening
  copy rather than manufacturing side columns.
- `data-lead-layout="two-column"` when there is one substantive secondary rail.
  A roughly two-thirds/one-third split is a useful starting point.
- `data-lead-layout="three-column"` only when both flanking rails contain
  substantive modules. The 25/45/30 ratio is a starting point, not a quota.

A substantive rail contains at least one complete context module such as a
secondary story, a compact table or timeline with explanation, or two useful
briefs. A section label, eyebrow, live badge, dateline, rule, pull quote without
context, or one-line status does not justify a column.

Treat the opening grid as a bounded front-page package, not a column scaffold
for the entire lead article. When a rail ends, close the grid or let the next
lead figure, body block, or supporting group span the freed columns. In
particular, never leave a label-only or mostly empty vertical corridor beside a
multi-screen headline, image, or article body.

Use whitespace to separate ranked modules, not to preserve an empty track.
Prefer compact fluid gaps and padding. At a desktop preview around 1200 pixels
wide, useful content should appear across every active opening column; if one
column ends after its heading or badge, choose a simpler layout.

## Required hierarchy

1. A compact utility strap with the real date, generated time, timezone, and
   issue label. Mark it with `data-edition-strap`.
2. A centered text masthead reading **Daedalus Daybook**.
3. A short department rail derived from the actual edition, followed by a
   double black rule. Mark it with `data-department-rail` and an `aria-label`.
4. One content-aware opening grid. Choose its feature, two-column, or
   three-column mode from the layout-utilization rules above. Mark it with
   `data-lead-grid` and `data-lead-layout`, and mark its lead article with
   `data-lead-story`.
5. Supporting story groups separated by hairline horizontal and vertical rules.
6. Department sections chosen from real coverage, such as the day ahead,
   systems desk, scoreboard, local desk, technology, culture, or signals. Mark
   each selected section with a short `data-department` value.
7. A concise editor's note or analysis block, then the complete interest
   coverage ledger. Give the note `id="editors-note"`.
8. A final sources and image credits section.

Vary section composition according to rank: split feature, narrow dispatch,
ruled brief, timeline, pull quote, or compact table. Do not repeat one card grid.

## Validation markup

Use these stable attributes. They are part of the daily-summary interface.

```html
<html lang="en" data-daybook-version="2">
  <main id="daybook">
    <p data-edition-strap>Tuesday, August 25, 2026 · 12:00 p.m. EDT</p>
    <h1>Daedalus Daybook</h1>
    <nav data-department-rail aria-label="Edition departments">...</nav>
    <article
      data-story
      data-lead-grid
      data-lead-layout="two-column"
      data-lead-story
      data-interest-key="ai-infrastructure"
      data-source-url="https://primary.example/story"
    >
      ...
      <figure
        data-image-source-url="https://images.example/photo.jpg"
        data-source-page="https://primary.example/story"
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
    <section data-department="technology">...</section>
    <section id="editors-note" aria-labelledby="editors-note-heading">
      ...
    </section>
    <section id="coverage" aria-labelledby="coverage-heading">
      <ul>
        <li
          data-interest-key="ai-infrastructure"
          data-coverage-status="covered"
          data-source-url="https://primary.example/story"
        >
          ...
        </li>
      </ul>
    </section>
    <section id="sources" aria-labelledby="sources-heading">...</section>
  </main>
</html>
```

Every manifest key appears on exactly one coverage-list item. Valid coverage
statuses are `covered`, `quiet`, and `unavailable`. A covered item requires an
HTTPS `data-source-url`. Quiet and unavailable items require visible explanatory
text, not an empty label.

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
- Use meaningful alt text and visible captions. Do not encode essential meaning
  only through color.
- At or below 740px, collapse to one ranked column: utility strap, masthead,
  lead headline, lead image, secondary story, briefs, departments, ledger, and
  sources. Prevent horizontal scrolling; do not merely shrink desktop columns.
- Remove desktop-only rail borders and gaps when columns collapse. Do not leave
  empty wrappers ahead of the lead headline or between ranked mobile modules.
- Include `@media print` rules that remove nonessential controls, keep ink black,
  preserve captions, and avoid breaking a story or figure across pages.
- Use no JavaScript. Motion is unnecessary for a newspaper edition.

## Final response

The raw file sent to validation starts at `<!DOCTYPE html>` and ends at
`</html>`. After validation, return that exact document inside one `html` code
fence with no surrounding prose.
