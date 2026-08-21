---
name: daily-summary
description: >-
  Use for a current Daedalus Daybook HTML daily briefing from live personal,
  news, sports, weather, cluster, and network sources.
metadata:
  author: NVIDIA Corporation and Affiliates <noreply@nvidia.com>
  version: 1.0.0
  tags:
    - daily-briefing
    - html
    - news
    - personal-data
---

# Daily Summary

## Purpose

Produce one polished, image-rich HTML edition titled **Daedalus Daybook** that
tells the user what matters today: the current date and time, Saline weather, their
sports teams, the live health of their Kubernetes cluster and UniFi network,
news tuned to their interests, and what is waiting in email and on the
calendar.

Treat each edition as a contemporary broadsheet front page inspired by classic
newspaper information design, not as a dark technology dashboard. Use a white
or warm newsprint canvas, near-black ink, serif display headlines, compact
sans-serif utility text, thin gray rules, square image crops, generous
whitespace, and one restrained semantic accent. Seek the reference's hierarchy
and scanning rhythm without copying any publication's nameplate, logo,
proprietary typeface, or exact page.

Choose the composition from the actual importance and visual strength of the
day's material. The strongest story should own the largest headline and most
prominent relevant image; supporting stories should step down clearly in size
and space. Prefer editorial columns, section rails, and ruled story groups over
rounded cards, dashboard tiles, gradients, glow effects, or heavy shadows. Do
not merely reshuffle or recolor the same grid every day.

Include a front page, a short editor's note, section features, an at-a-glance
comparison, next actions, and references with image credits. Keep the writing
concise, atmospheric, useful, and factually accurate.

The page is judged on one thing above all: it has to be **true and current**. A briefing that is stale or invented is worse than no briefing, because the user acts on it. Every rule below serves that goal.

For infrastructure status (Kubernetes, UniFi, etc.), report only currently active issues. Do not surface cumulative Kubernetes event counts, historical probe failures, or past warnings unless the pod or workload is currently in a non-Ready, CrashLoopBackOff, or otherwise degraded state right now. When a resource is healthy at query time, show it as healthy and omit stale event history.

## Prerequisites

- Current date/time and web access for time-sensitive public information.
- Read-only Kubernetes and UniFi connections for infrastructure sections.
- Connected Gmail and Calendar accounts for personal sections; omit them when unavailable.
- Image sourcing or generation capability for visual treatment.

## Output contract

Return a standalone HTML document with all CSS inline in the document and no
external JavaScript, fonts, or stylesheets. Source and generated images may use
verified HTTPS or authenticated application URLs. The frontend previews this
document and provides its download action.

This is a strict rendering contract:

- The first non-whitespace bytes must be `<!DOCTYPE html>`.
- The last non-whitespace bytes must be `</html>`.
- Return only the HTML, with no prose before or after it and no Markdown fence.
- Put limitations, unavailable sources, and image credits inside the page.
- Do not leave template tokens, Markdown image syntax, TODOs, or placeholder
  copy in the final document.

## Examples

Requests such as the following invoke the same complete briefing workflow:

```text
Run my morning briefing.
Catch me up on today.
```

The response is the standalone Daedalus Daybook HTML document described above.

## Instructions

1. Use the real current time to anchor every dated claim.
2. Call each named read-only source and validate its current result.
3. Omit missing or unverified material.
4. Design the edition around the strongest truthful editorial motif.
5. Validate the HTML, sources, images, and output boundaries before returning.

## Step 1: anchor the whole page to the real date and time

Do this first, every time, before any other tool call.

1. Call `current_datetime_tool`. Use its date, time, and timezone verbatim in the hero and footer.
2. Call `get_memory` once for the user's directives and interests. Daily-summary queries are server-expanded (searched at high top_k), so a single call returns the relevant profile context; do not loop on memory.

Everything downstream depends on that timestamp. This is the single most important rule in the skill:

- Put the real weekday, date, and generated time in the hero. **Never infer the date from memory, prior turns, or training data.** If `current_datetime_tool` fails, stop and say so rather than guessing a date, because a wrong date silently corrupts every "today" claim below it.
- **Date-stamp every live query.** When you search weather, sports, news, or email, put the actual date into the query string. An undated "latest" query returns whatever a source last cached, which is exactly how a briefing ends up reporting yesterday's game or a two-day-old forecast as if it were today.
- Every "today / tonight / this week" phrase in the output must be measured from that timestamp, not from a vague sense of now.

If a fact cannot be tied to the current day, it does not go in the page as "current."

## Step 2: gather each section from its real source

