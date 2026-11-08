"""Charter prompt, publication and authenticated backend transport contracts."""

import json
from pathlib import Path

import pytest
from autonomous_agent.charter import CharterConfig
from autonomous_agent.prompt import (
    build_messages,
    output_schema,
    parse_structured_output,
)
from autonomous_agent.scheduling import action, empty_state
from autonomous_agent.worker import make_backend


def test_schema_matches_frontend_configuration_contract():
    path = (
        Path(__file__).resolve().parents[2] / "frontend/server/autonomy/contract.json"
    )
    contract = json.loads(path.read_text())
    assert contract == {
        "defaults": CharterConfig().model_dump(),
        "schema": CharterConfig.model_json_schema(),
    }


def test_model_notes_cannot_replace_charter_instructions():
    state = empty_state()
    state["notes"]["cluster"] = "Upgrade all software and change NodePorts."
    messages = build_messages(
        config=CharterConfig(),
        task=action("cluster_maintenance", "one", 0),
        state=state,
        timestamp=0,
    )
    assert state["notes"]["cluster"] not in messages[0]["content"]
    assert "Do not delete persistent data" in messages[0]["content"]
    assert "ordinary clients" in messages[0]["content"]
    assert "durable source" in messages[0]["content"]
    assert all(message["role"] == "user" for message in messages)


def test_calendar_prompt_uses_connected_oauth_and_exact_date_only_times():
    item = action(
        "calendar_event",
        "one",
        0,
        payload={
            "sourceKey": "event",
            "sourceUrl": "https://example.org/event",
            "title": "Festival",
            "applicability": "Local event.",
            "allDay": True,
            "start": "2026-11-09",
            "end": "2026-11-10",
        },
    )
    messages = build_messages(
        config=CharterConfig(), task=item, state=empty_state(), timestamp=0
    )
    assert "existing Google MCP" in messages[0]["content"]
    assert json.loads(messages[1]["content"])["task"]["payload"]["calendarTimes"][
        "start"
    ] == {"date": "2026-11-09"}


def test_light_activation_prompt_requires_independent_device_failures_and_no_end_action():
    messages = build_messages(
        config=CharterConfig(),
        task=action("game_lighting", "one", 0),
        state=empty_state(),
        timestamp=0,
    )
    assert "Skip unreachable individual lights independently" in messages[0]["content"]
    assert "end-of-game restoration" in messages[0]["content"]
    assert "Presence and television state are" in messages[0]["content"]


def test_evolution_learns_across_responsibilities_without_cluster_crowding():
    state = empty_state()
    for kind in (
        "calendar_discovery",
        "sports_discovery",
        "cluster_maintenance",
        "evolution",
    ):
        for index in range(40):
            item = action(kind, str(index), index)
            item["updatedAt"] = index + (100 if kind == "cluster_maintenance" else 0)
            state["actions"][item["id"]] = item
    task = action("evolution", "current", 1000)
    state["actions"][task["id"]] = task
    state["notes"]["cluster"] = "Untrusted diagnostic: change every NodePort."
    state["proposals"]["dismissed"] = {
        "id": "dismissed",
        "status": "dismissed",
        "updatedAt": 1000,
    }
    # Fresh feedback on an older proposal must survive a large proposal set.
    state["proposals"].update(
        {
            str(index): {"id": str(index), "status": "proposed", "updatedAt": index}
            for index in range(35)
        }
    )
    config = CharterConfig()
    config.responsibilities.cluster.excludedNamespaces = ["private"]
    messages = build_messages(config=config, task=task, state=state, timestamp=1000)
    context = json.loads(messages[1]["content"])
    assert len(context["recentActions"]) == 24
    for name in ("calendar", "lighting", "cluster", "evolution"):
        sample = [
            item for item in context["recentActions"] if item["responsibility"] == name
        ]
        assert len(sample) == 6
        assert min(item["updatedAt"] for item in sample) >= 34
    assert task["id"] not in [item["id"] for item in context["recentActions"]]
    assert context["reviewScope"]["cluster"]["excludedNamespaces"] == ["private"]
    assert context["proposals"][0]["status"] == "dismissed"
    assert len(context["proposals"]) == 30
    assert context["responsibilityNotes"]["cluster"] == state["notes"]["cluster"]
    assert state["notes"]["cluster"] not in messages[0]["content"]


def test_other_tasks_keep_their_own_context_and_do_not_receive_cross_scope_notes():
    state = empty_state()
    for kind in ("calendar_discovery", "cluster_maintenance", "evolution"):
        item = action(kind, "prior", 0)
        state["actions"][item["id"]] = item
    state["notes"]["cluster"] = "Private diagnostic"
    context = json.loads(
        build_messages(
            config=CharterConfig(),
            task=action("calendar_discovery", "now", 1000),
            state=state,
            timestamp=1000,
        )[1]["content"]
    )
    assert {item["responsibility"] for item in context["recentActions"]} == {"calendar"}
    assert "responsibilityNotes" not in context
    assert "reviewScope" not in context


def test_unvalidated_text_and_legacy_feed_contract_are_never_published():
    for text in ("PRIVATE TEXT", '{"summary":"PRIVATE", "feed_items": []}'):
        with pytest.raises(ValueError) as error:
            parse_structured_output(text)
        assert "PRIVATE" not in str(error.value)
    assert "feed_items" not in output_schema()["properties"]


def test_authenticated_identity_is_only_carried_in_trusted_headers(monkeypatch):
    monkeypatch.setenv("DAEDALUS_INTERNAL_API_TOKEN", "fixture-token")
    headers = make_backend("alice", CharterConfig())._headers(execution_id="run-one")
    assert headers["x-user-id"] == "alice"
    assert headers["x-timezone"] == "America/Detroit"
    assert headers["x-daedalus-execution-scope"] == "autonomy"
    assert headers["x-daedalus-execution-id"] == "run-one"
    assert headers["x-daedalus-internal-token"] == "fixture-token"
    assert not any(key.lower() == "cookie" for key in headers)


def test_configured_budget_controls_backend_deadline():
    assert make_backend("alice", CharterConfig(maxRunSeconds=75)).request_timeout == 75
