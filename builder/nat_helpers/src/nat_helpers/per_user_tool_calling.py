"""Per-user form of NAT's pinned Responses API agent workflow.

NAT 1.8 ships a per-user MCP function group, but only registers a per-user
ReAct workflow. Daedalus registers its Responses agent at the supported
per-user workflow boundary so NAT builds OAuth-backed MCP groups with the
authenticated request context and caches the complete user workflow for the
configured idle window.

The adapter follows NAT's Responses agent configuration contract while adding
per-user construction, full inbound history, and stream serialization for the
existing Chat Completions-compatible front end.
"""

import asyncio
import datetime
import json
import logging
import os
import uuid
from collections.abc import AsyncGenerator
from contextlib import aclosing, asynccontextmanager

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
from nat.data_models.component_ref import FunctionRef
from nat.plugins.langchain.agent.responses_api_agent.register import (
    ResponsesAPIAgentWorkflowConfig,
)
from nat.utils.type_converter import GlobalTypeConverter
from nat_helpers.agent_loop_guard import (
    LoopGuardSettings,
    agent_run_scope,
    current_agent_run,
)
from nat_helpers.daily_summary_runtime import (
    DAILY_SUMMARY_PROFILE,
    DAILY_SUMMARY_SYNTHESIS_INSTRUCTION,
    request_profile,
    should_retry_final_synthesis,
    should_start_final_synthesis,
)
from nat_helpers.history_budget import _select_history_payloads
from pydantic import Field

logger = logging.getLogger(__name__)


class IncompleteAgentRun(RuntimeError):
    """Tool execution ended without completing the request; emitted work is retained."""


def _incomplete_notice(run) -> str:
    reason = {
        "iteration_limit": "the configured iteration limit was reached",
        "repeated_tool_error": "the same tool call failed repeatedly without a change",
        "execution_error": "execution failed before the answer was complete",
        "incomplete_model_response": "the model returned an incomplete response",
    }.get(run.stop_reason, "execution stopped before the answer was complete")
    return f"This request is incomplete: {reason}. Earlier output may be partial or unverified."


def _recovered_tool_results(run):
    """Return exact current-turn evidence for callers without the activity stream.

    The streaming frontend already journals tool events. Single-response API
    callers need the collected results in their response instead. Never use a
    second model call to recover this work, or include prior conversation data.
    """
    import re

    for message in run.last_messages[run.initial_messages :]:
        if getattr(message, "type", None) != "tool":
            continue
        content = message.content
        if not isinstance(content, str):
            content = json.dumps(content, ensure_ascii=False, default=str)
        fence = "`" * max(
            3, 1 + max((len(m[0]) for m in re.finditer(r"`+", content)), default=0)
        )
        yield (
            f"\n\nCollected tool result ({getattr(message, 'name', None) or 'tool'}; "
            f"not a verified final answer):\n\n{fence}text\n{content}\n{fence}"
        )


