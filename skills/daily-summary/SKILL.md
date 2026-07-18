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
  personal daily-briefing builder. Use nv-html for general NVIDIA-branded
  pages, dashboards, status pages, or one-off web deliverables, and
  creative-ideation to brainstorm ideas rather than produce a finished page.
---

# Daily Summary

Produce one clean, self-contained, dark-theme HTML page that tells the user everything that matters about their day: the date and time, weather in Saline MI, their teams, the health of their Kubernetes cluster and home network, news tuned to their interests, and what is waiting in email and on the calendar.

The page is judged on one thing above all: it has to be **true and current**. A briefing that is stale or invented is worse than no briefing, because the user acts on it. Every rule below serves that goal.

## The output in one line

A standalone HTML document, dark theme, NVIDIA Green accent used sparingly, built by filling `assets/daily-summary-template.html`. Return only the HTML, with no prose before or after it and no markdown fences.

This is a strict UI rendering contract, not a style preference:

- The first non-whitespace bytes of the final response must be `<!DOCTYPE html>`.
- The last non-whitespace bytes must be `</html>`.
- Never put progress narration such as "I'll gather..." or a tool/data summary in the final response. Tool calls and intermediate status belong in the runtime's intermediate-step stream, not in the HTML payload.
- Put source limitations and omitted-section notes inside the rendered page's **Sources Checked** card when useful. Do not explain them outside the document.
- Before returning, verify that no unresolved `{{...}}`, `{{#if ...}}`, or `{{#each ...}}` tokens remain and that the final payload satisfies the two byte-boundary checks above.

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

- **Omit any section with no reliable data.** Drop the whole `{{#if}}` block rather than filling it with guesses or "no data available" filler. The page should read as complete with whatever is real.
- **Shared-auth MCP failures (Kubernetes, UniFi) are operator incidents.** These use shared, operator-managed API keys. A failure cannot be fixed by user consent or confirmation, so do not retry it in the same turn. Note it plainly in Sources Checked, omit the affected card, and move on.
- **Per-user OAuth failures (Gmail, Calendar):** surface the emitted authorization prompt and wait for the user. Do not retry or fabricate. Never use a confirmation flow to repair authentication.
- **Large tool payloads:** if a tool returns more than roughly 5000 tokens (a verbose cluster summary, a big UniFi payload), run it through `content_distiller_tool` before you use it, so the page stays focused.
- When completeness and accuracy conflict, choose accuracy. A shorter true page beats a fuller uncertain one.

## Step 4: synthesize the hero and the decision sections

The gathered sections are inputs; the top of the page is where you make them useful.

- **Hero headline:** one line that captures the shape of the day (weather risk, cluster health, a stacked afternoon). The lede is one short paragraph on the day's overall posture.
- **Status pills:** three to five, each a `dot` colored by state (default green, `warn`, `danger`, `info`). Pull the sharpest facts, e.g. "4/4 nodes Ready", "Storms after 6 PM", "Yankees 7:05 PM".
- **Must Know:** the few cross-cutting facts the user would regret missing, decision-oriented and short.
- **Next Best Actions:** at most three, each an imperative title plus one reason (and a timing cue when it matters). This is the part the user acts on, so make it concrete.

## Step 5: render the template