The deployed Daedalus backend exposes a specific, read-only set of tools. Use
these and do not assume an unlisted tool exists. This skill authorizes only the
named read calls. Any call that sends, modifies, or deletes data requires the
user's explicit approval and is outside this skill.

### Weather (Saline, MI)

There is no dedicated weather tool. Use `perplexity_search_tool` with a dated query such as `Saline Michigan weather forecast <today's date> hourly high low precipitation`. For the authoritative point forecast, `webscrape_tool` the NWS Saline point forecast on `forecast.weather.gov`. Extract current conditions, today's high/low, and any evening precip or severe risk, then add one practical read (umbrella, commute, cold start). Keep it to the current-conditions line plus two or three forecast bullets.

### Sports (Yankees, Steelers, Michigan State FB and BB)

Use `perplexity_search_tool` with a dated query per team, e.g. `New York Yankees <today's date> last game result and next game time TV`. Cover all four the user tracks: **New York Yankees** (MLB), **Pittsburgh Steelers** (NFL), **Michigan State football**, and **Michigan State basketball**.

Be season-aware from the current date. In season, give the last result and the next matchup (time, venue, broadcast, one line of context). Out of season, give the relevant offseason note (final record, draft, schedule release) instead of pretending a game exists. Flag any game that conflicts with the day's commitments. Never fabricate a score; if you cannot confirm one, state the last confirmed result and its date.

### Kubernetes cluster status (active status only)

Use `k8s_mcp_server`: `getClusterSummary` for the live snapshot, and `listContexts` only if you need to confirm which cluster you are reading. Both are read-only.

Report the cluster's **current steady state, not its event history.** `getClusterSummary` may include a rolling Kubernetes event stream (image pulls, scheduling decisions, kubelet warnings). Those events are a log of things that already happened, and most are resolved by the time you read them. Treating that log as "current status" is the primary way this section goes wrong, so:

- Base the health verdict on **live conditions**: node Ready status, control-plane reachability, and current pod phase counts (Running vs Pending / CrashLoopBackOff / ImagePullBackOff / etc.).
- Surface an event as a current problem **only if the live state still shows it.** Report `ImagePullBackOff` only when a pod is in that state right now, not because an image-pull warning appears somewhere in the event log.
- Prefer counts and conditions ("4/4 nodes Ready, 37 pods Running, 1 Pending") over pasting event lines. Present headline numbers as compact, ruled briefs rather than dashboard tiles.
- If the only negative signal is stale event noise and the live state is clean, say the cluster is healthy.
- Suggest an inspection step when something is genuinely wrong; never suggest a destructive action.

### Network status (UniFi)

Use `unifi_mcp_server`: `getInfo` for controller and system health, `listSites` for the site inventory. Both are read-only. Report what is true now: controller reachable, sites and devices online vs offline, active alarms, WAN/internet up. As with Kubernetes, describe the current state, not alarms that have already cleared.

The backend currently exposes only `getInfo` and `listSites`. If you want device-level or per-subsystem WAN/LAN/WLAN detail that these two do not return, report what they do give and note the limit rather than guessing at fields you cannot see.

### News and interests

Lead with `curated_feed_search_tool` for trusted, source-specific recency, then fall back to `perplexity_search_tool` for anything outside the feed set. Feed scopes worth pulling for this user: `npr_news` (US/world), `nvidia_blog` / `nvidia_developer` / `nvidia_newsroom` (employer and technical focus), `semianalysis` and `mit_computing_review` / `mit_ai_review` (AI infrastructure and industry), `huggingface` / `openai_news` (AI ecosystem). Use `feed_scope="auto"` when the best source is unclear.

Tune selection to the user's interests from memory (LLM inference and optimization, TensorRT-LLM, Dynamo, NIM, Kubernetes; electronic, rock, and classical music) and to local Michigan / Saline / Ann Arbor items, which need `perplexity_search_tool` with a dated query since the feeds do not cover local news. Pick a few genuinely interesting items, one line each with a source link. Verify any volatile claim with `source_verifier_tool` before stating it as fact.

### Email (Gmail)

Use `gmail_mcp_server`. Start with `search_threads` using Gmail search syntax scoped to recent or unread and dated with today, e.g. `is:unread newer_than:2d` or `newer_than:1d`. Read a thread with `get_thread` only when you need context to judge whether it matters. Surface a few genuinely important items (sender, subject, one line on why it matters), not the whole inbox.

Gmail uses per-user OAuth. If it is not connected, the tool emits an authorization prompt. Show that prompt to the user and wait; do not retry the call and do not invent email. If Gmail is not connected, omit the Inbox card.

