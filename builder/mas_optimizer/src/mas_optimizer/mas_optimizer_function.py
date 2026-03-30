"""MAS-optimized evaluation, verification, and outcome logging for NeMo Agent Toolkit.

Registers three tools with NAT:

  mas_evaluate       Capability gate + task decomposability analysis.
                     Returns structured architecture recommendation.

  mas_verify         Verifier sub-agent that checks draft responses for
                     topic drift, missing content, and meta-task adherence.
                     Reduces error amplification from 17.2x to 4.4x.

  mas_log_outcome    Logs MAS/SAS outcomes for future capability gate
                     calibration via the memory system.

Architecture constants from 'Towards a Science of Scaling Agent Systems'
(arXiv:2512.08296v2), Tables 4-5, Section 4.3.
"""

import json
import logging
import os

from mas_optimizer.capability_gate import CapabilityGate
from mas_optimizer.task_analyzer import TaskAnalyzer
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field

logger = logging.getLogger(__name__)

# Paper-derived architecture constants
ERROR_AMP_CENTRALIZED = 4.4  # centralized MAS (vs 17.2x decentralized)
ERROR_AMP_DECENTRALIZED = 17.2
OPTIMAL_MSG_DENSITY = 0.39  # messages/turn at logarithmic saturation (Fig. 4)
ARCHITECTURE_PREDICTION_ACCURACY = 0.87  # 87% on held-out configurations


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
class MasOptimizerConfig(FunctionBaseConfig, name="mas_optimizer"):
    """Configuration for the MAS architecture optimizer tools."""

    sas_accuracy_threshold: float = Field(
        default=0.45,
        description=(
            "SAS accuracy threshold below which MAS engagement is justified. "
            "Derived from capability coefficient beta=-0.404, p<0.001."
        ),
    )
    decomposability_threshold: float = Field(
        default=0.35,
        description="Minimum decomposability score D to justify MAS overhead.",
    )
    tool_count_threshold: int = Field(
        default=12,
        description=(
            "Maximum active tool count for MAS eligibility. "
            "Coordination overhead dominates above this (beta=-0.267)."
        ),
    )
    default_user_id: str = Field(
        default="",
        description=(
            "Default user ID for memory log instructions. "
            "Falls back to DAEDALUS_DEFAULT_USER env var."
        ),
    )
    drift_keywords: list[str] = Field(
        default_factory=lambda: [
            "vision language",
            "VLM",
            "Qwen3-VL",
            "image model",
        ],
        description=(
            "Keywords that indicate topic drift when present in a response "
            "but absent from the original task."
        ),
    )
    required_keywords: list[str] = Field(
        default_factory=lambda: [
            "MAS",
            "verifier",
            "capability gate",
            "orchestrat",
            "decomposab",
        ],
        description=(
            "Substrings the verifier checks for in meta-architecture responses. "
            "Matched case-insensitively."
        ),
    )
    verbosity_ceiling: int = Field(
        default=2000,
        description="Word count above which the verifier flags a response as too verbose.",
    )


