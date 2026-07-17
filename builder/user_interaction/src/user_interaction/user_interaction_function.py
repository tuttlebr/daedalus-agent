"""Structured user interaction tools for NeMo Agent Toolkit.

Registers three tools with NAT:

  clarify             Ask the user a structured clarification question
                      with suggested options and context. Reduces ambiguity
                      in user requests before committing to a course of action.

  confirm_action      Get explicit user confirmation before taking a
                      consequential or irreversible action. Presents the
                      action, rationale, risks, and alternatives.

  confirm_research_plan
                      Present a deep-research plan, source strategy, and
                      expected cost/risk before expensive research begins.

  present_options     Present a structured comparison of options for the
                      user to choose from. Each option includes a label,
                      description, and trade-offs.

Inspired by Claude Code's AskUserQuestion tool and the principle that
structured interaction dramatically improves user satisfaction and
reduces wasted effort on misunderstood requests.
"""

import json
import logging
from typing import Any

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field
from user_interaction.approval_tokens import (
    create_pending_mcp_approval,
    make_redis_client,
    validate_approval_token,
)

logger = logging.getLogger(__name__)


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
    enabled_operations: list[str] | None = Field(
        default=None,
        description=(
            "Optional allow-list of operations to register. Supported values: "
            "clarify, confirm_action, confirm_research_plan, present_options, "
            "delete_memory_guarded. When omitted, all operations are registered."
        ),
    )


def _authenticated_user_or_fallback(fallback_user_id: str = "") -> str:
    from nat_helpers.identity import authenticated_user_id_from_context_or_fallback

    return authenticated_user_id_from_context_or_fallback(fallback_user_id)


