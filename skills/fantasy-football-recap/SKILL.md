---
name: fantasy-football-recap
description: Create a verified weekly ESPN fantasy football newspaper with complete league matchup coverage, standings, NFL reporting, and a shareable standalone HTML edition. Use for weekly recaps, league newsletters, current-week editions, preseason previews, or season reviews.
---

# Fantasy Football Recap

Act as editor, NFL reporter, fantasy analyst, and newspaper designer. The league
is the main character; the NFL supplies the wider story. Produce an original,
league-specific publication with authoritative reporting, sharp serif headlines,
short paragraphs, concrete numbers, and dry humor. Draw on classic New York
Times sports-section typography without copying its masthead or identity.

Accuracy governs the story: establish a single evidence ledger, check it, then
write from it. A confident sentence cannot resolve conflicting data.

## Tools and resources

Use the connected ESPN MCP leaf tools for league facts, `current_datetime_tool`
for time, and available research tools for public NFL reporting. Discover actual
schemas before calling them. All ESPN reads use explicit league and season;
roster reads also use explicit team and scoring week.

Read [the reporting contract](references/reporting-contract.md) before gathering
league data. It covers the connector's period, score, lineup, and standings
limitations and the input for [the scoreboard checker](scripts/check_scoreboard.py).
Use the checker when Python execution is available. Otherwise perform its
invariants with available calculation tools, retain only verified results, and
do not claim automated validation.

In Daedalus, load resources with
`agent_skills_tool(operation=load_skill, skill_name=fantasy-football-recap, resource=...)`.
Production supports list/load only: a loaded Python file is text. For calculation
or downloadable files, load [bubblewrap-agent-workflow](../bubblewrap-agent-workflow/SKILL.md)
by its skill name, then explicitly stage the helper and snapshot in the sandbox.
The sandbox does not inherit `/skills` or ESPN credentials. Do not call
`run_skill_script` or the daily-summary-specific renderer.

Load [espn-fantasy-football](../espn-fantasy-football/SKILL.md) only when a roster
decision needs its deeper lineup/waiver analysis; pass confirmed settings and
reads and retain this skill's publication format. Creating a recap authorizes
research and artifact creation, not lineup changes, transactions, or sending the
publication to managers.

## 1. Establish the edition

- Reuse an explicitly selected league. Otherwise check `account_status`, then
  `get_league` and `get_teams`. The configured default is a starting point;
  `account_status` does not enumerate account memberships. If multiple known
  leagues are plausible, ask the user to choose. Do not guess ownership or
  silently switch leagues after an access failure.
- Establish the actual season and scoring-period calendar from ESPN. January's
  calendar year may differ from the football season. Default to the latest
  **completed scoring week**, checking status and the schedule; neither the
  current scoring period nor current period minus one proves completion.
- Distinguish a scoring week from a matchup period spanning multiple weeks.
  A completed playoff leg can have an unresolved aggregate result. Honor
  historical requests without importing today's standings or rosters into them.
- For a requested current week, label each matchup final, live, scheduled, or
  unconfirmed. An unfinished game has a leader, never a winner. In preseason,
  produce a preview; after the season, produce a season review using verified
  historical results. Omit inapplicable weekly modules.
- Record season, scoring week or covered range, edition label, publication date,
  and an exact data-as-of timestamp with timezone and UTC offset. UTC is a valid
  fallback when the user's timezone is unknown. Preserve individual fetch times;
  do not imply that old evidence was refreshed by changing the dateline.

Ask only for missing context that materially changes the edition. A failing
connector is not an empty league; use supplied exports if available, or explain
the missing access instead of inventing an edition.

## 2. Report and build the evidence ledger

Read actual settings before interpretation: scoring categories, weights and
bonuses; starter, flex, bench and IR slots; team count; divisions; schedule;
playoffs; standings and matchup tiebreakers; waiver system and budget. Resolve
numeric stat/slot IDs from verified mappings. Never assume PPR or standard rules.

Fetch the complete scoreboard and team list. Retrieve relevant historical
lineups/rosters, previous results, transactions, projections, and the available
player pool when supported. Recover omitted rows with `tool_output_retriever_tool`
when `_daedalus_compacted_tool_output` appears; paginate before exhaustive claims.

Keep one private working ledger with:

- Edition context, rule summary, response timestamps, and source references.
- Every matchup keyed by stable IDs: participants and names, period and week,
  status evidence, weekly scores, aggregate scores where applicable, ESPN winner,
  computed winner/margin or live lead, and any unresolved discrepancy.
- Every team's applicable record, points for/against, rank/seed, division, and
  the period through which those fields are current; previous values only when
  genuinely available. Include byes and inactive postseason teams explicitly.
- Contributors keyed by player ID, fantasy team, week, historical lineup slot,
  and league-applied actual points. Keep projections and forecasts separate.
- Public claims with exact URLs, source dates, and verification times; ownership
  checks for waiver recommendations; evidence required for each proposed honor.

Copy scores from original responses into the checker input; do not retype a
handmade scoreboard as the supposed source. Calculate with decimal arithmetic,
retain source precision, and round only for display. Reuse the checked values
everywhere: tables, headlines, charts, prose, awards, and previews.

Run the checker before drafting. Investigate a failing assertion against the
source, refreshing the affected reads once when useful. Do not alter inputs to
make a preferred story pass. If unavailable evidence prevents reconciliation,
mark the affected result unconfirmed and omit dependent claims. Independent
verified material can still be published with a brief limitation.

Research the corresponding NFL week across several reputable sources, including
official results, statistics and injury reports plus independent reporting.
Prioritize consequential games, division races, tactics, emerging players, and
major news. Search public player/team names only; keep private league names,
IDs, account metadata and roster exports out of public search queries.

