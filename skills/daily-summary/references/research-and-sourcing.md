# Daily Daedalus research and sourcing

This reference and a trusted current clock arrive with the initial daily-summary
skill load. Establish current time and policy before personal-source preflight.
Plan sources only after the preflight and memory merge complete.

## Source planning and cadence

Call `source_verifier_tool` with `operation=plan_sources` once. Describe the
complete desk manifest and distinguish every-edition checks from conditional
signal checks. Keep default source families enabled unless a reader directive
excludes one. Use the returned tool order as a plan, not as permission to call
unrelated tools. Use `research_question` for the dated manifest and `depth=quick`.
Pass the needed source IDs in `selected_sources_json`: public families
`curated_feeds`, `perplexity_search`, and `known_url_scrape`, plus `workspace_data` and relevant
`repository_data`. Include `fantasy_data` for the in-season Sports beat. Add
`cluster_state` or `network_state` only for an explicit check or a current
material incident signal; do not run routine health reads. Preserve explicit source
inclusions/exclusions and reuse the completed personal-source reads. A broad
topic or approval hint does not require a new approval for this requested
briefing. The plan is a source menu, not a requirement to call every family.
If explicit source policy and exclusions already establish which baseline reads
are allowed, run those reads in parallel with this deterministic planning call.
Never schedule an excluded source, and wait for the plan when eligibility or
conditional source choice is unclear.

The interactive briefing uses a restricted catalog. `nvidia_docs_tool`,
`domain_retriever_tool`, and `x_mcp_server` are available in general chat,
but are not exposed in this mode. Use official public pages through the
available search/fetch tools instead; do not select their unavailable source
families or treat skill loading as a way to widen the catalog. The final
synthesis phase retains only `briefing_renderer_tool`.

Date-stamp queries about current health, today, tonight, this week, latest
results, releases, or schedules. Search snippets are discovery only and must
never support a published story, including qualitative claims. Every public
story or brief must cite a page fetched during this run whose body was read
and supports the reporting. A URL, search summary, fetch error, paywall or login
shell is not a fetched article. If the supporting body cannot be fetched, drop
the story; mark the desk unavailable when no sufficient evidence remains.
Prefer a small number of strong, primary sources over broad link collection.

When a candidate is selected, fetch its source page in the next eligible parallel
round with independent operational reads or image checks. Do not wait for an
unrelated desk to finish before retrieving already-selected evidence. Once the
desk inventory and supported reporting are sufficient, stop optional discovery;
continue only for a material unresolved claim, source gap, or new anomaly.

Always check Weather and Email & Calendar. Give Technology, Business, Health
and in-season Sports first research attention; use quick signals to select
material stories across the other desks. Every `daily-signal-check` desk,
including World, requires at least one dated discovery query before `quiet`;
batch queries and retain the query/result-to-desk mapping internally. A failed
or skipped check is `unavailable`. The policy’s conditional desks need
a timely trigger. Hindsight supplies private personalization, never verification
of a current quote, injury, shortage, treatment guideline or incident.

## Optional operational exception

Use this section only for an explicitly requested check or a current material
incident signal. Scope the read to that signal; do not execute this whole
checklist or inspect every system by default. A quiet omitted desk does not
assert health.

### Kubernetes and GPU Operator

Start with read-only `k8s_mcp_server.getClusterSummary`; call `listContexts` only
when the target context is genuinely ambiguous. Then inspect only the live
resources needed to explain anomalies.

- Cover current node conditions, unavailable or crash-looping workloads,
  failed or pending pods, and incomplete rollouts in the requested or affected
  scope. Inspect all namespaces only for an explicit fleet-wide check or when
  current evidence indicates a shared cluster failure.
- For job health, separate currently failed or active Jobs from cumulative
  historical failure counts. Never repeat an old failure percentage as current
  state without recomputing it.
- Check the GPU Operator's device plugin, DCGM exporter, GPU Feature Discovery
  or NFD, driver components, and GPU allocation symptoms when those resources
  exist. Report an error only when current status, scheduling, or logs support
  it.
- Prefer the owner chain and current condition over a noisy outer status. Name
  the failing layer and affected workload; do not diagnose from a pod phase
  alone.

### GitOps

Inspect current Flux reconciliation resources through the Kubernetes server
when available. Use read-only `github_mcp_server` operations for recent commits,
releases, issues, or pull requests in remembered fleet repositories. Distinguish
source changes from applied cluster state: a recent commit is not proof that
Flux reconciled it, and a healthy Flux object is not proof the desired commit
contains no drift.

Discover installed resource kinds with `getAPIResources` before querying
optional Flux kinds. An absent CRD means Flux is unavailable for that check;
do not retry the same nonexistent kind or classify it as an active outage.

### Home network and storage

