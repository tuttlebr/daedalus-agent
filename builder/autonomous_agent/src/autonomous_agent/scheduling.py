"""Deterministic scheduling and recovery for the autonomous charter.

State mutations run under the store's fenced compare-and-set transaction. The
model supplies observations, never queue identities, enabled flags, or clocks.
"""

from __future__ import annotations

from typing import Any

from .charter import (
    TASK_RESPONSIBILITY,
    CalendarEvent,
    CharterConfig,
    CharterOutput,
    in_window,
    instant,
    revision,
    stable_id,
    task_enabled,
    task_note_key,
    task_settings,
)

PERIODIC = {
    "calendar_discovery": "calendar",
    "sports_discovery": "lighting",
    "cluster_maintenance": "cluster",
    "evolution": "evolution",
}
EVENT_KINDS = {"calendar_event", "game_lighting"}


def available_action_slots(state: dict, config: CharterConfig) -> int:
    # Keep one slot per periodic responsibility so a busy
    # calendar cannot prevent health checks or discovery of an upcoming game.
    capacity = (
        config.maxPendingActions
        - len(PERIODIC)
        - len(config.responsibilities.lighting.rules)
    )
    pending = sum(
        item["kind"] in EVENT_KINDS and item["status"] in {"pending", "running"}
        for item in state["actions"].values()
    )
    return max(0, capacity - pending)


def empty_state() -> dict[str, Any]:
    return {
        "version": 2,
        "actions": {},
        "schedules": {},
        "records": {},
        "proposals": {},
        "notes": {},
        "runs": [],
        "summaries": [],
        "reported": {},
    }


def action(
    kind: str,
    identity: str,
    timestamp: int,
    *,
    due_at: int | None = None,
    payload: dict | None = None,
) -> dict[str, Any]:
    return {
        "id": stable_id(kind, identity),
        "kind": kind,
        "responsibility": TASK_RESPONSIBILITY.get(kind, "summary"),
        "status": "pending",
        "dueAt": timestamp if due_at is None else due_at,
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "attempts": 0,
        "payload": payload or {},
        "outcome": None,
    }


def schedule(state: dict, config: CharterConfig, timestamp: int) -> None:
    """Add independently due work; an unavailable source cannot starve another."""
    actions = state["actions"]
    for item in actions.values():
        if item["kind"] == "daily_summary" and item["status"] in {"pending", "running"}:
            item.update(status="cancelled", updatedAt=timestamp)
    state["schedules"].pop("daily_summary", None)
    if not config.enabled:
        return
    rule_ids = {rule.id for rule in config.responsibilities.lighting.rules}
    for mapping, prefix in [
        (state["schedules"], "sports_discovery:"),
        (state["notes"], "lighting:"),
    ]:
        for name in list(mapping):
            if name.startswith(prefix) and name[len(prefix) :] not in rule_ids:
                del mapping[name]
    for item in actions.values():
        if (
            item["status"] == "pending"
            and item["payload"].get("ruleId")
            and task_settings(config, item["kind"], item["payload"]) is None
        ):
            item.update(status="cancelled", updatedAt=timestamp)
    pending = sum(item["status"] in {"pending", "running"} for item in actions.values())
    checks = [(kind, {}) for kind in PERIODIC]
    checks.extend(
        ("sports_discovery", {"ruleId": rule.id})
        for rule in config.responsibilities.lighting.rules
    )
    for kind, payload in checks:
        settings = task_settings(config, kind, payload)
        if not task_enabled(config, kind, payload, timestamp):
            continue
        schedule_key = f"{kind}:{payload['ruleId']}" if payload else kind
        if any(
            item["kind"] == kind
            and item["payload"].get("ruleId") == payload.get("ruleId")
            and item["status"] in {"pending", "running"}
            for item in actions.values()
        ):
            continue
        last = state["schedules"].get(schedule_key)
        if last is not None and timestamp - last < settings.intervalSeconds * 1000:
            continue
        if pending >= config.maxPendingActions:
            continue
        identity = f"{payload['ruleId']}:{timestamp}" if payload else str(timestamp)
        item = action(kind, identity, timestamp, payload=payload)
        actions[item["id"]] = item
        pending += 1
        state["schedules"][schedule_key] = timestamp

    prune(state, config, timestamp)