### Calendar

Use `calendar_mcp_server`. The backend currently exposes only `list_calendars`, which returns the user's calendar list, not individual events. So you can confirm which calendars exist but cannot enumerate today's meetings from this tool alone. Do not fabricate events. If a richer calendar tool (an events/list capability) is available in the deployment, use it to fill the Calendar & Commitments card with real, chronological items grounded in today's date. Otherwise omit the card. Same per-user OAuth auth-prompt behavior as Gmail.

## Step 3: handle missing data and failures honestly

- **Omit any section with no reliable data.** The page should read as complete with whatever is real.
- **Shared-auth MCP failures (Kubernetes, UniFi) are operator incidents.** These use shared, operator-managed API keys. A failure cannot be fixed by user consent or confirmation, so do not retry it in the same turn. Note it plainly in Sources Checked, omit the affected card, and move on.
- **Per-user OAuth failures (Gmail, Calendar):** surface the emitted authorization prompt and wait for the user. Do not retry or fabricate. Never use a confirmation flow to repair authentication.
- **Large tool payloads:** if a tool returns more than roughly 5000 tokens (a verbose cluster summary, a big UniFi payload), run it through `content_distiller_tool` before you use it, so the page stays focused.
- When completeness and accuracy conflict, choose accuracy. A shorter true page beats a fuller uncertain one.

## Step 4: rank the front page and find its editorial story

Do not turn the gathered facts into a dashboard dump. Identify the day's
strongest truthful motif, such as a storm front, a quiet operations morning, a
game-night countdown, or a dense meeting runway. Let that motif determine the
lead image, display type, accent color, pacing, and one original issue
subtitle. Keep the recurring masthead **Daedalus Daybook**.

First rank all verified material by consequence, immediacy, usefulness, and
visual strength. Choose exactly one lead story. It can come from news, the day
ahead, sports, or systems when that subject genuinely dominates the day; do
not force a healthy cluster, routine weather, or a decorative image into the
lead slot. Pair the lead only with an image that directly supports it.

Build a clear broadsheet reading rhythm from the ranked material:

1. **Nameplate and dateline:** center **Daedalus Daybook** as a large text
   masthead. Put the full current date and generated time nearby in smaller
   utility type, followed by a compact department rail and a thin double rule.
2. **Opening story grid:** on wide screens use an asymmetric three-column
   composition. A narrow rail carries the lead headline, dek, and urgent
   updates; the broad center carries the lead image and caption; the remaining
   rail carries a strong secondary visual feature. A useful starting ratio is
   25/45/30, adjusted to fit the real stories and images.
3. **Supporting briefs:** place two or three related briefs directly under the
   opening grid, separated by hairline rules and vertical dividers. Use short
   read-time or status labels only when they are honest and useful.
4. **Department sections:** organize the day ahead, systems desk, scoreboard,
   signals, and personal items as labeled editorial sections. Give each a
   concise section rail, then mix a feature image with narrow text columns
   according to story rank instead of repeating identical cards.
5. **Editor's note, at a glance, and next moves:** use one concise analysis
   block, a cross-section timing view, and at most three concrete actions. Make
   interpretation visually distinct from reported facts.
6. **Sources and image credits:** list every factual source and every source
   image, plus clear labels for AI-generated illustrations.

On phones, collapse this composition into a single ranked reading order:
nameplate, lead headline, lead image and caption, secondary feature, supporting
briefs, then departments. Never preserve desktop columns by shrinking them
until the text becomes cramped.

Vary composition by section: split feature, narrow dispatch, ruled metric
brief, pull quote, timeline, or asymmetric grid. Use structure only when the
corresponding data exists. Aim for six to nine substantial editorial sections
and a six-to-eight-minute read, not artificial page count or filler.

## Step 5: source or create the visuals

Plan three to five distinct visual moments after the facts are known. Unless
image acquisition fails, include at least two raster images. Do not reuse the
same image, crop, or near-duplicate.

Every raster image must belong to a specific ranked story and sit adjacent to
that story's headline or text. Give the lead story first choice of the strongest
relevant landscape image, then assign secondary images in descending story
order. Do not add generic decorative photography merely to fill an allotted
image slot, and do not let a visually dramatic but less important story take
over the page. When fewer trustworthy images exist, use stronger typography
and whitespace instead of unrelated imagery.

### Source images

- Prefer an image published with the exact official or primary-source story.
  Use it only when `webscrape_tool` or a source result exposes a direct image
  URL and the subject, event, team, and location match the caption.
- Never put an article page URL in an `<img>` tag or use generic stock imagery
  as if it depicts a reported event.
