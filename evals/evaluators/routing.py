"""Routing correctness evaluator.

Scores whether the flattened top-level Responses workflow calls the expected
leaf tool or skill directly.

Dataset schema per case:

    - id: <string>
      query: <string>
      expected:
        route_tool: expected leaf tool name, or null
        required_tools: [<tool_name>, ...]
        skill: <skill_name> | null
      forbidden_tools: [<tool_name>, ...]   # optional
      conversational_only: true             # optional; expects no route tools
"""

from __future__ import annotations

from evaluators._common import EvalScore, find_tool_event

ROUTE_TOOLS = {
    "domain_retriever_tool",
    "curated_feed_search_tool",
    "source_policy_tool",
    "research_plan_approval_tool",
    "dynamo_mcp_server",
    "openshell_mcp_server",
    "aistore_mcp_server",
    "aiperf_mcp_server",
    "nvcf_mcp_server",
    "dsx_mcp_server",
    "k8s_mcp_server",
    "user_document_tool",
    "gmail_mcp_server",
    "calendar_mcp_server",
    "visual_media_tool",
    "vtt_interpreter_tool",
    "agent_skills_tool",
}


def _expected_route_tools(expected: dict) -> list[str]:
    tools: list[str] = []
    route_tool = expected.get("route_tool")
    if route_tool:
        tools.append(str(route_tool))
    for tool in expected.get("required_tools") or []:
        if tool:
            tools.append(str(tool))
    return list(dict.fromkeys(tools))


def _skill_loaded(events, expected_skill: str) -> bool:
    for ev in events:
        if ev.event_type != "TOOL_START":
            continue
        if "agent_skills" in ev.name or "load_skill" in ev.name:
            if expected_skill in ev.payload:
                return True
    return False


def score(case: dict, trace) -> EvalScore:
    expected = case.get("expected") or {}
    expected_route_tools = _expected_route_tools(expected)
    expected_skill = expected.get("skill")
    forbidden = set(case.get("forbidden_tools") or [])
    conversational_only = bool(case.get("conversational_only"))

    reasons: list[str] = []
    points = 0.0
    max_points = 0.0

    if conversational_only:
        max_points += 1.0
        called_routes = {
            ev.name
            for ev in trace.events
            if ev.event_type == "TOOL_START" and ev.name in ROUTE_TOOLS
        }
        if called_routes:
            reasons.append(
                f"route tools called for conversational-only case: {sorted(called_routes)}"
            )
        else:
            points += 1.0

    if expected_route_tools:
        max_points += 1.0
        missing = [
            tool
            for tool in expected_route_tools
            if find_tool_event(trace.events, tool, "TOOL_START") is None
        ]
        if not missing:
            points += 1.0
        else:
            called = {
                ev.name
                for ev in trace.events
                if ev.name in ROUTE_TOOLS and ev.event_type == "TOOL_START"
            }
            reasons.append(
                f"expected route tool(s) {missing!r} not invoked; called: {sorted(called)}"
            )

    if expected_skill:
        max_points += 1.0
        if _skill_loaded(trace.events, expected_skill):
            points += 1.0
        else:
            reasons.append(f"expected skill {expected_skill!r} not loaded")

    if forbidden:
        max_points += 1.0
        called = {ev.name for ev in trace.events if ev.event_type == "TOOL_START"}
        overlap = forbidden & called
        if overlap:
            reasons.append(f"forbidden tools called: {sorted(overlap)}")
        else:
            points += 1.0

    final_score = (points / max_points) if max_points else 1.0
    passed = final_score >= 0.8 and ((not conversational_only) or final_score == 1.0)

    return EvalScore(
        score=round(final_score, 3),
        passed=passed,
        detail={
            "reasons": reasons,
            "tools_called": [
                ev.name for ev in trace.events if ev.event_type == "TOOL_START"
            ],
        },
    )
