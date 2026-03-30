"""Task decomposability and tool-coordination analysis for MAS routing.

Computes two signals that determine whether a request benefits from
Multi-Agent System (MAS) orchestration:

  D (decomposability) — how parallelizable the task is.  High D means
  independent sub-tasks that multiple agents can tackle concurrently.

  T (tool count) — number of active tools.  High T increases coordination
  overhead, which can dominate MAS gains.

MAS is recommended only when D > threshold AND T < ceiling.

Constants derived from:
  - Tables 4-5, Section 4.3 of 'Towards a Science of Scaling Agent Systems'
    (arXiv:2512.08296v2)
  - Coordination coefficient: beta = -0.267
  - Architecture selection accuracy: 87% on held-out configurations
"""

import re
from dataclasses import dataclass

# Paper-derived constant (Table 4)
COORDINATION_BETA = -0.267

# Indicators of parallel sub-task structure
PARALLEL_INDICATORS: frozenset[str] = frozenset(
    {
        "and",
        "also",
        "additionally",
        "plus",
        "along with",
        "as well as",
        "simultaneously",
        "concurrently",
        "in parallel",
        "both",
        "together with",
    }
)

# Indicators of sequential dependency
SEQUENTIAL_INDICATORS: frozenset[str] = frozenset(
    {
        "then",
        "after",
        "before",
        "next",
        "subsequently",
        "followed by",
        "once",
        "when done",
        "first",
        "finally",
        "lastly",
    }
)

# Action verbs that represent distinct sub-tasks
_ACTION_VERB_PATTERN = re.compile(
    r"\b("
    r"search|find|analyze|check|verify|compare|explain|justify|describe|"
    r"list|extract|summarize|review|evaluate|test|validate|create|generate|"
    r"build|deploy|retrieve|fetch|compute|assess|monitor|update|configure|"
    r"diagnose|investigate|recommend|optimize|refactor|implement"
    r")\b",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class TaskAssessment:
    """Result of task decomposability and tool-count analysis."""

    decomposability_score: float
    tool_count: int
    mas_eligible: bool
    reason: str


class TaskAnalyzer:
    """Analyzes a task description to decide MAS eligibility.

    MAS is eligible when:
      - decomposability D > *decomposability_threshold* (default 0.35)
      - active tool count T < *tool_count_threshold* (default 12)

    The thresholds come from the paper's 180-configuration evaluation
    (beta = -0.267 for tool-coordination trade-off).
    """

    def __init__(
        self,
        decomposability_threshold: float = 0.35,
        tool_count_threshold: int = 12,
    ) -> None:
        self.decomposability_threshold = decomposability_threshold
        self.tool_count_threshold = tool_count_threshold

    @staticmethod
    def compute_decomposability(task_text: str) -> float:
        """Compute decomposability score D in [0.0, 1.0].

        Higher D means more independent sub-tasks that can be handled
        concurrently by parallel agents.
        """
        text_lower = task_text.lower()

        parallel_count = sum(1 for ind in PARALLEL_INDICATORS if ind in text_lower)
        sequential_count = sum(1 for ind in SEQUENTIAL_INDICATORS if ind in text_lower)
        action_verbs = set(_ACTION_VERB_PATTERN.findall(text_lower))

        # Parallel potential: explicit parallel markers + extra distinct verbs
        parallel_potential = parallel_count + max(0, len(action_verbs) - 1)

        total_indicators = parallel_count + sequential_count + len(action_verbs)
        if total_indicators == 0:
            return 0.0

        # D: ratio of parallel potential to total structural complexity
        d = parallel_potential / (total_indicators + 1)
        return min(1.0, d)

    @staticmethod
    def count_tools(active_tool_names: list[str]) -> int:
        """Return the number of active tools."""
        return len(active_tool_names)

    def evaluate(self, task_text: str, active_tool_names: list[str]) -> TaskAssessment:
        """Run the full task analysis and return an assessment."""
        d = self.compute_decomposability(task_text)
        t = self.count_tools(active_tool_names)

        d_ok = d > self.decomposability_threshold
        t_ok = t < self.tool_count_threshold
        eligible = d_ok and t_ok

        if eligible:
            reason = (
                f"D={d:.3f} > {self.decomposability_threshold}, "
                f"T={t} < {self.tool_count_threshold}; "
                f"task suitable for MAS (beta={COORDINATION_BETA})"
            )
        else:
            parts: list[str] = []
            if not d_ok:
                parts.append(
                    f"D={d:.3f} <= {self.decomposability_threshold} "
                    f"(low decomposability)"
                )
            if not t_ok:
                parts.append(
                    f"T={t} >= {self.tool_count_threshold} "
                    f"(coordination overhead dominates)"
                )
            reason = f"MAS not recommended: {'; '.join(parts)}"

        return TaskAssessment(
            decomposability_score=d,
            tool_count=t,
            mas_eligible=eligible,
            reason=reason,
        )