def select_due(state: dict, config: CharterConfig, timestamp: int) -> dict | None:
    eligible = []
    for item in state["actions"].values():
        if item["status"] != "pending" or not task_enabled(
            config, item["kind"], item["payload"]
        ):
            continue
        if item["dueAt"] > timestamp:
            continue
        if item["kind"] == "game_lighting":
            settings = task_settings(config, item["kind"], item["payload"])
            if item["payload"]["sport"] not in settings.sports or not in_window(
                settings, item["payload"]["startsAt"]
            ):
                item.update(status="cancelled", updatedAt=timestamp)
                continue
            deadline = item["payload"]["startsAt"] + (settings.catchUpMinutes * 60000)
            if timestamp > deadline:
                item.update(status="expired", updatedAt=timestamp)
                item["outcome"] = {
                    "status": "deferred",
                    "summary": "Game lighting was not applied: the start window elapsed.",
                }
                continue
        if task_enabled(config, item["kind"], item["payload"], timestamp):
            eligible.append(item)
    # Time-critical lighting comes first. Otherwise oldest work wins.
    return min(
        eligible,
        key=lambda item: (
            item["kind"] != "game_lighting",
            item["kind"] != "sports_discovery",
            item["dueAt"],
            item["id"],
        ),
        default=None,
    )


def recover(state: dict, timestamp: int) -> None:
    """Dispatched work has unknown effects; never replay it as a new action."""
    for item in state["actions"].values():
        if item["status"] != "running":
            continue
        item.update(status="uncertain", updatedAt=timestamp)
        item["outcome"] = {
            "status": "uncertain",
            "summary": "Execution was interrupted. External effects need reconciliation.",
        }
        for run in state["runs"]:
            if run["id"] == item.get("runId") and run["status"] == "running":
                run.update(
                    status="uncertain", completedAt=timestamp, outcome=item["outcome"]
                )
        if item["kind"] == "daily_summary":
            item.update(status="cancelled", updatedAt=timestamp)
        # Calendar discovery sees this intent and reads remote state before
        # proposing another write. Lighting remains terminal for this game.
        # Cluster maintenance inspects fresh state before deciding on a repair.