Use read-only `unifi_mcp_server` information, inventory, and status operations.
Use the `network-health-check` skill when needed. Report controller
reachability, adopted-device states, pending adoptions, and firmware notices
only from returned integration-API data. Alarm feeds and live WAN/VPN health
may be unavailable; do not invent those fields or infer health from configured
interfaces. Counts require complete current pages.

Report Synology storage health and the rsync mirror to
`/volume2/daedalus/datasets/cluster-maintenance/` only when a connected source
provides current evidence. Do not infer NAS health from UniFi reachability or
reuse a remembered stalled-mirror condition. When no live source exists, state
that limitation briefly beside the operations reporting.

Shared-auth failures on operational tools are operator issues. Mark the
affected source unavailable and continue; do not turn a credential failure into
a cluster incident.

## Weather, email, and calendar

### Saline weather

Use `nws_weather_tool` with Saline, Michigan's latitude and longitude, `days=4`,
and `include_observations=true` to collect the structured National Weather Service
forecast, current observations, and alerts in one call. Cover current conditions
plus the next three complete calendar days. Compare high, low, precipitation, wind, and any
alert that changes plans. Treat unavailable observations separately from the
forecast; a forecast is not a current observation. Retain the response's source
URLs, timestamps, and any coverage gaps. If the structured source is unavailable,
use an authoritative point-forecast page for the supported forecast claims.
Reuse these facts for field-weather interpretation rather than making a second
forecast query.

### Gmail

Use `gmail_mcp_server.search_threads` with a recent, bounded Gmail query. Read a
candidate's full message body with `get_thread(threadId=...)` or the exposed
message-read operation before making it an action item. Search previews and
subject lines are not sufficient evidence. Recover truncated body content;
if the full body is unavailable, omit the action. Preserve exact dates, times,
durations and stated impact. Distinguish an outage's duration from its maintenance
window; never turn a short interruption somewhere within a window into downtime
for that entire window. Surface a small number
of actionable items with sender, subject, and why each matters. Do not list
routine newsletters, expose unnecessary message content, create a draft, or
make another write.

### Calendar

Use `calendar_mcp_server.list_events` for a bounded interval covering the
current local day and the next three calendar days. Before an event becomes an
action item, read its full event description/body and start/end/timezone fields;
use `get_event(eventId=...)` when the list result omits or truncates any of them.
A preview or title is not sufficient. Preserve source times, duration and impact;
do not invent preparation or travel requirements. Separate today's agenda from the
look-ahead and preserve necessary travel or preparation context without
publishing irrelevant attendee data. `list_calendars` is inventory, not a
substitute for events. Never call `suggest_time` during a summary.

Use the connected schema's `startTime`, `endTime`, and `timeZone` fields;
do not substitute REST-style `time_min`/`time_max`. Gmail thread reads use
`threadId`, and Calendar event reads use `eventId`.

Gmail and Calendar use per-user OAuth. When a tool emits an authorization
prompt, surface it and wait. Resume without repeating completed public calls.

## AI, science, and industry

- For AI, NVIDIA, computing, and trusted recent feeds, start with one
  `curated_feed_search_tool(mode="discover", queries=[...], top_k=3)` call for
  independent feed questions. Each query has `query` and the narrowest relevant
  `feed_scope` from the connected schema; do not invent scopes. The tool returns
  ranked, sourced discovery candidates. Fetch selected material articles with
  `webscrape_tool`, or use the feed tool's article mode for one known research
  question. Reuse already returned article content rather than scraping it twice.
  Deepen only the
  changes that affect inference engineering, the NVIDIA stack, Kubernetes GPU
  scheduling, NVIDIA NeMo Agent Toolkit, or the Daedalus project.
- For official NVIDIA product behavior and stable technical context, fetch the
  relevant official page through the briefing's available search/fetch tools.
- For GitHub projects, use read-only `github_mcp_server` release, commit, issue,
  or pull-request operations. A release page or merged change is stronger than
  an aggregator's summary.
- For research, prefer the paper or lab page. State the operational consequence
  and avoid turning a benchmark win into a general result beyond its tested
  workload.
- For infrastructure partnerships and data-center moves, verify the parties,
  scope, and announced timing against primary statements. Include only moves
  that alter the technical or strategic landscape.

Use `perplexity_search_tool` for dated discovery outside the curated feeds, then
`webscrape_tool` on the selected primary or authoritative page.

## Outdoors, sports, finance, and culture

### Outdoors & Field

For birding, prefer recent eBird data, official migration resources, or a
credible local report for Washtenaw County. Separate observed sightings from a
seasonal expectation. Translate the verified weather into useful shooting or
birding windows around Saline and Ann Arbor. Photography guidance should solve
a concrete field or post-processing problem; do not manufacture gear news.

### Sports

