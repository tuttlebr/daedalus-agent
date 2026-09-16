#!/usr/bin/env python3
"""Audit raw ESPN score responses; status evidence is supplied by the reporter."""

import argparse
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def points(value):
    """Preserve missing values and decimal precision; never coerce them to zero."""
    if value is None:
        return None
    require(not isinstance(value, bool), "Boolean is not a score")
    try:
        result = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError("Invalid decimal score") from exc
    require(result.is_finite(), "Non-finite score")
    return result


def number(value):
    return None if value is None else format(value, "f")


def audit(snapshot):
    league, teams, board = (snapshot[key] for key in ("league", "teams", "scoreboard"))
    for key in ("league_id", "season"):
        require(league.get(key) is not None, f"Missing {key}")
        require(
            league[key] == teams.get(key) == board.get(key),
            f"Mixed {key} across responses",
        )
    week, period = board["week"], board["matchup_period"]
    periods = league["settings"]["scheduleSettings"]["matchupPeriods"]
    weeks = periods[str(period)]
    require(weeks and week in weeks, "Week is outside the matchup period")
    multiweek = len(weeks) > 1
    names = {}
    for team in teams["teams"]:
        team_id = str(team["id"])
        require(team_id not in names, "Duplicate team ID")
        require(bool(team.get("name")), "Missing team name")
        names[team_id] = team["name"]
    require(bool(names), "Empty team list")
    matches = board["matchups"]
    match_ids = [str(match["id"]) for match in matches]
    require(len(set(match_ids)) == len(match_ids), "Duplicate matchup ID")
    checks = snapshot["checks"]
    require(set(checks) == set(match_ids), "Status checks must cover every matchup")
    idle = snapshot.get("idle_teams", {})
    require(set(idle) <= set(names), "Unknown idle team")
    require(
        all(isinstance(reason, str) and reason.strip() for reason in idle.values()),
        "Idle teams need verified reasons",
    )
    seen, weekly, rows = set(), {}, []
    all_final = bool(matches) and not multiweek and not idle
    for match in matches:
        match_id = str(match["id"])
        require(match.get("matchupPeriodId") == period, "Mixed matchup periods")
        check = checks[match_id]
        status = check["status"]
        require(
            status in {"final", "live", "scheduled", "unconfirmed", "bye"},
            "Unknown status",
        )
        require(
            isinstance(check.get("evidence"), str) and check["evidence"].strip(),
            "Status needs evidence or an uncertainty explanation",
        )
        sides = [side for side in ("home", "away") if match.get(side) is not None]
        require(bool(sides), "Matchup has no teams")
        require((len(sides) == 1) == (status == "bye"), "Bye/side mismatch")
        all_final = all_final and status == "final"
        row = {
            "matchup_id": match_id,
            "status": status,
            "sides": {},
            "winner": None,
            "winner_team_id": None,
            "margin": None,
            "leader": None,
            "leader_team_id": None,
            "lead": None,
            "decision": None,
        }
        totals, participants = {}, set()
        for side in sides:
            source = match[side]
            team_id = str(source["teamId"])
            require(team_id in names, "Unknown matchup team")
            require(team_id not in participants, "Team plays itself")
            participants.add(team_id)
            seen.add(team_id)
            total = points(source.get("totalPoints"))
            if status == "live" and source.get("totalPointsLive") is not None:
                total = points(source["totalPointsLive"])
            by_week = source.get("pointsByScoringPeriod") or {}
            score = points(by_week.get(str(week)))
            if not multiweek:
                if status == "final" and score is not None and total is not None:
                    require(score == total, "Weekly/final total discrepancy")
                score = total
            if team_id in weekly:
                require(weekly[team_id] == score, "Conflicting weekly team scores")
            weekly[team_id] = score
            totals[side] = total
            row["sides"][side] = {
                "team_id": team_id,
                "name": names[team_id],
                "weekly_points": number(score),
                "matchup_points": number(total),
            }
        if status == "final":
            require(
                not multiweek or week == max(weeks),
                "An earlier multiweek leg cannot be a final series result",
            )
            require(all(v is not None for v in totals.values()), "Final score missing")
            difference = totals["home"] - totals["away"]
            official = match.get("winner")
            if difference == 0:
                if official == "TIE":
                    row["decision"] = "tie"
                else:
                    rule = check.get("tiebreaker")
                    require(
                        official in {"HOME", "AWAY"}
                        and isinstance(rule, str)
                        and rule.strip(),
                        "Equal-score winner requires a verified tiebreaker",
                    )
                    row["winner"] = row["sides"][official.lower()]["name"]
                    row["winner_team_id"] = row["sides"][official.lower()]["team_id"]
                    row["decision"] = "tiebreaker"
                row["margin"] = "0"
            else:
                winner_side = "HOME" if difference > 0 else "AWAY"
                require(official == winner_side, "Official winner contradicts scores")
                row["winner"] = row["sides"][winner_side.lower()]["name"]
                row["winner_team_id"] = row["sides"][winner_side.lower()]["team_id"]
                row["margin"] = number(abs(difference))
                row["decision"] = "points"
        elif status == "live" and all(v is not None for v in totals.values()):
            difference = totals["home"] - totals["away"]
            if difference:
                side = "home" if difference > 0 else "away"
                row["leader"] = row["sides"][side]["name"]
                row["leader_team_id"] = row["sides"][side]["team_id"]
            row["lead"] = number(abs(difference))
        rows.append(row)
    require(not (seen & set(idle)), "Idle team also appears in a matchup")
    require(seen | set(idle) == set(names), "Incomplete league coverage")
    extrema = None
    if all_final and all(value is not None for value in weekly.values()):
        extrema = {}
        for label, extreme in (("high", max), ("low", min)):
            value = extreme(weekly.values())
            extrema[label] = {
                "points": number(value),
                "teams": [
                    {"team_id": key, "name": names[key]}
                    for key, score in weekly.items()
                    if score == value
                ],
            }
    return {
        "season": board["season"],
        "week": week,
        "matchup_period": period,
        "multiweek": multiweek,
        "matchups": rows,
        "idle_teams": [
            {"name": names[key], "reason": reason} for key, reason in idle.items()
        ],
        "league_weekly_extrema": extrema,
        "limitation": (
            "Arithmetic and coverage within supplied responses only; reporter verifies "
            "source completeness and supplies status evidence."
        ),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    args = parser.parse_args()
    try:
        snapshot = json.loads(args.snapshot.read_text(), parse_float=Decimal)
        result = audit(snapshot)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, **result}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
