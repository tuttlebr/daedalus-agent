"""Synthetic score evidence exercises the recap helper without league access."""

import json
import runpy
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "skills/fantasy-football-recap/scripts/check_scoreboard.py"
)
audit = runpy.run_path(str(SCRIPT))["audit"]


@pytest.fixture
def snapshot():
    context = {"league_id": 1, "season": 2026}
    return {
        "league": {
            **context,
            "settings": {"scheduleSettings": {"matchupPeriods": {"1": [1]}}},
        },
        "teams": {
            **context,
            "teams": [{"id": 1, "name": "Comets"}, {"id": 2, "name": "Moons"}],
        },
        "scoreboard": {
            **context,
            "week": 1,
            "matchup_period": 1,
            "matchups": [
                {
                    "id": 7,
                    "matchupPeriodId": 1,
                    "winner": "HOME",
                    "home": {"teamId": 1, "totalPoints": "101.10"},
                    "away": {"teamId": 2, "totalPoints": "99.95"},
                }
            ],
        },
        "checks": {"7": {"status": "final", "evidence": "Synthetic final period"}},
    }


def test_exact_decimal_margin_and_correct_team(snapshot):
    result = audit(snapshot)
    match = result["matchups"][0]
    assert match["winner"] == "Comets"
    assert match["winner_team_id"] == "1"
    assert match["margin"] == "1.15"
    assert result["league_weekly_extrema"]["high"]["teams"] == [
        {"team_id": "1", "name": "Comets"}
    ]


@pytest.mark.parametrize(
    "home,away,margin", [("-1.25", "0", "1.25"), ("0", "0.001", "0.001")]
)
def test_away_wins_negative_and_subcent_scores(snapshot, home, away, margin):
    match = snapshot["scoreboard"]["matchups"][0]
    match["home"]["totalPoints"] = home
    match["away"]["totalPoints"] = away
    match["winner"] = "AWAY"
    result = audit(snapshot)["matchups"][0]
    assert result["winner"] == "Moons"
    assert result["margin"] == margin


def test_official_winner_conflict_fails(snapshot):
    snapshot["scoreboard"]["matchups"][0]["winner"] = "AWAY"
    with pytest.raises(ValueError, match="winner contradicts"):
        audit(snapshot)


def test_stat_correction_changes_winner_without_reusing_old_margin(snapshot):
    before = audit(snapshot)["matchups"][0]
    match = snapshot["scoreboard"]["matchups"][0]
    match["away"]["totalPoints"] = "102.10"
    match["winner"] = "AWAY"
    after = audit(snapshot)["matchups"][0]
    assert before["winner_team_id"] == "1"
    assert after["winner_team_id"] == "2" and after["margin"] == "1.00"


def test_single_week_discrepancy_requires_reconciliation(snapshot):
    match = snapshot["scoreboard"]["matchups"][0]
    match["home"]["pointsByScoringPeriod"] = {"1": "100.10"}
    with pytest.raises(ValueError, match="Weekly/final total discrepancy"):
        audit(snapshot)


def test_duplicate_names_keep_distinct_winner_identity(snapshot):
    snapshot["teams"]["teams"][1]["name"] = "Comets"
    row = audit(snapshot)["matchups"][0]
    assert row["sides"]["home"]["name"] == row["sides"]["away"]["name"]
    assert row["winner_team_id"] == "1"


@pytest.mark.parametrize("value", [None, True, "NaN", "Infinity", "unknown"])
def test_missing_or_invalid_final_score_never_becomes_zero(snapshot, value):
    snapshot["scoreboard"]["matchups"][0]["away"]["totalPoints"] = value
    with pytest.raises(ValueError):
        audit(snapshot)


def test_equal_score_tie_shares_extrema(snapshot):
    match = snapshot["scoreboard"]["matchups"][0]
    match["away"]["totalPoints"] = "101.10"
    match["winner"] = "TIE"
    result = audit(snapshot)
    assert result["matchups"][0]["winner"] is None
    assert result["matchups"][0]["decision"] == "tie"
    assert len(result["league_weekly_extrema"]["high"]["teams"]) == 2


def test_equal_score_win_requires_rule(snapshot):
    snapshot["scoreboard"]["matchups"][0]["away"]["totalPoints"] = "101.10"
    with pytest.raises(ValueError, match="verified tiebreaker"):
        audit(snapshot)
    snapshot["checks"]["7"]["tiebreaker"] = "Verified synthetic playoff seed rule"
    result = audit(snapshot)["matchups"][0]
    assert result["winner"] == "Comets"
    assert result["margin"] == "0"
    assert result["decision"] == "tiebreaker"


