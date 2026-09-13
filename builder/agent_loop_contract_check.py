"""Offline integration checks against the installed NAT/LangGraph runtime."""

import asyncio
import json
import os

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessageChunk
from langchain_core.outputs import ChatGenerationChunk
from langchain_core.tools import StructuredTool
from nat.builder.context import Context
from nat.data_models.api_server import ChatRequest
from nat_helpers.agent_loop_guard import agent_run_scope, current_agent_run
from nat_helpers.briefing_renderer import (
    BriefingRendererConfig,
    BriefingRendererInput,
    briefing_renderer,
)
from nat_helpers.per_user_tool_calling import (
    DaedalusPerUserResponsesAPIAgentWorkflowConfig,
    IncompleteAgentRun,
    _responses_api_agent_workflow,
)
from pydantic import Field


def _require(condition, detail):
    if not condition:
        raise RuntimeError(str(detail))


class StreamChunkTimeoutError(RuntimeError):
    """Match the production stream timeout class for offline retry coverage."""


class ContractLLM(BaseChatModel):
    model_name: str = "offline-contract"
    mode: str = "repeat_success"
    finalizations: int = 0
    tool_name: str = "lookup"
    seen: list = Field(default_factory=list)

    @property
    def _llm_type(self):
        return "offline-contract"

    def bind_tools(self, tools, **kwargs):
        return self.bind(tools=tools, **kwargs)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.finalizations += 1
        raise RuntimeError("Recovery must not make another model call")

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        run_id = current_agent_run().run_id
        self.seen.append(run_id)
        call = self.seen.count(run_id)
        _require(kwargs.get("tools"), "Recovery attempted a tools-free model call")
        if (
            self.mode == "complete"
            or (self.mode == "answer_commentary" and call > 1)
            or (self.mode == "daily_retry" and call > 3)
            or (self.mode == "progress" and call > 30)
            or (self.mode == "sandbox_progress" and call > 31)
            or (self.mode in {"reset_success", "reset_changed"} and call > 7)
        ):
            yield ChatGenerationChunk(message=AIMessageChunk(content="Completed."))
            return
        if self.mode in {"daily_retry", "provider_error", "truncated"} and call == 3:
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content=(
                        [
                            {
                                "type": "text",
                                "text": "Useful partial answer: retained evidence.",
                                "phase": "final_answer",
                            }
                        ]
                        if self.mode == "truncated"
                        else "Useful partial answer: retained evidence."
                    ),
                    chunk_position="last" if self.mode == "truncated" else None,
                    response_metadata=(
                        {"finish_reason": "length"} if self.mode == "truncated" else {}
                    ),
                )
            )
            if self.mode == "daily_retry":
                raise StreamChunkTimeoutError("Synthetic final stream stall")
            if self.mode == "provider_error":
                raise RuntimeError("Synthetic provider failure")
            return
        if self.mode in {"artifact_commentary", "answer_commentary"}:
            yield ChatGenerationChunk(
                message=AIMessageChunk(content="Preparing verified results. ")
            )
        value = (
            call
            if self.mode
            in {
                "daily_retry",
                "progress",
                "sandbox_progress",
                "provider_error",
                "truncated",
            }
            else 2
            if self.mode in {"reset_success", "reset_changed"} and call == 4
            else 1
        )
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content="",
                response_metadata=(
                    {"id": "resp_fixture", "status": "incomplete"}
                    if self.mode == "incomplete_tool"
                    else {"id": "resp_fixture"}
                    if self.mode == "missing_terminal_tool"
                    else {}
                ),
                tool_call_chunks=[
                    {
                        "name": self.tool_name,
                        "args": json.dumps({"value": value}),
                        "id": f"call-{call}",
                        "index": 0,
                    }
                ],
            )
        )


def _sandbox_output(value: int) -> str:
    return (
        "## Sandbox Execution Result\n"
        f"Request ID: fixture-{value}\nExit code: {1 if value == 1 else 0}\n"
        "Duration: 1 ms\nTimed out: False\nTruncated: False\n"
        f"stdout (JSON string): {json.dumps(f'evidence {value}')}\n"
        f"stderr (JSON string): {json.dumps('failed lookup' if value == 1 else '')}"
    )


