"""MAS-optimized evaluation, verification, and outcome logging for NeMo Agent Toolkit.

Registers three tools with NAT:

  mas_evaluate       Capability gate + task decomposability + sequential
                     interdependence analysis.  Returns architecture
                     recommendation (SAS, centralized, or decentralized).

  mas_verify         Verifier sub-agent that checks draft responses for
                     topic drift, missing content, task-response alignment,
                     and completeness.  Reduces error amplification from
                     17.2x (independent) to 4.4x (centralized).

  mas_log_outcome    Logs MAS/SAS outcomes with runtime coordination
                     metrics (O%, E_c) for closed-loop gate calibration.

Architecture constants from 'Towards a Science of Scaling Agent Systems'
(arXiv:2512.08296v2), Tables 4-5, Section 4.3.
"""

import json
import logging
import os
import re

from mas_optimizer.capability_gate import CapabilityGate
from mas_optimizer.task_analyzer import TaskAnalyzer
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field

logger = logging.getLogger(__name__)

# Paper-derived architecture constants (Table 5)
ERROR_AMP_INDEPENDENT = 17.2
ERROR_AMP_DECENTRALIZED = 7.8
ERROR_AMP_CENTRALIZED = 4.4
ERROR_AMP_HYBRID = 5.1
OPTIMAL_MSG_DENSITY = 0.39  # messages/turn at logarithmic saturation (Fig. 4)
ARCHITECTURE_PREDICTION_ACCURACY = 0.87  # 87% on held-out configurations

# Lightweight stop words for entity extraction (verification check)
_STOP_WORDS: frozenset[str] = frozenset(
    {
        "a",
        "an",
        "the",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "have",
        "has",
        "had",
        "do",
        "does",
        "did",
        "will",
        "would",
        "could",
        "should",
        "may",
        "might",
        "shall",
        "can",
        "need",
        "must",
        "to",
        "of",
        "in",
        "for",
        "on",
        "with",
        "at",
        "by",
        "from",
        "as",
        "into",
        "about",
        "like",
        "through",
        "after",
        "over",
        "between",
        "out",
        "against",
        "during",
        "without",
        "before",
        "under",
        "around",
        "among",
        "and",
        "but",
        "or",
        "nor",
        "not",
        "so",
        "yet",
        "both",
        "either",
        "neither",
        "each",
        "every",
        "all",
        "any",
        "few",
        "more",
        "most",
        "other",
        "some",
        "such",
        "no",
        "only",
        "own",
        "same",
        "than",
        "too",
        "very",
        "just",
        "because",
        "if",
        "when",
        "while",
        "where",
        "how",
        "what",
        "which",
        "who",
        "whom",
        "this",
        "that",
        "these",
        "those",
        "i",
        "me",
        "my",
        "we",
        "our",
        "you",
        "your",
        "he",
        "him",
        "his",
        "she",
        "her",
        "it",
        "its",
        "they",
        "them",
        "their",
        "please",
        "also",
        "well",
        "then",
    }
)

_WORD_RE = re.compile(r"[a-z]{3,}", re.IGNORECASE)


