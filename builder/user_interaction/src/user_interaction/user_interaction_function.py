"""Unified structured user-interaction tool for NeMo Agent Toolkit.

The registered function exposes one explicit ``operation`` dispatcher for
clarification, exact action approval, research-plan approval, option
presentation, and guarded memory deletion. A toolkit function builder must
yield exactly one runtime function, so these related behaviors share one typed
schema rather than attempting to yield multiple ``FunctionInfo`` objects.

Inspired by Claude Code's AskUserQuestion tool and the principle that
structured interaction dramatically improves user satisfaction and
reduces wasted effort on misunderstood requests.
"""

import json
import logging
from typing import Any, Literal

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import BaseModel, ConfigDict, Field
from user_interaction.approval_tokens import make_redis_client, validate_approval_token

logger = logging.getLogger(__name__)

UserInteractionOperation = Literal[
    "clarify",
    "confirm_action",
    "confirm_research_plan",
    "present_options",
    "delete_memory_guarded",
]

_ALL_OPERATIONS: tuple[UserInteractionOperation, ...] = (
    "clarify",
    "confirm_action",
    "confirm_research_plan",
    "present_options",
    "delete_memory_guarded",
)

_APPROVAL_ONLY_OPTIONS = {
    "approve",
    "approved",
    "confirm",
    "confirmed",
    "go ahead",
    "no",
    "please approve",
    "please go ahead",
    "please proceed",
    "proceed",
    "yes",
    "yes please",
    "yes, please",
    "yes proceed",
    "yes, proceed",
}


def _is_action_confirmation_clarification(
    question: str,
    options: str,
    context: str,
    why_asking: str,
) -> bool:
    """Reject attempts to use clarification as a second approval mechanism."""

    normalized_options = [
        option.strip().casefold().rstrip(".!")
        for option in options.split("|")
        if option.strip()
    ]
    if normalized_options and all(
        option in _APPROVAL_ONLY_OPTIONS for option in normalized_options
    ):
        return True

    combined = " ".join((question, context, why_asking)).casefold()
    return any(
        phrase in combined
        for phrase in (
            "already approved",
            "already confirmed",
            "ask for approval",
            "ask for confirmation",
            "confirm the action",
            "confirm the update",
            "confirm whether to proceed",
            "reconfirm",
            "shall i proceed",
            "should i proceed",
        )
    )


class UserInteractionConfig(FunctionBaseConfig, name="user_interaction"):
    """Configuration for the user_interaction function."""

    max_options: int = Field(
        default=6,
        ge=2,
        le=10,
        description="Maximum number of options to present in clarification or choice questions.",
    )
    redis_url: str | None = Field(
        default=None,
        description="Redis URL used for approval-token storage.",
    )
    enabled_operations: list[UserInteractionOperation] | None = Field(
        default=None,
        description=(
            "Optional allow-list of operations to register. Supported values: "
            "clarify, confirm_action, confirm_research_plan, present_options, "
            "delete_memory_guarded. When omitted, all operations are registered."
        ),
    )
    description: str = Field(
        default=(
            "Structured user interaction. Set operation explicitly. Use "
            "confirm_action for memory deletion only. MCP mutation approvals "
            "are owned by the execution gate; never serialize MCP arguments "
            "through this tool."
        ),
        description="LLM-facing description for the unified dispatcher.",
    )