class DaedalusPerUserResponsesAPIAgentWorkflowConfig(
    ResponsesAPIAgentWorkflowConfig,
    name="daedalus_per_user_responses_api_agent",
):
    """Responses API agent built and cached independently for each user."""

    instructions: str | None = Field(
        default=None,
        description="Top-level Responses API instructions for the agent.",
    )
    loop_guard: LoopGuardSettings = Field(default_factory=LoopGuardSettings)
    max_history: int = Field(
        default=15,
        ge=1,
        description="Maximum number of inbound conversation messages to retain.",
    )
    max_history_tokens: int = Field(
        default=32_000,
        ge=1_024,
        description=(
            "Maximum estimated tokens for inbound history. The newest message is "
            "always retained intact."
        ),
    )
    tool_output_compaction_enabled: bool = Field(
        default=True,
        description=(
            "Replace large structured tool results with reversible, query-aware "
            "previews before each model call."
        ),
    )
    tool_output_compaction_min_chars: int = Field(
        default=8_000,
        ge=1_000,
        description="Minimum structured result size eligible for compaction.",
    )
    tool_output_compaction_max_items: int = Field(
        default=16,
        ge=5,
        le=100,
        description="Maximum array rows retained in a compacted preview.",
    )
    tool_output_compaction_min_savings_chars: int = Field(
        default=1_500,
        ge=256,
        description="Minimum character savings required before compaction.",
    )
    tool_output_compaction_max_ratio: float = Field(
        default=0.70,
        gt=0,
        lt=1,
        description="Largest compacted/original size ratio worth applying.",
    )
    tool_output_compaction_max_original_chars: int = Field(
        default=4_000_000,
        ge=8_000,
        description="Largest exact result accepted into the short-lived cache.",
    )
    tool_output_cache_ttl_seconds: int = Field(
        default=7_200,
        ge=300,
        le=86_400,
        description="Lifetime of an exact cached result used for recovery.",
    )
    daily_summary_nat_tools: list[FunctionRef] = Field(
        default_factory=list,
        description=(
            "Narrow tool catalog exposed during an interactive daily-summary request."
        ),
    )
    daily_summary_final_nat_tools: list[FunctionRef] = Field(
        default_factory=list,
        description=(
            "Tools retained after the daily-summary research budget is exhausted."
        ),
    )
    daily_summary_research_budget_seconds: float = Field(
        default=300.0,
        ge=30.0,
        le=900.0,
        description=(
            "Wall-clock budget for daily-summary research before final synthesis."
        ),
    )
    daily_summary_synthesis_retry_timeout_seconds: float = Field(
        default=75.0,
        ge=15.0,
        le=120.0,
        description=(
            "Timeout for one synthesis-only retry after a daily-summary model "
            "stream ends before completion."
        ),
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


def _terminal_stream_chunk(chunk_id: str, model_name: str) -> ChatResponseChunk:
    """Signal Daedalus completion before tracing/exporter teardown begins.

    NAT owns the eventual OpenAI ``finish_reason`` chunk. Keep that standard
    terminal unique for direct API clients while giving Daedalus' stream worker
    an explicit early-completion extension it can act on.
    """
    return ChatResponseChunk(
        id=chunk_id,
        choices=[
            ChatResponseChunkChoice(
                index=0,
                delta=ChoiceDelta(),
                finish_reason=None,
                daedalus_terminal=True,
            )
        ],
        created=datetime.datetime.now(datetime.UTC),
        model=model_name,
        object="chat.completion.chunk",
    )


def _memory_context_budget_seconds() -> float:
    """Wall-clock budget for pre-turn memory enrichment."""

    raw = (os.getenv("DAEDALUS_MEMORY_CONTEXT_TIMEOUT_SECONDS") or "").strip()
    try:
        budget = float(raw) if raw else 2.5
    except ValueError:
        return 2.5
    return budget if budget > 0 else 2.5


def _bind_responses_llm(
    llm,
    *,
    tools: list[object],
    parallel_tool_calls: bool,
    instructions: str | None,
):
    """Bind Responses tools and instructions using the pinned LangChain API.

    Daedalus exposes tools with optional fields and free-form object values.
    LangChain's strict conversion makes every field required and closes those
    objects, which changes the tools' contracts and is rejected by OpenAI for
    schemas such as ``add_memory``. Responses function tools support the native
    non-strict JSON schemas, so preserve them here.
    """
    bound_llm = llm.bind_tools(
        tools=tools,
        parallel_tool_calls=parallel_tool_calls,
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
    from langchain_core.messages import (
        AIMessageChunk,
        HumanMessage,
        SystemMessage,
        convert_to_messages,
    )
    from langchain_core.messages.base import BaseMessage
    from langchain_core.runnables import RunnableBranch, RunnableLambda
    from langgraph.errors import GraphRecursionError
    from nat.plugins.langchain.agent.tool_calling_agent.agent import (
        AgentDecision,
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

    daily_summary_tools = []
    if config.daily_summary_nat_tools:
        daily_summary_tools = await builder.get_tools(
            tool_names=config.daily_summary_nat_tools,
            wrapper_type=LLMFrameworkEnum.LANGCHAIN,
        )
    daily_summary_final_tools = []
    if config.daily_summary_final_nat_tools:
        daily_summary_final_tools = await builder.get_tools(
            tool_names=config.daily_summary_final_nat_tools,
            wrapper_type=LLMFrameworkEnum.LANGCHAIN,
        )

    agent = ToolCallAgentGraph(
        llm=llm,
        tools=nat_tools,
        # The shipped config disables full-transcript logging. Bounded outcome
        # events below retain progress evidence without repeating the history.
        detailed_logs=config.verbose,
        handle_tool_errors=config.handle_tool_errors,
    )
    from nat_helpers.tool_output_compaction import (
        CompactionSettings,
        OptimizationCache,
        ToolOutputStore,
        optimize_tool_messages,
    )

    tool_output_settings = CompactionSettings(
        enabled=config.tool_output_compaction_enabled,
        min_chars=config.tool_output_compaction_min_chars,
        max_items=config.tool_output_compaction_max_items,
        min_savings_chars=config.tool_output_compaction_min_savings_chars,
        max_compacted_ratio=config.tool_output_compaction_max_ratio,
        max_original_chars=config.tool_output_compaction_max_original_chars,
        cache_ttl_seconds=config.tool_output_cache_ttl_seconds,
    )
    # Scoped to this per-user workflow, which NAT reclaims on idle.
    tool_output_cache = OptimizationCache()
    tool_output_store = ToolOutputStore(
        ttl_seconds=config.tool_output_cache_ttl_seconds,
    )

    async def _model_messages(state):
        messages = state.get("messages", [])
        run = current_agent_run()
        if run is not None:
            run.model_calls += 1
            run.last_messages = messages
            if should_start_final_synthesis(
                run,
                budget_seconds=config.daily_summary_research_budget_seconds,
            ):
                run.final_synthesis_requested = True
                logger.info(
                    "Daily-summary research budget ended; restricting the model to final synthesis"
                )

        model_messages = messages
        if tool_output_settings.enabled:
            user_id = None
            try:
                from nat_helpers.identity import authenticated_user_id_from_context

                user_id = authenticated_user_id_from_context()
            except Exception:
                # Exact recovery is user-scoped. Without trusted identity, keep the
                # original result instead of creating an inaccessible preview.
                user_id = None
            if user_id is not None:
                model_messages = await optimize_tool_messages(
                    messages,
                    user_id=user_id,
                    store=tool_output_store,
                    settings=tool_output_settings,
                    cache=tool_output_cache,
                )
        if run is not None and run.final_synthesis_requested:
            model_messages = [
                *model_messages,
                SystemMessage(content=DAILY_SUMMARY_SYNTHESIS_INSTRUCTION),
            ]
        return model_messages

    # Binding the instructions after the tools retains both sets of invocation
    # kwargs and makes LangChain serialize them as the top-level Responses
    # field. The helper preserves native optional tool arguments rather than
    # forcing NAT's strict-schema conversion across heterogeneous tools.
    bound_llm = _bind_responses_llm(
        llm,
        tools=bound_tools,
        parallel_tool_calls=config.parallel_tool_calls,
        instructions=config.instructions,
    )
    daily_summary_bound_llm = None
    if daily_summary_tools:
        daily_summary_bound_llm = _bind_responses_llm(
            llm,
            tools=daily_summary_tools,
            parallel_tool_calls=config.parallel_tool_calls,
            instructions=config.instructions,
        )
    daily_summary_final_bound_llm = None
    if daily_summary_final_tools:
        daily_summary_final_bound_llm = _bind_responses_llm(
            llm,
            tools=daily_summary_final_tools,
            parallel_tool_calls=config.parallel_tool_calls,
            instructions=config.instructions,
        )
    agent.bound_llm = bound_llm
    model_branch = bound_llm
    if daily_summary_bound_llm is not None:
        branches = []
        if daily_summary_final_bound_llm is not None:
            branches.append(
                (
                    lambda _: bool(
                        (run := current_agent_run()) and run.final_synthesis_requested
                    ),
                    daily_summary_final_bound_llm,
                )
            )
        branches.append(
            (
                lambda _: bool(
                    (run := current_agent_run())
                    and run.request_profile == DAILY_SUMMARY_PROFILE
                ),
                daily_summary_bound_llm,
            )
        )
        model_branch = RunnableBranch(*branches, bound_llm)
    agent.agent = (
        RunnableLambda(
            _model_messages,
            name="ResponsesInput",
        )
        | model_branch
    )

    # A denied mutation is a deterministic terminal state, not content for a
    # second model turn. Force NAT to build the tool conditional edge, then
    # route only a strictly validated approval marker to graph END. The direct
    # approval API owns the eventual execution after the user clicks a button.
    original_tool_conditional_edge = agent.tool_conditional_edge

    async def _approval_terminal_edge(state):
        from nat_helpers.front_end import _decode_valid_mcp_approval_marker

        run = current_agent_run()
        if run is not None:
            run.observe(state.messages)
        for message in reversed(state.messages):
            if getattr(message, "type", None) != "tool":
                break
            marker = _decode_valid_mcp_approval_marker(message.content)
            if marker:
                logger.info("Ending agent graph at MCP approval boundary")
                if run is not None:
                    run.terminal_content = marker
                return AgentDecision.END
        if run is not None:
            if run.terminal_content is not None or run.stop_reason:
                return AgentDecision.END
        return await original_tool_conditional_edge(state)

    original_validate_response = agent._validate_llm_response

    async def _validate_response(response, state):
        # Responses reports token-limit exhaustion as status=incomplete, not
        # Chat Completions' finish_reason=length. Check at the graph boundary
        # before partial tool calls can execute. The text has already streamed.
        metadata = response.response_metadata
        status = metadata.get("status")
        # LangChain 1.3 also ignores response.failed events. In that case only
        # response.created's id remains. A created response without a completed
        # status is not a completed answer, even if some text arrived.
        if status not in {None, "completed"} or (metadata.get("id") and status is None):
            current_agent_run().stop_reason = "incomplete_model_response"
            raise IncompleteAgentRun("The model response did not complete.")
        return await original_validate_response(response, state)

    agent._validate_llm_response = _validate_response
    agent.return_direct = ["__daedalus_mcp_approval_terminal__"]
    agent.tool_conditional_edge = _approval_terminal_edge
    graph = await agent.build_graph()

    async def _initial_state(
        chat_request_or_message: ChatRequestOrMessage,
    ) -> ToolCallAgentGraphState:
        message = GlobalTypeConverter.get().convert(
            chat_request_or_message,
            to_type=ChatRequest,
        )
        raw_messages = [item.model_dump() for item in message.messages]
        selected_messages = _select_history_payloads(
            raw_messages,
            max_messages=config.max_history,
            max_tokens=config.max_history_tokens,
        )
        if len(selected_messages) < len(raw_messages):
            logger.info(
                "Trimmed inbound history from %d to %d messages before model input",
                len(raw_messages),
                len(selected_messages),
            )
        messages: list[BaseMessage] = convert_to_messages(selected_messages)
        latest_user_text = ""
        latest_user_index: int | None = None
        for index in range(len(messages) - 1, -1, -1):
            if getattr(messages[index], "type", "") == "human":
                latest_user_text = _content_text(messages[index].content)
                latest_user_index = index
                break
        run = current_agent_run()
        if run is not None:
            run.request_profile = request_profile(latest_user_text)
        try:
            from nat_helpers.hindsight_client import client_from_env, memory_mode
            from nat_helpers.hindsight_memory_context import (
                build_automatic_memory_context,
            )
            from nat_helpers.identity import (
                authenticated_user_id_from_context,
                conversation_id_from_context_or_none,
                execution_scope_from_context_or_none,
            )

            mode = memory_mode()
            if mode == "hindsight" and (
                execution_scope_from_context_or_none() != "autonomy"
            ):
                if latest_user_text.strip() and latest_user_index is not None:
                    user_id = authenticated_user_id_from_context()
                    # This runs before the first token. The chain behind it can
                    # issue several serial Hindsight calls, each with its own
                    # per-request timeout, so an unbounded await here lets a
                    # degraded memory service add minutes of dead air to a turn
                    # that does not need memory to answer. Recall is
                    # best-effort by design; ship the turn without it rather
                    # than hold the user.
                    memory_context = await asyncio.wait_for(
                        build_automatic_memory_context(
                            client_from_env(),
                            user_id=user_id,
                            conversation_id=conversation_id_from_context_or_none(),
                            query=latest_user_text,
                        ),
                        timeout=_memory_context_budget_seconds(),
                    )
                    if memory_context:
                        messages.insert(
                            latest_user_index,
                            HumanMessage(content=memory_context),
                        )
        except TimeoutError:
            logger.warning(
                "Automatic Hindsight recall exceeded its budget; continuing without it"
            )
        except Exception:
            # Memory enrichment must not turn a healthy chat path into an outage.
            logger.warning("Automatic Hindsight recall unavailable", exc_info=True)

        run = current_agent_run()
        if run is not None:
            # Historical failures and skill loads do not consume this turn's
            # budget. Every invocation gets an independent context object.
            additional_props = getattr(message, "additional_props", None)
            run.activity_stream_requested = isinstance(additional_props, dict) and (
                additional_props.get("enableIntermediateSteps") is True
            )
            run.initial_messages = len(messages)
            run.processed = len(messages)
            run.last_messages = messages
        return ToolCallAgentGraphState(messages=messages)

    def _record_outcome(run, outcome):
        outcome = run.terminal_reason or run.stop_reason or outcome
        log = (
            logger.warning
            if outcome not in {"completed", "validated_artifact"}
            else logger.info
        )
        log(
            "Agent run ended: run_id=%s outcome=%s model_calls=%d tool_calls=%d",
            run.run_id,
            outcome,
            run.model_calls,
            run.tool_calls,
        )
        # NAT's Phoenix exporter consumes the toolkit event stream, not the
        # process-global OpenTelemetry tracer. Record the semantic outcome in
        # that stream even when the outer function succeeds by returning text.
        try:
            from nat.builder.context import Context
            from nat.data_models.intermediate_step import (
                IntermediateStepPayload,
                IntermediateStepType,
                StreamEventData,
            )

            context = Context.get()
            metadata = {
                "run_id": run.run_id,
                "workflow_run_id": str(context.workflow_run_id),
                "outcome": outcome,
                "failed": outcome not in {"completed", "validated_artifact"},
                "model_calls": run.model_calls,
                "tool_calls": run.tool_calls,
            }
            start = IntermediateStepPayload(
                event_type=IntermediateStepType.CUSTOM_START,
                name="daedalus.agent.outcome",
                metadata=metadata,
            )
            manager = context.intermediate_step_manager
            manager.push_intermediate_step(start)
            manager.push_intermediate_step(
                IntermediateStepPayload(
                    event_type=IntermediateStepType.CUSTOM_END,
                    UUID=start.UUID,
                    name=start.name,
                    metadata=metadata,
                    data=StreamEventData(output=metadata),
                )
            )
        except Exception:
            logger.debug("Agent outcome span unavailable", exc_info=True)

    async def _stream_graph_from_state(
        initial_state: ToolCallAgentGraphState,
    ) -> AsyncGenerator[ChatResponseChunk]:
        chunk_id = str(uuid.uuid4())
        try:
            async for msg, metadata in graph.astream(
                initial_state,
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
            current_agent_run().stop_reason = "iteration_limit"

    async def _stream_graph(
        chat_request_or_message: ChatRequestOrMessage,
    ) -> AsyncGenerator[ChatResponseChunk]:
        async for chunk in _stream_graph_from_state(
            await _initial_state(chat_request_or_message)
        ):
            yield chunk

    async def _run(
        chat_request_or_message: ChatRequestOrMessage,
        *,
        include_recovery_evidence: bool = False,
    ) -> AsyncGenerator[ChatResponseChunk]:
        with agent_run_scope(config.loop_guard) as run:
            outcome = "cancelled_or_error"
            chunk_id = str(uuid.uuid4())
            buffered_text: list[str] = []
            try:
                try:
                    async with aclosing(
                        _stream_graph(chat_request_or_message)
                    ) as stream:
                        async for chunk in stream:
                            chunk_id = chunk.id
                            if include_recovery_evidence:
                                buffered_text.extend(
                                    choice.delta.content or ""
                                    for choice in chunk.choices
                                )
                            else:
                                yield chunk
                except Exception as exc:
                    # Cancellation is a BaseException and must propagate. OAuth
                    # failures before work starts also retain their normal path.
                    if not run.tool_calls and not run.model_calls:
                        raise
                    if should_retry_final_synthesis(run, exc):
                        run.synthesis_retry_attempted = True
                        run.final_synthesis_requested = True
                        run.stop_reason = None
                        logger.warning(
                            "Daily-summary model stream failed; starting one bounded "
                            "synthesis-only retry: error_class=%s",
                            type(exc).__name__,
                        )
                        try:
                            retry_state = ToolCallAgentGraphState(
                                messages=list(run.last_messages)
                            )
                            async with asyncio.timeout(
                                config.daily_summary_synthesis_retry_timeout_seconds
                            ):
                                async for chunk in _stream_graph_from_state(
                                    retry_state
                                ):
                                    chunk_id = chunk.id
                                    if include_recovery_evidence:
                                        buffered_text.extend(
                                            choice.delta.content or ""
                                            for choice in chunk.choices
                                        )
                                    else:
                                        yield chunk
                        except Exception as retry_exc:
                            run.stop_reason = run.stop_reason or "execution_error"
                            logger.warning(
                                "Daily-summary synthesis retry failed: error_class=%s",
                                type(retry_exc).__name__,
                            )
                    else:
                        run.stop_reason = run.stop_reason or "execution_error"
                        logger.warning(
                            "Agent execution failed: error_class=%s",
                            type(exc).__name__,
                        )
                if run.terminal_content is not None:
                    yield ChatResponseChunk.create_streaming_chunk(
                        run.terminal_content,
                        id_=chunk_id,
                    )
                elif run.stop_reason:
                    # Already emitted assistant text is never replaced. The
                    # frontend persists its tool/activity stream and marks this
                    # request failed when IncompleteAgentRun reaches the SSE API.
                    notice = _incomplete_notice(run)
                    if include_recovery_evidence:
                        yield ChatResponseChunk.create_streaming_chunk(
                            "".join(buffered_text), id_=chunk_id
                        )
                    yield ChatResponseChunk.create_streaming_chunk(
                        "\n\n" + notice, id_=chunk_id
                    )
                    if include_recovery_evidence or not run.activity_stream_requested:
                        for evidence in _recovered_tool_results(run):
                            yield ChatResponseChunk.create_streaming_chunk(
                                evidence, id_=chunk_id
                            )
                    raise IncompleteAgentRun(notice)
                elif include_recovery_evidence:
                    # Successful single-response calls return only the final
                    # answer, just as before; commentary is retained on errors.
                    content = run.last_messages[-1].content
                    yield ChatResponseChunk.create_streaming_chunk(
                        _content_text(content) or str(content), id_=chunk_id
                    )
                outcome = "completed"
                yield _terminal_stream_chunk(
                    chunk_id, getattr(llm, "model_name", "unknown-model")
                )
            finally:
                _record_outcome(run, outcome)

    async def _stream_fn(
        chat_request_or_message: ChatRequestOrMessage,
    ) -> AsyncGenerator[ChatResponseChunk]:
        async with aclosing(_run(chat_request_or_message)) as stream:
            async for chunk in stream:
                yield chunk

    async def _response_fn(chat_request_or_message: ChatRequestOrMessage) -> str:
        # Use exactly the streaming execution path, including partial model
        # output that NAT would otherwise discard on response validation errors.
        parts = []
        try:
            async with aclosing(
                _run(chat_request_or_message, include_recovery_evidence=True)
            ) as stream:
                async for chunk in stream:
                    parts.extend(choice.delta.content or "" for choice in chunk.choices)
        except IncompleteAgentRun:
            # Single-response callers cannot receive text after an HTTP error.
            # Return an explicitly incomplete transcript with the actual evidence.
            pass
        return "".join(parts)

    try:
        yield FunctionInfo.create(
            single_fn=_response_fn,
            stream_fn=_stream_fn,
            description=config.description,
        )
    finally:
        await tool_output_store.close()


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