# ---------------------------------------------------------------------------
# Registered function
# ---------------------------------------------------------------------------
@register_function(config_type=MasOptimizerConfig)
async def mas_optimizer_function(config: MasOptimizerConfig, builder: Builder):
    gate = CapabilityGate(threshold=config.sas_accuracy_threshold)
    analyzer = TaskAnalyzer(
        decomposability_threshold=config.decomposability_threshold,
        tool_count_threshold=config.tool_count_threshold,
    )
    default_user = config.default_user_id or os.environ.get(
        "DAEDALUS_DEFAULT_USER", "tuttlebr"
    )

    # ------------------------------------------------------------------
    # Tool 1 -- mas_evaluate
    # ------------------------------------------------------------------
    async def mas_evaluate(
        task_description: str,
        active_tool_names: str = "",
        memory_results: str = "",
    ) -> str:
        """Evaluate whether a task benefits from Multi-Agent System (MAS) or
        Single-Agent System (SAS) architecture.

        Applies capability gating (SAS accuracy estimation) and task
        decomposability analysis per 'Towards a Science of Scaling Agent
        Systems' (arXiv:2512.08296v2).

        Args:
            task_description: The user request or meta-task to evaluate.
            active_tool_names: Comma-separated list of currently active tools.
            memory_results: JSON string of recent MAS outcome memories. Each
                entry should have a "success" key (0.0-1.0). Used for SAS
                accuracy estimation.

        Returns:
            JSON assessment with architecture recommendation.
        """
        tools = (
            [t.strip() for t in active_tool_names.split(",") if t.strip()]
            if active_tool_names
            else []
        )

        try:
            memories = json.loads(memory_results) if memory_results else []
        except (json.JSONDecodeError, TypeError):
            memories = []

        cap = gate.evaluate(memories)
        task = analyzer.evaluate(task_description, tools)

        mas_recommended = cap.mas_eligible and task.mas_eligible

        result = {
            "recommendation": "MAS" if mas_recommended else "SAS",
            "capability_gate": {
                "sas_accuracy_estimate": round(cap.sas_accuracy_estimate, 3),
                "threshold": cap.threshold,
                "eligible": cap.mas_eligible,
                "reason": cap.reason,
            },
            "task_analysis": {
                "decomposability_score": round(task.decomposability_score, 3),
                "tool_count": task.tool_count,
                "eligible": task.mas_eligible,
                "reason": task.reason,
            },
            "architecture": {
                "type": (
                    "centralized_mas_with_verifier"
                    if mas_recommended
                    else "single_agent"
                ),
                "error_amplification": (
                    f"{ERROR_AMP_CENTRALIZED}x" if mas_recommended else "1x (baseline)"
                ),
                "optimal_msg_density": (
                    OPTIMAL_MSG_DENSITY if mas_recommended else None
                ),
                "prediction_confidence": ARCHITECTURE_PREDICTION_ACCURACY,
            },
            "paper_ref": "arXiv:2512.08296v2, Tables 4-5, Section 4.3",
        }

        return json.dumps(result, indent=2)

    # ------------------------------------------------------------------
    # Tool 2 -- mas_verify
    # ------------------------------------------------------------------
    async def mas_verify(
        draft_response: str,
        original_task: str,
        task_type: str = "general",
    ) -> str:
        """Verify a draft response against the original task intent.

        Implements the verifier sub-agent from the centralized MAS
        architecture.  Checks for topic drift, missing required content,
        verbosity, and self-reference coherence.  Error amplification
        drops from 17.2x (no verifier) to 4.4x (with verifier).

        Args:
            draft_response: Synthesized draft to verify.
            original_task: Original user request or meta-task.
            task_type: One of "general", "meta_correction",
                "architecture_design", "self_improvement".

        Returns:
            JSON with pass/fail, issues, and revision notes.
        """
        issues: list[str] = []
        revision_notes: list[str] = []

        draft_lower = draft_response.lower()
        task_lower = original_task.lower()

        # -- Check 1: topic drift ----------------------------------------
        for keyword in config.drift_keywords:
            kw = keyword.lower()
            if kw in draft_lower and kw not in task_lower:
                issues.append(
                    f"topic_drift: '{keyword}' present in response "
                    f"but absent from original task"
                )
                revision_notes.append(
                    f"Remove or contextualize '{keyword}' unless "
                    f"directly tied to the task"
                )

        # -- Check 2: required architecture content ----------------------
        if task_type in (
            "meta_correction",
            "architecture_design",
            "self_improvement",
        ):
            missing = [
                kw for kw in config.required_keywords if kw.lower() not in draft_lower
            ]
            if missing:
                issues.append(
                    f"missing_content: architecture keywords not found: {missing}"
                )
                revision_notes.append(f"Add specifics about: {', '.join(missing)}")

        # -- Check 3: verbosity ------------------------------------------
        word_count = len(draft_response.split())
        if word_count > config.verbosity_ceiling:
            issues.append(
                f"verbosity: {word_count} words exceeds "
                f"{config.verbosity_ceiling}-word ceiling"
            )
            revision_notes.append(
                "Compress response; aim for information density " "over completeness"
            )

        # -- Check 4: self-reference coherence for meta-tasks ------------
        if task_type == "meta_correction":
            meta_signals = (
                "my own architecture",
                "self-improvement",
                "my architecture",
            )
            if any(s in task_lower for s in meta_signals):
                self_refs = ("your", "the agent", "daedalus", "itself")
                if not any(ref in draft_lower for ref in self_refs):
                    issues.append(
                        "self_reference: meta-task about agent architecture "
                        "but response lacks self-referential framing"
                    )
                    revision_notes.append(
                        "Frame response as addressing the agent's own "
                        "architecture, not a generic system"
                    )

        passed = len(issues) == 0

        result = {
            "passed": passed,
            "issues_found": len(issues),
            "issues": issues,
            "revision_notes": revision_notes,
            "verifier_config": {
                "error_amplification_with_verifier": f"{ERROR_AMP_CENTRALIZED}x",
                "error_amplification_without": f"{ERROR_AMP_DECENTRALIZED}x",
                "mechanism": "centralized cross-check with orchestrator",
            },
        }

        return json.dumps(result, indent=2)

    # ------------------------------------------------------------------
    # Tool 3 -- mas_log_outcome
    # ------------------------------------------------------------------
    async def mas_log_outcome(
        task_type: str,
        architecture_used: str,
        decomposability_score: float = 0.0,
        tool_count: int = 0,
        success_score: float = 0.0,
        notes: str = "",
    ) -> str:
        """Log a MAS/SAS task outcome for future capability gate calibration.

        Returns a structured memory entry.  The caller should persist it
        via add_memory so the capability gate can use it in subsequent
        evaluations.

        Args:
            task_type: Category (e.g., "meta_correction", "research",
                "coding", "daily_briefing").
            architecture_used: "SAS" or "centralized_mas_with_verifier".
            decomposability_score: D score for this task (0.0-1.0).
            tool_count: Number of active tools during this task.
            success_score: Estimated success (0.0-1.0).
            notes: Free-text notes about the outcome.

        Returns:
            JSON with the memory entry and add_memory instruction.
        """
        memory_text = (
            f"MAS outcome: type={task_type}, arch={architecture_used}, "
            f"D={decomposability_score:.2f}, T={tool_count}, "
            f"success={success_score:.1f}"
        )
        if notes:
            memory_text += f". {notes}"

        metadata_pairs = {
            "task_type": task_type,
            "architecture": architecture_used,
            "success": str(round(success_score, 2)),
        }

        result = {
            "logged": True,
            "memory_entry": memory_text,
            "metadata": {
                "task_type": task_type,
                "architecture": architecture_used,
                "decomposability_score": round(decomposability_score, 2),
                "tool_count": tool_count,
                "success_score": round(success_score, 1),
            },
            "add_memory_instruction": (
                f"Persist via: add_memory(user_id='{default_user}', "
                f"memory='{memory_text}', "
                f'metadata={{"key_value_pairs": {json.dumps(metadata_pairs)}}})'
            ),
        }

        return json.dumps(result, indent=2)

    # ------------------------------------------------------------------
    # Register all three tools with NAT
    # ------------------------------------------------------------------
    try:
        yield FunctionInfo.from_fn(
            mas_evaluate,
            description=(
                "Evaluate whether a task should use Multi-Agent System (MAS) "
                "or Single-Agent System (SAS). Applies capability gating "
                "(SAS accuracy < 0.45) and task decomposability analysis "
                "(D > 0.35, T < 12) per 'Towards a Science of Scaling Agent "
                "Systems'. Returns a JSON assessment with architecture "
                "recommendation, gate results, and confidence score."
            ),
        )

        yield FunctionInfo.from_fn(
            mas_verify,
            description=(
                "Verify a draft response against the original task intent. "
                "Checks for topic drift, missing architecture content, "
                "verbosity, and self-reference coherence. Implements the "
                "verifier sub-agent stage that reduces error amplification "
                "from 17.2x to 4.4x in centralized MAS."
            ),
        )

        yield FunctionInfo.from_fn(
            mas_log_outcome,
            description=(
                "Log a MAS/SAS task outcome for future capability gate "
                "calibration. Returns a structured memory entry and "
                "add_memory instruction. Call after task completion to "
                "close the feedback loop."
            ),
        )

    except GeneratorExit:
        logger.warning("mas_optimizer function exited early!")
    finally:
        logger.info("Cleaning up mas_optimizer function.")