- When identity or context is uncertain, call `visual_media_tool` with
  `operation="analyze"` on the candidate URL. If the match remains uncertain,
  omit it or generate a clearly labeled illustration.
- Link the figure caption to the source page and credit the publisher or named
  creator. Repeat the image URL or source page in **Sources and image
  credits**.

### Generated images

- Use `visual_media_tool` with `operation="generate"` for the cover and
  occasional section art when authentic source imagery is unavailable or a
  conceptual treatment is stronger. Generate each image for a different role
  and composition.
- Ground the prompt in public, verified facts and the issue's art direction,
  but treat the result as an editorial illustration, never as evidence of
  today's weather, a news event, a game, or infrastructure state.
- Never put private email, calendar, memory, cluster, device, topology,
  hostname, namespace, or alarm details into an image-generation prompt.
- Avoid logos, fake UI screenshots, public-figure likenesses, and text inside
  generated images. Caption every generated image **AI-generated editorial
  illustration**.
- The tool returns Markdown image references. For this HTML artifact, extract
  only the returned URL and preserve it exactly as the `<img src>`. Do not
  invent, alter, or guess an image identifier.

For every image, write descriptive alt text and a visible caption. Use
`loading="lazy"`, `decoding="async"`, `referrerpolicy="no-referrer"`, and
`object-fit` outside the lead image; load the lead image eagerly. If a visual
cannot be verified or generated, omit it and preserve the composition with
typography, whitespace, or a factual HTML table. Do not ship a broken image or
fake a missing editorial asset with decorative CSS or SVG art.

## Step 6: design and validate the edition

Create the issue from the day's content rather than a rigid reusable template.
Default to a light newsprint surface (`#fff` or a subtle warm off-white),
near-black text, muted gray secondary copy, and thin neutral rules. Use a
restrained red for true live/urgent labels and a muted blue or green only when
it carries a clear semantic meaning. Do not use a corporate-brand accent as
the governing visual language, dark hero treatments, glossy technology-site
styling, rounded card grids, gradients, or ornamental shadows. Use CSS custom
properties and fluid type with `clamp()`.

Use a high-contrast editorial serif stack such as Georgia, `Times New Roman`,
or Times for the masthead, headlines, and narrative copy, with an Arial or
Helvetica sans-serif stack for metadata, navigation, status labels, and
captions. Keep the nameplate original and text-only. Use compact headline line
heights, readable body measure, square corners, and borders generally no
heavier than 1px except the double rule under the department rail.

The document must:

- use semantic HTML landmarks, logical heading order, strong color contrast,
  keyboard-visible links, and meaningful alt text;
- adapt cleanly from a 360 px phone to a wide desktop without horizontal
  scrolling;
- use subtle motion only as progressive enhancement and honor
  `prefers-reduced-motion`;
- include `@media print` rules that remove decorative motion, avoid awkward
  section breaks, preserve image captions, and print legibly;
- open external links with `target="_blank" rel="noopener noreferrer"`;
- escape all externally sourced text before inserting it into HTML;
- use inline scripts only when optional and never require JavaScript for the
  reading experience.

Before returning, verify:

1. The timestamp and every time-relative claim use `current_datetime_tool`.
2. Every score, forecast, event, health state, and volatile claim has a real
   source or is omitted.
3. Every image loads from the exact selected URL, matches its caption, has a
   credit, and is not duplicated.
4. Generated visuals are labeled as illustrations and reveal no private data.
5. Missing sections collapse cleanly with no empty cards or placeholder text.
6. The final response satisfies the `<!DOCTYPE html>` and `</html>` boundary
   checks and contains only the HTML.

## Limitations

- Calendar coverage depends on an event-listing capability, not only calendar inventory.
- Missing or disconnected sources are omitted instead of inferred.
- Generated images are editorial illustrations and never evidence for current events or system state.

## Troubleshooting

For an MCP connection error or timeout, verify that the relevant MCP server is
running and connected. Retry one read once only after that verification; never
retry a write or infer missing data.

| Failure                                                               | Response                                                                         |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Current-time lookup fails                                             | Stop; do not guess the date.                                                     |
| Shared Kubernetes or UniFi connection fails                           | Record the unavailable source, omit its card, and do not retry in the same turn. |
| Gmail or Calendar requests authorization                              | Show the authorization prompt and wait; do not retry before connection.          |
| A connector returns a transient error after it was verified connected | Retry one read once, then omit the section and disclose the failure.             |
| An image cannot be verified or loaded                                 | Omit it or replace it with labeled generated art; rebalance with type and space. |
