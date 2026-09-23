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
6. Editor's Note and edition footer. Omit the Sources section and desk ledger;
   keep source links on the reporting and image credits in figure captions.

At or below 740px, every region becomes one ranked column in DOM order. The
lead comes first, followed by Weather and Email & Calendar, their overflow,
operations detail, supporting departments, and Editor's Note.

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
- Keep quiet desks internal. Mention material source limitations briefly beside
  affected reporting or in the Editor's Note; do not create filler panels.

These limits prevent one long story from pinning unrelated columns open and
creating the empty corridor seen in the v3 layout.

## Reporting density and voice

Lead with the most important supported conclusion or decision needing
attention. Explain its consequence for the reader's operations, customers,
economics, or plans before recounting activity. Begin operations with a plain,
evidence-backed verdict such as stable, watching, degraded, or action required.
Avoid alarmist headlines and do not invent a business consequence for a quiet day.

Distinguish observed facts from interpretation, recommendations, and
commitments. Identify production observations, controlled tests, published or
customer reports, and estimates. Give numbers denominators and scope: affected
versus total, current versus historical, ready versus desired. Include technical
detail when it changes the decision, preserving the capability, workload,
environment, baseline, and operating requirements needed to interpret or repeat
a result. Throughput alone does not establish lower cost or a better customer
experience.

Connect cases to broader implications only as far as their evidence supports.
A single launch, benchmark, or customer example is not a universal market
trend. Keep historical results separate from today's progress. The Editor's
Note may synthesize reported facts or propose a priority; it must not introduce
unsupported claims or imply that a proposed priority is already agreed.

Put the needed decision or validation near the fact that creates it. Explain
what it would resolve and who should act, distinguishing confirmed owners and
dates from proposals. Never invent metrics, ownership, deadlines, or delivery
commitments. Keep private mail and calendar copy discreet; prefer “prepare
for” and “reply to” over unnecessary quotations.

Use clear, natural English, concrete verbs, familiar words, declarative
headlines, precise deks, and focused paragraphs. Let the reporting determine
paragraph and list structure within the fixed page layout. Avoid repeated
sentence patterns, symmetrical slogans, forced lists of three, promotional
language, em dashes, and vague phrases such as “unlock value.” Headings and
lists should help scanning. The fixed masthead tagline is publication identity,
not a pattern to repeat in reporting.

Make every story understandable on its own. Explain how material uncertainty
affects its conclusion or next action; avoid unexplained research shorthand
and blanket disclaimers. Keep detailed chronology and supporting evidence in
the continuation and linked sources. Before finishing, check that the reader
can identify the central conclusion, assess its evidence, and understand any
requested action. Apply this same voice to the sourced text fallback. Aim for
five to eight minutes only when the reporting earns that length; a quiet
edition should be visibly shorter.

## Structured provenance

Use the source objects in `references/edition-format.md`. The renderer converts
them into stable attributes:

- public reporting becomes `data-source-kind="web"` with an HTTPS
  `data-source-url` and a safe visible link;
- live operational or personal reporting becomes `data-source-kind="tool"`
  with a comma-separated `data-source-ref`;
- weather and personal modules carry `data-coverage-status`; all desk statuses
  stay in the internal validation manifest without a visible ledger;
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
  </main>
</html>
```

Do not reproduce these elements by hand or edit them after rendering. The raw
file sent to validation starts at `<!DOCTYPE html>` and ends at `</html>`.
Return the exact validated document inside one `html` fence with no surrounding
prose.
