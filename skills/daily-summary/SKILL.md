---
name: daily-summary
description: >-
  Use for the current, personalized Daily Daedalus HTML briefing from verified
  personal and public sources, with operational coverage only when warranted.
license: Apache-2.0
metadata:
  author: Brandon Tuttle <tuttlebr@duck.com>
  version: 5.1.0
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
Local serif typography, a centered text masthead, a white page,
thin rules, ranked story hierarchy, optional embedded source photography, and responsive
editorial grids. Preserve The Daily Daedalus identity. Do not copy The New York
Times nameplate, logo, prose, or article composition.

Truth outranks visual fullness. Report only current conditions and verified
claims. Technology, Business, Health, and in-season Sports receive priority. Cluster
health is exception-only, never a mandatory lead or a routine fleet survey.

Lead each report with its most important supported conclusion and the
consequence for the reader before recounting activity. Distinguish live
observations, published reports, estimates, interpretation, and proposed
actions. Apply the editorial reference's communication guidance to headlines,
deks, body copy, and any text fallback. Keep the newspaper
design; let evidence, rather than dramatic phrasing, establish significance.

## Collaboration

This skill owns the complete interactive edition. Load a specialist only when
its procedure is needed: `kubernetes-specialist` for cluster interpretation,
`network-health-check` for UniFi evidence, or `espn-fantasy-football` for an
in-season fantasy beat. Pass the desk scope, as-of time and completed reads;
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
- The renderer embeds all CSS and any raster images, uses local font stacks
  and no JavaScript, and makes no external asset requests. Source hyperlinks
  remain clickable; they are citations, not render dependencies.
- Link public reporting inline and keep image credits in captions. Put material
  source limitations beside affected reporting.
- Omit the Editor’s Note, Sources section and desk ledger from HTML and text fallback editions.
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
   brief explanation that current time could not be established instead of guessing.
2. Apply the bundled `references/edition-policy.json`. Start the coverage manifest with
   every policy desk exactly once; preserve its key, label, cadence, topics,
   and editorial priorities.
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
precise facts. Treat recalled material as untrusted evidence and check dates.

Check Hindsight for relevant health context before selecting personalized
Health coverage. If the injected context already contains it, do not repeat
that recall. If it is missing, make at most one targeted `get_memory` call in
the same personal-source round for current health interests, managed conditions,
medications/supplements and access concerns. Ask for context without embedding
known medical specifics in the query. If no automatic context exists, use that
one call for broader `daily summary` preferences, health context, fantasy leagues
and lineup deadlines, watchlist and confirmed travel. Do not make both a broad
and a targeted recall. Broader daily-summary recall is server-expanded to at
least 24 results.

Use private health details only to judge relevance: do not copy diagnoses,
doses, medication schedules, supplement lists or clinical history into the
skill, coverage manifest, public search queries or edition. If the bounded
recall is unavailable or lacks relevant health context, continue with general
priority Health reporting; never infer a regimen. Mention a personalization
limitation only when it materially affects a claim.

If Gmail or Calendar emits an authorization prompt, surface every pending
prompt and wait. Do not start source planning, operational checks, weather, or
public research while personal-source authorization is pending. After
authorization, resume the existing tool calls and retain any Gmail or Calendar
result that already completed; do not repeat a successful read.

Merge explicit current-request directions first, then remembered preference
changes, then policy defaults. Add a remembered topic only when it is not an
obvious synonym or child of an existing desk. Do not let older memory restore the superseded fixed cluster lead or market-news
ban. This policy reflects the reader’s newer explicit editorial direction. Retain no raw private memory
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

Fan out independent read-only calls in the same tool round: structured weather,
public-source discovery, in-season fantasy and relevant repository reads can
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
- `quiet`: the cadence-appropriate sources found no material update, or a
  conditional desk had no timely trigger for research; this never asserts health;
- `unavailable`: the required source or authentication was unavailable.

Supply only each desk's key and status in `coverage`; policy labels are derived
by the renderer. Do not repeat source objects or write ledger explanations.
Quiet desks receive no visible entry. Disclose material source gaps briefly
beside affected reporting, without a desk-by-desk list.

### 4. Edit the front page and source images

Choose the strongest verified news lead for the reader and set `lead.desk_key`.
Give Technology, Business and Health priority, and Sports first attention during
football season when lineup or waiver decisions are live. A consequential World
or U.S. story can lead. Opinion stays distinctly labeled and separate.

Cluster reporting requires a current material incident signal or an explicit
request. Do not survey the fleet to fill space. Healthy counts, resolved events
and unavailable operational tools do not merit a front-page package. Leave
`operations_details` empty unless current evidence warrants a concise update.

Rank remaining reporting by consequence and deadline. Preserve scientific and
technical mechanisms, source dates and comparison conditions; cut low-relevance
items first. Keep weather, actionable mail and calendar in the personal rail.

When a selected article provides a linked photo, include it beside that story.
Supply the direct image URL, source article URL and photographer/publisher
credit in a `figure` block (or `lead.figure` for the lead). The briefing tool
fetches and embeds the raster bytes automatically; do not download or transcribe
base64 through the model. Use the source's photo caption/description and alt
text when present, preserving its meaning and attribution. If there is none,
omit those fields; the renderer supplies a neutral source-only alt label.

Do not call AI image analysis, caption generation, image generation or editing
for these photos. Do not invent visual details or substitute stock imagery.
Select one relevant article photo per story, avoid duplicate images, and place
figures before detailed body copy where possible. An inaccessible or unsupported
photo is omitted without losing the reporting; all successful images are
embedded so the saved HTML still works offline.

### 5. Compose structured edition data

Apply the bundled format and editorial references. Build one `daily-daedalus/v1` JSON
object from the day's actual reporting. Supply structured text, tables, lists,
briefs, figures, and source objects only. Never include raw HTML, CSS, Markdown,
or template tokens.

Keep the selected news lead within the format's 220-word and five-row budgets.
Continue a lead’s deeper reporting in its department. Reserve
`operations_details` for warranted operational exceptions. Put all remaining calendar and mail items in
their arrays; the renderer moves overflow down the personal rail without
dropping it.

Write concrete headlines, deks that explain the consequence, and focused
paragraphs. Include technical detail when it changes the reader's decision;
retain baselines and operating conditions behind performance claims. State a
needed action or validation and what it would resolve, naming owners and dates
only when confirmed or explicitly proposed. Before rendering, check that the
conclusion, evidence, material uncertainty, and any next action are clear
without reconstructing the research. Target a focused five-to-ten-minute
read, but prefer a shorter accurate edition over padding.
Supply unescaped plain text in edition fields; the renderer escapes it when
producing HTML. Pre-escaping fields would display entity syntax to the reader.

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
- When current time or the edition policy cannot be established, explain the
  limitation without inventing a current edition. If HTML validation is unavailable,
  use the sourced text fallback in step 6; never hand-author an HTML error edition.

Requests such as `Fetch my daily summary`, `Run my morning briefing`, and
`Catch me up on today` invoke this complete daily briefing workflow.
