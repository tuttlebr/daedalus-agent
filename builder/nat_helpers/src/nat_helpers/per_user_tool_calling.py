"""Per-user forms of NAT's pinned OpenAI agent workflows.

NAT 1.8 ships a per-user MCP function group, but only registers a per-user
ReAct workflow. Daedalus uses the tool-calling workflow for chat-completions
streaming, so this adapter registers the same upstream implementation at the
supported per-user workflow boundary. NAT then builds OAuth-backed MCP groups
with the authenticated request context and caches the complete user workflow
for the configured idle window.

Responses uses NAT's Responses agent configuration contract rather than the
Chat Completions tool-agent contract. The Daedalus Responses adapter preserves
that contract while adding per-user construction, full inbound history, and
stream serialization for the existing Chat Completions-compatible front end.
"""

import datetime
import json
import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from nat.builder.builder import Builder
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_per_user_function
from nat.data_models.api_server import (
    ChatRequest,
    ChatRequestOrMessage,
    ChatResponseChunk,
    ChatResponseChunkChoice,
    ChoiceDelta,
    ChoiceDeltaToolCall,
    ChoiceDeltaToolCallFunction,
)
from nat.plugins.langchain.agent.responses_api_agent.register import (
    ResponsesAPIAgentWorkflowConfig,
)
from nat.plugins.langchain.agent.tool_calling_agent.register import (
    ToolCallAgentWorkflowConfig,
    tool_calling_agent_workflow,
)
from nat.utils.type_converter import GlobalTypeConverter
from pydantic import Field


class DaedalusPerUserToolCallAgentWorkflowConfig(
    ToolCallAgentWorkflowConfig,
    name="daedalus_per_user_tool_calling_agent",
):
    """Tool-calling agent built and cached independently for each user."""


class DaedalusPerUserResponsesAPIAgentWorkflowConfig(
    ResponsesAPIAgentWorkflowConfig,
    name="daedalus_per_user_responses_api_agent",
):
    """Responses API agent built and cached independently for each user."""

    instructions: str | None = Field(
        default=None,
        description="Top-level Responses API instructions for the agent.",
    )
    max_history: int = Field(
        default=15,
        ge=1,
        description="Maximum number of inbound conversation messages to retain.",
    )


