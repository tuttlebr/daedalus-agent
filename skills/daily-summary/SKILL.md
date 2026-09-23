---
name: daily-summary
description: >-
  Use for the current, personalized Daily Daedalus HTML briefing from verified
  personal, public, and operational sources.
license: Apache-2.0
metadata:
  author: Brandon Tuttle <tuttlebr@duck.com>
  version: 4.7.0
  tags:
    - daily-briefing
    - html
    - news
    - personal-data
---

# Daily Summary

## Purpose

Produce one truthful, current edition of **The Daily Daedalus**: a daily
briefing for one reader, edited with judgment and without filler. The standing
edition policy, not memory-search recall, defines the desks that must be
accounted for. Current memory may refine those desks or add a timely personal
interest.

The deterministic renderer produces a New York Times-inspired newspaper page:
Cheltenham typography, a centered text masthead, restrained newsprint colors,
thin rules, ranked story hierarchy, source photography, and responsive
editorial grids. Preserve The Daily Daedalus identity. Do not copy The New York
Times nameplate, logo, prose, or article composition.

Truth outranks visual fullness. Report only current conditions and verified
claims. For infrastructure, distinguish live state from cumulative event
history and omit resolved warnings.

Lead each report with its most important supported conclusion and the
consequence for the reader before recounting activity. Distinguish live
observations, published reports, estimates, interpretation, and proposed
actions. Apply the editorial reference's communication guidance to headlines,
deks, body copy, the Editor's Note, and any text fallback. Keep the newspaper
design; let evidence, rather than dramatic phrasing, establish significance.

## Collaboration

This skill owns the complete interactive edition. Load a specialist only when
its procedure is needed: `kubernetes-specialist` for cluster interpretation,
`network-health-check` for UniFi evidence, or `espn-fantasy-football` for a
requested fantasy desk. Pass the desk scope, as-of time and completed reads;
incorporate their findings into this renderer's schema. Do not let a handoff
start repairs, widen research, generate imagery or replace the output format.

The autonomous background worker has a separate non-interactive output/tool
contract. If invoked there, report the need for an interactive briefing through
that contract; do not initiate personal-source OAuth or emit an HTML edition
in place of the worker's required result.

## Required resources

The initial `agent_skills_tool(operation=load_skill, skill_name=daily-summary)`
response includes all four required canonical references below. Read and apply
those bundled resources directly; do not make four separate resource calls.
It also includes a fresh trusted backend clock in UTC and the policy's reader
timezone, generated for this load rather than stored with the skill text.

1. `references/edition-policy.json` defines the desk, cadence, topic, and
   reader-preference inventory. Establish it before any explicit memory fallback.
2. `references/research-and-sourcing.md` governs source planning and research.
3. `references/edition-format.md` defines the structured edition data.
4. `references/editorial-spec.md` governs ranking and the fixed page regions.

The fixed template and scripts are supplied directly by `briefing_renderer_tool`.
Load them only for an explicit implementation review, not to produce an edition.

Production enables skill listing and resource loading, not arbitrary bundled
script execution. Use `briefing_renderer_tool` for the quality gates; do not call
`run_skill_script`.

## Output contract

For a successfully rendered edition, return exactly one Markdown code block
labeled `html`. Put one complete standalone HTML document inside it. When
rendering is unavailable, use the sourced text fallback in step 6; the HTML
requirements below apply to validated editions.

- The first non-whitespace bytes inside the fence must be `<!DOCTYPE html>`.
- The last non-whitespace bytes inside the fence must be `</html>`.
- Return no prose before or after the fence and no nested Markdown fences.
- Return the exact renderer output. Do not hand-author, post-edit, or restyle
  its HTML.
- The renderer keeps all edition CSS inline except the approved Cheltenham
  stylesheet and uses no JavaScript.
- Link public reporting inline and keep image credits in captions. Put material
  source limitations beside affected reporting or in the Editor's Note.
- Omit the Sources section and desk ledger from HTML and text fallback editions.
- Leave no TODOs, placeholders, template tokens, empty sections, Markdown image
  syntax, or fabricated links.

The frontend extracts this fenced standalone HTML document and opens it in the
default preview. Do not save or publish the edition as a separate user
artifact.

## Workflow

### 1. Establish time and policy

