"""Cognitive reasoning scratchpad for NeMo Agent Toolkit.

Provides two meta-cognitive tools with zero side effects:

  think           Extended inner monologue / reasoning step.
                  Returns the thought unchanged. Forces the agent to
                  reason explicitly before acting on complex problems.

  sequential_think  Multi-step structured reasoning with revision.
                    Maintains a numbered thought chain and supports
                    branching back to revise earlier steps.

Inspired by the "think" tool pattern proven to dramatically improve
agent performance on multi-step tasks, ambiguous requests, and complex
tool-result processing.
"""

import json
import logging

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field

logger = logging.getLogger(__name__)


class ThinkToolConfig(FunctionBaseConfig, name="think_tool"):
    """Configuration for the think_tool function."""

    max_thought_length: int = Field(
        default=50000,
        ge=100,
        le=200000,
        description="Maximum character length for a single thought.",
    )
    max_chain_steps: int = Field(
        default=20,
        ge=2,
        le=50,
        description="Maximum steps in a sequential thinking chain before requiring synthesis.",
    )


@register_function(config_type=ThinkToolConfig)
async def think_tool_function(config: ThinkToolConfig, builder: Builder):
    # Shared state for sequential thinking chains (per-conversation)
    thought_chains: dict[str, list[dict]] = {}

    # ------------------------------------------------------------------
    # Tool 1 -- think
    # ------------------------------------------------------------------
    async def think(thought: str) -> str:
        """Use this tool to think through something before acting.

        This tool has NO side effects -- it does not retrieve information,
        call APIs, or change any state. It simply returns your thought
        back to you, giving you space to reason.

        Use it when you need to:
        - Process complex or ambiguous user requests before choosing tools
        - Reason step-by-step through a multi-part problem
        - Interpret and synthesize results from multiple tool calls
        - Weigh trade-offs before recommending an action
        - Plan which tools to call and in what order
        - Check your reasoning for errors before responding
        - Resolve conflicting information from different sources

        Args:
            thought: Your reasoning, analysis, or internal monologue.
                Write freely -- this is your private scratchpad.

        Returns:
            Your thought, echoed back unchanged.
        """
        if len(thought) > config.max_thought_length:
            return thought[: config.max_thought_length] + (
                f"\n\n[Thought truncated at {config.max_thought_length} characters. "
                f"Break complex reasoning into multiple think() calls.]"
            )
        return thought

    # ------------------------------------------------------------------
    # Tool 2 -- sequential_think
    # ------------------------------------------------------------------
    async def sequential_think(
        thought: str,
        chain_id: str = "default",
        step_label: str = "",
        revise_step: int = 0,
    ) -> str:
        """Structured multi-step reasoning with revision support.

        Builds a numbered chain of thoughts that you can review and revise.
        Use this for complex analysis that benefits from explicit step
        tracking -- e.g., evaluating multiple options, building an argument,
        or debugging a multi-stage process.

        Unlike think(), this maintains state across calls within the same
        chain_id, so you can reference and revise earlier steps.

        Args:
            thought: The content of this reasoning step.
            chain_id: Identifier for the thought chain. Use different IDs
                for independent reasoning threads (default: "default").
            step_label: Optional label for this step (e.g., "hypothesis",
                "evidence", "conclusion"). If omitted, steps are just numbered.
            revise_step: If > 0, revises the thought at that step number
                instead of appending a new step. Set to the step number
                you want to replace with updated reasoning.

        Returns:
            JSON summary of the chain state: current step count, the
            recorded thought, and the full chain so far.
        """
        if chain_id not in thought_chains:
            thought_chains[chain_id] = []

        chain = thought_chains[chain_id]

        # Enforce chain length limit
        if len(chain) >= config.max_chain_steps and revise_step == 0:
            return json.dumps(
                {
                    "error": (
                        f"Chain '{chain_id}' has reached {config.max_chain_steps} steps. "
                        f"Synthesize your reasoning with think() or start a new chain."
                    ),
                    "chain_length": len(chain),
                    "chain_summary": [
                        {
                            "step": i + 1,
                            "label": s.get("label", ""),
                            "preview": s["thought"][:100],
                        }
                        for i, s in enumerate(chain)
                    ],
                },
                indent=2,
            )

        # Truncate thought if needed
        truncated = len(thought) > config.max_thought_length
        effective_thought = (
            thought[: config.max_thought_length] if truncated else thought
        )

        entry = {
            "thought": effective_thought,
            "label": step_label,
        }

        # Revise an existing step or append new
        if revise_step > 0 and revise_step <= len(chain):
            chain[revise_step - 1] = entry
            action = "revised"
            step_num = revise_step
        else:
            chain.append(entry)
            action = "appended"
            step_num = len(chain)

        result = {
            "action": action,
            "step": step_num,
            "label": step_label or f"step_{step_num}",
            "chain_id": chain_id,
            "chain_length": len(chain),
            "thought": effective_thought,
        }

        if truncated:
            result["warning"] = (
                f"Thought truncated at {config.max_thought_length} characters."
            )

        return json.dumps(result, indent=2)

    # ------------------------------------------------------------------
    # Register tools with NAT
    # ------------------------------------------------------------------
    try:
        yield FunctionInfo.from_fn(
            think,
            description=(
                "Private reasoning scratchpad with zero side effects. Use this "
                "tool to think through complex problems before acting: process "
                "ambiguous requests, plan multi-step tool invocations, synthesize "
                "results from multiple sources, weigh trade-offs, or check your "
                "reasoning for errors. Returns your thought unchanged. Call this "
                "BEFORE acting whenever the path forward is not immediately obvious."
            ),
        )

        yield FunctionInfo.from_fn(
            sequential_think,
            description=(
                "Multi-step structured reasoning with revision support. Builds a "
                "numbered thought chain that persists across calls within the same "
                "chain_id. Use for extended analysis: evaluating options, building "
                "arguments, debugging multi-stage processes, or any reasoning that "
                "benefits from reviewing and revising earlier steps. Use think() "
                "for one-off reasoning; use this when you need to track and revise "
                "a multi-step chain."
            ),
        )

    except GeneratorExit:
        logger.warning("think_tool function exited early!")
    finally:
        thought_chains.clear()
        logger.info("Cleaning up think_tool function.")
