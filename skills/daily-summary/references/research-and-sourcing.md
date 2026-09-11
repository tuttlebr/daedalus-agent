# Daily Daedalus research and sourcing

Load this reference after current time and policy, before personal-source
preflight. Plan sources only after the preflight and memory merge complete.

## Source planning and cadence

Call `source_verifier_tool` with `operation=plan_sources` once. Describe the
complete desk manifest and distinguish every-edition checks from conditional
signal checks. Keep default source families enabled unless a reader directive
excludes one. Use the returned tool order as a plan, not as permission to call
unrelated tools. Use `research_question` for the dated manifest and `depth=quick`.
Pass the needed source IDs in `selected_sources_json`: public families
`curated_feeds`, `perplexity_search`, `known_url_scrape`, `nvidia_docs`,
`curated_domains`, and `x_mcp`, plus `workspace_data`, `cluster_state`,
`network_state`, and `repository_data` for the standing desks. Add
`fantasy_data` only for a requested fantasy desk. Preserve explicit source
inclusions/exclusions and reuse the completed personal-source reads. A broad
topic or approval hint does not require a new approval for this requested
briefing. The plan is a source menu, not a requirement to call every family.

Date-stamp queries about current health, today, tonight, this week, latest
results, releases, or schedules. A search snippet is discovery evidence, not
support for a precise or volatile final claim. Prefer a small number of strong,
primary sources over broad link collection.

Always check the Cluster & Infrastructure, Weather, and Email & Calendar desks.
For other desks, use a trusted quick signal first and deepen only material
items. The conditional finance desk normally needs no research unless a
seasonal date or structural event makes it relevant.

## Front Page — Cluster & Infrastructure

### Kubernetes and GPU Operator

Start with read-only `k8s_mcp_server.getClusterSummary`; call `listContexts` only
when the target context is genuinely ambiguous. Then inspect only the live
resources needed to explain anomalies.

- Cover current node conditions, unavailable or crash-looping workloads,
  failed or pending pods, and incomplete rollouts across all live namespaces.
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
reuse a remembered stalled-mirror condition. Mark this subtopic unavailable in
the desk ledger when no live source exists.

Shared-auth failures on operational tools are operator issues. Mark the
affected source unavailable and continue; do not turn a credential failure into
a cluster incident.

## Weather, email, and calendar

### Saline weather

Use an authoritative forecast for Saline, Michigan; prefer the National Weather
Service point forecast when available. Cover current conditions plus the next
three complete calendar days. Compare high, low, precipitation, wind, and any
alert that changes plans. Reuse these facts for field-weather interpretation
rather than making a second forecast query.

### Gmail

Use `gmail_mcp_server.search_threads` with a recent, bounded Gmail query. Read a
thread or message only when needed to judge importance. Surface a small number
of actionable items with sender, subject, and why each matters. Do not list
routine newsletters, expose unnecessary message content, create a draft, or
make another write.

### Calendar

Use `calendar_mcp_server.list_events` for a bounded interval covering the
current local day and the next three calendar days. Use `get_event` or
`search_events` only when needed for context. Separate today's agenda from the
look-ahead and preserve necessary travel or preparation context without
publishing irrelevant attendee data. `list_calendars` is inventory, not a
substitute for events. Never call `suggest_time` during a summary.

Use the connected schema's `startTime`, `endTime`, and `timeZone` fields;
do not substitute REST-style `time_min`/`time_max`. Gmail thread reads use
`threadId`, and Calendar event reads use `eventId`.

Gmail and Calendar use per-user OAuth. When a tool emits an authorization
prompt, surface it and wait. Resume without repeating completed public calls.

## AI, science, and industry

- For AI, NVIDIA, computing, and trusted recent feeds, start with
  `curated_feed_search_tool` using the narrowest relevant scope. Deepen only the
  changes that affect inference engineering, the NVIDIA stack, Kubernetes GPU
  scheduling, NVIDIA NeMo Agent Toolkit, or the Daedalus project.
- For official NVIDIA product behavior, use `nvidia_docs_tool`. For stable
  technical context, use `domain_retriever_tool` or the relevant official page.
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
`webscrape_tool` on the selected primary or authoritative page. Use
`nvidia_docs_tool` for official NVIDIA product behavior and
`domain_retriever_tool` for stable reference context.

## Outdoors, sports, finance, and culture

### Outdoors & Field

For birding, prefer recent eBird data, official migration resources, or a
credible local report for Washtenaw County. Separate observed sightings from a
seasonal expectation. Translate the verified weather into useful shooting or
birding windows around Saline and Ann Arbor. Photography guidance should solve
a concrete field or post-processing problem; do not manufacture gear news.

### Sports

Use official league, team, conference, or broadcaster pages for scores,
standings, and schedules. Cover the Yankees, Steelers, Michigan State men's
football, and Michigan State men's basketball only to their current seasonal
relevance. Prefer the last result, next game, standing or record context, and
one material development. A WFAN listen link is optional and must be verified
as useful for that game-day context.

### Markets & Finance

Do not run a daily ticker or market search. Research this desk only for a timely
seasonal personal-finance reminder or a verified structural macro change that
affects long-term planning. No stock picks, trading calls, fear framing, or
generic market-close recap.

### Culture & Leisure

Use primary recipes, artist or venue pages, publishers, and local sources.
Favor vegetarian cooking, seasonal ingredients, exceptional Saline or Ann
Arbor options, electronic/rock/classical listening with time commitment, and
science-fiction media in the orbit of Star Trek or The X-Files. Include a
shared idea with Alicia only when it is genuinely specific and useful.

## Claims, deduplication, and citations

- Verify precise scores, schedules, warnings, forecasts, releases, and other
  consequential volatile claims against the selected source. Use
  `source_verifier_tool(operation=verify_claim, claim=..., source_url=...)`
  for public-source claims when support is not already exact. Private and live
  operational claims use their authenticated source tools, not a public fetch.
- Distinguish reported facts from the editor's synthesis.
- Link every public-web story or brief to its HTTPS source page. For live tool
  or private-tool evidence, name the tool source in the sources section without
  exposing credentials, opaque identifiers, or raw personal content. Never
  fabricate a public URL for a Kubernetes, UniFi, Gmail, or Calendar result.
- Use one fact in one best location. Cross-reference or reinterpret it instead
  of repeating forecast, cluster, schedule, or release copy across desks.
- If authoritative sources disagree, state the disagreement or omit the claim.
- If a cadence-appropriate check has no material result, mark the desk `quiet`.

## Source-only images

Images are evidence-adjacent editorial assets, not decoration.

1. Select a direct HTTPS raster URL published on the primary or official page
   used for the adjacent story.
2. Confirm that subject, event, team, place, and date match the caption. Use
   `visual_media_tool` with `operation=analyze` when any match is uncertain.
3. Record the direct image URL, source page, and named photographer or publisher
   credit. Use all three in the required figure attributes and caption.
4. Do not put article-page URLs in `<img src>`, use generic stock as reported
   evidence, or reuse the same image URL twice.
5. Never call `visual_media_tool` with `operation=generate` or `operation=edit`
   for a daily summary. Never use `/api/generated-image/` assets.

When trustworthy source imagery is unavailable or fails analysis, omit it and
rebalance the page with type, rules, and whitespace.

Recover relevant omitted compacted rows before exact or absence claims. Use
`content_distiller_tool` for lengthy source prose only when helpful, preserving
source identifiers and URLs; keep structured evidence and render resources exact. Retry one verified transient read once. For an
unavailable source, record the limitation and continue with supported desks.
