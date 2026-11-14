"""Custom tasks use service tools and deterministic schedules, independent of Hue."""

import json
from datetime import datetime

import pytest
from autonomous_agent.charter import AutomationRule, CharterConfig, task_enabled
from autonomous_agent.prompt import build_messages
from autonomous_agent.scheduling import empty_state, prune, schedule, select_due
from pydantic import ValidationError


def ms(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


def config(**settings):
    result = CharterConfig()
    for name in ("calendar", "lighting", "cluster", "evolution"):
        getattr(result.responsibilities, name).enabled = False
    result.responsibilities.automations.rules = [
        AutomationRule(
            id="weather",
            title="Morning weather",
            instructions="Check the forecast and summarize rain.",
            allowedTools=["nws_weather_tool"],
            **settings,
        )
    ]
    return result


def test_independent_rules_schedule_once_and_keep_scoped_instructions():
    cfg = config(intervalSeconds=300)
    cfg.responsibilities.automations.rules.append(
        AutomationRule(
            id="network",
            title="Network check",
            instructions="Inspect current network health.",
            allowedTools=["unifi_mcp_server__get_health"],
            intervalSeconds=600,
        )
    )
    state = empty_state()
    now = ms("2026-11-09T08:00:00-05:00")
    schedule(state, cfg, now)
    schedule(state, cfg, now + 10000)
    assert len(state["actions"]) == 2
    task = select_due(state, cfg, now)
    messages = build_messages(config=cfg, task=task, state=state, timestamp=now)
    context = json.loads(messages[1]["content"])
    rule = next(
        rule
        for rule in cfg.responsibilities.automations.rules
        if rule.id == task["payload"]["ruleId"]
    )
    assert context["settings"]["allowedTools"] == rule.allowedTools
    assert context["settings"]["instructions"] == rule.instructions
    assert "selected" in messages[0]["content"]
    task.update(status="completed")
    schedule(state, cfg, now + 600000)
    assert len(state["actions"]) == 3


def test_daily_schedule_windows_expiration_and_dst():
    cfg = config(dailyTimes=["08:00"], weekdays=[0], months=[11])
    state = empty_state()
    schedule(state, cfg, ms("2026-11-09T07:59:59-05:00"))
    assert not state["actions"]
    now = ms("2026-11-09T08:00:05-05:00")
    schedule(state, cfg, now)
    task = select_due(state, cfg, now)
    assert task["dueAt"] == ms("2026-11-09T08:00:00-05:00")
    task["status"] = "completed"
    schedule(state, cfg, now + 60000)
    assert len(state["actions"]) == 1
    schedule(state, cfg, ms("2026-11-10T08:00:00-05:00"))
    assert len(state["actions"]) == 1
    # A queued fixed-time task cannot run after its missed-start allowance.
    task["status"] = "pending"
    assert select_due(state, cfg, now + 16 * 60000) is None
    assert task["status"] == "expired"
    fall = config(dailyTimes=["01:30"])
    state = empty_state()
    schedule(state, fall, ms("2026-11-01T01:30:05-04:00"))
    next(iter(state["actions"].values()))["status"] = "completed"
    schedule(state, fall, ms("2026-11-01T01:30:05-05:00"))
    assert len(state["actions"]) == 1
    spring = config(dailyTimes=["02:30"])
    state = empty_state()
    schedule(state, spring, ms("2026-03-08T03:30:05-04:00"))
    assert not state["actions"]


def test_pause_edit_and_removal_revoke_queued_work():
    cfg = config()
    state = empty_state()
    now = ms("2026-11-09T08:00:00-05:00")
    schedule(state, cfg, now)
    task = next(iter(state["actions"].values()))
    assert task_enabled(cfg, "automation", task["payload"], now)
    cfg.responsibilities.automations.rules[0].allowedTools.append(
        "perplexity_search_tool"
    )
    assert not task_enabled(cfg, "automation", task["payload"], now)
    schedule(state, cfg, now)
    assert task["status"] == "cancelled"
    cfg.responsibilities.automations.rules.clear()
    schedule(state, cfg, now)
    assert not state["schedules"]
    assert select_due(state, cfg, now) is None


def test_uncertain_effects_hold_only_the_affected_rule_and_survive_pruning():
    cfg = config(intervalSeconds=300)
    state = empty_state()
    now = ms("2026-11-09T08:00:00-05:00")
    schedule(state, cfg, now)
    task = next(iter(state["actions"].values()))
    task["status"] = "uncertain"
    cfg.responsibilities.automations.rules.append(
        AutomationRule(
            id="other",
            title="Other task",
            instructions="Check weather elsewhere.",
            allowedTools=["nws_weather_tool"],
        )
    )
    schedule(state, cfg, now + 600000)
    assert len(state["actions"]) == 2
    assert select_due(state, cfg, now + 600000)["payload"]["ruleId"] == "other"
    prune(state, cfg, now + 400 * 86400000)
    assert task["id"] in state["actions"]


@pytest.mark.parametrize(
    "patch",
    [
        {"allowedTools": []},
        {"allowedTools": ["*"]},
        {"allowedTools": ["tool", "tool"]},
        {"dailyTimes": ["24:00"]},
        {"dailyTimes": ["08:00", "08:00"]},
        {"instructions": " "},
    ],
)
def test_invalid_automation_contracts(patch):
    with pytest.raises(ValidationError):
        AutomationRule.model_validate(
            {
                "id": "one",
                "title": "Check",
                "instructions": "Check the weather.",
                "allowedTools": ["nws_weather_tool"],
                **patch,
            }
        )


def test_daily_catch_up_crosses_midnight_using_the_scheduled_day():
    cfg = config(dailyTimes=["23:59"], weekdays=[0])
    state = empty_state()
    now = ms("2026-11-10T00:05:00-05:00")
    schedule(state, cfg, now)
    task = select_due(state, cfg, now)
    assert task["dueAt"] == ms("2026-11-09T23:59:00-05:00")
    assert task_enabled(cfg, "automation", task["payload"], now)