## 3. Apply the story gates

- **Win/loss:** require confirmed final status and agreement between official
  result and comparable scores. An equal-score win needs the actual tiebreaker.
  A bye is not a played win; a completed multiweek leg is not a series victory.
- **Numbers:** label weekly versus cumulative points, actuals versus projections,
  and regular season versus playoffs. Missing is unknown, never zero. Do not add
  this week's result to a record that already includes it.
- **Consequence:** establish the standings cutoff before saying a team improved
  to a record, moved places, extended a streak, clinched, or was eliminated.
  Show ESPN's published table if its ordering cannot be independently explained;
  do not invent tiebreakers, odds, or clinching scenarios.
- **Superlatives:** compare the full relevant population, state its scope, and
  share tied honors. Week-high score is not a season record. A league-wide award
  needs all teams; a player award needs all eligible starters, not a shortlist.
- **Drama:** call a result an upset only with a dated pregame expectation.
  Require scoring-timeline evidence for a comeback, lead change, walk-off, or
  Monday-night rescue. Final scores and kickoff order alone do not prove any of
  these. A current live projection is not a pregame projection.
- **Bench regret:** verify the player was actually benched that week, eligible
  for a legal replacement slot, and available under roster/lock rules. Compute
  `new total = official total - replaced starter actual + bench player actual`;
  evaluate ties under league rules. Label hindsight. Do not combine incompatible
  swaps, reuse a player, or call a merely higher total a missed win.
- **Transactions:** require an executed transaction before the relevant lock,
  an eligible start, and actual contribution before claiming it affected a result.
- **Interpretation:** signal opinion and forecasts. Never invent quotations,
  motives, interviews, rivalries, traditions, or historical records. Friendly
  roasting must follow verified outcomes and decisions; let the numbers earn it.

## 4. Edit the newspaper

Aim for roughly two-thirds league coverage, one-third NFL, and 1,500–2,200 words,
adjusting to league size and evidence. Give every matchup attention, distribute
coverage across teams, and prefer a tighter edition to filler. Avoid generic AI
phrasing, forced puns, gambling filler, excessive exclamation marks, and repeated
player summaries. Choose story order for this edition; combine or omit optional
modules when reporting is thin.

1. **Front-page lead:** a specific headline, one-sentence deck, and feature on
   the strongest supported league story: what happened, who drove it, and its
   verified significance. Expand the marquee matchup here without duplicating it
   in the scoreboard recap.
2. **League scoreboard:** a compact table with every matchup and explicit status;
   include byes separately. Give each pairing a distinctive short recap with
   verified contributors and consequences, or acknowledge unavailable lineup data.
3. **Standings desk:** ESPN standings, applicable records/points/playoff position,
   and meaningful movement only with historical comparison. Optional power
   rankings are labeled opinion with a stated basis.
4. **Around the NFL:** three to five consequential stories explaining what
   happened, why it matters to real football, and any supported connection to
   this league. Include football analysis beyond fantasy point totals.
5. **Roster desk:** concise injury, role, usage, next-opponent, and waiver advice
   tailored to scoring and roster rules. Verify league availability immediately
   before recommending a pickup. Otherwise label “players to check.” Distinguish
   free agents from waiver claims; tie any FAAB range to actual budget/rules.
6. **Back page:** three to five supported humorous honors, such as Performance
   of the Week, Narrow Escape, Most Agonizing Loss, Bench Regret, or Transaction
   That Mattered. Omit an honor whose evidence gate fails.
7. **Next week's marquee:** use the next confirmed league schedule, verify the
   stakes, and identify relevant players/developments. If pairings are unknown,
   say so and preview confirmed dates or decisions. Finish with a What to Watch
   box containing no more than three concrete items.

## 5. Design, check, and deliver

Create a complete standalone HTML document with an original league-specific
masthead, issue metadata, warm off-white background, near-black text, one restrained
accent, bold serif headlines, readable body type, thin rules, and generous spacing.
Use embedded CSS and system fonts, with no external assets, fonts, scripts or
tracking. Escape source text and allow only safe public source URLs in links.

Build a dominant lead with supporting columns and compact sidebars. Use desktop
grids and a single column on mobile. Give tables semantic headers, readable team
names, and aligned tabular numerals. Charts must be original, directly derived
from checked data, and add information. Include print CSS with repeated table
headers, sensible breaks, visible overflow and no clipped content; do not mark
an entire long section as unbreakable.

Link important public claims next to the reporting to exact articles or official
reports. Include a compact sources footer naming ESPN league data with its
season/week and retrieval time, plus the public reporting used. Never expose
private access links, IDs, emails, private messages, raw responses, or technical
MCP details in the publication, filename, metadata, or HTML comments. Team names
are the default identifiers. Keep the working ledger private.

Before release, refresh volatile scores/statuses, standings, injuries and selected
waiver availability. If facts changed, update the ledger and regenerate all affected
prose, tables, awards, charts and previews. Check every numerical and directional
claim against the final ledger, including “beat,” “lost,” “ahead,” and record
changes. Confirm all matchups are covered and headlines satisfy the story gates.
Remove stale news, unsupported certainty, duplication, and template placeholders.

When tools allow, inspect the actual rendered HTML at desktop and mobile widths
and inspect print layout. If PDF generation is available, export from the same
final HTML, visually inspect its pages, and provide the matching PDF too. State
any unavailable rendering check briefly; never claim an unperformed check.

Save and publish the verified HTML using the host's artifact tools and return
the real download link with a brief delivery note, plus the PDF link if produced.
In Daedalus this requires successful sandbox `publish_file`, not just `write_file`.
If file creation or publication is unavailable, return the complete HTML in one
`html` code block. Do not fabricate a download URL or expose sandbox host paths.
