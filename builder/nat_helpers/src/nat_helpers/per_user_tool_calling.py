"""Per-user form of NAT's pinned tool-calling agent.

NAT 1.8 ships a per-user MCP function group, but only registers a per-user
ReAct workflow. Daedalus uses the tool-calling workflow for chat-completions
streaming, so this adapter registers the same upstream implementation at the
supported per-user workflow boundary. NAT then builds OAuth-backed MCP groups
with the authenticated request context and caches the complete user workflow
for the configured idle window.

The same workflow configuration also supports NAT's OpenAI Responses API
provider mode. The upstream tool-calling graph works with both provider APIs,
but its HTTP adapter only serializes string content chunks. Responses emits
structured content blocks, so the Responses path below preserves the upstream
graph semantics while normalizing those blocks for the existing Chat
Completions-compatible Daedalus front end.
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
from nat.plugins.langchain.agent.tool_calling_agent.register import (
    ToolCallAgentWorkflowConfig,
    tool_calling_agent_workflow,
)
from nat.utils.type_converter import GlobalTypeConverter


class DaedalusPerUserToolCallAgentWorkflowConfig(
    ToolCallAgentWorkflowConfig,
    name="daedalus_per_user_tool_calling_agent",
):
    """Tool-calling agent built and cached independently for each user."""


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


@asynccontextmanager
async def _responses_tool_calling_agent_workflow(
    config: ToolCallAgentWorkflowConfig,
    builder: Builder,
    llm,
):
    """Run NAT's tool-calling graph with Responses-compatible output handling."""
    from langchain_core.messages import AIMessageChunk, trim_messages
    from langchain_core.messages.base import BaseMessage
    from langgraph.errors import GraphRecursionError
    from nat.plugins.langchain.agent.tool_calling_agent.agent import (
        ToolCallAgentGraph,
        ToolCallAgentGraphState,
        create_tool_calling_agent_prompt,
    )

    prompt = create_tool_calling_agent_prompt(config)
    tools = await builder.get_tools(
        tool_names=config.tool_names,
        wrapper_type=LLMFrameworkEnum.LANGCHAIN,
    )
    if not tools:
        raise ValueError(
            f"No tools specified for Tool Calling Agent '{config.llm_name}'"
        )

    return_direct_tools = (
        await builder.get_tools(
            tool_names=config.return_direct,
            wrapper_type=LLMFrameworkEnum.LANGCHAIN,
        )
        if config.return_direct
        else None
    )
    graph = await ToolCallAgentGraph(
        llm=llm,
        tools=tools,
        prompt=prompt,
        detailed_logs=config.verbose,
        log_response_max_chars=config.log_response_max_chars,
        handle_tool_errors=config.handle_tool_errors,
        return_direct=return_direct_tools,
        max_truncation_retries=config.truncation_retry.max_retries,
        truncation_scaling_fn=config.truncation_retry.build_scaling_fn(),
        max_empty_response_retries=config.max_empty_response_retries,
    ).build_graph()

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
    """Use pinned NAT semantics with transport-specific response serialization."""
    upstream_config = ToolCallAgentWorkflowConfig.model_validate(config.model_dump())
    llm = await builder.get_llm(
        upstream_config.llm_name,
        wrapper_type=LLMFrameworkEnum.LANGCHAIN,
    )
    if getattr(llm, "use_responses_api", False):
        async with _responses_tool_calling_agent_workflow(
            upstream_config,
            builder,
            llm,
        ) as function_info:
            yield function_info
        return

    async with tool_calling_agent_workflow(upstream_config, builder) as function_info:
        yield function_info