def accept_observations(
    state: dict,
    task: dict,
    output: CharterOutput,
    config: CharterConfig,
    timestamp: int,
) -> None:
    """Validate ownership, then commit observations and their durable intents."""
    if output.calendarEvents and task["kind"] != "calendar_discovery":
        raise ValueError("Only calendar discovery may schedule calendar events")
    if output.games and task["kind"] != "sports_discovery":
        raise ValueError("Only sports discovery may schedule game lighting")
    if output.proposals and task["kind"] != "evolution":
        raise ValueError("Only evolution may publish responsibility proposals")
    pending = sum(
        item["kind"] in EVENT_KINDS and item["status"] in {"pending", "running"}
        for item in state["actions"].values()
    )
    candidates: list[dict] = []
    for event in output.calendarEvents:
        if state["records"].get(event.sourceKey, {}).get("dismissed"):
            continue
        if event.is_past(timestamp) and not event.cancelled:
            continue
        payload = event.model_dump()
        identity = f"{event.sourceKey}:{revision(payload)}"
        item = action("calendar_event", identity, timestamp, payload=payload)
        for previous in state["actions"].values():
            if (
                previous["kind"] == "calendar_event"
                and previous["payload"].get("sourceKey") == event.sourceKey
                and previous["id"] != item["id"]
                and previous["status"] == "pending"
            ):
                previous.update(status="cancelled", updatedAt=timestamp)
                pending -= 1
        prior = state["actions"].get(item["id"])
        if prior:
            record = state["records"].get(event.sourceKey, {})
            changed_back = (
                prior["status"] == "completed"
                and record.get("event")
                and revision(record["event"]) != revision(payload)
            )
            reconcile_unknown = (
                prior["status"] == "uncertain"
                and prior["attempts"] < config.maxAttempts
            )
            waiting_on_source = (
                prior["status"] == "failed"
                and (prior.get("outcome") or {}).get("status") == "deferred"
                and not (prior.get("outcome") or {}).get("mutationAttempted")
                and timestamp - prior["updatedAt"]
                >= config.responsibilities.calendar.intervalSeconds * 1000
            )
            if not prior.get("cancelledByUser") and (
                changed_back
                or reconcile_unknown
                or waiting_on_source
                or prior["status"] == "cancelled"
            ):
                # Preserve uncertain attempt counts; a source revision returning
                # after another revision is a new reconciliation, not a retry.
                if not reconcile_unknown:
                    prior["attempts"] = 0
                prior.update(status="pending", dueAt=timestamp, updatedAt=timestamp)
                pending += 1
            continue
        candidates.append(item)

    for game in output.games:
        settings = task_settings(config, "sports_discovery", task["payload"])
        if settings is None:
            continue
        # Identity excludes start time: a postponed game is the same game.
        identity = f"{game.sport}:{game.sourceKey}"
        rule_id = task["payload"].get("ruleId")
        if rule_id:
            identity = f"{rule_id}:{identity}"
        item_id = stable_id("game_lighting", identity)
        prior = state["actions"].get(item_id)
        if prior and prior.get("cancelledByUser"):
            continue
        if prior and prior["status"] not in {"pending", "cancelled", "expired"}:
            continue
        starts_at = int(instant(game.start).timestamp() * 1000)
        payload = {**game.model_dump(), "startsAt": starts_at}
        if rule_id:
            payload["ruleId"] = rule_id
        item = action(
            "game_lighting", identity, timestamp, due_at=starts_at, payload=payload
        )
        if (
            game.status != "scheduled"
            or game.sport not in settings.sports
            or not in_window(settings, starts_at)
        ):
            item["status"] = "cancelled"
        elif timestamp > starts_at + settings.catchUpMinutes * 60000:
            item["status"] = "expired"
        if prior and prior["status"] == "pending":
            pending -= 1
        candidates.append(item)
    if pending + sum(
        item["status"] == "pending" for item in candidates
    ) > config.maxPendingActions - len(PERIODIC) - len(
        config.responsibilities.lighting.rules
    ):
        raise ValueError(
            "Pending action capacity exceeded; observations were not committed"
        )
    for item in candidates:
        state["actions"][item["id"]] = item
    for proposal in output.proposals:
        existing = state["proposals"].get(proposal.id)
        if existing and existing["status"] != "proposed":
            continue
        state["proposals"][proposal.id] = {
            **proposal.model_dump(),
            "status": "proposed",
            "updatedAt": timestamp,
        }
    if output.notes:
        state["notes"][task_note_key(task)] = output.notes


