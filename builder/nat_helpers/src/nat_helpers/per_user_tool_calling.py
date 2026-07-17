"""Per-user form of NAT's pinned tool-calling agent.

NAT 1.7 ships a per-user MCP function group, but only registers a per-user
ReAct workflow. Daedalus uses the tool-calling workflow for chat-completions
streaming, so this adapter registers the same upstream implementation at the
supported per-user workflow boundary. NAT then builds OAuth-backed MCP groups
with the authenticated request context and caches the complete user workflow
for the configured idle window.
"""

from nat.builder.builder import Builder
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.cli.register_workflow import register_per_user_function
from nat.data_models.api_server import ChatRequest, ChatResponseChunk
from nat.plugins.langchain.agent.tool_calling_agent.register import (
    ToolCallAgentWorkflowConfig,
    tool_calling_agent_workflow,
)


class DaedalusPerUserToolCallAgentWorkflowConfig(
    ToolCallAgentWorkflowConfig,
    name="daedalus_per_user_tool_calling_agent",
):
    """Tool-calling agent built and cached independently for each user."""


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
    """Delegate construction and execution semantics to pinned upstream NAT."""
    upstream_config = ToolCallAgentWorkflowConfig.model_validate(config.model_dump())
    async with tool_calling_agent_workflow(upstream_config, builder) as function_info:
        yield function_info
