# Reporting contract

Read before selecting the week or collecting scores. These are connector
contracts verified against the repository's ESPN server; inspect connected
schemas and returned fields if they differ. Tools are read-only.

## ESPN reads and their limits

| Read                                                                | Use and constraint                                                                                                                                                                |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account_status()`                                                  | Configured league, season and team defaults; does not list memberships or prove the requested season is active. `verify=True` checks only the default league.                     |
| `get_league(league_id, season)`                                     | Settings, status, and `settings.scheduleSettings.matchupPeriods`, mapping matchup-period IDs to scoring weeks. Read relevant finality and schedule evidence here.                 |
| `get_teams(league_id, season)`                                      | All teams, names, records, points and returned seeds/ranks. Has no historical `week` argument; do not present this as last week's standings.                                      |
| `get_matchups(week, include_lineups, team_id, league_id, season)`   | Explicit `week` selects a scoring week and resolves its matchup period. Omit `team_id` for the complete scoreboard. Retrieve lineups by team if a complete response is too large. |
| `get_roster(team_id, week, league_id, season)`                      | Roster slots and actual/projected stat rows. Verify historical lineup identity; a requested week alone does not prove an unchanged historical roster.                             |
| `get_player(player_id, league_id, season)`                          | Ownership, availability, eligible slots, detailed stats. Has no `week` argument; select matching returned stat rows.                                                              |
| `get_transactions(week, limit, offset, league_id, season)`          | Executed transactions, newest first. Pending bids/claims are unavailable. Follow `next_offset`; an error is not “no transactions.”                                                |
| `get_free_agents(position, week, limit, offset, league_id, season)` | Includes `FREEAGENT` and `WAIVERS`, ordered by ownership percentage, not projection. Check the recommended player's current league status.                                        |
| `search_players(query, season, limit, offset)`                      | Public identity lookup; does not establish league availability.                                                                                                                   |

The host supplies authentication. Do not request cookies/tokens in chat or retry
an unchanged access failure. Do not put connector defaults or private IDs in
search queries or the finished artifact.

## Periods, scores, and status

- Preserve `league_id`, `season`, requested `week`, `matchup_period`, and
  `fetched_at` on source snapshots. Resolve team IDs through this league's team
  list; names need not be unique. D/ST player IDs may be negative.
- `home`/`away` are containers, not winners. `winner` can identify the winning
  side or a tie; retain its exact value. Unknown/unresolved flags are not finals.
  Finality requires league/matchup status and completion evidence. If the
  connector cannot establish it, label the result unconfirmed.
- `totalPoints` is the matchup aggregate. In a multiweek matchup use
  `pointsByScoringPeriod[str(week)]` for that week's score. Show both with
  explicit labels when relevant; never call an aggregate “this week's points.”
- `totalPointsLive` is a live total; `totalProjectedPointsLive` is a live forecast.
  Neither a live lead nor a forecast establishes a final winner. Never use live
  projected totals to assert a pregame favorite or an upset.
- Do not treat Monday's end, zero players remaining, a nonzero score, or a winner
  flag in isolation as proof of finality. Check postponed games and the configured
  matchup-period end. A final can still receive a stat correction; timestamp it.
- Prefer official team scores over a reconstructed roster sum. League adjustments,
  rounding or mismatched lineups can explain a discrepancy; investigate and omit
  unsupported contributor claims rather than overriding the official score.
- Matchup lineups come from `rosterForCurrentScoringPeriod` and may contain only
  `appliedStatTotal`, without enough period metadata. For a historical edition,
  verify each claimed starter and contribution against period-specific evidence.
- Player `statSourceId=0` means actual, `1` projected. Match `seasonId`,
  `scoringPeriodId`, and the verified `statSplitTypeId` for weekly stats. Do not sum
  weekly, season-total, average and projected rows. `appliedTotal` already includes
  league scoring; applying PPR/bonuses again double counts them.

For historical standings, prefer a saved contemporaneous table. Reconstruction
requires all prior completed results, applicable scoring/record rules, divisions,
adjustments and tiebreakers. If unavailable, omit historical ranks/movement and
explain the gap. A current table used in a current publication must say “as of”
its actual cutoff, including any newer results. Never add a result twice.

## Deterministic scoreboard check

The bundled helper checks arithmetic and coverage within supplied ESPN responses.
It does **not** independently establish source completeness or finality, validate
prose, audit standings, verify lineup legality, or fetch news. The reporter still
owns those checks, including confirming that raw responses were not truncated.

Load `scripts/check_scoreboard.py`, stage its exact text and a private JSON snapshot,
then execute the equivalent of:

```text
python3 check_scoreboard.py snapshot.json
```

Use structured `argv` through the sandbox. The helper reads one file and writes
JSON to stdout; it neither contacts ESPN nor publishes the ledger. Exit code 1
means the snapshot cannot be certified. Preserve source responses and correct
only a demonstrated extraction error or a refreshed fact, never the source result.

Input object:

```json
{
  "league": {
    "league_id": 1,
    "season": 2026,
    "settings": { "scheduleSettings": { "matchupPeriods": { "1": [1] } } }
  },
  "teams": {
    "league_id": 1,
    "season": 2026,
    "teams": [
      { "id": 1, "name": "Example A" },
      { "id": 2, "name": "Example B" }
    ]
  },
  "scoreboard": {
    "league_id": 1,
    "season": 2026,
    "week": 1,
    "matchup_period": 1,
    "matchups": [
      {
        "id": 1,
        "matchupPeriodId": 1,
        "winner": "HOME",
        "home": { "teamId": 1, "totalPoints": "101.10" },
        "away": { "teamId": 2, "totalPoints": "99.95" }
      }
    ]
  },
  "checks": {
    "1": {
      "status": "final",
      "evidence": "Example only: independently confirmed period and matchup completion"
    }
  },
  "idle_teams": {}
}
```

Replace the three response objects with original tool data, retaining fetch
timestamps and numeric precision. The example is synthetic, never league evidence.
The helper accepts JSON numeric scores or exact decimal strings.

`checks` must contain one entry per matchup ID, with `status` one of `final`,
`live`, `scheduled`, `unconfirmed`, or `bye`, and a nonempty `evidence` note
identifying the actual status evidence or why confirmation is unavailable.
For equal-score finals awarded to a side, add `tiebreaker` describing the verified
rule applied. Do not fabricate these annotations; the helper trusts them.

`idle_teams` maps otherwise absent team IDs to verified reasons (such as postseason
elimination). Do not use it to excuse truncated results. Missing or extra matchup
annotations, duplicate matchup IDs, unexplained absent teams, period mismatches,
and conflicting scores/winner flags fail the check. Doubleheaders may repeat
teams; their weekly scores must agree. A bye requires one side and earns no
played win.

Output distinguishes `weekly_points` from `matchup_points`, final `winner` and
`margin` from live `leader` and `lead`, and score ties from verified tiebreak wins.
Missing scores stay null; finals require both official totals. Full-population
weekly high/low lists are supplied only when every team has a verified final
single-week result and comparable weekly points. Multiweek, incomplete, or idle
populations require an explicitly scoped comparison by the reporter instead.
Tied extrema include all teams. The helper preserves decimals without imposing
display rounding: if rounding would hide a real margin, show enough digits.

## Claim audit before release

Check every story sentence back to the ledger, not just the table. Useful probes:

- Does “A beat B” agree with official side identities, finality, scores and winner?
- Does “by 1.15” equal the exact score difference, without rounding inputs first?
- Is “improved to 3–1” supported by a record that actually includes this result?
- Does “highest scorer lost” compare all teams' weekly actuals and final results?
- Is “would have won” based on one feasible historical lineup and a strict win
  after the actual tiebreaker, rather than a higher total that still loses?
- Does a weekly lead in a two-week playoff stay a weekly lead in the headline?
- Are byes, ties, inactive teams, stat corrections and unconfirmed results carried
  consistently through every module?

Recheck injuries and player ownership at publication time. For historical editions,
separate contemporaneous reporting from any explicitly labeled current update;
never silently import later knowledge into the original week's narrative.