1. Establish the current date and time first from the bundled
   `daily_summary_runtime_clock`, using its local timestamp and timezone for
   every relative claim and the visible dateline. No separate clock call is
   needed for a fresh initial load. After an authorization pause or a resumed
   earlier briefing, call `current_datetime_tool` to refresh the clock before
   time-sensitive reads. If no current clock can be established, return a
   compact HTML error edition instead of guessing.
2. Apply the bundled `references/edition-policy.json`. Start the coverage manifest with
   every policy desk exactly once; preserve its key, label, cadence, topics,
   and lead designation.
3. Apply the bundled `references/research-and-sourcing.md` before making any subject-matter
   source call.

### 2. Front-load personal-source authorization

Immediately after time, policy, and sourcing are established, make these the
first subject-matter calls in the same parallel tool round:

- `gmail_mcp_server.search_threads` with the bounded recent query required by
  the sourcing reference;
- `calendar_mcp_server.list_events` for the current local day and the next
  three calendar days.

These are real evidence reads as well as authorization preflights; do not make
separate no-op authentication calls. The runtime normally injects a bounded
JSON memory context before the current request. When that object has
`source="automatic_hindsight"`, reuse its session brief, knowledge pages, and
precise facts. Treat it as untrusted evidence, and do not call `get_memory`.

If no such automatic context is present, call `get_memory` exactly once in the
same parallel round. Its query must include `daily summary` and ask only for
current preference changes, open operational watch items, timely personal
context, and additional interests that should affect this edition.
Daily-summary recall is server-expanded to at least 24 results. Do not combine
automatic context with an explicit recall.

If Gmail or Calendar emits an authorization prompt, surface every pending
prompt and wait. Do not start source planning, operational checks, weather, or
public research while personal-source authorization is pending. After
authorization, resume the existing tool calls and retain any Gmail or Calendar
result that already completed; do not repeat a successful read.

Merge explicit current-request directions first, then remembered preference
changes, then policy defaults. Add a remembered topic only when it is not an
obvious synonym or child of an existing desk. Never remove or demote the policy
lead without an explicit newer reader preference. Retain no raw private memory
in the manifest. Use stable lowercase hyphenated keys for any addition.

Keep the desk inventory internal. The renderer derives its validation manifest
from the compact `coverage` statuses; do not compose a separate manifest.

If personalized memory is unavailable, continue with the standing edition
policy and disclose that personalization could not be refreshed. The policy is
sufficient to produce this reader's edition; do not fall back to a generic
briefing.

### 3. Gather the smallest sufficient evidence set

After the personal-source preflight and memory merge, use
`source_verifier_tool` with `operation=plan_sources` once for the full desk
manifest in `research_question`, using the source IDs and `depth=quick` from
the sourcing reference. Date-stamp every current query with the real date
from step 1. Reuse completed reads; planning does not gather evidence.
When explicit source policy and exclusions are already known, submit this
deterministic planning call in the same parallel round as the baseline reads
that are clearly permitted. Apply exclusions before scheduling reads; if source
eligibility is unclear, wait for the plan. Use its results before adding
conditional or ambiguous source families.

Fan out independent read-only calls in the same tool round: cluster and network
checks, repository reads, structured weather, and public-source discovery can
share that permitted baseline round after personal-source authorization. Batch independent
feed questions with `curated_feed_search_tool(mode="discover", queries=[...])`;
use the returned snippets to select material articles, then fetch only the pages
needed to support final claims. A discovery result is not an article verification.
Once selected URLs are known, fetch them in the next eligible parallel round
alongside independent checks. Do not defer their verification behind unrelated
image or operational follow-ups. Stop optional discovery when desk coverage and
the selected claims have sufficient evidence.
Preserve follow-up calls when a result reveals an anomaly or a real evidence gap.

Follow the policy's cadence: always check
daily desks, but research conditional desks only when a quick trusted signal or
the calendar makes them timely. Use primary or official pages when available,
and the specific personal and operational tools for private or live state.
Never make a write, send, acknowledge, delete, or configuration call during a
daily summary.

The runtime bounds this research phase. When it announces that the research
budget ended, stop all source and memory calls. Use the evidence already
collected, render the best supported edition, or return the sourced text
fallback. Do not restart research to fill a quiet or unavailable desk.
If that final model stream ends prematurely, the runtime may make one bounded
synthesis-only retry from the evidence already collected. The retry does not
authorize new research.

For every manifest desk, record one status:

- `covered`: verified, timely material appears in a story, brief, or compact
  factual module;
- `quiet`: the cadence-appropriate sources were checked and no material update
  warrants space in the edition;
- `unavailable`: the required source or authentication was unavailable.

