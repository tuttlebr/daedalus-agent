# Daily-summary research and sourcing

Use this reference after the current time and personalized interest manifest are
available.

## Source planning

Call `source_verifier_tool` with `operation=plan_sources` once. Describe the
complete manifest in the research question and keep default source families
enabled unless the user's directives exclude one. Use its recommended tool
order as a plan, not as permission to call unrelated tools.

Date-stamp every query about today, tonight, this week, latest results, current
health, or schedules. Prefer primary sources and direct read-only tools. A
search snippet is discovery evidence, not sufficient support for a precise or
volatile final claim.

## Tool routing

- **General, local, weather, sports, culture, and interests outside curated
  feeds:** use `perplexity_search_tool` for dated discovery, then
  `webscrape_tool` on the selected primary or authoritative page. Use the NWS
  point forecast for US weather when available.
- **AI, NVIDIA, computing, and trusted recent feeds:** start with
  `curated_feed_search_tool` using the most relevant scope. Use broad search
  only when the feeds do not cover the manifest item.
- **Official NVIDIA product behavior:** use `nvidia_docs_tool`. For other stable
  technical context, use `domain_retriever_tool` or the relevant official page.
- **GitHub projects:** use read-only `github_mcp_server` operations for releases,
  commits, issues, or pull requests relevant to a remembered project.
- **Social signals:** use `x_mcp_server` only when a social-media beat is in the
  manifest. Verify consequential claims against a primary non-social source.
- **Uploaded or workspace documents:** use `user_document_tool` or read-only
  `docs_mcp_server` only when the user's manifest or request makes them relevant.

## Personal desks

### Gmail

Use `gmail_mcp_server.search_threads` with a recent, bounded Gmail query. Read a
thread or message only when needed to judge importance. Surface a small number
of actionable items with sender, subject, and why each matters. Never create a
draft or make another write during this workflow.

### Calendar

Use `calendar_mcp_server.list_events` for the current day's bounded interval.
Use `get_event` or `search_events` only when needed for context or a manifest
item. `list_calendars` is inventory, not a substitute for events. Do not call
`suggest_time` unless the user separately asks to schedule something.

Gmail and Calendar use per-user OAuth. When the tool emits an authorization
prompt, surface it and wait. Resume without repeating completed public calls.

## Operational desks

### Kubernetes

Use read-only `k8s_mcp_server.getClusterSummary`; call `listContexts` only when
the target context is ambiguous. Base the verdict on current node conditions,
control-plane reachability, and current pod phases. An old event is a current
problem only when the live resource remains degraded. Prefer counts and current
conditions. Never suggest or perform a destructive action.

### UniFi

Use the currently exposed read-only `unifi_mcp_server` information and site
inventory operations, including `getInfo` and `listSites` when available. Report
controller reachability, site/device availability, active alarms, and WAN state
only to the depth returned. Do not infer missing fields or call a mutation.

For both desks, a shared-auth failure is an operator issue. Mark the desk
unavailable and continue; do not request user confirmation as an authentication
repair.

## Claims and citations

- Verify precise scores, schedules, warnings, forecasts, releases, and other
  consequential volatile claims against the selected source. Use
  `source_verifier_tool.verify_claim` when source support is not already exact.
- Distinguish reported facts from the editor's synthesis.
- Link every story or brief to an HTTPS source page and list it again in the
  sources section.
- If two authoritative sources disagree, state the disagreement or omit the
  claim. Never silently choose the more dramatic version.
- If a manifest beat has no material update after a reasonable source check,
  mark it `quiet`. Do not manufacture a story.

## Source-only images

Images are evidence-adjacent editorial assets, not decoration.

1. Select a direct HTTPS raster URL published on the primary or official page
   used for the adjacent story.
2. Confirm the image subject, event, team, place, and date match the caption.
   Use `visual_media_tool` with `operation=analyze` when any match is uncertain.
3. Record the direct image URL, source page, and named photographer or publisher
   credit. Use all three in the required figure attributes and visible caption.
4. Do not put article-page URLs in `<img src>`, use generic stock as reported
   evidence, or reuse the same image URL twice.
5. Never call `visual_media_tool` with `operation=generate` or `operation=edit`
   for a daily summary. Never use `/api/generated-image/` assets.

When trustworthy source imagery is unavailable or fails analysis, omit it and
rebalance the page with type, rules, and whitespace.

## Large payloads and failures

Use `content_distiller_tool` when a source result exceeds roughly 5000 tokens.
Keep enough source identifiers and URLs to preserve provenance. Retry one
verified transient read once. For unavailable sources, record the limitation in
the ledger and sources section and continue with supported beats.
