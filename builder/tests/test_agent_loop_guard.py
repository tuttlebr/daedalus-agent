"""Behavioral boundaries for request-scoped agent progress guards."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from nat_helpers.agent_loop_guard import (
    AgentRun,
    LoopGuardSettings,
    agent_run_scope,
    current_agent_run,
    tool_outcome,
)


def sandbox_output(stdout="", *, code=0, request="different-every-time"):
    return (
        "## Sandbox Execution Result\n"
        f"Request ID: {request}\nExit code: {code}\nDuration: 51 ms\n"
        "Timed out: False\nTruncated: False\nConversation workspace persisted: True\n"
        f"stdout (JSON string): {json.dumps(stdout)}\n"
        'stderr (JSON string): ""'
    )


def add_result(
    run, messages, *, name="search", args=None, content="found", status=None
):
    call_id = str(len(messages))
    messages.extend(
        [
            SimpleNamespace(
                type="ai",
                tool_calls=[{"id": call_id, "name": name, "args": args or {}}],
            ),
            SimpleNamespace(
                type="tool",
                tool_calls=[],
                name=name,
                tool_call_id=call_id,
                content=content,
                status=status,
            ),
        ]
    )
    run.observe(messages)


def test_identical_consecutive_failures_ignore_only_sandbox_request_metadata():
    run, messages = AgentRun(), []
    for i in range(4):
        add_result(
            run,
            messages,
            name="llm_sandbox_tool",
            args={"argv": ["python3", "broken.py"]},
            content=sandbox_output("same failure", code=1, request=str(i)),
        )
        assert run.stop_reason == (None if i < 3 else "repeated_tool_error")
    run.observe(messages)
    assert run.tool_calls == 4


def test_sandbox_failure_does_not_limit_later_productive_work():
    run, messages = AgentRun(), []
    add_result(
        run,
        messages,
        name="llm_sandbox_tool",
        content=sandbox_output('{"passed":false,"errors":["bad document"]}', code=1),
    )
    for i in range(110):
        add_result(
            run,
            messages,
            name="llm_sandbox_tool",
            args={"argv": ["python3", "-c", f"inspect({i})"]},
            content=sandbox_output(f"slice {i}"),
        )
    assert run.stop_reason is None


def test_successful_polling_is_not_a_failure_loop():
    run, messages = AgentRun(), []
    for i in range(30):
        add_result(
            run,
            messages,
            name="llm_sandbox_tool",
            args={"argv": ["cat", "status.json"]},
            content=sandbox_output("running", request=str(i)),
        )
    assert run.stop_reason is None


@pytest.mark.parametrize("change", ["success", "arguments", "error"])
def test_progress_or_a_changed_failure_resets_the_consecutive_guard(change):
    run, messages = AgentRun(), []
    for _ in range(3):
        add_result(run, messages, content="Error: original")
    if change == "success":
        add_result(run, messages, content="success")
    elif change == "arguments":
        add_result(run, messages, args={"query": "new"}, content="Error: original")
    else:
        add_result(run, messages, content="Error: changed")
    for _ in range(3):
        add_result(run, messages, content="Error: original")
    assert run.stop_reason is None
    add_result(run, messages, content="Error: original")
    assert run.stop_reason == "repeated_tool_error"


def test_distinct_error_offsets_do_not_conflate_independent_failures():
    run, messages = AgentRun(), []
    for i in range(30):
        add_result(
            run,
            messages,
            content=json.dumps(
                {"passed": False, "errors": [f"bad JSON at character {i * 5}"]}
            ),
        )
    assert run.stop_reason is None


def test_truncated_success_is_not_an_execution_failure():
    content = sandbox_output("partial preview").replace(
        "Truncated: False", "Truncated: True"
    )
    assert not tool_outcome(content).failed


def test_history_does_not_consume_current_turn_budget():
    historical, messages = AgentRun(), []
    for _ in range(6):
        add_result(historical, messages, content="Error: unavailable")
    run = AgentRun(processed=len(messages))
    add_result(run, messages, args={"query": "new"}, content="new answer")
    assert run.tool_calls == 1
    assert run.stop_reason is None


def test_successful_parallel_sibling_resets_failures_before_stopping():
    fixture, messages = AgentRun(), []
    for _ in range(4):
        add_result(fixture, messages, content="Error: unavailable")
    add_result(fixture, messages, content="new evidence")
    run = AgentRun()
    run.observe(messages)
    assert run.stop_reason is None
    assert run.tool_calls == 5


def test_disabled_guard_does_not_stop_repeated_errors():
    run, messages = AgentRun(settings=LoopGuardSettings(enabled=False)), []
    for _ in range(20):
        add_result(run, messages, content="Error: unavailable")
    assert run.stop_reason is None


def test_zero_exit_with_failed_json_report_is_a_failure():
    result = tool_outcome(sandbox_output('{"passed":false,"errors":["bad"]}'))
    assert result.failed


def test_request_context_isolated_across_parallel_tasks_and_reset_after_cancellation():
    async def scenario():
        ready = asyncio.Event()

        async def task(name):
            with agent_run_scope() as run:
                run.attempts["briefing"] = name
                ready.set()
                await asyncio.sleep(0)
                assert current_agent_run() is run
                assert run.attempts["briefing"] == name
            assert current_agent_run() is None
            return run.run_id

        ids = await asyncio.gather(task(1), task(2))
        assert len(set(ids)) == 2
        assert current_agent_run() is None
        with pytest.raises(asyncio.CancelledError), agent_run_scope():
            raise asyncio.CancelledError
        assert current_agent_run() is None

    asyncio.run(scenario())