def test_live_projection_and_winner_flag_do_not_create_a_win(snapshot):
    snapshot["checks"]["7"]["status"] = "live"
    match = snapshot["scoreboard"]["matchups"][0]
    match["away"].update(totalPointsLive="102.50", totalProjectedPointsLive="999")
    result = audit(snapshot)
    row = result["matchups"][0]
    assert row["winner"] is None and row["margin"] is None
    assert row["leader"] == "Moons" and row["lead"] == "1.40"
    assert result["league_weekly_extrema"] is None


@pytest.mark.parametrize("status", ["scheduled", "unconfirmed"])
def test_unconfirmed_or_scheduled_has_no_winner_or_leader(snapshot, status):
    snapshot["checks"]["7"]["status"] = status
    result = audit(snapshot)["matchups"][0]
    assert result["winner"] is result["leader"] is result["margin"] is None


def test_weekly_playoff_leg_is_not_an_aggregate_victory(snapshot):
    snapshot["league"]["settings"]["scheduleSettings"]["matchupPeriods"]["1"] = [1, 2]
    match = snapshot["scoreboard"]["matchups"][0]
    match["home"].update(totalPoints="220.00", pointsByScoringPeriod={"1": "90.00"})
    match["away"].update(totalPoints="210.00", pointsByScoringPeriod={"1": "110.00"})
    with pytest.raises(ValueError, match="earlier multiweek leg"):
        audit(snapshot)
    snapshot["checks"]["7"]["status"] = "live"
    result = audit(snapshot)
    row = result["matchups"][0]
    assert row["sides"]["home"]["weekly_points"] == "90.00"
    assert row["sides"]["home"]["matchup_points"] == "220.00"
    assert row["leader"] == "Comets" and row["winner"] is None
    assert result["league_weekly_extrema"] is None


def test_multiweek_final_uses_aggregate_and_missing_week_stays_unknown(snapshot):
    snapshot["league"]["settings"]["scheduleSettings"]["matchupPeriods"]["1"] = [1, 2]
    snapshot["scoreboard"]["week"] = 2
    row = audit(snapshot)["matchups"][0]
    assert row["winner"] == "Comets"
    assert row["sides"]["home"]["weekly_points"] is None


def test_bye_never_creates_a_win(snapshot):
    del snapshot["scoreboard"]["matchups"][0]["away"]
    snapshot["checks"]["7"]["status"] = "bye"
    snapshot["idle_teams"] = {"2": "Eliminated in synthetic postseason"}
    result = audit(snapshot)
    assert result["matchups"][0]["winner"] is None
    assert result["league_weekly_extrema"] is None


@pytest.mark.parametrize("key", ["league_id", "season"])
def test_mixed_context_fails(snapshot, key):
    snapshot["teams"][key] += 1
    with pytest.raises(ValueError, match=f"Mixed {key}"):
        audit(snapshot)


def test_incomplete_league_cannot_earn_league_superlative(snapshot):
    snapshot["teams"]["teams"].append({"id": 3, "name": "Stars"})
    with pytest.raises(ValueError, match="Incomplete league"):
        audit(snapshot)


def test_duplicate_matchup_and_missing_status_fail(snapshot):
    snapshot["scoreboard"]["matchups"] *= 2
    with pytest.raises(ValueError, match="Duplicate matchup"):
        audit(snapshot)
    snapshot["scoreboard"]["matchups"].pop()
    snapshot["checks"].clear()
    with pytest.raises(ValueError, match="cover every matchup"):
        audit(snapshot)


def test_doubleheader_preserves_each_matchup_and_deduplicates_extrema(snapshot):
    match = snapshot["scoreboard"]["matchups"][0]
    snapshot["scoreboard"]["matchups"].append({**match, "id": 8})
    snapshot["checks"]["8"] = dict(snapshot["checks"]["7"])
    result = audit(snapshot)
    assert len(result["matchups"]) == 2
    assert len(result["league_weekly_extrema"]["high"]["teams"]) == 1
    snapshot["scoreboard"]["matchups"][1]["home"] = {"teamId": 1, "totalPoints": "130"}
    with pytest.raises(ValueError, match="Conflicting weekly"):
        audit(snapshot)


def test_cli_preserves_numeric_decimal_precision_and_rejects_bad_json(
    snapshot, tmp_path
):
    path = tmp_path / "snapshot.json"
    path.write_text(
        json.dumps(snapshot).replace('"101.10"', "101.10").replace('"99.95"', "99.95")
    )
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(path)], capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["matchups"][0]["margin"] == "1.15"
    path.write_text("{")
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(path)], capture_output=True, text=True
    )
    assert result.returncode == 1
    assert json.loads(result.stderr)["ok"] is False
