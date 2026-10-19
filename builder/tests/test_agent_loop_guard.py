"""Leaf-result classification and request-scoped tool state.

The Rust loop counts repeated failures by tool, arguments, and the signature
of ``tool_outcome().comparable`` that the Python service returns.
"""

import asyncio
import json

import pytest
from nat_helpers.agent_loop_guard import (
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


def test_identical_sandbox_failures_ignore_only_request_metadata():
    first = tool_outcome(sandbox_output("same failure", code=1, request="1"))
    second = tool_outcome(sandbox_output("same failure", code=1, request="2"))
    changed = tool_outcome(sandbox_output("other failure", code=1, request="3"))

    assert first.failed and second.failed and changed.failed
    assert first.comparable == second.comparable
    assert first.comparable != changed.comparable


def test_successful_polling_is_not_a_failure():
    assert not tool_outcome(sandbox_output("running", request="1")).failed
    assert not tool_outcome("found").failed


@pytest.mark.parametrize(
    "content",
    [
        "Error: unavailable",
        json.dumps({"passed": False, "errors": ["bad document"]}),
        json.dumps({"success": False}),
        json.dumps({"isError": True}),
        json.dumps({"status": "failed"}),
        json.dumps({"error": "unavailable"}),
    ],
)
def test_explicit_failure_envelopes_are_failures(content):
    assert tool_outcome(content).failed


def test_status_error_is_a_failure_even_with_ordinary_text():
    assert tool_outcome("ordinary text", status="error").failed


def test_distinct_error_offsets_remain_distinct_failures():
    outcomes = [
        tool_outcome(
            json.dumps({"passed": False, "errors": [f"bad JSON at character {i}"]})
        )
        for i in (5, 10)
    ]
    assert all(outcome.failed for outcome in outcomes)
    assert outcomes[0].comparable != outcomes[1].comparable


def test_truncated_success_is_not_an_execution_failure():
    content = sandbox_output("partial preview").replace(
        "Truncated: False", "Truncated: True"
    )
    assert not tool_outcome(content).failed


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
            return run

        runs = await asyncio.gather(task(1), task(2))
        assert runs[0] is not runs[1]
        assert current_agent_run() is None
        with pytest.raises(asyncio.CancelledError), agent_run_scope():
            raise asyncio.CancelledError
        assert current_agent_run() is None

    asyncio.run(scenario())