In football season load `espn-fantasy-football` and use connected ESPN evidence
for both leagues before making personal lineup claims. Refresh scoring period,
team/league mapping, roster availability, odd-team byes, waiver position, lineup
slots and transaction/lock deadlines. Use team practice reports for DNP/Limited/
Full trends with dates and distinguish these from game designations. Give
snap/target/touch denominators and time windows. Check candidate ownership and
league rules; a familiar player name is not evidence of waiver availability.
Treat user-supplied records, injuries and Week 4 alternatives as dated leads to
verify. State corrections when final numbers replace live estimates.

For each league entry, include:

- **Overall record:** use the team's overall wins/losses/ties for the verified
  league, team and season. When raw ESPN fields are returned, use
  `record.overall.wins`, `record.overall.losses` and `record.overall.ties`;
  otherwise use only fields explicitly identified as overall. Never substitute
  home, away or division splits or infer a record from one matchup. Omit zero
  ties in W-L display; preserve nonzero ties as W-L-T.
- **Lineup verdict:** `Swap` or `Hold`, naming the relevant starter and eligible,
  unlocked alternative with their same-week, league-scored projections and
  projection as-of time. A hold needs comparison evidence too; missing
  projections are unknown, not zero. If evidence is missing, report the lineup
  verdict as unavailable instead of inventing a swap/hold recommendation.
- **Waiver priority:** the team's returned `waiverRank` (or explicitly labeled
  equivalent) and its as-of context;
  if the league uses FAAB, report verified remaining budget and applicable
  priority/tiebreaker. Say unavailable when the tool does not provide it.

These are reporting fields within existing story text or tables, not new schema
keys. Verify private league records, projections and waiver state against ESPN,
never through public-web claim verification. Public projection/news claims still
follow the public verification gate below.

Use official league, team, conference, or broadcaster pages for scores,
standings, and schedules. Cover the Yankees, Steelers, Michigan State men's
football, and Michigan State men's basketball only to their current seasonal
relevance. Prefer the last result, next game, standing or record context, and
one material development. A WFAN listen link is optional and must be verified
as useful for that game-day context.

### Business, World and U.S.

Business has three daily signal checks: NVDA, the semiconductor complex, and
AI-infrastructure economics. Use issuer filings/earnings, exchange or reliable
market data, financing documents and named reporting. Compare NVDA with a
semiconductor and broad-market benchmark over the same session. State price,
currency, date, market timezone and close/intraday/delayed status; do not use a
remembered price as today’s close. Distinguish fiscal quarters from calendar
quarters and authorized buybacks from executed repurchases.

Trace financing counterparties, debt, equity, commitments and actual spending.
For export controls and regulation read the rule or official action: mechanism,
jurisdiction, covered products/entities, exceptions, effective date and whether
it is proposed, final or enforced. Attribute government and vendor projections.
National bank, media-business and Fed/credit news belongs here, not in a forced
New York regional section.

### Health and private context

Check the injected Hindsight context for relevant current health interests.
If it lacks that context, use the single targeted recall allowed by SKILL.md;
when no injection exists, include health in the one broader recall instead.
Do not store or reproduce the reader’s medical specifics in shared resources or
public research queries. Missing private context does not demote Health: cover
material general news without claiming personal applicability.

Use FDA safety communications, labels, shortage databases, published guidelines
and original studies. Identify drug/formulation, notice date and affected scope.
For studies retain population, sample size, design, comparator, duration, effect
sizes, absolute/relative risks and confidence intervals when available. State
when a metric was not reported or cannot be derived. Explain association versus
causation and whether evidence is peer-reviewed, preliminary or replicated.
Report evidence and practical access consequences; do not suggest regimen changes.

### Science, Opinion, Arts, Style and Travel

Follow each desk’s policy lane. Keep scientific mechanisms and limitations in
the story. Opinion needs a named author and explicit label, its evidentiary
chain and relevant counterevidence; do not treat commentary as a primary source
for contested facts. For travel, date real prices and schedules and verify
current plans through private context; an old work trip is not a new itinerary.

### Culture & Leisure

Use primary recipes, artist or venue pages, publishers, and local sources.
Favor vegetarian cooking, seasonal ingredients, exceptional Saline or Ann
Arbor options, electronic/rock/classical listening with time commitment, and
science-fiction media in the orbit of Star Trek or The X-Files. Include a
shared idea with Alicia only when it is genuinely specific and useful.

## Claims, deduplication, and citations

- Before publication, use
  `source_verifier_tool(operation=verify_claim, claim=..., source_url=...)`
  on the lead story's central public claim and every precise number from a public
  source, even when the page already appears to support it exactly. This includes
  figures in headlines, deks, captions, tables, weather and briefs, plus precise
  dates, times, scores, prices, percentages and projections. Check the exact final
  claim with its units, period and comparison basis; one claim may contain related
  figures, but unrelated claims need separate checks. Reuse a successful result
  for identical repetitions; batch independent checks. A verification response
  without fetched supporting page content does not replace the required read.
  Remove or correct unsupported claims; an inconclusive or failed check is not
  permission to publish. Run these checks before the renderer-only phase.
