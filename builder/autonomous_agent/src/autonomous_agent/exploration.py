"""Bounded research rotation derived from the worker's existing run history."""

from __future__ import annotations

from typing import Any

# Half familiar, half exploratory. These are research starting points, never
# publication quotas or permission to leave an explicitly selected goal.
_APPROACHES = (
    (
        "known",
        "Check a meaningful change or unresolved question in a tracked interest.",
    ),
    (
        "adjacent",
        "Connect a neighboring field or technique to a concrete user interest.",
    ),
    ("known", "Explore a useful technique, explanation, or overlooked primary source."),
    (
        "scout",
        "Investigate an underexplored topic with a specific link to the user's interests.",
    ),
)


def scoped_completed_runs(
    recent_runs: list[dict[str, Any]], goal_id: str | None
) -> list[dict[str, Any]]:
    """Keep newest-first completed attempts for this objective only."""

    return [
        run
        for run in recent_runs
        if isinstance(run, dict)
        and run.get("status") == "completed"
        and (run.get("goalId") or None) == (goal_id or None)
    ]


def stored_item_count(run: dict[str, Any]) -> int | None:
    metrics = run.get("metrics")
    value = metrics.get("feedItemsStored") if isinstance(metrics, dict) else None
    if type(value) is int and value >= 0:
        return value
    ids = run.get("feedItemIds")
    return len(ids) if isinstance(ids, list) else None


def build_exploration_context(
    *,
    recent_runs: list[dict[str, Any]],
    recent_feed: list[dict[str, Any]],
    goal_id: str | None,
) -> dict[str, Any]:
    """Rotate across restarts and bounded history, learning from quiet attempts.

    The worker owns the cursor in run metrics; mutable model notes cannot reset
    it. Older histories bootstrap from lane coverage, with no migration needed.
    Failed/cancelled attempts do not advance the successful research rotation.
    """

    completed = scoped_completed_runs(recent_runs, goal_id)
    step = None
    for run in completed:
        metrics = run.get("metrics")
        previous = metrics.get("explorationStep") if isinstance(metrics, dict) else None
        if type(previous) is int and 0 <= previous < len(_APPROACHES):
            step = (previous + 1) % len(_APPROACHES)
            break

    if step is None:
        run_ids = {run.get("id") for run in completed}
        coverage = {"known": 0, "adjacent": 0, "scout": 0}
        for item in recent_feed[:60]:
            if not isinstance(item, dict):
                continue
            if goal_id and item.get("runId") not in run_ids:
                continue
            lane = item.get("lane")
            if lane in coverage:
                coverage[lane] += 1
        # Two familiar slots to one of each exploratory lane.
        step = min(
            (0, 1, 3), key=lambda i: coverage[_APPROACHES[i][0]] / (2 if i == 0 else 1)
        )

    quiet_runs = 0
    for run in completed[:5]:
        if stored_item_count(run) != 0:
            break
        quiet_runs += 1
    if quiet_runs >= 2 and _APPROACHES[step][0] == "known":
        step = (step + 1) % len(_APPROACHES)

    lane, approach = _APPROACHES[step]
    return {
        "step": step,
        "preferred_lane": lane,
        "approach": approach,
        "consecutive_quiet_runs": quiet_runs,
        "change_topic": quiet_runs >= 2,
    }
