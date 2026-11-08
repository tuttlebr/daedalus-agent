"""Daily reports are a deterministic projection of persisted action evidence."""

from __future__ import annotations

from .charter import CharterConfig, revision


def publish_daily_summary(
    state: dict, task: dict, config: CharterConfig, timestamp: int
) -> dict:
    day = task["payload"]["date"]
    existing = next(
        (entry for entry in state["summaries"] if entry["date"] == day), None
    )
    if existing:
        complete_summary(state, task, timestamp)
        return existing
    items = []
    # Oldest first ensures a very busy day can carry additional changes into the
    # next digest rather than permanently starving them behind newer activity.
    for entry in sorted(
        state["actions"].values(), key=lambda entry: entry["updatedAt"]
    ):
        outcome = entry.get("outcome")
        if not outcome or entry["kind"] == "daily_summary":
            continue
        identity = f"{entry['kind']}:{entry['payload'].get('sourceKey', '')}"
        if entry["payload"].get("ruleId"):
            identity += f":{entry['payload']['ruleId']}"
        content = {
            "responsibility": entry["responsibility"],
            "status": outcome["status"],
            "summary": outcome["summary"],
            "recommendations": outcome.get("recommendations", []),
            "skipped": outcome.get("skipped", []),
        }
        signature = revision(
            {
                **content,
                "payload": entry["payload"],
                "observedState": outcome.get("observedState", {}),
            }
        )
        action_key = f"action:{entry['id']}"
        if state["reported"].get(action_key, {}).get("signature") == signature:
            continue
        # Track each observed outcome separately from the latest finding. This
        # prevents old history replay, but still reports A -> B -> A recurrence.
        state["reported"][action_key] = {"signature": signature, "updatedAt": timestamp}
        finding_key = f"finding:{identity}"
        if state["reported"].get(finding_key, {}).get("signature") == signature:
            continue
        state["reported"][finding_key] = {
            "signature": signature,
            "updatedAt": timestamp,
        }
        items.append(
            {
                **content,
                "actionId": entry["id"],
                "evidence": outcome.get("evidence", []),
            }
        )
        if len(items) >= 100:
            break
    for proposal in state["proposals"].values():
        report_key = f"proposal:{proposal['id']}"
        signature = revision(
            {key: value for key, value in proposal.items() if key != "updatedAt"}
        )
        if state["reported"].get(report_key, {}).get("signature") != signature:
            items.append(
                {
                    "responsibility": "evolution",
                    "status": proposal["status"],
                    "proposal": proposal,
                }
            )
            state["reported"][report_key] = {
                "signature": signature,
                "updatedAt": timestamp,
            }
    summary = {
        "id": task["id"],
        "date": day,
        "title": f"Daily summary · {day}",
        "items": items,
        "message": "" if items else "No new actions or changed findings to report.",
        "createdAt": timestamp,
    }
    state["summaries"].insert(0, summary)
    state["summaries"] = state["summaries"][: config.maxSummariesStored]
    complete_summary(state, task, timestamp)
    return summary


def complete_summary(state: dict, task: dict, timestamp: int) -> None:
    task.update(
        status="completed",
        updatedAt=timestamp,
        outcome={
            "status": "completed",
            "summary": "Daily summary published to the Autonomy dashboard.",
        },
    )
    for run in state["runs"]:
        if run["id"] == task.get("runId"):
            run.update(
                status="completed", completedAt=timestamp, outcome=task["outcome"]
            )
