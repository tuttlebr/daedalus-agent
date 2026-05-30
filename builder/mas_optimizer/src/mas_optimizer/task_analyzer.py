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

# Requests tied to one concrete execution surface are cheaper and more reliable
# as SAS even when they include multiple verbs.
SINGLE_DOMAIN_SAS_INDICATORS: frozenset[str] = frozenset(
    {
        "uploaded document",
        "uploaded documents",
        "my doc",
        "my docs",
        "the pdf i uploaded",
        "that report",
        "documentref",
        "imageref",
        "videoref",
        "generate an image",
        "edit image",
        "describe image",
        "summarize this vtt",
        "summarize this transcript",
        "meeting transcript",
        "list the pods",
        "describe pod",
        "open pull requests",
        "merged pull requests",
        "pull requests",
        "pull-request status",
        "pr status",
    }
)

# Coding/debugging is a single execution surface for this deployment. These
# tasks may contain many verbs, but spawning a MAS procedure usually adds
# coordination overhead instead of improving the code path.
CODING_SAS_INDICATORS: frozenset[str] = frozenset(
    {
        "backend tests",
        "codebase",
        "debug",
        "failing test",
        "failing tests",
        "implement a fix",
        "lint",
        "pytest",
        "refactor",
        "regression coverage",
        "repository",
        "root cause",
        "stack trace",
        "test failure",
        "traceback",
    }
)

# Structured analysis over independent source families is the class of task that
# benefits from a centralized MAS even when natural wording includes a mild
# sequential phrase such as "then cross-check".
STRUCTURED_MULTI_SOURCE_ANALYSIS_INDICATORS: frozenset[str] = frozenset(
    {
        "filing",
        "financial filing",
        "earnings call",
        "transcript",
        "competitor",
        "10-k",
        "10-q",
        "analyst notes",
        "revenue growth",
        "margin",
        "operating margin",
        "capex",
        "ai infrastructure",
        "comparison table",
        "structured comparison",
        "cross-check",
        "alongside",
    }
)

STRUCTURED_MULTI_SOURCE_MIN_SIGNALS = 3
STRUCTURED_MULTI_SOURCE_THRESHOLD_DISCOUNT = 0.17

EXPLORATORY_MULTI_SOURCE_INDICATORS: frozenset[str] = frozenset(
    {
        "at least five",
        "broad",
        "cross-validate",
        "emerging pattern",
        "explore the public web",
        "five independent",
        "gather leads",
        "independent leads",
        "independent sources",
        "multiple independent",
        "novel applications",
        "public web",
        "surface surprising",
        "surprising findings",
    }
)

EXPLORATORY_MULTI_SOURCE_MIN_SIGNALS = 2

# Top-level execution domains exposed by the orchestrator. When these are
# present, lower-level helper tools should not inflate the coordination count.
ROUTING_DOMAIN_TOOLS: frozenset[str] = frozenset(
    {
        "research_agent",
        "nvidia_docs_agent",
        "ops_agent",
        "user_data_agent",
    }
)

