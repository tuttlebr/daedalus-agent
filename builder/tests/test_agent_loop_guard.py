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


def test_repetition_ignores_sandbox_request_metadata_and_is_not_off_by_one():
    run, messages = AgentRun(), []
    for i in range(4):
        add_result(
            run,
            messages,
            name="llm_sandbox_tool",
            args={"argv": ["cat", "broken.json"]},
            content=sandbox_output("same bytes", request=str(i)),
        )
        assert run.stop_reason == (None if i < 3 else "repeated_tool_result")
    run.observe(messages)
    assert run.tool_calls == 4


def test_changed_scripts_with_successful_inspections_do_not_escape_repair_budget():
    run, messages = AgentRun(), []
    add_result(
        run,
        messages,
        name="llm_sandbox_tool",
        args={"argv": ["python3", "render.py"]},
        content=sandbox_output('{"passed":false,"errors":["bad document"]}', code=1),
    )
    for i in range(12):
        add_result(
            run,
            messages,
            name="llm_sandbox_tool",
            args={"argv": ["python3", "-c", f"inspect({i})"]},
            content=sandbox_output(f"slice {i}"),
        )
        assert run.stop_reason == (None if i < 11 else "repair_budget_exceeded")


@pytest.mark.parametrize("content", ['{"passed":true}', "rendered successfully"])
def test_successful_validation_or_original_call_rerun_resolves_repair(content):
    run, messages = AgentRun(), []
    args = {"argv": ["python3", "render.py"]}
    add_result(
        run,
        messages,
        name="llm_sandbox_tool",
        args=args,
        content=sandbox_output("bad", code=1),
    )
    add_result(
        run,
        messages,
        name="llm_sandbox_tool",
        args=args,
        content=sandbox_output(content),
    )
    assert not run.repairs
    for i in range(40):
        add_result(
            run,
            messages,
            name="llm_sandbox_tool",
            args={"argv": ["python3", str(i)]},
            content=sandbox_output(str(i)),
        )
    assert run.stop_reason is None


def test_different_error_offsets_and_commands_do_not_reset_error_count():
    run, messages = AgentRun(), []
    for i in range(4):
        add_result(
            run,
            messages,
            args={"attempt": i},
            content=json.dumps(
                {"passed": False, "errors": [f"bad JSON at character {i * 5}"]}
            ),
        )
    assert run.stop_reason == "repeated_tool_error"


def test_long_research_with_new_evidence_continues():
    run, messages = AgentRun(), []
    for i in range(110):
        add_result(run, messages, args={"query": f"topic {i}"}, content=f"evidence {i}")
    assert run.stop_reason is None
    assert len(run.recent) == 24


def test_changing_collected_file_content_is_progress():
    run, messages = AgentRun(), []
    for i in range(30):
        content = (
            sandbox_output()
            + "\ncontent (UTF-8 JSON string): "
            + json.dumps(f"new content {i}")
        )
        add_result(
            run,
            messages,
            name="llm_sandbox_tool",
            args={"operation": "read_file", "file_path": "result.txt"},
            content=content,
        )
    assert run.stop_reason is None


def test_history_does_not_consume_current_turn_budget():
    historical, messages = AgentRun(), []
    for _ in range(6):
        add_result(historical, messages, content="Error: unavailable")
    run = AgentRun(processed=len(messages))
    add_result(run, messages, args={"query": "new"}, content="new answer")
    assert run.tool_calls == 1
    assert run.stop_reason is None


def test_explicit_phase_budget_counts_auxiliary_tools_even_when_guard_disabled():
    run = AgentRun(settings=LoopGuardSettings(enabled=False), repair_phase="briefing")
    messages = []
    for i in range(6):
        add_result(run, messages, name=f"different_tool_{i}", content="success")
    assert run.stop_reason == "repair_budget_exceeded"


def test_zero_exit_with_failed_json_report_is_a_failure():
    result = tool_outcome(sandbox_output('{"passed":false,"errors":["bad"]}'))
    assert result.failed and not result.validated


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