def _lookup_runner(mode, executions):
    async def lookup(value: int) -> str:
        """Read an offline fixture."""
        executions.append(value)
        if mode in {"artifact", "artifact_commentary"}:
            run = current_agent_run()
            run.terminal_reason = "validated_artifact"
            run.terminal_content = "```html\n<p>exact validated fixture</p>\n```"
        if mode == "sandbox_progress":
            return _sandbox_output(value)
        if mode in {"repeat_failure", "reset_changed"} or (
            mode == "reset_success" and value == 1
        ):
            return "Error: fixture unavailable"
        return f"result {value}"

    return lookup


class ContractBuilder:
    def __init__(self, tool):
        self.tool = tool

    async def get_tools(self, **kwargs):
        return [self.tool]


async def verify_agent_loop_contract():
    previous = os.environ.get("DAEDALUS_MEMORY_MODE")
    os.environ["DAEDALUS_MEMORY_MODE"] = "disabled"
    events = []
    subscription = Context.get().intermediate_step_manager.subscribe(events.append)
    try:
        for streaming in (False, True):
            for mode in (
                "repeat_success",
                "repeat_failure",
                "reset_success",
                "reset_changed",
                "sandbox_progress",
                "complete",
                "progress",
                "artifact",
                "artifact_commentary",
                "answer_commentary",
                "daily_retry",
                "provider_error",
                "truncated",
                "recursion",
                "incomplete_tool",
                "missing_terminal_tool",
            ):
                executions = []

                tool_name = (
                    "llm_sandbox_tool" if mode == "sandbox_progress" else "lookup"
                )
                tool = StructuredTool.from_function(
                    coroutine=_lookup_runner(mode, executions), name=tool_name
                )

                llm = ContractLLM(mode=mode, tool_name=tool_name)
                config = DaedalusPerUserResponsesAPIAgentWorkflowConfig(
                    llm_name="offline",
                    nat_tools=[tool_name],
                    daily_summary_nat_tools=(
                        [tool_name] if mode == "daily_retry" else []
                    ),
                    daily_summary_final_nat_tools=(
                        [tool_name] if mode == "daily_retry" else []
                    ),
                    tool_output_compaction_enabled=False,
                    max_iterations=(
                        2
                        if mode == "recursion"
                        else 8
                        if mode == "repeat_success"
                        else 128
                    ),
                )
                if mode == "recursion":
                    config.loop_guard.enabled = False
                incomplete = mode in {
                    "repeat_success",
                    "repeat_failure",
                    "provider_error",
                    "truncated",
                    "recursion",
                    "incomplete_tool",
                    "missing_terminal_tool",
                }
                async with _responses_api_agent_workflow(
                    config, ContractBuilder(tool), llm
                ) as info:
                    request = ChatRequest(
                        messages=[
                            {"role": "user", "content": "historical request"},
                            {"role": "assistant", "content": "OLD_TURN_NOT_RECOVERY"},
                            {
                                "role": "user",
                                "content": (
                                    "daily summary"
                                    if mode == "daily_retry"
                                    else "offline fixture"
                                ),
                            },
                        ]
                    )
                    for _ in range(2):
                        before = len(executions)
                        if streaming:
                            chunks = []
                            interrupted = False
                            try:
                                async for chunk in info.stream_fn(request):
                                    chunks.append(chunk)
                            except IncompleteAgentRun:
                                interrupted = True
                            _require(interrupted == incomplete, (mode, interrupted))
                            text = "".join(
                                c.choices[0].delta.content or "" for c in chunks
                            )
                            terminals = sum(
                                bool(getattr(c.choices[0], "daedalus_terminal", False))
                                for c in chunks
                            )
                            _require(
                                terminals == (0 if incomplete else 1), (mode, terminals)
                            )
                        else:
                            text = await info.single_fn(request)
                        _require(
                            current_agent_run() is None, "Agent run context leaked"
                        )
                        _require(
                            llm.finalizations == 0, "Recovery made another model call"
                        )
                        _require(
                            "OLD_TURN_NOT_RECOVERY" not in text,
                            "Recovery leaked prior turns",
                        )
                        delta = len(executions) - before
                        if incomplete:
                            _require("incomplete" in text.lower(), (mode, text))
                            if mode == "repeat_failure":
                                _require(delta == 4, (mode, delta))
                                if not streaming:
                                    _require(
                                        "fixture unavailable" in text,
                                        "Tool evidence lost",
                                    )
                            elif mode == "repeat_success":
                                _require(4 < delta <= 9, (mode, delta))
                                if not streaming:
                                    _require(
                                        "result 1" in text,
                                        "Successful tool evidence lost",
                                    )
                            elif mode == "recursion":
                                _require(0 < delta <= 3, (mode, delta))
                            elif mode in {"incomplete_tool", "missing_terminal_tool"}:
                                _require(
                                    delta == 0,
                                    (mode, "Incomplete response executed tools", delta),
                                )
                            else:
                                _require(delta == 2, (mode, delta))
                                _require(
                                    "Useful partial answer: retained evidence." in text,
                                    (mode, "Partial model output lost", text),
                                )
                                if not streaming:
                                    _require(
                                        "result 1" in text and "result 2" in text,
                                        "Tool evidence lost",
                                    )
                        elif mode in {"artifact", "artifact_commentary"}:
                            _require(delta == 1, (mode, delta))
                            expected = "```html\n<p>exact validated fixture</p>\n```"
                            if streaming and mode == "artifact_commentary":
                                expected = "Preparing verified results. " + expected
                            _require(text == expected, text)
                        else:
                            expected = "Completed."
                            if streaming and mode == "answer_commentary":
                                expected = "Preparing verified results. " + expected
                            if streaming and mode == "daily_retry":
                                expected = (
                                    "Useful partial answer: retained evidence."
                                    + expected
                                )
                            _require(text == expected, (mode, text))
                            expected_calls = {
                                "complete": 0,
                                "answer_commentary": 1,
                                "progress": 30,
                                "sandbox_progress": 31,
                                "reset_success": 7,
                                "reset_changed": 7,
                                "daily_retry": 2,
                            }
                            _require(delta == expected_calls[mode], (mode, delta))
                    if mode == "repeat_failure":
                        before = len(executions)
                        outputs = await asyncio.gather(
                            info.single_fn(request), info.single_fn(request)
                        )
                        _require(
                            len(executions) - before == 8,
                            "Concurrent requests shared a budget",
                        )
                        _require(
                            all("incomplete" in output.lower() for output in outputs),
                            "Concurrent termination failed",
                        )
                    if streaming and mode == "complete":
                        stream = info.stream_fn(request)
                        await stream.asend(None)
                        await stream.aclose()
                        _require(
                            current_agent_run() is None,
                            "Stream close leaked request context",
                        )
                expected_runs = (
                    4
                    if mode == "repeat_failure"
                    else 3
                    if streaming and mode == "complete"
                    else 2
                )
                _require(len(set(llm.seen)) == expected_runs, (mode, llm.seen))

        outcomes = [
            event.payload.data.output
            for event in events
            if event.payload.name == "daedalus.agent.outcome"
            and event.payload.event_type.value == "CUSTOM_END"
        ]
        _require(
            any(
                o["outcome"] == "repeated_tool_error" and o["failed"] for o in outcomes
            ),
            "Failed run missing from NAT telemetry",
        )
        _require(
            any(o["outcome"] == "iteration_limit" and o["failed"] for o in outcomes),
            "Iteration limit missing from NAT telemetry",
        )
        _require(
            any(
                o["outcome"] == "validated_artifact" and not o["failed"]
                for o in outcomes
            ),
            "Validated artifact missing from NAT telemetry",
        )

        class SandboxBuilder:
            async def get_function(self, name):
                _require(name == "llm_sandbox_tool", "Incorrect sandbox dependency")
                return self

            async def acall_invoke(self, **kwargs):
                raise RuntimeError(
                    "Missing resources should fail before sandbox execution"
                )

        async with briefing_renderer(
            BriefingRendererConfig(skill_directory="/missing-contract-skill"),
            SandboxBuilder(),
        ) as info:
            _require(
                info.input_schema is BriefingRendererInput, "Briefing input schema lost"
            )
            with agent_run_scope() as run:
                output = await info.single_fn(BriefingRendererInput(edition={}))
                _require(
                    json.loads(output)["terminal"] is False,
                    "Renderer failure stopped useful work",
                )
                _require(
                    run.terminal_content is None,
                    "Renderer replaced research with fallback HTML",
                )
                _require(
                    json.loads(output)["edition"] == {},
                    "Renderer lost submitted edition",
                )
    finally:
        subscription.unsubscribe()
        if previous is None:
            os.environ.pop("DAEDALUS_MEMORY_MODE", None)
        else:
            os.environ["DAEDALUS_MEMORY_MODE"] = previous


if __name__ == "__main__":
    asyncio.run(verify_agent_loop_contract())
    print("Agent loop runtime contracts passed.")
