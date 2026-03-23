"""
Register a resilient tool-calling agent workflow with NAT.

Identical to the built-in ``tool_calling_agent`` but uses
``ResilientToolCallAgentGraph`` which repairs malformed JSON in
LLM tool-call arguments before the agent processes them.

Usage in YAML config:

    workflow:
      _type: tool_calling_agent_resilient
      llm_name: tool_calling_llm
      tool_names: [...]
"""

import logging

from langchain_core.messages import AIMessage
from langgraph.errors import GraphRecursionError
from nat.builder.builder import Builder
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.agent import AgentBaseConfig
from nat.data_models.api_server import ChatRequest, ChatRequestOrMessage
from nat.data_models.component_ref import FunctionGroupRef, FunctionRef
from nat.utils.type_converter import GlobalTypeConverter
from pydantic import Field

logger = logging.getLogger(__name__)


class ResilientToolCallAgentConfig(
    AgentBaseConfig, name="tool_calling_agent_resilient"
):
    """
    A resilient variant of the Tool Calling Agent that automatically repairs
    malformed JSON in LLM tool-call arguments (e.g. missing closing braces).
    """

    description: str = Field(
        default="Resilient Tool Calling Agent Workflow",
        description="Description of this function's use.",
    )
    tool_names: list[FunctionRef | FunctionGroupRef] = Field(
        default_factory=list,
        description="The list of tools to provide to the tool calling agent.",
    )
    handle_tool_errors: bool = Field(
        default=True,
        description="Specify ability to handle tool calling errors.",
    )
    max_iterations: int = Field(
        default=15,
        description="Number of tool calls before stopping the tool calling agent.",
    )
    max_history: int = Field(
        default=15,
        description="Maximum number of messages to keep in the conversation history.",
    )
    system_prompt: str | None = Field(
        default=None,
        description="Provides the system prompt to use with the agent.",
    )
    additional_instructions: str | None = Field(
        default=None,
        description="Additional instructions appended to the system prompt.",
    )
    return_direct: list[FunctionRef] | None = Field(
        default=None,
        description="List of tool names that should return responses directly without LLM processing.",
    )


@register_function(
    config_type=ResilientToolCallAgentConfig,
    framework_wrappers=[LLMFrameworkEnum.LANGCHAIN],
)
async def resilient_tool_calling_agent_workflow(
    config: ResilientToolCallAgentConfig, builder: Builder
):
    from json_repair_agent.resilient_agent import ResilientToolCallAgentGraph
    from langchain_core.messages import trim_messages
    from langchain_core.messages.base import BaseMessage
    from langgraph.graph.state import CompiledStateGraph
    from nat.plugins.langchain.agent.base import AGENT_LOG_PREFIX
    from nat.plugins.langchain.agent.tool_calling_agent.agent import (
        ToolCallAgentGraphState,
        create_tool_calling_agent_prompt,
    )

    prompt = create_tool_calling_agent_prompt(config)
    llm = await builder.get_llm(
        config.llm_name, wrapper_type=LLMFrameworkEnum.LANGCHAIN
    )
    tools = await builder.get_tools(
        tool_names=config.tool_names, wrapper_type=LLMFrameworkEnum.LANGCHAIN
    )
    if not tools:
        raise ValueError(
            f"No tools specified for Resilient Tool Calling Agent '{config.llm_name}'"
        )

    return_direct_tools = (
        await builder.get_tools(
            tool_names=config.return_direct, wrapper_type=LLMFrameworkEnum.LANGCHAIN
        )
        if config.return_direct
        else None
    )

    graph: CompiledStateGraph = await ResilientToolCallAgentGraph(
        llm=llm,
        tools=tools,
        prompt=prompt,
        detailed_logs=config.verbose,
        log_response_max_chars=config.log_response_max_chars,
        handle_tool_errors=config.handle_tool_errors,
        return_direct=return_direct_tools,
    ).build_graph()

    async def _response_fn(chat_request_or_message: ChatRequestOrMessage) -> str:
        try:
            message = GlobalTypeConverter.get().convert(
                chat_request_or_message, to_type=ChatRequest
            )

            messages: list[BaseMessage] = trim_messages(
                messages=[m.model_dump() for m in message.messages],
                max_tokens=config.max_history,
                strategy="last",
                token_counter=len,
                start_on="human",
                include_system=True,
            )
            initial_state = ToolCallAgentGraphState(messages=messages)
            recursion_limit = (config.max_iterations + 1) * 2

            last_state: dict | None = None
            hit_recursion_limit = False
            try:
                async for state_snapshot in graph.astream(
                    initial_state,
                    config={"recursion_limit": recursion_limit},
                    stream_mode="values",
                ):
                    last_state = state_snapshot
            except GraphRecursionError:
                hit_recursion_limit = True
                logger.warning(
                    "%s Recursion limit (%d) reached — returning best-effort response",
                    AGENT_LOG_PREFIX,
                    recursion_limit,
                )

            if last_state is None:
                raise RuntimeError("Agent graph produced no state")

            final_state = ToolCallAgentGraphState(**last_state)

            if hit_recursion_limit:
                for msg in reversed(final_state.messages):
                    if isinstance(msg, AIMessage) and msg.content:
                        return str(msg.content)

            output_message = final_state.messages[-1]
            return str(output_message.content)
        except Exception as ex:
            logger.error(
                "%s Resilient Tool Calling Agent failed: %s", AGENT_LOG_PREFIX, ex
            )
            raise

    try:
        yield FunctionInfo.from_fn(_response_fn, description=config.description)
    except GeneratorExit:
        logger.exception("%s Workflow exited early!", AGENT_LOG_PREFIX)
    finally:
        logger.debug(
            "%s Cleaning up resilient tool calling agent workflow.", AGENT_LOG_PREFIX
        )