def _content_text(content: object) -> str:
    """Extract text from Chat Completions strings or Responses content blocks."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""

    parts: list[str] = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
            continue
        if not isinstance(block, dict):
            continue
        if block.get("type") not in {"text", "output_text"}:
            continue
        text = block.get("text")
        if isinstance(text, str):
            parts.append(text)
    return "".join(parts)


def _bind_responses_llm(
    llm,
    *,
    tools: list[object],
    parallel_tool_calls: bool,
    instructions: str | None,
):
    """Bind Responses tools and instructions using the pinned LangChain API."""
    bound_llm = llm.bind_tools(
        tools=tools,
        parallel_tool_calls=parallel_tool_calls,
        strict=True,
    )
    if instructions:
        bound_llm = bound_llm.bind(instructions=instructions)
    return bound_llm


@asynccontextmanager
async def _responses_api_agent_workflow(
    config: DaedalusPerUserResponsesAPIAgentWorkflowConfig,
    builder: Builder,
    llm,
):
    """Run NAT's Responses agent contract with Daedalus stream handling."""
    from langchain_core.messages import AIMessageChunk, trim_messages
    from langchain_core.messages.base import BaseMessage
    from langchain_core.runnables import RunnableLambda
    from langgraph.errors import GraphRecursionError
    from nat.plugins.langchain.agent.tool_calling_agent.agent import (
        ToolCallAgentGraph,
        ToolCallAgentGraphState,
    )

    nat_tools = await builder.get_tools(
        tool_names=config.nat_tools,
        wrapper_type=LLMFrameworkEnum.LANGCHAIN,
    )
    bound_tools = [
        *nat_tools,
        *(tool.model_dump() for tool in config.mcp_tools),
        *config.builtin_tools,
    ]
    if not bound_tools:
        raise ValueError(
            f"No tools specified for Responses API Agent '{config.llm_name}'"
        )

    agent = ToolCallAgentGraph(
        llm=llm,
        tools=nat_tools,
        detailed_logs=config.verbose,
        handle_tool_errors=config.handle_tool_errors,
    )
    # NAT's Responses agent binds function tools in strict mode. Binding the
    # instructions after the tools retains both sets of invocation kwargs and
    # makes LangChain serialize them as the top-level Responses field.
    bound_llm = _bind_responses_llm(
        llm,
        tools=bound_tools,
        parallel_tool_calls=config.parallel_tool_calls,
        instructions=config.instructions,
    )
    agent.bound_llm = bound_llm
    agent.agent = (
        RunnableLambda(
            lambda state: state.get("messages", []),
            name="ResponsesInput",
        )
        | bound_llm
    )
    graph = await agent.build_graph()

    def _initial_state(
        chat_request_or_message: ChatRequestOrMessage,
    ) -> ToolCallAgentGraphState:
        message = GlobalTypeConverter.get().convert(
            chat_request_or_message,
            to_type=ChatRequest,
        )
        messages: list[BaseMessage] = trim_messages(
            messages=[item.model_dump() for item in message.messages],
            max_tokens=config.max_history,
            strategy="last",
            token_counter=len,
            start_on="human",
            include_system=True,
        )
        return ToolCallAgentGraphState(messages=messages)

    def _iteration_limit_message() -> str:
        return (
            "The tool calling agent could not produce a final answer within "
            f"{config.max_iterations} iterations. The agent repeatedly called "
            "tools without converging on a response."
        )

    async def _response_fn(chat_request_or_message: ChatRequestOrMessage) -> str:
        try:
            state = await graph.ainvoke(
                _initial_state(chat_request_or_message),
                config={"recursion_limit": (config.max_iterations + 1) * 2},
            )
            final_state = ToolCallAgentGraphState(**state)
            content = final_state.messages[-1].content
            return _content_text(content) or str(content)
        except GraphRecursionError:
            return _iteration_limit_message()

    async def _stream_fn(
        chat_request_or_message: ChatRequestOrMessage,
    ) -> AsyncGenerator[ChatResponseChunk]:
        chunk_id = str(uuid.uuid4())
        try:
            async for msg, metadata in graph.astream(
                _initial_state(chat_request_or_message),
                config={"recursion_limit": (config.max_iterations + 1) * 2},
                stream_mode="messages",
            ):
                if not isinstance(msg, AIMessageChunk):
                    continue
                if metadata.get("langgraph_node") != "agent":
                    continue

                text = _content_text(msg.content)
                if text:
                    yield ChatResponseChunk.create_streaming_chunk(text, id_=chunk_id)

                tool_calls = getattr(msg, "tool_call_chunks", None) or getattr(
                    msg,
                    "tool_calls",
                    None,
                )
                if tool_calls:
                    delta_tool_calls = []
                    for index, tool_call in enumerate(tool_calls):
                        call_index = tool_call.get("index")
                        if not isinstance(call_index, int):
                            call_index = index
                        arguments = tool_call.get("args", "")
                        if isinstance(arguments, dict):
                            arguments = json.dumps(arguments)
                        delta_tool_calls.append(
                            ChoiceDeltaToolCall(
                                index=call_index,
                                id=tool_call.get("id"),
                                type=("function" if tool_call.get("id") else None),
                                function=ChoiceDeltaToolCallFunction(
                                    name=tool_call.get("name"),
                                    arguments=arguments,
                                ),
                            )
                        )
                    yield ChatResponseChunk(
                        id=chunk_id,
                        choices=[
                            ChatResponseChunkChoice(
                                index=0,
                                delta=ChoiceDelta(tool_calls=delta_tool_calls),
                                finish_reason=None,
                            )
                        ],
                        created=datetime.datetime.now(datetime.UTC),
                        model=getattr(llm, "model_name", "unknown-model"),
                        object="chat.completion.chunk",
                    )
        except GraphRecursionError:
            yield ChatResponseChunk.create_streaming_chunk(
                _iteration_limit_message(),
                id_=chunk_id,
            )

    yield FunctionInfo.create(
        single_fn=_response_fn,
        stream_fn=_stream_fn,
        description=config.description,
    )


@register_per_user_function(
    config_type=DaedalusPerUserToolCallAgentWorkflowConfig,
    input_type=ChatRequest,
    single_output_type=str,
    streaming_output_type=ChatResponseChunk,
    framework_wrappers=[LLMFrameworkEnum.LANGCHAIN],
)
async def daedalus_per_user_tool_calling_agent(
    config: DaedalusPerUserToolCallAgentWorkflowConfig,
    builder: Builder,
):
    """Build the legacy Chat Completions tool agent for one user."""
    upstream_config = ToolCallAgentWorkflowConfig.model_validate(config.model_dump())
    async with tool_calling_agent_workflow(upstream_config, builder) as function_info:
        yield function_info


@register_per_user_function(
    config_type=DaedalusPerUserResponsesAPIAgentWorkflowConfig,
    input_type=ChatRequest,
    single_output_type=str,
    streaming_output_type=ChatResponseChunk,
    framework_wrappers=[LLMFrameworkEnum.LANGCHAIN],
)
async def daedalus_per_user_responses_api_agent(
    config: DaedalusPerUserResponsesAPIAgentWorkflowConfig,
    builder: Builder,
):
    """Build the Responses API agent and its user-specific tools."""
    llm = await builder.get_llm(
        config.llm_name,
        wrapper_type=LLMFrameworkEnum.LANGCHAIN,
    )
    if not getattr(llm, "use_responses_api", False):
        raise ValueError(
            "Daedalus Responses API Agent requires an LLM with api_type: responses"
        )

    async with _responses_api_agent_workflow(
        config,
        builder,
        llm,
    ) as function_info:
        yield function_info