def finish(
    state: dict,
    task_id: str,
    output: CharterOutput,
    config: CharterConfig,
    timestamp: int,
) -> None:
    task = state["actions"][task_id]
    rescheduled_game = None
    if task["kind"] == "game_lighting" and output.games:
        # A last-minute official schedule check may move this same game. Never
        # admit unrelated games or turn an attempted activation into a retry.
        if (
            len(output.games) != 1
            or output.outcome.status != "deferred"
            or output.outcome.mutationAttempted
        ):
            raise ValueError(
                "A game schedule correction requires one unattempted deferred activation"
            )
        game = output.games[0]
        if (game.sourceKey, game.sport) != (
            task["payload"]["sourceKey"],
            task["payload"]["sport"],
        ):
            raise ValueError("An activation may only reconcile its own game")
        rescheduled_game = game
        output = output.model_copy(update={"games": []})
    if output.outcome.status == "deferred" and output.outcome.mutationAttempted:
        raise ValueError("Attempted mutations cannot be deferred for automatic retry")
    if task["kind"] == "calendar_event" and output.outcome.status == "completed":
        if not output.outcome.externalId or not output.outcome.observedState:
            raise ValueError(
                "Calendar completion requires the verified remote ID and state"
            )
    accept_observations(state, task, output, config, timestamp)
    task["outcome"] = output.outcome.model_dump()
    task["status"] = output.outcome.status
    task["updatedAt"] = timestamp
    if (
        output.outcome.status == "deferred"
        and task["attempts"] < config.maxAttempts
        and not task.get("cancelledByUser")
    ):
        # A deferred result means no effect was attempted. Runtime enforcement
        # must reject this classification if a mutation was actually dispatched.
        task["status"] = "pending"
        task["dueAt"] = timestamp + min(3600, 60 * 2 ** task["attempts"]) * 1000
    elif output.outcome.status == "deferred":
        task["status"] = "cancelled" if task.get("cancelledByUser") else "failed"
    if rescheduled_game is not None:
        start = int(instant(rescheduled_game.start).timestamp() * 1000)
        rule_id = task["payload"].get("ruleId")
        settings = task_settings(config, "game_lighting", task["payload"])
        task["payload"] = {**rescheduled_game.model_dump(), "startsAt": start}
        if rule_id:
            task["payload"]["ruleId"] = rule_id
        if (
            settings is None
            or rescheduled_game.status != "scheduled"
            or not in_window(settings, start)
        ):
            task["status"] = "cancelled"
        elif timestamp > start + settings.catchUpMinutes * 60000:
            task["status"] = "expired"
        elif task["status"] == "pending":
            task["dueAt"] = max(start, task["dueAt"])
    if task["kind"] == "calendar_event" and output.outcome.status == "completed":
        state["records"][task["payload"]["sourceKey"]] = {
            **state["records"].get(task["payload"]["sourceKey"], {}),
            "externalId": output.outcome.externalId,
            "observedState": output.outcome.observedState,
            "event": task["payload"],
            "updatedAt": timestamp,
        }


def prune(state: dict, config: CharterConfig, timestamp: int) -> None:
    # Keep a year's evidence/tombstones, plus future calendar intents and active
    # work. Past uncertain work cannot be replayed: calendar discovery rejects
    # elapsed events and lighting expires by the verified start time.
    cutoff = timestamp - 366 * 86400000
    state["actions"] = {
        key: item
        for key, item in state["actions"].items()
        if item["status"] in {"pending", "running"}
        or (
            item["kind"] == "calendar_event"
            and not CalendarEvent.model_validate(item["payload"]).is_past(timestamp)
        )
        or item["updatedAt"] >= cutoff
    }
    # Frequent health checks are evidence, not event identities. Bound their
    # history separately from calendar/game tombstones and active work.
    history = sorted(
        (
            item
            for item in state["actions"].values()
            if item["kind"] not in {"calendar_event", "game_lighting"}
            and item["status"] not in {"pending", "running"}
        ),
        key=lambda item: item["updatedAt"],
        reverse=True,
    )
    for item in history[config.maxRunsStored :]:
        del state["actions"][item["id"]]
    for key, record in list(state["records"].items()):
        if record.get("updatedAt", timestamp) >= cutoff or not record.get("event"):
            continue
        if CalendarEvent.model_validate(record["event"]).is_past(timestamp):
            if record.get("dismissed"):
                # User feedback outlives operational history; discard bulky
                # expired remote fields while retaining the dismissal identity.
                state["records"][key] = {
                    "dismissed": True,
                    "updatedAt": record["updatedAt"],
                }
            else:
                del state["records"][key]
    state["runs"] = state["runs"][: config.maxRunsStored]
