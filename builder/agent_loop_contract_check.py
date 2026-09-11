"""Offline integration checks against the installed NAT/LangGraph runtime."""

import asyncio
import json
import os

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
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
    _responses_api_agent_workflow,
)
from pydantic import Field


def _require(condition, detail):
    if not condition:
        raise RuntimeError(str(detail))


class ContractLLM(BaseChatModel):
    model_name: str = "offline-contract"
    mode: str = "repeat"
    calls: int = 0
    finalizations: int = 0
    tool_name: str = "lookup"
    seen: list = Field(default_factory=list)

    @property
    def _llm_type(self):
        return "offline-contract"

    def bind_tools(self, tools, **kwargs):
        return self.bind(tools=tools, **kwargs)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        _require(kwargs.get("tools") == [], "Agent loop runtime contract failed")
        _require(
            kwargs.get("tool_choice") == "none", "Agent loop runtime contract failed"
        )
        self.finalizations += 1
        if self.mode == "finalizer_error":
            raise RuntimeError("offline finalizer failure")
        if self.mode == "finalizer_tools":
            return ChatResult(
                generations=[
                    ChatGeneration(
                        message=AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "name": "lookup",
                                    "args": {"value": 2},
                                    "id": "forbidden",
                                }
                            ],
                        )
                    )
                ]
            )
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content="Verified partial results; request incomplete."
                    )
                )
            ]
        )

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        if self.mode == "finalizer_timeout":
            await asyncio.sleep(60)
        return self._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        self.calls += 1
        self.seen.append(current_agent_run().run_id)
        if self.mode == "complete" or (self.mode == "progress" and self.calls > 30):
            yield ChatGenerationChunk(message=AIMessageChunk(content="Completed."))
            return
        value = self.calls if self.mode == "progress" else 1
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content="",
                tool_call_chunks=[
                    {
                        "name": self.tool_name,
                        "args": json.dumps({"value": value}),
                        "id": f"call-{self.calls}",
                        "index": 0,
                    }
                ],
            )
        )


async def verify_agent_loop_contract():
    previous = os.environ.get("DAEDALUS_MEMORY_MODE")
    os.environ["DAEDALUS_MEMORY_MODE"] = "disabled"
    events = []
    subscription = Context.get().intermediate_step_manager.subscribe(events.append)
    try:
        for streaming in (False, True):
            for mode in (
                "repeat",
                "complete",
                "progress",
                "artifact",
                "finalizer_error",
                "finalizer_tools",
                "finalizer_timeout",
                "briefing_failure",
                "recursion",
            ):
                executions = []

                async def lookup(value: int) -> str:
                    """Read an offline fixture."""
                    executions.append(value)
                    if mode == "artifact":
                        run = current_agent_run()
                        run.terminal_reason = "validated_artifact"
                        run.terminal_content = (
                            "```html\n<p>exact validated fixture</p>\n```"
                        )
                    if mode == "briefing_failure":
                        current_agent_run().briefing = True
                        return "Error: validation failed"
                    return f"result {value}"

                tool = StructuredTool.from_function(coroutine=lookup, name="lookup")

                class Builder:
                    async def get_tools(self, **kwargs):
                        return [tool]

                llm = ContractLLM(mode=mode)
                config = DaedalusPerUserResponsesAPIAgentWorkflowConfig(
                    llm_name="offline",
                    nat_tools=["lookup"],
                    tool_output_compaction_enabled=False,
                    max_iterations=2 if mode == "recursion" else 128,
                )
                if mode == "recursion":
                    config.loop_guard.enabled = False
                if mode == "finalizer_timeout":
                    config.loop_guard.final_response_timeout = 0.01
                async with _responses_api_agent_workflow(
                    config, Builder(), llm
                ) as info:
                    request = ChatRequest(
                        messages=[{"role": "user", "content": "offline fixture"}]
                    )
                    for invocation in range(2):
                        before = len(executions)
                        if streaming:
                            chunks = [c async for c in info.stream_fn(request)]
                            text = "".join(
                                c.choices[0].delta.content or "" for c in chunks
                            )
                            _require(
                                sum(
                                    bool(
                                        getattr(
                                            c.choices[0], "daedalus_terminal", False
                                        )
                                    )
                                    for c in chunks
                                )
                                == 1,
                                "Agent loop runtime contract failed",
                            )
                        else:
                            text = await info.single_fn(request)
                        _require(
                            current_agent_run() is None,
                            "Agent loop runtime contract failed",
                        )
                        delta = len(executions) - before
                        if mode in (
                            "repeat",
                            "finalizer_error",
                            "finalizer_tools",
                            "finalizer_timeout",
                        ):
                            _require(delta == 4, (mode, delta))
                            _require(
                                "incomplete" in text,
                                "Agent loop runtime contract failed",
                            )
                        elif mode == "recursion":
                            _require(
                                0 < delta <= 3, "Agent loop runtime contract failed"
                            )
                            _require(
                                "incomplete" in text,
                                "Agent loop runtime contract failed",
                            )
                        elif mode == "briefing_failure":
                            _require(
                                delta == 4 and "Briefing unavailable" in text,
                                "Briefing fallback failed",
                            )
                            _require(
                                llm.finalizations == 0, "Briefing fallback called model"
                            )
                        elif mode == "artifact":
                            _require(delta == 1, "Agent loop runtime contract failed")
                            _require(
                                text == "```html\n<p>exact validated fixture</p>\n```",
                                "Agent loop runtime contract failed",
                            )
                            _require(
                                llm.finalizations == 0,
                                "Agent loop runtime contract failed",
                            )
                        else:
                            _require(
                                text == "Completed.",
                                "Agent loop runtime contract failed",
                            )
                            if mode == "progress" and invocation == 0:
                                _require(
                                    delta == 30, "Agent loop runtime contract failed"
                                )
                    if mode == "repeat":
                        before = len(executions)
                        outputs = await asyncio.gather(
                            info.single_fn(request), info.single_fn(request)
                        )
                        _require(
                            len(executions) - before == 8,
                            "Concurrent requests shared a budget",
                        )
                        _require(
                            all("incomplete" in output for output in outputs),
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
                    if mode == "repeat"
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
                o["outcome"] == "repeated_tool_result" and o["failed"] for o in outcomes
            ),
            "Failed run missing from NAT telemetry",
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
                    json.loads(output)["terminal"],
                    "Briefing unavailable state did not terminate",
                )
                _require(run.terminal_content is not None, "Briefing fallback missing")
    finally:
        subscription.unsubscribe()
        if previous is None:
            os.environ.pop("DAEDALUS_MEMORY_MODE", None)
        else:
            os.environ["DAEDALUS_MEMORY_MODE"] = previous


if __name__ == "__main__":
    asyncio.run(verify_agent_loop_contract())
    print("Agent loop runtime contracts passed.")
