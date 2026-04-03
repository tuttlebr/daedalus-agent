"""Task decomposability, sequential interdependence, and architecture selection.

Computes three signals that determine MAS routing:

  D (decomposability) -- how parallelizable the task is.
  SI (sequential interdependence) -- how tightly coupled the steps are.
  Task type -- whether the task is structured analysis or exploratory.

MAS is recommended only when effective_D > threshold AND T < ceiling,
where effective_D = D * (1 - SI) penalises tasks with illusory
parallelism (high D but also high sequential coupling).

Architecture selection follows the paper's domain-specific findings:
  - Centralized: best for structured analysis (+80.9% Finance Agent)
  - Decentralized: best for exploratory/web research (+9.2% BrowseComp)

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

# ---------------------------------------------------------------------------
# Keyword sets
# ---------------------------------------------------------------------------

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

# Indicators of tight inter-step coupling (output of step N feeds step N+1).
# These distinguish genuinely sequential tasks (PlanCraft: -70%) from tasks
# that merely use ordering words for clarity (Finance Agent: +81%).
INTERDEPENDENCE_INDICATORS: frozenset[str] = frozenset(
    {
        "output of",
        "result of",
        "depends on",
        "based on the previous",
        "using the result",
        "feeds into",
        "requires the",
        "after completing",
        "once you have",
        "from the previous",
        "with the output",
        "chain",
        "pipeline",
        "step by step",
        "in order to",
        "sequentially",
        "one at a time",
        "craft",
        "build upon",
        "prerequisite",
    }
)

# Indicators of exploratory / web-research tasks (decentralized +9.2%)
EXPLORATION_INDICATORS: frozenset[str] = frozenset(
    {
        "search for",
        "browse",
        "explore",
        "look up",
        "look into",
        "find out",
        "discover",
        "research",
        "investigate",
        "gather information",
        "what is",
        "who is",
        "what are",
        "latest",
        "recent news",
        "current status",
        "news about",
        "tell me about",
        "learn about",
    }
)

# Indicators of structured analysis tasks (centralized +80.9%)
ANALYSIS_INDICATORS: frozenset[str] = frozenset(
    {
        "analyze",
        "compare",
        "evaluate",
        "assess",
        "review",
        "synthesize",
        "calculate",
        "estimate",
        "determine",
        "diagnose",
        "recommend",
        "design",
        "architect",
        "plan",
        "audit",
        "benchmark",
        "trade-off",
        "tradeoff",
        "pros and cons",
        "cost-benefit",
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
    sequential_interdependence: float
    effective_decomposability: float
    tool_count: int
    mas_eligible: bool
    recommended_architecture: str  # "centralized" | "decentralized"
    reason: str


class TaskAnalyzer:
    """Analyzes a task description to decide MAS eligibility and architecture.

    MAS is eligible when:
      - effective D > *decomposability_threshold* (default 0.35)
      - active tool count T < *tool_count_threshold* (default 12)

    Where effective D = D * (1 - SI), penalising tasks with sequential
    interdependence that makes apparent parallelism illusory.

    Architecture selection:
      - Exploratory / web research tasks -> decentralized (BrowseComp +9.2%)
      - Structured analysis tasks -> centralized (Finance Agent +80.9%)
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
    def compute_sequential_interdependence(task_text: str) -> float:
        """Compute sequential interdependence score SI in [0.0, 1.0].

        High SI means steps are tightly coupled (output of step N feeds
        step N+1).  This penalises the decomposability score because
        tasks like PlanCraft (D=0.42, SI high) degrade -70% under MAS,
        while Finance Agent (D=0.41, SI low) improves +81%.
        """
        text_lower = task_text.lower()

        interdep_count = sum(
            1 for ind in INTERDEPENDENCE_INDICATORS if ind in text_lower
        )
        sequential_count = sum(1 for ind in SEQUENTIAL_INDICATORS if ind in text_lower)

        # Denominator: total structural signals (parallel + sequential +
        # interdependence + action verbs).  Avoid division by zero.
        parallel_count = sum(1 for ind in PARALLEL_INDICATORS if ind in text_lower)
        action_verbs = set(_ACTION_VERB_PATTERN.findall(text_lower))
        total = parallel_count + sequential_count + interdep_count + len(action_verbs)
        if total == 0:
            return 0.0

        # SI weights interdependence indicators more heavily than plain
        # sequential words because "first ... then" can be stylistic,
        # while "using the result of" signals real coupling.
        si = (interdep_count * 2 + sequential_count) / (total + 1)
        return min(1.0, si)

    @staticmethod
    def classify_task_type(task_text: str) -> str:
        """Classify task as 'exploratory' or 'structured_analysis'.

        Paper findings (Section 4.2):
          - Decentralized excels at exploratory tasks (BrowseComp +9.2%)
          - Centralized excels at structured analysis (Finance +80.9%)
        """
        text_lower = task_text.lower()

        exploration_score = sum(
            1 for ind in EXPLORATION_INDICATORS if ind in text_lower
        )
        analysis_score = sum(1 for ind in ANALYSIS_INDICATORS if ind in text_lower)

        if exploration_score > analysis_score:
            return "exploratory"
        return "structured_analysis"

    @staticmethod
    def count_tools(active_tool_names: list[str]) -> int:
        """Return the number of active tools."""
        return len(active_tool_names)

    def evaluate(self, task_text: str, active_tool_names: list[str]) -> TaskAssessment:
        """Run the full task analysis and return an assessment."""
        d = self.compute_decomposability(task_text)
        si = self.compute_sequential_interdependence(task_text)
        t = self.count_tools(active_tool_names)
        task_type = self.classify_task_type(task_text)

        # Effective decomposability: penalise by sequential interdependence.
        # Finance Agent (D=0.41, SI~0) -> effective_d ~ 0.41 (passes)
        # PlanCraft  (D=0.42, SI~0.5) -> effective_d ~ 0.21 (fails)
        effective_d = d * (1.0 - si)

        d_ok = effective_d > self.decomposability_threshold
        t_ok = t < self.tool_count_threshold
        eligible = d_ok and t_ok

        # Architecture: centralized (default, lowest error amp 4.4x)
        # or decentralized (better for exploratory, 7.8x error amp)
        if task_type == "exploratory":
            arch = "decentralized"
        else:
            arch = "centralized"

        if eligible:
            reason = (
                f"D={d:.3f}, SI={si:.3f}, effective_D={effective_d:.3f} "
                f"> {self.decomposability_threshold}, "
                f"T={t} < {self.tool_count_threshold}; "
                f"task suitable for MAS ({arch}, beta={COORDINATION_BETA})"
            )
        else:
            parts: list[str] = []
            if not d_ok:
                parts.append(
                    f"effective_D={effective_d:.3f} <= "
                    f"{self.decomposability_threshold} "
                    f"(D={d:.3f}, SI={si:.3f})"
                )
            if not t_ok:
                parts.append(
                    f"T={t} >= {self.tool_count_threshold} "
                    f"(coordination overhead dominates)"
                )
            reason = f"MAS not recommended: {'; '.join(parts)}"

        return TaskAssessment(
            decomposability_score=d,
            sequential_interdependence=si,
            effective_decomposability=effective_d,
            tool_count=t,
            mas_eligible=eligible,
            recommended_architecture=arch,
            reason=reason,
        )
