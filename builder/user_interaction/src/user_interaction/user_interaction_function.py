"""Single-use authorization for authenticated memory deletion.

Ordinary questions and research plans belong in chat. MCP approvals belong to
its execution gate. This tool owns only the memory-deletion workflow.
"""

import logging
from typing import Literal

from daedalus_runtime.tools import ToolConfig, ToolDefinition, register_tool
from nat_helpers.identity import authenticated_user_id_from_context
from pydantic import BaseModel, ConfigDict, Field
from user_interaction.approval_tokens import make_redis_client, validate_approval_token

logger = logging.getLogger(__name__)
UserInteractionOperation = Literal["confirm_action", "delete_memory_guarded"]


class UserInteractionConfig(ToolConfig, name="user_interaction"):
    redis_url: str | None = None
    enabled_operations: list[UserInteractionOperation] | None = None
    description: str = (
        "Delete the authenticated caller's durable memory after approval. "
        "confirm_action requires action and reason and returns a pending request, "
        "not a credential. delete_memory_guarded requires a single-use "
        "approval_token from the authenticated approval route. No identity or "
        "target arguments are accepted. MCP approvals use the execution gate. "
        "Ask clarification questions and present research plans directly in chat."
    )


class UserInteractionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: UserInteractionOperation
    action: str = Field(default="", description="Description of the memory deletion.")
    reason: str = Field(default="", description="Why the user requested deletion.")
    risks: str = Field(default="", description="Additional consequences to disclose.")
    alternatives: str = Field(default="", description="Alternatives, separated by |.")
    approval_token: str = Field(
        default="", description="Single-use memory deletion credential; never invent."
    )


@register_tool(config_type=UserInteractionConfig)
async def user_interaction_function(config, _builder):
    enabled = set(
        ("confirm_action", "delete_memory_guarded")
        if config.enabled_operations is None
        else config.enabled_operations
    )
    redis_client = None

    async def user_interaction(
        operation: UserInteractionOperation,
        action: str = "",
        reason: str = "",
        risks: str = "",
        alternatives: str = "",
        approval_token: str = "",
    ) -> str:
        if operation not in enabled:
            return "Error: requested memory-deletion operation is disabled."
        try:
            user = authenticated_user_id_from_context()
        except ValueError:
            return "Error: authenticated user is required."
        if not user:
            return "Error: authenticated user is required."
        if operation == "confirm_action":
            if not action.strip() or not reason.strip():
                return "Error: memory deletion requires an action and reason."
            parts = [
                "**Action requiring confirmation:**\n\nDelete all of your durable memory.",
                f"\n**Requested action:** {action}",
                f"\n**Reason:** {reason}",
                "\n**Warning:** This action is difficult to reverse.",
            ]
            if risks:
                parts.append(f"\n**Risks:** {risks}")
            if alternatives:
                parts.append(f"\n**Alternatives considered:** {alternatives}")
            parts.extend(
                [
                    "\nProceed? (yes/no)\nReply with `approve` or `deny`.",
                    "\nNo executable credential has been created. The authenticated "
                    "approval route will mint one only after the user approves.",
                    f"\nApproval scope: action_type=`delete_memory`, target=`{user}`.",
                ]
            )
            return "\n".join(parts)
        if not approval_token.strip():
            return "Error: delete_memory denied: approval token required."
        nonlocal redis_client
        if redis_client is None:
            redis_client = make_redis_client(config.redis_url)
        ok, reason = validate_approval_token(
            redis_client,
            user_id=user,
            token=approval_token,
            action_type="delete_memory",
            target=user,
            consume=True,
        )
        if not ok:
            return f"Error: delete_memory denied: {reason}."
        from nat_helpers.hindsight_client import client_from_env, memory_mode
        from nat_helpers.memory_lifecycle import clear_user_memory

        if memory_mode() == "disabled":
            return "Error: durable memory is disabled by the operator; nothing was deleted."
        try:
            await clear_user_memory(client_from_env(), user)
        except Exception:
            logger.exception("Hindsight memory clear failed")
            return "Error: Hindsight memory could not be cleared."
        return "Durable memory cleared."

    try:
        yield ToolDefinition.from_fn(
            user_interaction,
            input_schema=UserInteractionInput,
            description=config.description,
        )
    finally:
        if redis_client is not None:
            redis_client.close()