def _extract_entities(text: str) -> set[str]:
    """Extract significant words (>= 3 chars, not stop words)."""
    return {w.lower() for w in _WORD_RE.findall(text)} - _STOP_WORDS


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
        description="Minimum effective decomposability score to justify MAS overhead.",
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
    alignment_threshold: float = Field(
        default=0.25,
        description=(
            "Minimum entity overlap ratio between task and response. "
            "Below this, the verifier flags weak task-response alignment."
        ),
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

        Applies capability gating (SAS accuracy estimation), task
        decomposability, and sequential interdependence analysis per
        'Towards a Science of Scaling Agent Systems' (arXiv:2512.08296v2).

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

        # Architecture type selection (Section 4.2):
        #   centralized -> structured analysis (Finance +80.9%, Ae=4.4x)
        #   decentralized -> exploratory/web research (BrowseComp +9.2%, Ae=7.8x)
        if mas_recommended:
            arch_type = task.recommended_architecture
            if arch_type == "decentralized":
                full_arch = "decentralized_mas"
                error_amp = f"{ERROR_AMP_DECENTRALIZED}x"
            else:
                full_arch = "centralized_mas_with_verifier"
                error_amp = f"{ERROR_AMP_CENTRALIZED}x"
        else:
            full_arch = "single_agent"
            error_amp = "1x (baseline)"

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
                "sequential_interdependence": round(task.sequential_interdependence, 3),
                "effective_decomposability": round(task.effective_decomposability, 3),
                "tool_count": task.tool_count,
                "eligible": task.mas_eligible,
                "recommended_architecture": task.recommended_architecture,
                "reason": task.reason,
            },
            "architecture": {
                "type": full_arch,
                "error_amplification": error_amp,
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
        architecture.  Checks for topic drift, task-response alignment,
        completeness, missing required content, verbosity, and
        self-reference coherence.

        Error amplification drops from 17.2x (no verifier) to 4.4x
        (with verifier).  89% of centralized failures occur at the
        synthesis stage, so verification focuses on whether the response
        actually addresses the question.

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

        if not draft_response or not original_task:
            return json.dumps(
                {
                    "passed": False,
                    "issues_found": 1,
                    "issues": [
                        "missing_input: both draft_response and original_task are required"
                    ],
                    "revision_notes": [
                        "Provide both draft_response and original_task parameters"
                    ],
                    "verifier_config": {
                        "error_amplification_with_verifier": f"{ERROR_AMP_CENTRALIZED}x",
                        "error_amplification_without": f"{ERROR_AMP_INDEPENDENT}x",
                        "mechanism": "centralized cross-check with orchestrator",
                    },
                },
                indent=2,
            )

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

        # -- Check 2: task-response alignment ----------------------------
        # Extract key entities from task and check coverage in response.
        # Paper Section 4.4: 89% of centralized failures occur at
        # orchestrator-level synthesis, not component execution.
        task_entities = _extract_entities(original_task)
        if task_entities:
            response_entities = _extract_entities(draft_response)
            overlap = len(task_entities & response_entities)
            coverage = overlap / len(task_entities)
            if coverage < config.alignment_threshold:
                issues.append(
                    f"weak_alignment: only {overlap}/{len(task_entities)} "
                    f"task entities found in response "
                    f"(coverage={coverage:.0%} < {config.alignment_threshold:.0%})"
                )
                missing = task_entities - response_entities
                sample = sorted(missing)[:5]
                revision_notes.append(
                    f"Response may not address the task. "
                    f"Missing entities: {', '.join(sample)}"
                )

        # -- Check 3: required architecture content ----------------------
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

        # -- Check 4: verbosity ------------------------------------------
        word_count = len(draft_response.split())
        if word_count > config.verbosity_ceiling:
            issues.append(
                f"verbosity: {word_count} words exceeds "
                f"{config.verbosity_ceiling}-word ceiling"
            )
            revision_notes.append(
                "Compress response; aim for information density " "over completeness"
            )

        # -- Check 5: self-reference coherence for meta-tasks ------------
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
                "error_amplification_without": f"{ERROR_AMP_INDEPENDENT}x",
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
        turn_count: int = 0,
        sas_baseline_turns: int = 7,
        notes: str = "",
    ) -> str:
        """Log a MAS/SAS task outcome with runtime coordination metrics.

        Returns a structured memory entry with computed overhead (O%) and
        coordination efficiency (E_c) for future capability gate
        calibration.  The caller should persist it via add_memory.

        Args:
            task_type: Category (e.g., "meta_correction", "research",
                "coding", "daily_briefing").
            architecture_used: "SAS", "centralized_mas_with_verifier",
                or "decentralized_mas".
            decomposability_score: D score for this task (0.0-1.0).
            tool_count: Number of active tools during this task.
            success_score: Estimated success (0.0-1.0).
            turn_count: Total reasoning turns used (0 = unknown).
            sas_baseline_turns: Expected SAS turns for comparison.
                Paper Table 5 mean: 7.2.
            notes: Free-text notes about the outcome.

        Returns:
            JSON with the memory entry, runtime metrics, and
            add_memory instruction.
        """
        # Compute runtime coordination metrics (Table 5, Section 4.4)
        if turn_count > 0 and sas_baseline_turns > 0:
            overhead_pct = round(
                (turn_count - sas_baseline_turns) / sas_baseline_turns * 100, 1
            )
            relative_turns = turn_count / sas_baseline_turns
            efficiency = (
                round(success_score / relative_turns, 3) if relative_turns > 0 else 0.0
            )
        else:
            overhead_pct = None
            efficiency = None

        memory_text = (
            f"MAS outcome: type={task_type}, arch={architecture_used}, "
            f"D={decomposability_score:.2f}, T={tool_count}, "
            f"success={success_score:.1f}"
        )
        if overhead_pct is not None:
            memory_text += f", O%={overhead_pct}, Ec={efficiency}"
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
            "runtime_metrics": {
                "turn_count": turn_count if turn_count > 0 else None,
                "sas_baseline_turns": sas_baseline_turns,
                "overhead_pct": overhead_pct,
                "coordination_efficiency": efficiency,
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
                "(SAS accuracy < 0.45), task decomposability, and sequential "
                "interdependence analysis per 'Towards a Science of Scaling "
                "Agent Systems'. Returns a JSON assessment with architecture "
                "recommendation (SAS, centralized, or decentralized), gate "
                "results, and confidence score."
            ),
        )

        yield FunctionInfo.from_fn(
            mas_verify,
            description=(
                "Verify a draft response against the original task intent. "
                "Checks for topic drift, task-response entity alignment, "
                "missing architecture content, verbosity, and self-reference "
                "coherence. Implements the verifier sub-agent stage that "
                "reduces error amplification from 17.2x to 4.4x in "
                "centralized MAS."
            ),
        )

        yield FunctionInfo.from_fn(
            mas_log_outcome,
            description=(
                "Log a MAS/SAS task outcome with runtime coordination metrics "
                "(overhead O%, efficiency E_c) for future capability gate "
                "calibration. Returns a structured memory entry and "
                "add_memory instruction. Call after task completion to "
                "close the feedback loop."
            ),
        )

    except GeneratorExit:
        logger.warning("mas_optimizer function exited early!")
    finally:
        logger.info("Cleaning up mas_optimizer function.")