# Tools that support orchestration, memory, or routing. They add latency but do
# not represent independent task-solving domains for MAS overhead purposes.
META_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "add_memory",
        "agent_skills_tool",
        "current_datetime_tool",
        "delete_memory",
        "get_memory",
        "mas_optimizer_tool",
        "ops_confirmation_tool",
        "user_interaction_tool",
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
    routing_basis: str
    matched_signals: dict[str, list[str]]
    bypass_reason: str | None


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
    def _matched_indicators(task_text: str, indicators: frozenset[str]) -> list[str]:
        text_lower = task_text.lower()
        return sorted(ind for ind in indicators if ind in text_lower)

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

        if any(ind in text_lower for ind in CODING_SAS_INDICATORS):
            return "structured_analysis"

        exploration_score = sum(
            1 for ind in EXPLORATION_INDICATORS if ind in text_lower
        )
        analysis_score = sum(1 for ind in ANALYSIS_INDICATORS if ind in text_lower)

        if exploration_score > analysis_score:
            return "exploratory"
        return "structured_analysis"

    @staticmethod
    def is_single_domain_sas(task_text: str) -> bool:
        """Return true for tasks that should stay on one specialist path."""
        text_lower = task_text.lower()
        return any(ind in text_lower for ind in SINGLE_DOMAIN_SAS_INDICATORS)

    @staticmethod
    def is_coding_sas(task_text: str) -> bool:
        """Return true for coding/debugging tasks that should stay SAS."""
        text_lower = task_text.lower()
        return any(ind in text_lower for ind in CODING_SAS_INDICATORS)

    @staticmethod
    def is_structured_multi_source_analysis(task_text: str) -> bool:
        """Return true for structured analysis across independent sources."""
        text_lower = task_text.lower()
        source_signals = sum(
            1
            for ind in STRUCTURED_MULTI_SOURCE_ANALYSIS_INDICATORS
            if ind in text_lower
        )
        analysis_signals = sum(1 for ind in ANALYSIS_INDICATORS if ind in text_lower)
        return (
            source_signals >= STRUCTURED_MULTI_SOURCE_MIN_SIGNALS
            and analysis_signals > 0
        )

    @staticmethod
    def is_exploratory_multi_source_research(task_text: str) -> bool:
        """Return true for broad research across independent public sources."""
        text_lower = task_text.lower()
        source_signals = sum(
            1 for ind in EXPLORATORY_MULTI_SOURCE_INDICATORS if ind in text_lower
        )
        exploration_signals = sum(
            1 for ind in EXPLORATION_INDICATORS if ind in text_lower
        )
        return (
            source_signals >= EXPLORATORY_MULTI_SOURCE_MIN_SIGNALS
            and exploration_signals > 0
        )

    @staticmethod
    def normalize_tool_names(active_tool_names: list[str]) -> list[str]:
        """Return effective execution tools for coordination-overhead scoring."""
        cleaned = {
            tool.strip()
            for tool in active_tool_names
            if isinstance(tool, str) and tool.strip()
        }

        routing_domains = sorted(cleaned & ROUTING_DOMAIN_TOOLS)
        if routing_domains:
            return routing_domains

        return sorted(tool for tool in cleaned if tool not in META_TOOL_NAMES)

    @classmethod
    def count_tools(cls, active_tool_names: list[str]) -> int:
        """Return the effective number of active execution tools."""
        return len(cls.normalize_tool_names(active_tool_names))

    def evaluate(self, task_text: str, active_tool_names: list[str]) -> TaskAssessment:
        """Run the full task analysis and return an assessment."""
        matched_signals = {
            "parallel": self._matched_indicators(task_text, PARALLEL_INDICATORS),
            "sequential": self._matched_indicators(task_text, SEQUENTIAL_INDICATORS),
            "interdependence": self._matched_indicators(
                task_text, INTERDEPENDENCE_INDICATORS
            ),
            "exploration": self._matched_indicators(task_text, EXPLORATION_INDICATORS),
            "analysis": self._matched_indicators(task_text, ANALYSIS_INDICATORS),
            "single_domain_sas": self._matched_indicators(
                task_text, SINGLE_DOMAIN_SAS_INDICATORS
            ),
            "coding_sas": self._matched_indicators(task_text, CODING_SAS_INDICATORS),
            "structured_multi_source": self._matched_indicators(
                task_text, STRUCTURED_MULTI_SOURCE_ANALYSIS_INDICATORS
            ),
            "exploratory_multi_source": self._matched_indicators(
                task_text, EXPLORATORY_MULTI_SOURCE_INDICATORS
            ),
        }
        d = self.compute_decomposability(task_text)
        si = self.compute_sequential_interdependence(task_text)
        t = self.count_tools(active_tool_names)
        task_type = self.classify_task_type(task_text)

        # Effective decomposability: penalise by sequential interdependence.
        # Finance Agent (D=0.41, SI~0) -> effective_d ~ 0.41 (passes)
        # PlanCraft  (D=0.42, SI~0.5) -> effective_d ~ 0.21 (fails)
        effective_d = d * (1.0 - si)

        effective_threshold = self.decomposability_threshold
        structured_multi_source = self.is_structured_multi_source_analysis(task_text)
        exploratory_multi_source = self.is_exploratory_multi_source_research(task_text)
        if structured_multi_source and task_type == "structured_analysis":
            effective_threshold = max(
                0.0,
                self.decomposability_threshold
                - STRUCTURED_MULTI_SOURCE_THRESHOLD_DISCOUNT,
            )

        single_domain_sas = self.is_single_domain_sas(task_text)
        coding_sas = self.is_coding_sas(task_text)

        d_ok = effective_d > effective_threshold
        t_ok = t < self.tool_count_threshold
        eligible = d_ok and t_ok and not single_domain_sas and not coding_sas
        bypass_reasons: list[str] = []
        if single_domain_sas:
            bypass_reasons.append(
                "single-domain request should use SAS/specialist routing"
            )
        if coding_sas:
            bypass_reasons.append(
                "coding/debugging request should use SAS/skill routing"
            )
        bypass_reason = "; ".join(bypass_reasons) or None

        # Architecture: centralized (default, lowest error amp 4.4x)
        # or decentralized (better for exploratory, 7.8x error amp)
        if exploratory_multi_source:
            arch = "decentralized"
        else:
            arch = "centralized"

        if structured_multi_source:
            routing_basis = "structured_multi_source_analysis"
        elif exploratory_multi_source:
            routing_basis = "exploratory_multi_source_research"
        elif eligible:
            routing_basis = "general_decomposable_task"
        else:
            routing_basis = "single_agent_or_specialist"

        if eligible:
            reason = (
                f"D={d:.3f}, SI={si:.3f}, effective_D={effective_d:.3f} "
                f"> {effective_threshold:.3f}, "
                f"T={t} < {self.tool_count_threshold}; "
                f"task suitable for MAS ({arch}, beta={COORDINATION_BETA})"
            )
        else:
            parts: list[str] = []
            if bypass_reason:
                parts.append(bypass_reason)
            if not d_ok:
                parts.append(
                    f"effective_D={effective_d:.3f} <= "
                    f"{effective_threshold:.3f} "
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
            routing_basis=routing_basis,
            matched_signals=matched_signals,
            bypass_reason=bypass_reason,
        )
