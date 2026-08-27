# The Daily Daedalus editorial specification

Use this reference while ranking a full daily-summary edition into the fixed
v4 renderer regions. The renderer owns the markup and CSS; the editor owns
selection, hierarchy, brevity, and truthful sourcing.

## Identity

The masthead is **The Daily Daedalus**. Directly beneath it, include the
standing line **One reader. One editor. No filler.** The canonical template
loads the approved Cheltenham stylesheet:

`https://g1.nyt.com/fonts/css/web-fonts.c851560786173ad206e1f76c1901be7e096e8f8b.css`

The page uses warm-white newsprint, near-black ink, muted secondary text, thin
rules, and red only for a genuinely urgent condition. It is an edited
newspaper, not an observability dashboard. Do not add rounded cards, gradients,
glow, ornamental shadows, dark panels, or corporate-brand treatments.

## Fixed page composition

The template renders these regions in order:

1. A utility strap marked `data-edition-strap`, centered masthead, standing
   line, and department rail marked `data-department-rail`.
2. A desktop 7/5 front page marked `data-lead-grid data-lead-layout="split"`.
   Cluster & Infrastructure is the bounded lead on the left. Weather and Email
   & Calendar stack on the right.
3. A full-width day-ahead continuation when the right rail exceeds four agenda
   items or two mail actions, or when a three-day look-ahead exists.
4. A full-width operations continuation marked `data-lead-continuation`.
   Independent modules balance into two editorial columns on wide screens.
5. Supporting departments as separate ranked bands. The first of three or more
   stories becomes the feature; later stories form compact pairs.
6. Editor's Note, complete desk ledger, sources, and image credits.

At or below 740px, every region becomes one ranked column in DOM order. The
lead comes first, followed by Weather and Email & Calendar, their overflow,
operations detail, supporting departments, ledger, and sources.

## Opening budgets

The front grid is a bounded package, not a container for the complete
operations report.

- Use one operations headline, one dek, one verdict, one or two paragraphs
  totaling at most 220 words, and at most one five-row snapshot table.
- Put restart timelines, pod tables, GPU details, Flux, UniFi, Synology, mirror
  state, and other extended evidence in `operations_details`.
- Covered Weather always contains today plus three complete days.
- The opening personal rail contains the first four agenda items and first two
  actionable mail items. The renderer moves all remaining items below the grid;
  do not manually truncate them.
- A quiet or unavailable desk belongs in the ledger, not in a filler panel.

These limits prevent one long story from pinning unrelated columns open and
creating the empty corridor seen in the v3 layout.

## Reporting density and voice

- Begin operations with a plain verdict such as stable, watching, degraded, or
  action required, supported by current evidence. Avoid alarmist language.
- Give numbers denominators and scope: affected versus total, current versus
  historical, ready versus desired.
- Put the reader's next action near the fact that creates it.
- Use short declarative headlines, precise deks, and compact paragraphs.
- Keep private mail and calendar copy discreet. Prefer “prepare for” and
  “reply to” over unnecessary quotations.
- The Editor's Note may connect reported facts or name the day's priority; it
  must not introduce an unsupported claim.
- Aim for five to eight minutes only when the reporting earns that length. A
  quiet edition should be visibly shorter.

## Structured provenance

Use the source objects in `references/edition-format.md`. The renderer converts
them into stable attributes:

- public reporting becomes `data-source-kind="web"` with an HTTPS
  `data-source-url` and a safe visible link;
- live operational or personal reporting becomes `data-source-kind="tool"`
  with a comma-separated `data-source-ref` and visible tool names;
- every ledger item carries its `data-coverage-status` from the structured
  edition and appears exactly once;
- Every `<img>` belongs inside a `<figure>` with URL, page, caption, credit,
  meaningful alt text, asynchronous decoding, and no-referrer behavior.

Use two to four images only when exact source material is available and
relevant. Never generate, edit, synthesize, or substitute stock imagery.

## Stable v4 interface

The canonical template emits:

```html
<html
  lang="en"
  data-daybook-version="4"
  data-template-version="daybook-v4"
  data-policy-version="2026-08-27"
>
  <p class="edition-strap" data-edition-strap>...</p>
  <nav
    class="departments"
    data-department-rail
    aria-label="Edition departments"
  >
    ...
  </nav>
  <main id="daybook">
    <section class="front-page" data-lead-grid data-lead-layout="split">
      <article
        class="lead-story"
        data-story
        data-lead-story
        data-layout-slot="lead"
        data-desk-key="cluster-infrastructure"
      >
        ...
      </article>
      <aside class="day-ahead" data-day-ahead data-layout-slot="day-ahead">
        ...
      </aside>
    </section>
    <section id="operations-continuation" data-lead-continuation>...</section>
    <section id="editors-note">...</section>
    <section id="coverage">...</section>
    <section id="sources">...</section>
  </main>
</html>
```

Do not reproduce these elements by hand or edit them after rendering. The raw
file sent to validation starts at `<!DOCTYPE html>` and ends at `</html>`.
Return the exact validated document inside one `html` fence with no surrounding
prose.
