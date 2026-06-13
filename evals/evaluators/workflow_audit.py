"""Workflow audit evaluator.

This evaluator is intentionally deterministic. It checks the observable trace
and final text against the contract encoded in the dataset: required tools,
forbidden tools, citation/format expectations, and cost/latency budgets.
"""

from __future__ import annotations

import re

from evaluators._common import EvalScore


def _called_tools(trace) -> list[str]:
    return [ev.name for ev in trace.events if ev.event_type == "TOOL_START"]


def _tool_called(required_tool: str, tools: list[str]) -> bool:
    if required_tool in tools:
        return True
    if required_tool == "agent_skills_tool":
        return any("agent_skills" in tool or "load_skill" in tool for tool in tools)
    return False


def _skill_loaded(events, expected_skill: str) -> bool:
    for ev in events:
        if ev.event_type != "TOOL_START":
            continue
        if "agent_skills" in ev.name or "load_skill" in ev.name:
            if expected_skill in str(ev.payload):
                return True
    return False


def _has_url_citation(response: str) -> bool:
    return bool(re.search(r"https?://\S+", response))


def score(case: dict, trace) -> EvalScore:
    expected = case.get("expected") or {}
    required_tools = set(expected.get("required_tools") or [])
    required_tool_groups = expected.get("required_tool_groups") or []
    forbidden_tools = set(expected.get("forbidden_tools") or [])
    expected_skill = expected.get("skill")
    required_phrases = expected.get("response_contains") or []
    response_regexes = expected.get("response_regex") or []
    requires_citation = bool(expected.get("requires_citation"))
    max_latency_s = expected.get("max_latency_s")
    max_total_tokens = expected.get("max_total_tokens")
    max_tool_calls = expected.get("max_tool_calls")
    min_tool_calls = expected.get("min_tool_calls")
    max_workflow_calls = expected.get("max_workflow_calls")

    checks: list[tuple[bool, str]] = []
    tools = _called_tools(trace)

    for tool_name in sorted(required_tools):
        checks.append(
            (_tool_called(tool_name, tools), f"required tool not called: {tool_name}")
        )

    for group in required_tool_groups:
        group_tools = [str(tool) for tool in group]
        checks.append(
            (
                any(_tool_called(tool, tools) for tool in group_tools),
                f"none of required tool group called: {group_tools}",
            )
        )

    forbidden_called = [
        tool for tool in sorted(forbidden_tools) if _tool_called(tool, tools)
    ]
    checks.append((not forbidden_called, f"forbidden tools called: {forbidden_called}"))

    if expected_skill:
        checks.append(
            (
                _skill_loaded(trace.events, str(expected_skill)),
                f"expected skill not loaded: {expected_skill}",
            )
        )

    if min_tool_calls is not None:
        checks.append(
            (
                len(tools) >= int(min_tool_calls),
                f"only {len(tools)} tool calls, expected at least {min_tool_calls}",
            )
        )

    if max_tool_calls is not None:
        checks.append(
            (
                len(tools) <= int(max_tool_calls),
                f"{len(tools)} tool calls, expected at most {max_tool_calls}",
            )
        )

    if max_workflow_calls is not None:
        workflow_calls = int(trace.metrics.get("workflow_call_count") or 0)
        checks.append(
            (
                workflow_calls <= int(max_workflow_calls),
                f"{workflow_calls} workflow calls, expected at most {max_workflow_calls}",
            )
        )

    if requires_citation:
        checks.append(
            (_has_url_citation(trace.response), "response has no URL citation")
        )

    for phrase in required_phrases:
        checks.append(
            (
                phrase.lower() in trace.response.lower(),
                f"response missing phrase: {phrase!r}",
            )
        )

    for pattern in response_regexes:
        checks.append(
            (
                re.search(pattern, trace.response, flags=re.IGNORECASE | re.MULTILINE)
                is not None,
                f"response did not match regex: {pattern!r}",
            )
        )

    if max_latency_s is not None:
        checks.append(
            (
                trace.latency_seconds <= float(max_latency_s),
                f"latency {trace.latency_seconds:.2f}s exceeds {max_latency_s}s",
            )
        )

    total_tokens = trace.metrics.get("usage", {}).get("total_tokens")
    if max_total_tokens is not None and total_tokens is not None:
        checks.append(
            (
                int(total_tokens) <= int(max_total_tokens),
                f"total tokens {total_tokens} exceeds {max_total_tokens}",
            )
        )

    if trace.error:
        checks.append((False, trace.error))

    if not checks:
        return EvalScore(
            score=1.0,
            passed=True,
            detail={"reasons": [], "tools_called": tools},
        )

    passed_checks = sum(1 for ok, _ in checks if ok)
    final_score = passed_checks / len(checks)
    threshold = float(case.get("min_score", 1.0))
    reasons = [reason for ok, reason in checks if not ok]

    return EvalScore(
        score=round(final_score, 3),
        passed=final_score >= threshold and not reasons,
        detail={
            "reasons": reasons,
            "tools_called": tools,
            "metrics": trace.metrics,
            "success_criteria": case.get("success_criteria"),
        },
    )