class UserInteractionInput(BaseModel):
    """Explicit LLM-facing schema for the unified interaction dispatcher."""

    model_config = ConfigDict(extra="forbid")

    operation: UserInteractionOperation = Field(
        description=(
            "Required operation. Use confirm_action for memory deletion only. "
            "Never use clarify for approval."
        )
    )
    question: str = Field(default="", description="Question for clarify only.")
    options: str = Field(
        default="", description="Pipe-separated choices for clarify only."
    )
    context: str = Field(default="", description="Context for clarify only.")
    why_asking: str = Field(
        default="", description="Reason the clarification is needed."
    )
    action: str = Field(
        default="",
        description=(
            "Nonempty exact action presented by confirm_action. Required for "
            "approval requests; an MCP mutation safely derives it from the exact "
            "server, tool, and target only when omitted."
        ),
    )
    reason: str = Field(
        default="",
        description=(
            "Nonempty reason for confirm_action or plan approval. Required for "
            "approval requests; an MCP mutation uses a fixed gate reason only "
            "when omitted."
        ),
    )
    risks: str = Field(default="", description="Material action or plan risks.")
    alternatives: str = Field(
        default="", description="Pipe-separated action alternatives."
    )
    reversible: bool = Field(
        default=True, description="Whether the confirmed action is reversible."
    )
    user_id: str = Field(
        default="",
        description=("Legacy non-HTTP fallback only. Omit for authenticated requests."),
    )
    action_type: str = Field(
        default="unspecified",
        description="Use mcp_mutation for an approval-gated MCP call.",
    )
    target: str = Field(
        default="", description="Exact non-wildcard approval or plan target."
    )
    server_name: str = Field(
        default="", description="Exact MCP function-group name for confirm_action."
    )
    tool_name: str = Field(
        default="", description="Exact remote MCP tool name for confirm_action."
    )
    arguments_json: str = Field(
        default="",
        description="Exact MCP arguments JSON object for confirm_action.",
    )
    title: str = Field(default="", description="Plan title for confirm_research_plan.")
    sections_json: str = Field(
        default="[]", description="Plan sections JSON for confirm_research_plan."
    )
    source_strategy_json: str = Field(
        default="", description="Optional source strategy JSON for plan approval."
    )
    estimated_tool_calls: int = Field(
        default=0,
        ge=0,
        description="Estimated calls for confirm_research_plan.",
    )
    decision: str = Field(
        default="", description="Decision to present with present_options."
    )
    options_json: str = Field(
        default="[]", description="Option objects JSON for present_options."
    )
    recommendation: str = Field(
        default="", description="Optional recommendation for present_options."
    )
    approval_token: str = Field(
        default="",
        description="Single-use credential for delete_memory_guarded only.",
    )


def _authenticated_user_or_fallback(fallback_user_id: str = "") -> str:
    from nat_helpers.identity import authenticated_user_id_from_context_or_fallback

    return authenticated_user_id_from_context_or_fallback(fallback_user_id)