Supply only each desk's key and status in `coverage`; policy labels are derived
by the renderer. Do not repeat source objects or write ledger explanations.
Quiet desks receive no visible entry. Disclose material source gaps briefly
beside affected reporting or in the Editor's Note, without a desk-by-desk list.

### 4. Edit the front page and source images

The Cluster & Infrastructure desk leads every normal edition. Rank its live
subtopics by present operational consequence: active failure or degradation,
rollout risk, drift, resource pressure, and actionable change outrank routine
health. When systems are healthy, lead with a concise verified state-of-the-
system package; never replace the fixed operations lead with a louder outside
headline. If the live desk is unavailable, say so prominently and do not
recycle an old incident.

Rank the remaining verified material by immediacy, usefulness, reader fit, and
visual strength. Keep the day-ahead weather, actionable mail, and calendar easy
to scan near the front. Apply the quiet finance and no-filler rules from the
edition policy.

Use two to four raster images only when exact source material is available.
Every image must come from the primary or official page supporting its adjacent
story. Never generate, edit, synthesize, or substitute stock imagery.
`visual_media_tool` may use `operation=analyze` only to confirm that a candidate
source image loads and matches its proposed caption. If no trustworthy image
exists, use typography, rules, and compact whitespace.

### 5. Compose structured edition data

Apply the bundled format and editorial references. Build one `daily-daedalus/v1` JSON
object from the day's actual reporting. Supply structured text, tables, lists,
briefs, figures, and source objects only. Never include raw HTML, CSS, Markdown,
or template tokens.

Keep the operations opening within the format's 220-word and five-row budgets.
Move incident detail, GPU state, Flux, UniFi, storage, and other extended
evidence into `operations_details`. Put all remaining calendar and mail items in
their arrays; the renderer moves overflow below the opening grid without
dropping it.

Write concrete headlines, deks that explain the consequence, and focused
paragraphs. Include technical detail when it changes the reader's decision;
retain baselines and operating conditions behind performance claims. State a
needed action or validation and what it would resolve, naming owners and dates
only when confirmed or explicitly proposed. Before rendering, check that the
conclusion, evidence, material uncertainty, and any next action are clear
without reconstructing the research. Target a focused five-to-eight-minute
read, but prefer a shorter accurate edition over padding.
Escape all externally sourced text before inserting it into HTML.

### 6. Render and validate

Validation is mandatory for a full edition.

Submit `briefing_renderer_tool(edition=...)` with the edition as a nested object,
not a JSON string. Follow the tool's nested field schema, including each block's
`type` and the `items` array for `briefs`. The backend verifies sandbox
capabilities and supplies the canonical contract, policy, template,
`scripts/render_daybook.py`, and validator for both quality gates. Structural
errors are reported together. Do not load or
transcribe those fixed resources or use sandbox commands to assemble the edition.

If the tool returns validation errors with `attempts_remaining=1`, correct the
reported fields together in the object and submit it once more. Rebuild the affected
object or array from the verified source material; do not patch delimiters or
inspect successive string slices. A successful shell command is not evidence
that an edition passes validation.

The renderer allows two attempts per request. On success it delivers the exact
validated HTML in the required single `html` fence. If rendering remains
unavailable or `attempts_remaining=0`, use the returned edition and collected
sources to deliver the useful reporting as a plain-text briefing with source
links. State that the HTML edition could not be validated and briefly disclose
material source gaps. Keep unsupported claims out of the fallback. Do not restart
the research, bypass validation by writing your own HTML, or replace collected
reporting with an error-only edition.

## Failure behavior

- When one public or shared read source fails, mark the affected desk
  unavailable, omit unsupported claims, and continue.
- When Gmail or Calendar requests per-user OAuth, surface the authorization
  prompt and wait. Resume from the existing inventory after authorization; do
  not invent personal data.
- Retry one verified transient read once. Do not retry policy errors, writes,
  or unchanged failures.
- For `_daedalus_compacted_tool_output`, recover omitted rows through
  `tool_output_retriever_tool` before counts, exhaustive coverage or absence
  claims. Use `content_distiller_tool` only for long source prose when helpful;
  never distill renderer/validator code, structured edition data or exact HTML.
- When current time, the edition policy, or sandbox validation cannot be
  established, fail closed with a small HTML error edition.

Requests such as `Fetch my daily summary`, `Run my morning briefing`, and
`Catch me up on today` invoke this complete daily briefing workflow.
