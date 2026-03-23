"""
A drop-in replacement for NAT's ``tool_calling_agent`` that automatically
repairs malformed JSON in LLM tool-call arguments.

When an LLM emits ``invalid_tool_calls`` (e.g. missing closing braces),
the standard agent silently ignores them and ends the turn. This subclass
intercepts the LLM response, attempts JSON repair, and promotes repaired
calls back into ``tool_calls`` so the agent loop continues normally.
"""

import json
import logging

from json_repair_agent.json_repair import repair_json_string
from langchain_core.callbacks.base import AsyncCallbackHandler
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.runnables.config import RunnableConfig
from langchain_core.tools import BaseTool
from langgraph.runtime import DEFAULT_RUNTIME
from nat.plugins.langchain.agent.base import AGENT_CALL_LOG_MESSAGE, AGENT_LOG_PREFIX
from nat.plugins.langchain.agent.tool_calling_agent.agent import (
    ToolCallAgentGraph,
    ToolCallAgentGraphState,
)

logger = logging.getLogger(__name__)


class ResilientToolCallAgentGraph(ToolCallAgentGraph):
    """Extends ``ToolCallAgentGraph`` with automatic JSON repair for invalid tool calls."""

    def __init__(
        self,
        llm: BaseChatModel,
        tools: list[BaseTool],
        prompt: str | None = None,
        callbacks: list[AsyncCallbackHandler] | None = None,
        detailed_logs: bool = False,
        log_response_max_chars: int = 1000,
        handle_tool_errors: bool = True,
        return_direct: list[BaseTool] | None = None,
    ):
        super().__init__(
            llm=llm,
            tools=tools,
            prompt=prompt,
            callbacks=callbacks,
            detailed_logs=detailed_logs,
            log_response_max_chars=log_response_max_chars,
            handle_tool_errors=handle_tool_errors,
            return_direct=return_direct,
        )

    async def agent_node(self, state: ToolCallAgentGraphState):
        try:
            logger.debug(
                "%s Starting Resilient Tool Calling Agent Node", AGENT_LOG_PREFIX
            )

            if len(state.messages) == 0:
                raise RuntimeError('No input received in state: "messages"')

            response: AIMessage = await self.agent.ainvoke(
                {"messages": state.messages},
                config=RunnableConfig(
                    callbacks=self.callbacks,
                    configurable={"__pregel_runtime": DEFAULT_RUNTIME},
                ),
            )

            if self.detailed_logs:
                agent_input = "\n".join(str(m.content) for m in state.messages)
                logger.info(AGENT_CALL_LOG_MESSAGE, agent_input, response)

            response = _repair_invalid_tool_calls(response)

            state.messages += [response]
            return state

        except Exception as ex:
            logger.error("%s Failed to call agent_node: %s", AGENT_LOG_PREFIX, ex)
            raise


def _repair_invalid_tool_calls(message: AIMessage) -> AIMessage:
    """Move repairable ``invalid_tool_calls`` into ``tool_calls``."""
    if not hasattr(message, "invalid_tool_calls") or not message.invalid_tool_calls:
        return message

    repaired: list[dict] = []
    still_invalid = []

    for itc in message.invalid_tool_calls:
        fixed = repair_json_string(
            itc.get("args", "") if isinstance(itc, dict) else getattr(itc, "args", "")
        )
        name = (
            itc.get("name", "") if isinstance(itc, dict) else getattr(itc, "name", "")
        )
        tc_id = itc.get("id", "") if isinstance(itc, dict) else getattr(itc, "id", "")

        if fixed is not None:
            logger.info(
                "%s Repaired invalid tool call for '%s': %s -> %s",
                AGENT_LOG_PREFIX,
                name,
                (
                    itc.get("args", "")
                    if isinstance(itc, dict)
                    else getattr(itc, "args", "")
                )[:120],
                fixed[:120],
            )
            repaired.append(
                {
                    "name": name,
                    "args": json.loads(fixed),
                    "id": tc_id,
                    "type": "tool_call",
                }
            )
        else:
            logger.warning(
                "%s Could not repair invalid tool call for '%s': %s",
                AGENT_LOG_PREFIX,
                name,
                (
                    itc.get("args", "")
                    if isinstance(itc, dict)
                    else getattr(itc, "args", "")
                )[:200],
            )
            still_invalid.append(itc)

    if repaired:
        message.tool_calls = list(message.tool_calls) + repaired
        message.invalid_tool_calls = still_invalid

    return message
