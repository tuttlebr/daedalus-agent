"""Routing correctness evaluator.

Scores whether the agent's trace matches expected routing: mas_evaluate
was called, returned the expected SAS/MAS verdict, and the expected
sub-agent/skill was invoked.

Dataset schema per case:

    - id: <string>
      query: <string>
      expected:
        architecture: SAS | MAS-centralized | MAS-decentralized
        sub_agent: research_agent | ops_agent | media_agent | user_data_agent | null
        skill: <skill_name> | null
      forbidden_tools: [<tool_name>, ...]   # optional
      conversational_only: true             # optional; expects NO routing tool calls
"""

from __future__ import annotations

from evaluators._common import EvalScore, find_tool_event, parse_json_blob

SUB_AGENTS = {"research_agent", "ops_agent", "media_agent", "user_data_agent"}


def _architecture_matches(mas_out: dict, expected: str) -> bool:
    """Compare expected label (SAS | MAS-centralized | MAS-decentralized) to mas_evaluate output."""
    recommendation = (mas_out.get("recommendation") or "").upper()
    task_arch = (
        mas_out.get("task_analysis", {}).get("recommended_architecture") or ""
    ).lower()
    expected_up = expected.upper()
    if expected_up == "SAS":
        return recommendation == "SAS"
    if expected_up == "MAS-CENTRALIZED":
        return recommendation == "MAS" and task_arch == "centralized"
    if expected_up == "MAS-DECENTRALIZED":
        return recommendation == "MAS" and task_arch == "decentralized"
    return False


def score(case: dict, trace) -> EvalScore:
    expected = case.get("expected") or {}
    expected_arch = (expected.get("architecture") or "").strip()
    expected_sub = expected.get("sub_agent")
    expected_skill = expected.get("skill")
    forbidden = set(case.get("forbidden_tools") or [])
    conversational_only = bool(case.get("conversational_only"))

    reasons: list[str] = []
    points = 0.0
    max_points = 0.0

    # Gate 1: mas_evaluate was / wasn't called as expected
    max_points += 1.0
    mas_called = find_tool_event(trace.events, "mas_evaluate", "TOOL_START") is not None
    if conversational_only:
        if not mas_called:
            points += 1.0
        else:
            reasons.append("mas_evaluate was called for a conversational-only case")
    else:
        if mas_called:
            points += 0.4
            mas_end = find_tool_event(trace.events, "mas_evaluate", "TOOL_END")
            mas_output = parse_json_blob(mas_end.payload) if mas_end else None
            if mas_output:
                points += 0.2
                if expected_arch:
                    if _architecture_matches(mas_output, expected_arch):
                        points += 0.4
                    else:
                        reasons.append(
                            f"mas_evaluate returned "
                            f"recommendation={mas_output.get('recommendation')!r} "
                            f"arch={mas_output.get('task_analysis', {}).get('recommended_architecture')!r}, "
                            f"expected {expected_arch!r}"
                        )
                else:
                    points += 0.4
            else:
                reasons.append("could not parse mas_evaluate output as JSON")
        else:
            reasons.append("mas_evaluate was not called")

    # Gate 2: expected sub-agent was invoked
    if expected_sub:
        max_points += 1.0
        if find_tool_event(trace.events, expected_sub, "TOOL_START"):
            points += 1.0
        else:
            called = {
                ev.name
                for ev in trace.events
                if ev.name in SUB_AGENTS and ev.event_type == "TOOL_START"
            }
            if called:
                reasons.append(
                    f"expected sub-agent {expected_sub!r} not invoked; called: {sorted(called)}"
                )
            else:
                reasons.append(f"expected sub-agent {expected_sub!r} not invoked")

    # Gate 3: expected skill was loaded
    if expected_skill:
        max_points += 1.0
        loaded = False
        for ev in trace.events:
            if ev.event_type != "TOOL_START":
                continue
            if "agent_skills" in ev.name or "load_skill" in ev.name:
                if expected_skill in ev.payload:
                    loaded = True
                    break
        if loaded:
            points += 1.0
        else:
            reasons.append(f"expected skill {expected_skill!r} not loaded")

    # Gate 4: no forbidden tools were called
    if forbidden:
        max_points += 1.0
        called = {ev.name for ev in trace.events if ev.event_type == "TOOL_START"}
        overlap = forbidden & called
        if overlap:
            reasons.append(f"forbidden tools called: {sorted(overlap)}")
        else:
            points += 1.0

    final_score = (points / max_points) if max_points else 1.0
    passed = final_score >= 0.8 and (
        # for conversational-only, require perfect (no routing tools called)
        (not conversational_only) or final_score == 1.0
    )

    return EvalScore(
        score=round(final_score, 3),
        passed=passed,
        detail={
            "reasons": reasons,
            "mas_evaluate_called": mas_called,
            "tools_called": [
                ev.name for ev in trace.events if ev.event_type == "TOOL_START"
            ],
        },
    )
