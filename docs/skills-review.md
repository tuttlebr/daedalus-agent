# Skill review records

## 2026-09-23: application communication style

Reviewed all 20 skills against the reader's conclusion-first, evidence-led
communication guidance. Updated editorial and reporting instructions in the
16 skills listed in [the surface review](communication-style.md#skill-review),
including Daily Daedalus's main instructions, bundled editorial and format
references, and sourced text fallback. Technical reports retain baselines and
operating conditions; proposed owners, dates, priorities, and actions remain
distinct from commitments. Creative work retains explicit artistic requests
and exact lettering.

The application prompts use shared full, source-summary, or prose guidance
according to their purpose. Existing JSON/HTML contracts, permissions, source
gates, and artifact delivery still apply. The surface review records prompt
ownership and concrete editorial acceptance cases. Validation checks guidance
delivery, skill/resource loading, and output compatibility; it does not claim
that a live deployment or model-behavior evaluation has occurred.

Validation: 1,867 builder tests passed, 5 integration tests skipped, and coverage
was 88.15%. The full collection is blocked by the pre-existing missing
`test-fixtures/code-audit-independent-20260909.json.gz`; the successful run
excluded only `test_independent_audit_contracts.py`. All 20 skills passed
frontmatter validation, and the installed NeMo Agent Toolkit runtime loaded
all 20 skills and 113 text resources and validated 18 native tools. Pre-commit,
local skill links, Helm lint/render, and both rendered backend prompt copies
passed. No deployment or stored-memory migration was performed.

## 2026-09-21: daily-summary edition contract and rendering outcomes

The nested edition contract is now one maintained JSON schema used by the tool
catalog and the standalone renderer. A stdlib helper checks supported schema
keywords and collects structural errors across the edition, so one correction
can address all reported block defects. Existing source, coverage, image, HTML,
and two-attempt gates remain in force. The briefing instructions direct selected
source-page fetches into the next eligible parallel round and stop optional
discovery when reporting has sufficient evidence.

The renderer checks sandbox capabilities before staging canonical resources and
reports its execution path and recovery reason. Text fallback has a distinct
degraded outcome instead of ordinary completion; only canonical validated HTML
is marked as an artifact success. The runtime, rather than skill prose, owns
these checks and outcomes.

Validation records include synthetic aggregate-error regressions, standalone
stdlib-only rendering, the real parser/dispatcher and every bundled text
resource, schema serialization and invocation through the actual NAT/LangChain
wrapper, and sandbox adapter contracts. HTTP scenarios use a synthetic model
provider and the real sandbox to check exact inline HTML, one correction, and
the bounded text fallback with its distinct outcome.
Private trace payloads are used only in temporary local reproduction; no private
edition data is included in fixtures. These checks do not establish future model
adherence or a deployed end-to-end latency improvement.

## 2026-09-21: daily-summary preparation and source latency

The initial daily-summary load now returns the four required canonical policy,
sourcing, format, and editorial references together, plus a fresh UTC and reader
timezone clock. The dispatcher reads the existing resources without copying them
into a second maintained bundle, and a missing resource or invalid timezone
prevents the successful-load event. Clock refresh remains required after an
authorization pause or resumed briefing. Other skills retain on-demand resources.

The briefing batches independent curated-feed discovery questions, hydrates only
selected reporting, and uses structured National Weather Service evidence. Once
personal-source authorization and memory merge finish, clearly permitted baseline
reads can share a parallel round with deterministic source planning. Source
exclusions, conditional research, anomaly follow-ups, source-only images, and the
renderer validation and text-fallback guarantees remain in force.

Validation: focused tests covered all 20 skills and every bundled text resource,
exact canonical bootstrap contents, missing-resource failure, fresh local dates
and daylight-saving offsets, routing, and privacy-safe duration events. The
installed NAT/LangGraph runtime passed the full agent-loop contract and added
streaming checks: first-chunk delivery precedes provider completion, measured
model duration includes provider wait, and failure or cancellation closes the
span and provider stream. These are source and offline runtime checks, not a live
briefing latency benchmark or proof of model adherence. No deployment was performed.

## 2026-09-19: use-hue-api compact reference

Added the latest Hue skill with a generated JSON reference for 155 REST
operations, an offline reference reader, and an optional HTML importer. The
superseded HTML export is not bundled. Corrected paths and links for Daedalus,
documented explicit resource staging for sandbox use, and tied live operations
to the discovered `hue_mcp_server` catalog. Registered the skill in the ownership
table and updated the catalog expectation to 20 skills. The generated reference
has a dedicated 2 MB pre-commit limit; other files retain their existing limits.

Validation: 82 catalog, parser, dispatcher, and tool-alignment tests passed,
including discovery and text-resource loading across all 20 skills. Frontmatter
and local links passed. Offline helper checks covered reader pagination,
alternate references, invalid inputs, importer deduplication, nested required
fields, and rejection of conflicting copies without overwriting the output.
The bundled reference contains 155 distinct operation contracts. These checks
validate packaging and helper behavior; no bridge operation, model behavior
evaluation, or deployment was performed for this skill addition.

## 2026-09-16: fantasy-football-recap Fowling Dispatch design pattern

Made the supplied Fowling Dispatch visual system the standard for every recap,
live edition, preview, season review and matching PDF. The skill now loads a
focused design reference and a standalone HTML template with the white,
charcoal, burgundy and gray palette; Georgia-led typography; centered masthead
and lead; ruled sections; story/sidebar columns; score tables and bars; matchup
recaps; awards; watch box; and sources footer. League identity and verified
reporting populate the template instead of reusing the reference edition's facts.
Existing reporting gates and the required ESPN companion remain intact.

The template includes semantic table headers, focusable table scrolling on narrow
screens, wrapping for long names, and print rules for repeated headers and short
components. Chart widths are generated from each edition's checked scores,
including zero-width bars for zero; unsupported score scales need another chart
or no chart.

Validation: 103 focused recap, catalog, parser, dispatcher and tool-alignment
tests passed, including resource loading across all 19 skills. Skill frontmatter,
local links and pre-commit checks passed. A temporary synthetic nine-team edition
was rendered in Chromium at 1280px, 390px and 320px and exported to a six-page
Letter PDF. Layout checks covered white backgrounds, burgundy accents, responsive
type, page overflow, score-bar proportions, print table visibility and headers,
and absence of external requests. Desktop/mobile screenshots and rendered PDF
pages were visually inspected; PDF text bounds remained inside the pages. This
checks the template, not a live league edition or model adherence. No deployment
was performed.

## 2026-09-16: fantasy-football-recap presentation and required companion

Required a pure white (`#FFFFFF`) page and newspaper canvas across desktop,
mobile, and print while preserving creative typography, accents, and story layout.
Excluded blocks explaining the website or its layout; necessary reporting caveats
remain beside affected stories. Every edition now loads and applies
`espn-fantasy-football`, with matching ownership and companion integration guidance
that preserves the recap's reporting gates and newspaper format.

Validation: both edited skills passed frontmatter validation. All three catalog
tests passed, including parser/dispatcher discovery and resource loading across
all 19 application skills. These are instruction and loading checks; no live
edition, model behavior evaluation, rendered publication, or deployment was performed.

## 2026-09-15: fantasy-football-recap

Added a weekly league newspaper skill with standalone HTML/file delivery and
optional visually checked PDF. A reporting contract documents the ESPN
connector's scoring-period versus matchup-period behavior, historical lineup
and standings limits, actual versus projected stats, and availability checks.
The editorial gates require evidence for win/loss stories, records, superlatives,
upsets, comebacks, legal bench substitutions and transaction impact.

The bundled decimal scoreboard checker consumes original ESPN response objects
and reporter-supplied status evidence. It checks context, team/matchup coverage
within supplied responses, score precision, official winners, ties, byes and
multiweek totals.
It separates final winners from live leaders and withholds full-league extrema
when coverage or comparability is incomplete. Its status annotations are trusted
inputs: the helper does not establish source completeness or finality, audit
prose/standings, or validate historical lineup legality. Daedalus loads it as text
for explicit sandbox staging; no new runtime tool or execution permission was added.

Validation: 103 focused Python tests passed, including 26 synthetic recap cases
and discovery/resource loading across all 19 application skills, parser/dispatcher
checks, and tool-skill alignment. Skill frontmatter and local links passed.
This validates the helper and source contracts; no live league edition, model
behavior evaluation, rendered publication, or deployment was performed.

## 2026-09-12: daily-summary token efficiency

Removed the Sources and desk ledger sections, their template CSS, and repeated
coverage explanations/source objects. Coverage now contains desk keys and
statuses, with policy labels derived by the renderer. Public headlines link to
their sources; tool provenance stays in reporting attributes and image credits
stay in captions. Quiet desks have no visible entry, and material source gaps
belong beside affected reporting or in the Editor's Note. These instructions
also apply to the text fallback.

Validation: 205 Python 3.12 tests passed across the renderer, HTML validator,
renderer tool, skill parser/dispatcher, catalog, and backend contracts. The
remaining provider transport test passed on rerun after restoring
`llms.tool_calling_llm.truncation: auto`. Both desktop/mobile Playwright layout
tests passed. The installed NAT runtime loaded all 18 skills and 102 text
resources. Frontmatter and local skill links passed.

The dense fixture's compact JSON input fell from 2,739 to 2,332 tokens (14.9%)
and its rendered HTML from 8,287 to 7,015 (15.3%), measured with `o200k_base`.
These are fixture measurements, not live end-to-end briefing usage. No
deployment or external-source briefing was performed.

## 2026-09-12: daily-summary recovery

The renderer retains the submitted edition on failure and no longer terminates
the whole request with an error-only HTML edition. The skill now tells the agent
to deliver available, sourced reporting as text when its two rendering attempts
are exhausted. Successful HTML still requires canonical validation and exact
inline delivery. Source, read-only, and publication boundaries are unchanged.

Validation: 125 focused builder tests passed, including renderer failures and
configuration/dispatcher contracts. The pinned toolkit runtime loaded all 18
skills and 102 bundled resources; the edited skill passed frontmatter validation
and local link checks. These checks establish the runtime contract, not the
quality of a live briefing from external sources.

## 2026-09-12: daily-summary latency safeguards

The interactive briefing reuses the bounded automatic Hindsight context when
present instead of repeating a 24-result memory recall. A missing automatic
context still permits one explicit recall. The runtime exposes a briefing-only
tool catalog and ends research after five minutes, leaving the renderer and
sourced text fallback as the only final-synthesis paths. Source, read-only,
validation, and OAuth boundaries are unchanged.

Validation: all changed files passed pre-commit; 1,470 builder tests passed with
75.96% coverage (4 integration tests skipped, and the independent-audit test
file could not be collected because its independently generated fixture is
absent from this checkout). The pinned NAT runtime accepted the configuration, registered
the custom telemetry and RSS components, and passed its agent-loop contract,
including a synthetic stalled final stream followed by exactly one bounded
synthesis-only retry. Helm lint/render passed, and backend image
`sha256:6662c208199a6db9add9b68e71a2771041b0cdf73ad870dcd2be19c02a4beb73`
was deployed in Helm revision 36. A live daily summary then completed in 224.0
seconds without an explicit `get_memory` call. Both renderer attempts rejected
invalid input, after which the workflow completed with the required text
fallback. Live Phoenix OTLP requests returned HTTP 200 and the backend recorded
no exporter errors.
