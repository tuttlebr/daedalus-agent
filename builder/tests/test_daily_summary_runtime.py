"""Daily-summary request routing and bounded synthesis contracts."""

from nat_helpers.agent_loop_guard import AgentRun
from nat_helpers.daily_summary_runtime import (
    DAILY_SUMMARY_PROFILE,
    request_profile,
    should_retry_final_synthesis,
    should_start_final_synthesis,
)


def test_only_explicit_daily_briefing_requests_select_the_narrow_profile():
    assert request_profile("Please run my daily summary") == DAILY_SUMMARY_PROFILE
    assert request_profile("Run my morning briefing") == DAILY_SUMMARY_PROFILE
    assert request_profile("Catch me up on today") == DAILY_SUMMARY_PROFILE
    assert request_profile("Debug the summary endpoint") == "default"


def test_daily_summary_enters_final_synthesis_after_research_budget(monkeypatch):
    run = AgentRun(
        started_at=100.0,
        request_profile=DAILY_SUMMARY_PROFILE,
    )
    run.tool_calls = 1
    monkeypatch.setattr(
        "nat_helpers.daily_summary_runtime.time.monotonic",
        lambda: 400.0,
    )

    assert should_start_final_synthesis(run, budget_seconds=300.0)
    run.final_synthesis_requested = True
    assert not should_start_final_synthesis(run, budget_seconds=300.0)


def test_general_requests_never_enter_daily_final_synthesis(monkeypatch):
    run = AgentRun(started_at=0.0, request_profile="default")
    run.tool_calls = 20
    monkeypatch.setattr(
        "nat_helpers.daily_summary_runtime.time.monotonic",
        lambda: 1000.0,
    )

    assert not should_start_final_synthesis(run, budget_seconds=300.0)


def test_daily_summary_gets_one_retry_after_a_stalled_final_stream():
    stalled = type("StreamChunkTimeoutError", (Exception,), {})()
    run = AgentRun(request_profile=DAILY_SUMMARY_PROFILE)
    run.tool_calls = 3
    run.last_messages = [object()]

    assert should_retry_final_synthesis(run, stalled)
    run.synthesis_retry_attempted = True
    assert not should_retry_final_synthesis(run, stalled)


def test_daily_summary_does_not_retry_tool_or_general_errors():
    run = AgentRun(request_profile=DAILY_SUMMARY_PROFILE)
    run.tool_calls = 1
    run.last_messages = [object()]

    assert not should_retry_final_synthesis(run, RuntimeError("tool failure"))
    run.request_profile = "default"
    timeout = type("StreamChunkTimeoutError", (Exception,), {})()
    assert not should_retry_final_synthesis(run, timeout)
