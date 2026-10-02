# The Daily Daedalus editorial specification

Use this reference to rank and edit a daily edition. The deterministic renderer
owns markup and CSS; the editor owns selection, evidence and hierarchy.

## Identity and composition

Preserve **The Daily Daedalus** and **One reader. One editor. No filler.**
Use the supplied newspaper reference as a visual direction: white paper,
near-black serif headlines, compact sans-serif utility text, fine gray rules,
a centered masthead, a double-rule department rail and varied story sizes.
Do not copy the Times nameplate, logo or prose. No dashboard cards, shadows,
gradients or decorative status panels.

The canonical `daybook-v4.html` asset retains its runtime filename and version
markers for compatibility. Its current composition is:

1. Dated utility strap, masthead, standing line and links to populated desks.
2. A desktop 2.1/1 grid with independently flowing columns. The main column
   contains the selected news lead followed immediately by ranked departments.
   The narrower rail opens with Health when covered, then weather, mail,
   calendar and their continuation, followed by Opinion and selective lifestyle desks as
   designated by policy placement. Its stories stack in a single column. One column's length never postpones the other's next story.
3. Optional operational exceptions after the newspaper grid.
4. Editor's Note and edition footer. No Sources appendix or desk ledger;
   citations stay on their reporting and image credits in captions.

At 740px and below, the DOM-backed grid becomes one column: lead, personal
rail, ranked departments, any operational exceptions, Editor's Note. Long
headlines wrap, tables scroll within focusable labeled containers, and no text
is clipped or line-clamped. Printing uses normal document flow, repeated table
headers and breakable long articles so a long desk does not create blank pages.

Everything needed to render is in one HTML document: embedded CSS, local
Georgia/Times serif and Arial/Helvetica utility stacks, optional embedded raster
bytes, and no scripts, remote fonts or external assets. Source hyperlinks
remain ordinary HTTPS citations. Typography and semantic tables must look
complete when there are no photographs. Never add imagery merely to fill space.

## Selection and opening budgets

`edition-policy.json` owns desk interests and priority. Choose the strongest
verified lead by personal consequence and deadline, setting `lead.desk_key`.
Technology, Business and Health get first attention; Sports is highest priority
during football season when fantasy decisions are live. World and U.S. can
lead when their implications warrant it. Opinion is separate and cannot serve
as the reported-news lead. Cluster health has no reserved front-page position:
only a current consequential incident or explicit request warrants research.

Use one headline, one dek, one or two lead paragraphs totaling at most 220
words, and optionally one five-row table. `verdict` is optional and useful only
for an actual operational condition. Continue an important mechanism or detailed
comparison in the same desk below the lead; do not cut it just to hit a reading
time. Do not duplicate the lead story in full.

The personal rail opens with four agenda items and two mail actions; the
renderer preserves the remainder and three-day look-ahead below them in that
rail. Covered weather includes today plus three complete days. Departments
with a single story use the main column's full width. With three or more, the
first is a feature and the remaining stories form compact pairs. Quiet desks
are omitted. Lower-priority items can be briefs or absent, never filler panels.

## Reporting density and voice

Lead with the supported conclusion and what changes for compute supply, cost,
competition, work, health, a lineup or a trip. Explain the mechanism. Keep
observations, published reports, forecasts, analyst speculation and editorial
inference distinguishable. Attribute projections to their named originators.
Vendor claims require workload, configuration, baseline, date and limitations;
a claimed speedup is not production evidence or proof of cheaper inference.

Date every numerical claim by its measurement date or reporting period. Keep
source precision, units, denominator, timezone and comparison basis in text or
semantic tables, with the source beside the claim. An edition timestamp alone
is insufficient. Market comparisons use the same session. Fantasy reporting
uses the actual league rules and scoring period. Health studies retain design,
population, effect size, absolute and relative risk where available, time horizon
and uncertainty; say when a requested measure was not reported or derivable.
The HTML structure validates presentation and provenance, not factual truth.

When later final numbers supersede earlier live estimates, replace the old
claim in the story and add a dated correction naming both values and the
source. Never present both as current. An archived edition should make the
correction understandable without access to an earlier conversation.

Opinion is labeled at both desk and story level. Name the writer, state the
argument and show its evidence chain, uncertainty and material counterevidence.
The Editor's Note may synthesize reported facts but may not introduce an
unsupported factual claim or imply an agreed action.

Private Hindsight context selects relevant coverage; it is not publishable
copy. Do not reproduce diagnoses, medication schedules, supplement lists,
clinical history, raw mail or attendee details. A missing medical profile does
not make Health a low-priority desk. Do not infer personal applicability or
recommend dosing changes.

Use concrete verbs, declarative headlines, explanatory deks and focused
paragraphs. Avoid promotional language, “revolutionary,” slogans, forced lists
of three, em dashes and invented consequences. Five to ten minutes is a guide,
not a quota. Compress low-relevance copy before removing a useful mechanism.
Apply the same evidence standard and voice to the sourced text fallback.

## Structured provenance and validation

Use the source objects and blocks in `edition-format.md`. Public reporting has
an HTTPS `data-source-url` linked within its article; connected tools have safe
`data-source-ref` identifiers. `source.detail` can state publication/as-of dates,
but numeric dates must also be visible beside the claim. Every optional image
has verified embedded raster bytes, original image URL, source page, credit,
meaningful alt text and a linked caption. Remote image URLs are provenance only.

Keep the canonical `data-daybook-version="4"`,
`data-template-version="daybook-v4"`, `data-lead-grid`, `data-lead-story`,
`data-layout-slot`, `data-department-rail` and internal coverage markers. The
lead marker identifies the selected desk, not a fixed infrastructure desk.
The optional operations continuation alone uses `data-lead-continuation`.
Do not hand-edit rendered HTML. Return exactly the validated standalone
document inside one `html` fence.
