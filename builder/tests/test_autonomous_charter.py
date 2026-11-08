"""Behavioral contracts for calendar dates, durable scheduling and daily reporting."""

from copy import deepcopy
from datetime import datetime

import pytest
from autonomous_agent.charter import CalendarEvent, CharterConfig, CharterOutput
from autonomous_agent.prompt import parse_structured_output
from autonomous_agent.scheduling import (
    accept_observations,
    action,
    empty_state,
    finish,
    prune,
    recover,
    schedule,
    select_due,
)
from autonomous_agent.summary import publish_daily_summary
from pydantic import ValidationError


def ms(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


NOW = ms("2026-11-07T12:00:00-05:00")


def output(**kwargs):
    return CharterOutput.model_validate(
        {
            "outcome": {
                "status": "completed",
                "summary": "Verified source.",
                "evidence": [{"description": "Read official schedule."}],
            },
            **kwargs,
        }
    )


def event(**kwargs):
    return {
        "sourceKey": "saline-leaves-2026",
        "sourceUrl": "https://www.salinemi.gov/newslist.php",
        "title": "Leaf pickup",
        "applicability": "Official citywide collection window.",
        "allDay": True,
        "start": "2026-11-09",
        "end": "2026-11-14",
        **kwargs,
    }


def game(**kwargs):
    return {
        "sourceKey": "msu-game-2026-11-07",
        "sourceUrl": "https://msuspartans.com/sports/football/schedule",
        "sport": "football",
        "opponent": "Opponent",
        "start": "2026-11-07T13:00:00-05:00",
        "status": "scheduled",
        **kwargs,
    }


@pytest.mark.parametrize(
    "legacy",
    [
        {"mode": "hybrid"},
        {"actionPolicy": "broad_autonomy"},
        {"feedDedupeEnabled": True},
        {"intervalSeconds": 14400},
        {"expansionPolicy": "unrestricted"},
        {
            "responsibilities": {
                "cluster": {"configurationSource": "external_repository"}
            }
        },
    ],
)
def test_retired_configuration_is_not_accepted(legacy):
    with pytest.raises(ValidationError):
        CharterConfig.model_validate(legacy)


def test_old_feed_output_is_rejected_without_echoing_private_text():
    with pytest.raises(ValueError) as error:
        parse_structured_output('{"summary":"PRIVATE", "feed_items": []}')
    assert "PRIVATE" not in str(error.value)


def test_all_day_collection_windows_remain_date_only():
    value = CalendarEvent.model_validate(event())
    assert value.calendar_times() == {
        "start": {"date": "2026-11-09"},
        "end": {"date": "2026-11-14"},
    }
    assert not value.is_past(NOW)
    assert value.is_past(ms("2026-11-14T00:00:00-05:00"))


@pytest.mark.parametrize(
    ("start", "expected"),
    [
        ("2026-07-01T18:00:00Z", "2026-07-01T14:00:00-04:00"),
        ("2026-12-01T18:00:00Z", "2026-12-01T13:00:00-05:00"),
    ],
)
def test_timed_events_follow_michigan_daylight_saving(start, expected):
    value = CalendarEvent.model_validate(
        event(allDay=False, start=start, end=start.replace("18:", "19:"))
    )
    assert value.calendar_times()["start"] == {
        "dateTime": expected,
        "timeZone": "America/Detroit",
    }


@pytest.mark.parametrize(
    "values",
    [
        {"allDay": False, "start": "2026-11-09T12:00:00", "end": "2026-11-09T13:00:00"},
        {"start": "2026-11-09", "end": "2026-11-09"},
        {"start": "2026-11-09T00:00:00Z"},
        {"sourceUrl": "https://user:secret@example.org/event"},
    ],
)
def test_ambiguous_or_invalid_calendar_inputs_fail_closed(values):
    with pytest.raises(ValidationError):
        CalendarEvent.model_validate(event(**values))


def test_calendar_discovery_skips_stale_year_and_deduplicates_current_event():
    state, config = empty_state(), CharterConfig()
    task = action("calendar_discovery", "today", NOW)
    observations = output(
        calendarEvents=[
            event(),
            event(sourceKey="old", start="2025-11-09", end="2025-11-14"),
        ]
    )
    accept_observations(state, task, observations, config, NOW)
    accept_observations(state, task, observations, config, NOW + 1000)
    assert len(state["actions"]) == 1
    assert next(iter(state["actions"].values()))["payload"]["start"] == "2026-11-09"


def test_revised_event_supersedes_pending_write():
    state, config = empty_state(), CharterConfig()
    task = action("calendar_discovery", "today", NOW)
    accept_observations(state, task, output(calendarEvents=[event()]), config, NOW)
    accept_observations(
        state, task, output(calendarEvents=[event(start="2026-11-10")]), config, NOW
    )
    assert sorted(item["status"] for item in state["actions"].values()) == [
        "cancelled",
        "pending",
    ]


def test_model_cannot_schedule_another_responsibility():
    with pytest.raises(ValueError, match="Only calendar discovery"):
        accept_observations(
            empty_state(),
            action("evolution", "today", NOW),
            output(calendarEvents=[event()]),
            CharterConfig(),
            NOW,
        )


def test_game_postponement_preserves_identity_and_completed_activation_is_not_replayed():
    state, config = empty_state(), CharterConfig()
    task = action("sports_discovery", "today", NOW)
    accept_observations(state, task, output(games=[game()]), config, NOW)
    identity = next(iter(state["actions"]))
    accept_observations(
        state,
        task,
        output(games=[game(start="2026-11-07T14:00:00-05:00")]),
        config,
        NOW,
    )
    assert list(state["actions"]) == [identity]
    assert state["actions"][identity]["dueAt"] == ms("2026-11-07T14:00:00-05:00")
    state["actions"][identity]["status"] = "completed"
    accept_observations(
        state,
        task,
        output(games=[game(start="2026-11-07T15:00:00-05:00")]),
        config,
        NOW,
    )
    assert state["actions"][identity]["status"] == "completed"
    assert len(state["actions"]) == 1  # No end-of-game task is created.


def test_cancelled_game_does_not_activate_and_can_be_rescheduled_before_execution():
    state, config = empty_state(), CharterConfig()
    task = action("sports_discovery", "today", NOW)
    for status in ("scheduled", "postponed", "scheduled", "cancelled"):
        accept_observations(
            state, task, output(games=[game(status=status)]), config, NOW
        )
        entry = next(iter(state["actions"].values()))
        assert entry["status"] == ("pending" if status == "scheduled" else "cancelled")
    assert select_due(state, config, ms("2026-11-07T13:00:00-05:00")) is None


def test_missed_game_window_expires_instead_of_lighting_a_completed_game():
    state, config = empty_state(), CharterConfig()
    task = action("sports_discovery", "today", NOW)
    accept_observations(state, task, output(games=[game()]), config, NOW)
    assert select_due(state, config, ms("2026-11-07T13:16:00-05:00")) is None
    assert next(iter(state["actions"].values()))["status"] == "expired"


def test_scheduler_prioritizes_due_game_and_pauses_individual_responsibilities():
    state, config = empty_state(), CharterConfig()
    schedule(state, config, NOW)
    task = action("sports_discovery", "today", NOW)
    accept_observations(state, task, output(games=[game()]), config, NOW)
    assert (
        select_due(state, config, ms("2026-11-07T13:00:00-05:00"))["kind"]
        == "game_lighting"
    )
    config.responsibilities.lighting.enabled = False
    assert (
        select_due(state, config, ms("2026-11-07T13:00:00-05:00"))["responsibility"]
        != "lighting"
    )
    config.enabled = False
    assert select_due(state, config, NOW) is None


def test_unavailable_work_does_not_prevent_other_responsibilities_from_being_scheduled():
    state, config = empty_state(), CharterConfig()
    schedule(state, config, NOW)
    for item in state["actions"].values():
        if item["kind"] == "calendar_discovery":
            item["status"] = "uncertain"
    schedule(state, config, NOW + 1000)
    assert {
        item["kind"]
        for item in state["actions"].values()
        if item["status"] == "pending"
    } == {
        "sports_discovery",
        "cluster_maintenance",
        "evolution",
    }


def test_restart_never_replays_dispatched_game_or_cluster_work():
    state, config = empty_state(), CharterConfig()
    task = action("sports_discovery", "today", NOW)
    accept_observations(state, task, output(games=[game()]), config, NOW)
    entry = next(iter(state["actions"].values()))
    entry.update(status="running", runId="run-interrupted")
    state["runs"] = [{"id": "run-interrupted", "status": "running"}]
    recover(state, NOW)
    assert entry["status"] == "uncertain"
    assert state["runs"][0]["status"] == "uncertain"
    accept_observations(state, task, output(games=[game()]), config, NOW)
    assert entry["status"] == "uncertain"
    assert select_due(state, config, ms("2026-11-07T13:00:00-05:00")) is None


@pytest.mark.parametrize("day", ["2026-07-01", "2026-11-07"])
def test_daily_summary_occurs_once_at_configured_eastern_time_across_restarts(day):
    offset = "-04:00" if day.endswith("07-01") else "-05:00"
    state, config = empty_state(), CharterConfig()
    schedule(state, config, ms(f"{day}T17:59:00{offset}"))
    assert not any(
        item["kind"] == "daily_summary" for item in state["actions"].values()
    )
    schedule(state, config, ms(f"{day}T18:00:00{offset}"))
    restored = deepcopy(state)
    schedule(restored, config, ms(f"{day}T19:00:00{offset}"))
    assert (
        len(
            [
                item
                for item in restored["actions"].values()
                if item["kind"] == "daily_summary"
            ]
        )
        == 1
    )


def test_digest_reports_verified_partial_and_unknown_results_without_repeat_findings():
    state, config = empty_state(), CharterConfig()
    task = action("game_lighting", "one", NOW)
    task.update(
        status="partial",
        outcome={
            "status": "partial",
            "summary": "Reachable lights changed.",
            "skipped": ["offline-light"],
        },
    )
    state["actions"][task["id"]] = task
    digest_task = action(
        "daily_summary", "2026-11-07", NOW, payload={"date": "2026-11-07"}
    )
    first = publish_daily_summary(state, digest_task, config, NOW)
    assert first["items"][0]["status"] == "partial"
    assert first["items"][0]["skipped"] == ["offline-light"]
    assert publish_daily_summary(state, digest_task, config, NOW) == first
    tomorrow = action(
        "daily_summary", "2026-11-08", NOW, payload={"date": "2026-11-08"}
    )
    assert publish_daily_summary(state, tomorrow, config, NOW)["items"] == []


def test_completion_requires_evidence_but_failure_does_not_invent_it():
    with pytest.raises(ValidationError, match="evidence"):
        CharterOutput.model_validate(
            {"outcome": {"status": "completed", "summary": "done"}}
        )
    assert output().outcome.evidence
    assert (
        CharterOutput.model_validate(
            {"outcome": {"status": "uncertain", "summary": "Lost stream"}}
        ).outcome.status
        == "uncertain"
    )


def test_digest_reports_recurring_issue_after_recovery_without_replaying_history():
    state, config = empty_state(), CharterConfig()
    for day, summary in enumerate(
        ["Admission failed", "Admission recovered", "Admission failed"], 7
    ):
        task = action("cluster_maintenance", str(day), NOW + day)
        task.update(
            status="completed", outcome={"status": "completed", "summary": summary}
        )
        state["actions"][task["id"]] = task
        digest = action(
            "daily_summary", str(day), NOW, payload={"date": f"2026-11-{day:02}"}
        )
        result = publish_daily_summary(state, digest, config, NOW + day)
        assert [item["summary"] for item in result["items"]] == [summary]
    digest = action("daily_summary", "10", NOW, payload={"date": "2026-11-10"})
    assert publish_daily_summary(state, digest, config, NOW + 10)["items"] == []


def test_calendar_dismissal_survives_a_completion_racing_cancellation():
    state, config = empty_state(), CharterConfig()
    task = action("calendar_event", "one", NOW, payload=event())
    state["actions"][task["id"]] = task
    state["records"][event()["sourceKey"]] = {"dismissed": True}
    finish(
        state,
        task["id"],
        output(
            outcome={
                "status": "completed",
                "summary": "Verified event",
                "externalId": "remote-id",
                "observedState": {"title": "Leaf pickup"},
                "evidence": [{"description": "Read back event"}],
            }
        ),
        config,
        NOW,
    )
    assert state["records"][event()["sourceKey"]]["dismissed"] is True
    assert state["records"][event()["sourceKey"]]["externalId"] == "remote-id"
    before = deepcopy(state)
    accept_observations(
        state,
        action("calendar_discovery", "later", NOW),
        output(calendarEvents=[event(start="2026-11-10")]),
        config,
        NOW,
    )
    assert state == before


def test_last_minute_game_change_reschedules_the_same_activation_before_any_write():
    state, config = empty_state(), CharterConfig()
    accept_observations(
        state,
        action("sports_discovery", "today", NOW),
        output(games=[game()]),
        config,
        NOW,
    )
    task = next(iter(state["actions"].values()))
    task.update(status="running", attempts=1)
    correction = output(
        outcome={"status": "deferred", "summary": "Official tipoff moved."},
        games=[game(start="2026-11-07T14:00:00-05:00")],
    )
    finish(state, task["id"], correction, config, ms("2026-11-07T13:00:00-05:00"))
    assert task["status"] == "pending"
    assert task["dueAt"] == ms("2026-11-07T14:00:00-05:00")
    assert len(state["actions"]) == 1
    assert select_due(state, config, ms("2026-11-07T13:15:00-05:00")) is None
    assert (
        select_due(state, config, ms("2026-11-07T14:00:00-05:00"))["id"] == task["id"]
    )
    correction.outcome.mutationAttempted = True
    with pytest.raises(ValueError, match="unattempted"):
        finish(state, task["id"], correction, config, NOW)


def test_observation_batch_rejects_conflicting_identities():
    with pytest.raises(ValidationError, match="once per result"):
        output(calendarEvents=[event(), event(start="2026-11-10")])


def test_cancelled_uncertain_calendar_intent_is_not_requeued():
    state, config = empty_state(), CharterConfig()
    discovery = action("calendar_discovery", "today", NOW)
    accept_observations(state, discovery, output(calendarEvents=[event()]), config, NOW)
    task = next(iter(state["actions"].values()))
    task.update(status="uncertain", cancelledByUser=True, attempts=1)
    accept_observations(state, discovery, output(calendarEvents=[event()]), config, NOW)
    assert task["status"] == "uncertain"


def test_calendar_source_failure_retries_only_after_discovery_cooldown():
    state, config = empty_state(), CharterConfig()
    discovery = action("calendar_discovery", "today", NOW)
    observation = output(calendarEvents=[event()])
    accept_observations(state, discovery, observation, config, NOW)
    task = next(iter(state["actions"].values()))
    task.update(status="running", attempts=config.maxAttempts)
    finish(
        state,
        task["id"],
        output(outcome={"status": "deferred", "summary": "Google access unavailable."}),
        config,
        NOW,
    )
    assert task["status"] == "failed"
    accept_observations(state, discovery, observation, config, NOW + 1)
    assert task["status"] == "failed"
    retry_at = NOW + config.responsibilities.calendar.intervalSeconds * 1000
    accept_observations(state, discovery, observation, config, retry_at)
    assert task["status"] == "pending"
    assert task["attempts"] == 0
    assert task["dueAt"] == retry_at


def test_calendar_schedule_reverting_to_an_older_revision_is_reconciled_again():
    state, config = empty_state(), CharterConfig()
    discovery = action("calendar_discovery", "today", NOW)
    for day in ("2026-11-09", "2026-11-10", "2026-11-09"):
        accept_observations(
            state, discovery, output(calendarEvents=[event(start=day)]), config, NOW
        )
        pending = [
            item for item in state["actions"].values() if item["status"] == "pending"
        ]
        assert len(pending) == 1
        task = pending[0]
        assert task["payload"]["start"] == day
        finish(
            state,
            task["id"],
            output(
                outcome={
                    "status": "completed",
                    "summary": "Updated date",
                    "externalId": "same-google-event",
                    "observedState": {"start": day},
                    "evidence": [{"description": "Read event back"}],
                }
            ),
            config,
            NOW,
        )
    assert len(state["actions"]) == 2


def test_source_reverting_before_dispatch_cancels_the_superseded_pending_revision():
    state, config = empty_state(), CharterConfig()
    discovery = action("calendar_discovery", "today", NOW)
    for day in ("2026-11-09", "2026-11-10", "2026-11-09"):
        accept_observations(
            state, discovery, output(calendarEvents=[event(start=day)]), config, NOW
        )
    pending = [
        item for item in state["actions"].values() if item["status"] == "pending"
    ]
    assert len(pending) == 1
    assert pending[0]["payload"]["start"] == "2026-11-09"


def test_frequent_health_history_is_bounded_without_losing_active_work_or_game_identity():
    state, config = empty_state(), CharterConfig(maxRunsStored=10)
    for index in range(30):
        task = action("cluster_maintenance", str(index), NOW + index)
        task["status"] = "completed"
        state["actions"][task["id"]] = task
    active = action("cluster_maintenance", "active", NOW)
    state["actions"][active["id"]] = active
    accept_observations(
        state,
        action("sports_discovery", "today", NOW),
        output(games=[game()]),
        config,
        NOW,
    )
    lighting = next(
        item for item in state["actions"].values() if item["kind"] == "game_lighting"
    )
    lighting["status"] = "uncertain"
    prune(state, config, NOW + 100)
    assert len(state["actions"]) == 12
    assert state["actions"][active["id"]]["status"] == "pending"
    assert state["actions"][lighting["id"]]["status"] == "uncertain"


def test_interrupted_daily_summary_claim_is_recovered_without_losing_the_days_report():
    state, config = empty_state(), CharterConfig()
    task = action("daily_summary", "today", NOW, payload={"date": "2026-11-07"})
    task.update(status="running", runId="run-summary")
    state["actions"][task["id"]] = task
    state["runs"] = [{"id": "run-summary", "status": "running"}]
    recover(state, NOW)
    assert task["status"] == "pending"
    assert select_due(state, config, NOW)["id"] == task["id"]
    first = publish_daily_summary(state, task, config, NOW)
    task.update(status="running", runId="run-summary-again")
    state["runs"].insert(0, {"id": "run-summary-again", "status": "running"})
    assert publish_daily_summary(state, task, config, NOW) == first
    assert len(state["summaries"]) == 1
    assert task["status"] == "completed"
    assert state["runs"][0]["status"] == "completed"


def test_periodic_scheduling_respects_pending_capacity_and_retries_when_space_opens():
    state, config = empty_state(), CharterConfig(maxPendingActions=10)
    for index in range(10):
        task = action("calendar_event", str(index), NOW, payload=event())
        state["actions"][task["id"]] = task
    schedule(state, config, NOW)
    assert len(state["actions"]) == 10
    assert state["schedules"] == {}
    next(iter(state["actions"].values()))["status"] = "completed"
    schedule(state, config, NOW)
    assert sum(item["status"] == "pending" for item in state["actions"].values()) == 10
    assert "calendar_discovery" in state["schedules"]
