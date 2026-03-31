"""Structured user interaction tools for NeMo Agent Toolkit.

Registers three tools with NAT:

  clarify             Ask the user a structured clarification question
                      with suggested options and context. Reduces ambiguity
                      in user requests before committing to a course of action.

  confirm_action      Get explicit user confirmation before taking a
                      consequential or irreversible action. Presents the
                      action, rationale, risks, and alternatives.

  present_options     Present a structured comparison of options for the
                      user to choose from. Each option includes a label,
                      description, and trade-offs.

Inspired by Claude Code's AskUserQuestion tool and the principle that
structured interaction dramatically improves user satisfaction and
reduces wasted effort on misunderstood requests.
"""

import json
import logging

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field

logger = logging.getLogger(__name__)


class UserInteractionConfig(FunctionBaseConfig, name="user_interaction"):
    """Configuration for the user_interaction function."""

    max_options: int = Field(
        default=6,
        ge=2,
        le=10,
        description="Maximum number of options to present in clarification or choice questions.",
    )


@register_function(config_type=UserInteractionConfig)
async def user_interaction_function(config: UserInteractionConfig, builder: Builder):
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
                    f"  {i+1}. {opt}"
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
    ) -> str:
        """Request user confirmation before taking a consequential action.

        Use this before any action that:
        - Modifies external state (Kubernetes, GitHub, memory)
        - Is difficult or impossible to reverse
        - Has significant resource costs
        - Could have unintended side effects

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

        Returns:
            Formatted confirmation request to present to the user.
        """
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

        parts.append("\nProceed? (yes/no)")

        return "\n".join(parts)

    # ------------------------------------------------------------------
    # Tool 3 -- present_options
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
            label = opt.get("label", f"Option {i+1}")
            desc = opt.get("description", "")
            tradeoffs = opt.get("tradeoffs", "")

            parts.append(f"**{i+1}. {label}**")
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
    # Register all three tools with NAT
    # ------------------------------------------------------------------
    try:
        yield FunctionInfo.from_fn(
            clarify,
            description=(
                "Ask the user a structured clarification question with suggested "
                "options. Use BEFORE committing to an action when the request is "
                "ambiguous. Reduces wasted effort from misunderstood requests. "
                "Formats the question with context, options, and rationale."
            ),
        )

        yield FunctionInfo.from_fn(
            confirm_action,
            description=(
                "Request explicit user confirmation before taking a consequential "
                "action. Use before modifying external state (Kubernetes, GitHub, "
                "memory), irreversible actions, or actions with significant costs. "
                "Presents the action, reason, risks, and alternatives."
            ),
        )

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

    except GeneratorExit:
        logger.warning("user_interaction function exited early!")
    finally:
        logger.info("Cleaning up user_interaction function.")