- Never send private mail, calendar, memory, fantasy-league data or live
  operational claims to public-web verification, even if one becomes the lead.
  Verify those against the full authenticated source result. Public facts
  delivered through a tool still require public verification; transport alone
  does not make them private. Do not send surrounding private context with a
  public claim.
- Date every numeric claim at its observation date or reporting period, not
  merely the edition date. Retain exact decimals, units, denominators, currency,
  timezone and comparison basis in plain text or semantic tables. Use Decimal
  arithmetic for financial/fantasy calculations; do not round before deriving
  changes. Identify forecasts and their named originators separately from facts.
- Correct superseded live estimates in the story itself and add a dated
  correction identifying the old value, final replacement and source. Never
  silently mix live/final periods or carry stale user examples into a new issue.
- Attribute a quoted or paraphrased analyst view to that analyst, not to the
  publication or the editor as established fact. Label editorial interpretation
  `Synthesis:` and ground it in the story's verified facts.
- Link every public-web story or brief to its HTTPS source page. For live tool
  or private-tool evidence, retain the tool reference in the reporting's
  structured source object without exposing credentials, opaque identifiers,
  or raw personal content. Do not assemble a separate Sources section. Never
  fabricate a public URL for a Kubernetes, UniFi, Gmail, or Calendar result.
- Use one fact in one best location. Cross-reference or reinterpret it instead
  of repeating forecast, cluster, schedule, or release copy across desks.
- If authoritative sources disagree, state the disagreement or omit the claim.
- If a cadence-appropriate check has no material result, mark the desk `quiet`.

## Pre-render consistency check

Perform one reconciliation pass before rendering or delivering a text fallback:

- Compare every repeated figure in headlines, deks, body text, captions, alt text,
  tables and personal modules with the same verified source value, unit, period
  and status. Recalculate derived values from those inputs. Resolve mismatches
  from evidence; omit a conflicting caption or figure rather than silently
  rewriting a source quotation or propagating its error into the body.
- Convert timestamped instants to the policy's `America/Detroit` timezone using
  the offset applicable on that date, including daylight-saving transitions and
  date rollover. Do not relabel UTC as local or use today's offset for another
  date. Keep date-only/all-day events as dates. Preserve the original timezone
  when it is needed to interpret a market session or deadline.
- Compare source publication/update/observation timestamps and their fetch times
  as UTC instants, retaining the tool's fetch timestamp in the internal evidence
  record. No source timestamp may be later than its fetch time. Resolve
  an apparent conflict from explicit offsets or a corrected source; otherwise
  omit the affected claim/source. Do not invent precision for date-only stamps
  or relabel a future stamp. Future event/forecast target times are distinct from
  source timestamps and may legitimately follow the fetch.
- Recheck personal actions against full bodies, keeping maintenance window,
  interruption duration and impact distinct. Recheck each fantasy entry's
  overall record, projection-supported verdict and waiver priority.
- Confirm every daily-signal desk has a discovery result before `quiet`, every
  public story has a fetched supporting page, and required claim checks passed.
  Keep this working evidence and timing record internal; do not add schema keys,
  visible audit notes or caveat lists.

## Article photos and source descriptions

When a selected article exposes a relevant photograph through its article
markup, Markdown image, linked raster URL or article-specific image metadata,
include that photo. Use the direct image URL rather than the article URL;
ignore publisher logos, icons, ads and unrelated recommendations. Do not run
another broad image search or an AI analysis step.

Pass the photo URL, source article page and original photographer/agency credit
(or publisher when no photographer is credited) to the renderer. Copy the
source's caption or photo description when provided, and its alt text when
available. Keep this a short source excerpt and preserve attribution; do not
infer depicted people, place or events from the headline. If no description is
provided, omit it and use the renderer's neutral source-only fallback.

`briefing_renderer_tool` downloads and embeds the selected raster images without
passing bytes through the model. It uses bounded public HTTPS requests, compact
display copies where needed, and skips inaccessible, oversized or unsupported
images while retaining the story. Choose one photo per story and do not repeat
the same photo. No `visual_media_tool` analysis, generation or editing is needed
or permitted for routine source-photo inclusion. Never use generated-image
assets. The final document has no external rendering dependencies.

Recover relevant omitted compacted rows before exact or absence claims. Summarize
lengthy source prose directly when helpful, preserving
source identifiers and URLs; keep structured evidence and render resources exact. Retry one verified transient read once. For an
unavailable source, record the limitation and continue with supported desks.