Load `assets/daily-summary-template.html` (via the skill's bundled resources) and fill it. The template is a self-contained dark page with a 12-column responsive grid and no external dependencies, so it renders the same anywhere.

Do not recreate the page from memory or substitute another HTML layout. The bundled template is the required artifact base for this personal briefing.

Rules for filling it:

- Replace every `{{placeholder}}` with verified data, and delete any `{{#if}}` section whose backing data is missing (Step 3).
- Keep it a cohesive dark theme. Do not reintroduce light/white cards; use the `.card` and `.card.alt` panels for variation.
- Use `<strong>` for inline labels inside bullets, and `<code>` only for technical identifiers like namespace or pod names.
- Stat tiles (`kubernetes.stats`, `network.stats`) take a `status_class` of `ok`, `warn`, or `danger` and hold one number plus a short label. Omit a tile whose metric you do not have.
- All links open in a new tab: `target="_blank" rel="noopener noreferrer"`.
- Do not add JavaScript, images, canvas, or SVG unless the user explicitly asks. Do not use `visual_media_tool` for a daily summary.
- Return only the final HTML document.

## Placeholder convention and example shape

Placeholders use double curly braces. Loops use `{{#each ...}}`; conditional sections use `{{#if ...}}`. If the runtime does not render Handlebars, substitute the values directly before returning the HTML. A compact example of the data the template expects:

```json
{
  "summary": {
    "weekday": "Saturday",
    "date_display": "July 18, 2026",
    "generated_time": "7:42 AM",
    "timezone": "EDT"
  },
  "hero": {
    "headline": "Clear morning, cluster healthy, Yankees at home tonight.",
    "summary_paragraph": "Quiet ops day. Weather holds until evening, and your only hard commitment is the 2 PM sync.",
    "pills": [
      { "label": "4/4 nodes Ready", "status_class": "" },
      { "label": "Network all online", "status_class": "" },
      { "label": "Storms after 8 PM", "status_class": "warn" }
    ]
  },
  "weather": {
    "headline": "84°F high · storms late",
    "current_conditions": "Now: 68°F, clear, light NW wind.",
    "bullets": [
      "<strong>Afternoon:</strong> Sunny, low 80s.",
      "<strong>Evening:</strong> Scattered storms after 8 PM.",
      "<strong>Read:</strong> Great day; grab a layer for tonight."
    ]
  },
  "kubernetes": {
    "headline": "Healthy control plane, no active pod issues.",
    "stats": [
      { "value": "4/4", "label": "Nodes Ready", "status_class": "ok" },
      { "value": "37", "label": "Pods Running", "status_class": "ok" },
      { "value": "0", "label": "Not Ready", "status_class": "ok" }
    ],
    "bullets": [
      "<strong>Control plane:</strong> reachable, all nodes Ready.",
      "<strong>Workloads:</strong> 37 Running, 0 Pending. No CrashLoop or ImagePull issues in current state."
    ]
  },
  "network": {
    "headline": "Controller up, all devices online.",
    "stats": [
      { "value": "1", "label": "Sites", "status_class": "ok" },
      { "value": "0", "label": "Alarms", "status_class": "ok" }
    ],
    "bullets": [
      "<strong>WAN:</strong> up.",
      "<strong>Devices:</strong> all reporting."
    ]
  },
  "sports": {
    "items": [
      {
        "team": "Yankees",
        "summary": "Host the Red Sox 7:05 PM EDT (YES). Won last night 5-3."
      },
      { "team": "Steelers", "summary": "Offseason. Camp opens next week." },
      {
        "team": "MSU Football",
        "summary": "Offseason. Opener Aug 30 vs Western Michigan."
      },
      {
        "team": "MSU Basketball",
        "summary": "Offseason. 2026-27 schedule not yet released."
      }
    ]
  },
  "news": {
    "items": [
      {
        "headline": "NVIDIA ships new inference optimization guide",
        "summary": "Covers TensorRT-LLM throughput tuning.",
        "url": "https://developer.nvidia.com/blog/",
        "source": "developer.nvidia.com"
      }
    ]
  },
  "email": {
    "items": [
      {
        "sender": "Jane Doe",
        "subject": "Q3 roadmap review",
        "note": "Wants your input before the 2 PM sync."
      }
    ]
  },
  "must_know": {
    "items": [
      "<strong>Only hard commitment:</strong> 2 PM roadmap sync.",
      "<strong>Weather:</strong> usable until ~8 PM."
    ]
  },
  "actions": {
    "items": [
      {
        "title": "Reply to the roadmap thread before 2 PM.",
        "reason": "Jane is waiting on your input."
      }
    ]
  },
  "sources": {
    "items": [
      {
        "label": "Weather: NWS Saline point forecast.",
        "url": "https://forecast.weather.gov/",
        "display_url": "forecast.weather.gov"
      },
      {
        "label": "Kubernetes: k8s_mcp_server getClusterSummary (live).",
        "url": null,
        "display_url": null
      }
    ]
  }
}
```
