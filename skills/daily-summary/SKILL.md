---
name: daily-summary
description: >-
  Build the user's single, self-contained dark-theme HTML daily briefing,
  grounded in the real current date and time, with a fixed personal section
  set: a date/time hero, weather for Saline MI, sports for the New York
  Yankees, Pittsburgh Steelers, and Michigan State football and basketball,
  live read-only Kubernetes cluster status, UniFi network status, news matched
  to the user's interests, and recent email and calendar. Use this whenever
  the user asks for a daily summary, daily briefing, morning brief, "my daily
  update", "what's my day look like", "run my briefing", or "catch me up on
  today", even when they do not name a template or say "HTML". This is the
  personal daily-briefing builder.
---

# Daily Summary

Produce one clean, self-contained, dark-theme HTML publication that tells the user everything that matters about their day: the date and time, weather in Saline MI, their sports teams, the health of their Kubernetes cluster and home Unifi network, news tuned to their interests, and what is waiting in email and on the calendar.

The publication should feel like a refined independent news magazine combined with a high-end tech journal. Use elegant typography, dark developer theme colors, generous whitespace, cinematic photography where relevant, and varied editorial layouts. Photos may be pulled from source material or generated with AI where relevant.

Include a cover, an introduction, features, a comparative overview, and a brief references page. Keep the writing concise, atmospheric, and factually accurate.

Use web search to verify all current details. Make sure every image accurately matches the news/information and location being discussed, and do not reuse the same or near-duplicate images.

Create a polished html file for download.

The page is judged on one thing above all: it has to be **true and current**. A briefing that is stale or invented is worse than no briefing, because the user acts on it. Every rule below serves that goal.

For infrastructure status (Kubernetes, UniFi, etc.), report only currently active issues. Do not surface cumulative Kubernetes event counts, historical probe failures, or past warnings unless the pod or workload is currently in a non-Ready, CrashLoopBackOff, or otherwise degraded state right now. When a resource is healthy at query time, show it as healthy and omit stale event history.

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

The deployed Daedalus backend exposes a specific, read-only set of tools. Use these. Do not assume a tool exists that is not listed here. All of these are read-only, so no confirmation is needed to call them.

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
- Prefer counts and conditions ("4/4 nodes Ready, 37 pods Running, 1 Pending") over pasting event lines. Use the stat tiles for the headline numbers.
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