@register_function(config_type=UserInteractionConfig)
async def user_interaction_function(config: UserInteractionConfig, builder: Builder):
    _redis_client: Any | None = None
    enabled = set(config.enabled_operations or [])

    def _enabled(operation: str) -> bool:
        return not enabled or operation in enabled

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
        - Modifies external state (Kubernetes, GitHub)
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
                "argument. Use confirm_action only for destructive external "
                "mutations or memory deletes."
            )

        parts = [f"**Action requiring confirmation:**\n\n{action}"]

        parts.append(f"\n**Reason:** {reason}")

        if risks:
            parts.append(f"\n**Risks:** {risks}")

        if not reversible:
            parts.append("\n**Warning:** This action is difficult to reverse.")

        if alternatives:
            alt_list = [a.strip() for a in alternatives.split("|") if a.strip()]
            if alt_list:
                alts_formatted = ", ".join(alt_list)
                parts.append(f"\n**Alternatives considered:** {alts_formatted}")

        resolved_user_id = _authenticated_user_or_fallback(user_id)
        resolved_target = (target or "").strip()
        pending_mcp_approval: dict[str, Any] | None = None
        if normalized_action_type == "delete_memory":
            if resolved_target and resolved_target != resolved_user_id:
                return "Error: delete_memory target must match the authenticated user."
            resolved_target = resolved_user_id
        if normalized_action_type == "mcp_mutation":
            from nat_helpers.identity import execution_scope_from_context_or_none

            execution_scope = execution_scope_from_context_or_none()
            if execution_scope is not None and execution_scope != "autonomy":
                return (
                    "Error: mutating MCP actions are available only through the "
                    "Autonomy dashboard, which provides the authenticated "
                    "approval and resume workflow. Interactive chat remains "
                    "read-only for these tools."
                )
            if not resolved_target or resolved_target == "*":
                return "Error: MCP approval requires an exact, non-wildcard target."
            if not server_name.strip():
                return "Error: MCP approval requires the exact server_name."
            if not tool_name.strip():
                return "Error: MCP approval requires the exact tool_name."
            try:
                pending_mcp_approval = create_pending_mcp_approval(
                    _get_redis(),
                    user_id=resolved_user_id,
                    action=action,
                    reason=reason,
                    target=resolved_target,
                    server_name=server_name,
                    tool_name=tool_name,
                    arguments_json=arguments_json,
                )
            except Exception as exc:
                logger.warning(
                    "Unable to persist pending MCP approval: error_class=%s",
                    type(exc).__name__,
                )
                return "Error: unable to create a protected pending approval."

        parts.append("\nProceed? (yes/no)")
        if resolved_user_id and normalized_action_type != "unspecified":
            parts.append(
                "\nNo executable credential has been created. The authenticated "
                "approval route will mint one only after the user approves."
            )
            parts.append(
                f"\nApproval scope: action_type=`{normalized_action_type}`, "
                f"target=`{resolved_target}`"
            )
            if normalized_action_type == "mcp_mutation":
                if pending_mcp_approval is None:
                    raise RuntimeError("pending MCP approval was not created")
                parts[-1] += (
                    f", server_name=`{server_name.strip()}`, "
                    f"tool_name=`{tool_name.strip()}`, "
                    "approval_request_id="
                    f"`{pending_mcp_approval['request_id']}`, "
                    "arguments_sha256="
                    f"`{pending_mcp_approval['arguments_sha256']}`."
                )
                parts.append(
                    "\nArguments for review (sensitive values redacted):\n\n"
                    f"```json\n{pending_mcp_approval['arguments_preview']}\n```"
                )
            else:
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
        """Delete Redis-backed memory keys for a user after token validation.

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

        # NAT Redis memory keys contain only a random id. Ownership lives in
        # the JSON value, so key-name substring matching can both miss the
        # intended user's records and delete another user's colliding id.
        deleted = 0
        owned_keys = []
        for memory_key in redis_client.scan_iter("nat:memory:*"):
            try:
                raw = redis_client.execute_command("JSON.GET", memory_key)
            except Exception:
                raw = redis_client.get(memory_key)
            try:
                record = json.loads(raw) if isinstance(raw, str) else raw
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(record, list) and len(record) == 1:
                record = record[0]
            if isinstance(record, dict) and record.get("user_id") == resolved_user:
                owned_keys.append(memory_key)
        if owned_keys:
            deleted = int(redis_client.delete(*owned_keys) or 0)

        return f"Deleted {deleted} memory key(s) for user_id='{resolved_user}'."

    # ------------------------------------------------------------------
    # Register all tools with NAT
    # ------------------------------------------------------------------
    try:
        if _enabled("clarify"):
            yield FunctionInfo.from_fn(
                clarify,
                description=(
                    "Ask the user a structured clarification question with suggested "
                    "options. Use BEFORE committing to an action when the request is "
                    "ambiguous. Reduces wasted effort from misunderstood requests. "
                    "Formats the question with context, options, and rationale."
                ),
            )

        if _enabled("confirm_action"):
            yield FunctionInfo.from_fn(
                confirm_action,
                description=(
                    "Request explicit user confirmation before taking a consequential "
                    "action. Use before destructive external-state mutations "
                    "(Kubernetes, GitHub), memory deletes, irreversible actions, "
                    "or actions with significant costs. Do not use for add_memory "
                    "or memory_update. Presents the action, reason, risks, and "
                    "alternatives. MCP mutations must include exact tool_name, "
                    "target, and arguments_json; this tool never returns a live "
                    "credential."
                ),
            )

        if _enabled("confirm_research_plan"):
            yield FunctionInfo.from_fn(
                confirm_research_plan,
                description=(
                    "Request explicit approval before starting an expensive "
                    "AIQ-style deep research plan. Args: title, sections_json, "
                    "optional source_strategy_json, estimated_tool_calls, risks, "
                    "and target. Presents sections, source strategy, "
                    "cost/risk trade-offs, and records a pending decision using "
                    "the authenticated request identity."
                ),
            )

        if _enabled("present_options"):
            yield FunctionInfo.from_fn(
                present_options,
                description=(
                    "Present a structured comparison of options for the user to "
                    "choose from. Use when multiple valid approaches exist and the "
                    "best choice depends on user preferences you cannot determine "
                    "from context. Each option includes label, description, and "
                    "trade-offs."
                ),
            )

        if _enabled("delete_memory_guarded"):
            yield FunctionInfo.from_fn(
                delete_memory_guarded,
                description=(
                    "Delete all Redis-backed memories for a user only after validating "
                    "a single-use approval_token from confirm_action. Required arg: "
                    "approval_token. The backend derives user identity from the "
                    "authenticated request. The token must have action_type "
                    "'delete_memory' and target equal to that user_id."
                ),
            )

    except GeneratorExit:
        logger.warning("user_interaction function exited early!")
    finally:
        logger.info("Cleaning up user_interaction function.")