@register_function(config_type=UserInteractionConfig)
async def user_interaction_function(config: UserInteractionConfig, builder: Builder):
    _redis_client: Any | None = None
    enabled = set(config.enabled_operations or _ALL_OPERATIONS)

    def _get_redis():
        nonlocal _redis_client
        if _redis_client is None:
            _redis_client = make_redis_client(config.redis_url)
        return _redis_client

    # ------------------------------------------------------------------
    # Tool 1 -- clarify
    # ------------------------------------------------------------------
    async def clarify(
        question: str,
        options: str = "",
        context: str = "",
        why_asking: str = "",
    ) -> str:
        """Ask the user a structured clarification question.

        Use this BEFORE committing to a course of action when the user's
        request is ambiguous or could be interpreted in multiple ways.
        It is much better to clarify than to guess wrong and waste effort.

        Never use this tool to request or reconfirm approval, permission, or
        whether to proceed. If the user has already said yes, approve, or
        proceed, do not ask again. Use confirm_action only when a protected
        action requires an exact pending approval.

        This tool formats your question clearly for the user and returns
        the formatted output. The user will respond in their next message.

        Args:
            question: The specific question to ask. Be direct and concrete.
                Bad: "What would you like?" Good: "Should I search for
                recent news or query the knowledge base for background?"
            options: Suggested answers, separated by " | ". Each option
                should be brief (under 10 words). The user can always
                give a different answer. Example: "Recent news | Knowledge
                base background | Both"
            context: Brief explanation of what you understand so far about
                the user's request. Helps the user see what you're working
                with and correct any misunderstanding.
            why_asking: Why this clarification matters for the quality of
                your response. Example: "This determines whether I use
                real-time search or the curated knowledge base."

        Returns:
            Formatted clarification question to present to the user.
        """
        if _is_action_confirmation_clarification(
            question,
            options,
            context,
            why_asking,
        ):
            return (
                "Invalid clarification request: clarify cannot request or "
                "reconfirm action approval. Do not ask the user again. MCP "
                "mutation approvals are created automatically by the execution "
                "gate; stop after its approval marker without another tool call."
            )

        parts = [f"**Clarification needed:** {question}"]

        if context:
            parts.append(f"\nWhat I understand so far: {context}")

        if why_asking:
            parts.append(f"\nWhy I'm asking: {why_asking}")

        if options:
            option_list = [o.strip() for o in options.split("|") if o.strip()]
            if option_list:
                options_formatted = "\n".join(
                    f"  {i + 1}. {opt}"
                    for i, opt in enumerate(option_list[: config.max_options])
                )
                parts.append(f"\nSuggested options:\n{options_formatted}")
                parts.append("\n(You can also provide a different answer.)")

        return "\n".join(parts)

    # ------------------------------------------------------------------
    # Tool 2 -- confirm_action
    # ------------------------------------------------------------------
    async def confirm_action(
        action: str,
        reason: str,
        risks: str = "",
        alternatives: str = "",
        reversible: bool = True,
        user_id: str = "",
        action_type: str = "unspecified",
        target: str = "",
        server_name: str = "",
        tool_name: str = "",
        arguments_json: str = "",
    ) -> str:
        """Request user confirmation before taking a consequential action.

        Use this before any action that:
        - Modifies external state and is explicitly approval-gated
        - Is difficult or impossible to reverse
        - Has significant resource costs
        - Could have unintended side effects
        - Deletes memory

        This tool formats the confirmation request. The user will approve
        or deny in their next message.

        Args:
            action: Clear description of what you plan to do. Be specific.
                Example: "Scale the inference deployment from 2 to 5 replicas
                in the production namespace."
            reason: Why you believe this action is appropriate given the
                user's request.
            risks: Potential downsides or side effects. Be honest about
                what could go wrong. Leave empty if risks are negligible.
            alternatives: Other approaches you considered. Helps the user
                understand the decision space. Separate with " | ".
            reversible: Whether this action can be easily undone.
            user_id: Legacy fallback user id. Authenticated HTTP requests
                derive the user from trusted request headers.
            action_type: Consequential action category, e.g. "delete_memory".
            target: Exact action target the approval applies to. Wildcards are
                not permitted for executable approvals.
            server_name: Exact configured MCP function-group name for
                action_type='mcp_mutation' (for example, k8s_mcp_server).
            tool_name: Exact MCP tool name for action_type='mcp_mutation'.
            arguments_json: Exact JSON object that will be sent to the MCP tool,
                excluding approval_token. Required for MCP mutations.

        Returns:
            Formatted confirmation request to present to the user.
        """
        normalized_action_type = action_type.strip().lower()
        normalized_action = action.strip().lower()
        looks_like_memory_write = "memory" in normalized_action and any(
            verb in normalized_action
            for verb in ("add", "store", "remember", "save", "persist")
        )
        if (
            normalized_action_type
            in {
                "memory_update",
                "add_memory",
            }
            or looks_like_memory_write
        ):
            return (
                "No confirmation is required for an explicit user-requested "
                "memory write. Call add_memory directly now, without a user_id "
                "argument. Use confirm_action only for explicitly approval-gated "
                "external mutations or memory deletes."
            )

        resolved_user_id = _authenticated_user_or_fallback(user_id)
        resolved_target = (target or "").strip()
        resolved_action = action.strip()
        resolved_reason = reason.strip()
        if normalized_action_type == "delete_memory":
            if resolved_target and resolved_target != resolved_user_id:
                return "Error: delete_memory target must match the authenticated user."
            resolved_target = resolved_user_id
        if normalized_action_type == "mcp_mutation":
            return (
                "Error: MCP mutation approvals are created automatically by the "
                "execution gate. Do not serialize mutation arguments through "
                "user_interaction_tool and do not retry the blocked tool in this turn."
            )

        parts = [f"**Action requiring confirmation:**\n\n{resolved_action}"]

        parts.append(f"\n**Reason:** {resolved_reason}")

        if risks:
            parts.append(f"\n**Risks:** {risks}")

        if not reversible:
            parts.append("\n**Warning:** This action is difficult to reverse.")

        if alternatives:
            alt_list = [a.strip() for a in alternatives.split("|") if a.strip()]
            if alt_list:
                alts_formatted = ", ".join(alt_list)
                parts.append(f"\n**Alternatives considered:** {alts_formatted}")

        parts.append(
            "\nProceed? (yes/no)\nReply with `approve` or `deny`. "
            "Natural confirmations such as `Please proceed` or "
            "`Yes, confirm the doc update` are also accepted."
        )
        if resolved_user_id and normalized_action_type != "unspecified":
            parts.append(
                "\nNo executable credential has been created. The authenticated "
                "approval route will mint one only after the user approves."
            )
            parts.append(
                f"\nApproval scope: action_type=`{normalized_action_type}`, "
                f"target=`{resolved_target}`"
            )
            parts[-1] += "."

        return "\n".join(parts)

    # ------------------------------------------------------------------
    # Tool 3 -- confirm_research_plan
    # ------------------------------------------------------------------
    async def confirm_research_plan(
        title: str,
        sections_json: str,
        source_strategy_json: str = "",
        estimated_tool_calls: int = 0,
        risks: str = "",
        user_id: str = "",
        target: str = "",
    ) -> str:
        """Request approval for an expensive deep-research plan.

        Use this after planning and before broad/deep research starts. The
        output is intended to pause the run and let the user approve, reject,
        or revise the plan in their next message.

        Args:
            title: Short title for the research plan.
            sections_json: JSON list of report sections, or object with a
                sections field.
            source_strategy_json: Optional JSON from plan_sources.
            estimated_tool_calls: Estimated retrieval/search calls.
            risks: Material risks, gaps, or cost concerns.
            user_id: Legacy fallback user id. Authenticated HTTP requests
                derive the user from trusted request headers.
            target: Optional plan target. Defaults to title.
        """
        resolved_title = (title or "Deep research plan").strip()
        try:
            parsed_sections = json.loads(sections_json or "[]")
            if isinstance(parsed_sections, dict):
                parsed_sections = parsed_sections.get("sections", [])
            if not isinstance(parsed_sections, list):
                parsed_sections = [str(parsed_sections)]
        except (json.JSONDecodeError, TypeError):
            parsed_sections = [
                item.strip()
                for item in (sections_json or "").split("|")
                if item.strip()
            ]

        sections = [str(item).strip() for item in parsed_sections if str(item).strip()]

        strategy_lines: list[str] = []
        if source_strategy_json:
            try:
                strategy = json.loads(source_strategy_json)
                recommended = strategy.get("recommended_tool_sequence", [])
                for item in recommended[: config.max_options]:
                    name = item.get("name") or item.get("source_id") or "Source"
                    tools = ", ".join(item.get("tools") or [])
                    reason = item.get("reason", "")
                    line = f"- {name}"
                    if tools:
                        line += f" ({tools})"
                    if reason:
                        line += f": {reason}"
                    strategy_lines.append(line)
                for warning in strategy.get("warnings", [])[: config.max_options]:
                    strategy_lines.append(f"- Warning: {warning}")
            except (json.JSONDecodeError, TypeError, AttributeError):
                strategy_lines.append(source_strategy_json.strip())

        parts = [f"**Deep research plan approval:** {resolved_title}"]

        if sections:
            parts.append("\n**Planned report sections:**")
            parts.extend(f"{idx}. {section}" for idx, section in enumerate(sections, 1))

        if strategy_lines:
            parts.append("\n**Source strategy:**")
            parts.extend(strategy_lines)

        if estimated_tool_calls > 0:
            parts.append(f"\n**Estimated tool calls:** {estimated_tool_calls}")

        if risks:
            parts.append(f"\n**Risks or trade-offs:** {risks}")
        elif estimated_tool_calls >= 6:
            parts.append(
                "\n**Risks or trade-offs:** This may take longer and consume more "
                "tool/LLM budget than a quick research answer."
            )

        resolved_user_id = _authenticated_user_or_fallback(user_id)

        parts.append(
            "\nReply yes to approve this plan, or describe changes to revise scope, "
            "sections, sources, or depth."
        )
        if resolved_user_id:
            parts.append(
                "\nNo approval credential has been created. "
                "The authenticated approval route records the decision."
            )
            parts.append(
                f"\nApproval scope: action_type=`deep_research_plan`, "
                f"target=`{target or resolved_title}`."
            )

        return "\n".join(parts)

    # ------------------------------------------------------------------
    # Tool 4 -- present_options
    # ------------------------------------------------------------------
    async def present_options(
        decision: str,
        options_json: str,
        recommendation: str = "",
    ) -> str:
        """Present structured options for the user to choose from.

        Use this when you have identified multiple valid approaches and
        the best choice depends on user preferences or priorities that
        you cannot determine from context alone.

        Args:
            decision: What decision needs to be made. Example: "How to
                structure the daily briefing report."
            options_json: JSON array of option objects. Each object should
                have: "label" (short name), "description" (what it does),
                and "tradeoffs" (pros/cons or considerations).
                Example: [{"label": "Detailed", "description": "Full
                analysis with sources", "tradeoffs": "Comprehensive but
                takes longer to read"}, {"label": "Headlines", "description":
                "Key points only", "tradeoffs": "Quick scan but may miss
                nuance"}]
            recommendation: Your recommended option and why, if you have
                a preference. Leave empty to present options neutrally.

        Returns:
            Formatted options comparison to present to the user.
        """
        parts = [f"**Decision:** {decision}\n"]

        try:
            options = json.loads(options_json)
            if not isinstance(options, list):
                options = [options]
        except (json.JSONDecodeError, TypeError):
            return f"Error: options_json must be a valid JSON array. Received: {options_json[:200]}"

        for i, opt in enumerate(options[: config.max_options]):
            label = opt.get("label", f"Option {i + 1}")
            desc = opt.get("description", "")
            tradeoffs = opt.get("tradeoffs", "")

            parts.append(f"**{i + 1}. {label}**")
            if desc:
                parts.append(f"   {desc}")
            if tradeoffs:
                parts.append(f"   *Considerations:* {tradeoffs}")
            parts.append("")

        if recommendation:
            parts.append(f"**My recommendation:** {recommendation}")

        parts.append("Which option do you prefer? (number or description)")

        return "\n".join(parts)

    # ------------------------------------------------------------------
    # Tool 5 -- delete_memory_guarded
    # ------------------------------------------------------------------
    async def delete_memory_guarded(
        approval_token: str,
        user_id: str = "",
    ) -> str:
        """Delete Hindsight memory for a user after token validation.

        Args:
            approval_token: Single-use token from confirm_action.
            user_id: Legacy fallback only. Authenticated HTTP requests derive
                the user from trusted request headers.
        """
        resolved_user = _authenticated_user_or_fallback(user_id)
        if not resolved_user:
            return "Error: user_id is required."

        redis_client = _get_redis()
        ok, reason = validate_approval_token(
            redis_client,
            user_id=resolved_user,
            token=approval_token,
            action_type="delete_memory",
            target=resolved_user,
            consume=True,
        )
        if not ok:
            return f"Error: delete_memory denied: {reason}."

        from nat_helpers.hindsight_client import client_from_env, memory_mode

        mode = memory_mode()
        if mode == "disabled":
            return "Durable memory is disabled by the operator."
        try:
            await client_from_env().clear_memories(user_id=resolved_user)
        except Exception:
            logger.exception("Hindsight memory clear failed")
            return "Error: Hindsight memory could not be cleared."

        return "Durable memory cleared."

    async def user_interaction(
        operation: UserInteractionOperation,
        question: str = "",
        options: str = "",
        context: str = "",
        why_asking: str = "",
        action: str = "",
        reason: str = "",
        risks: str = "",
        alternatives: str = "",
        reversible: bool = True,
        user_id: str = "",
        action_type: str = "unspecified",
        target: str = "",
        server_name: str = "",
        tool_name: str = "",
        arguments_json: str = "",
        title: str = "",
        sections_json: str = "[]",
        source_strategy_json: str = "",
        estimated_tool_calls: int = 0,
        decision: str = "",
        options_json: str = "[]",
        recommendation: str = "",
        approval_token: str = "",
    ) -> str:
        """Dispatch one explicit structured user-interaction operation."""

        op = str(operation or "").strip()
        if op not in enabled:
            enabled_text = ", ".join(
                candidate for candidate in _ALL_OPERATIONS if candidate in enabled
            )
            return (
                f"Error: operation '{op}' is disabled. "
                f"Enabled operations: {enabled_text or '(none)'}."
            )

        if op == "clarify":
            return await clarify(question, options, context, why_asking)
        if op == "confirm_action":
            return await confirm_action(
                action,
                reason,
                risks,
                alternatives,
                reversible,
                user_id,
                action_type,
                target,
                server_name,
                tool_name,
                arguments_json,
            )
        if op == "confirm_research_plan":
            return await confirm_research_plan(
                title,
                sections_json,
                source_strategy_json,
                estimated_tool_calls,
                risks,
                user_id,
                target,
            )
        if op == "present_options":
            return await present_options(decision, options_json, recommendation)
        if op == "delete_memory_guarded":
            return await delete_memory_guarded(approval_token, user_id)
        raise AssertionError(f"Unhandled user-interaction operation: {op}")

    # A registered toolkit function builder is an async context manager and
    # must yield exactly one FunctionInfo. The old implementation yielded one
    # FunctionInfo per operation; production therefore exposed only the first
    # (clarify) schema and confirm_action could never be called. Keep one typed
    # dispatcher so every enabled operation is present in the actual tool
    # contract.
    try:
        yield FunctionInfo.from_fn(
            user_interaction,
            input_schema=UserInteractionInput,
            description=config.description,
        )

    except GeneratorExit:
        logger.warning("user_interaction function exited early!")
    finally:
        logger.info("Cleaning up user_interaction function.")
