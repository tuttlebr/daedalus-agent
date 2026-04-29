"""Capability gate for MAS architecture selection.

Gates MAS spawning based on estimated Single-Agent System (SAS) accuracy.
When SAS accuracy is already sufficient (>= threshold), the coordination
overhead of MAS produces negative returns.

Constants derived from:
  - Table 4, Section 4.3 of 'Towards a Science of Scaling Agent Systems'
    (arXiv:2512.08296v2)
  - Capability coefficient: beta = -0.404, p < 0.001
"""

from dataclasses import dataclass
from typing import Any

# Paper-derived constant (Table 4)
CAPABILITY_BETA = -0.404


@dataclass(frozen=True, slots=True)
class CapabilityAssessment:
    """Result of the capability gate evaluation."""

    sas_accuracy_estimate: float | None
    threshold: float
    mas_eligible: bool
    has_calibration: bool
    sample_count: int
    reason: str


class CapabilityGate:
    """Decides whether MAS is justified based on estimated SAS baseline accuracy.

    Only proceeds with MAS when the estimated SAS accuracy falls below
    *threshold* (default 0.45). Above that, the single-agent system is
    already performing well enough that MAS coordination overhead produces
    negative returns (beta = -0.404).
    """

    def __init__(self, threshold: float = 0.45) -> None:
        self.threshold = threshold

    @staticmethod
    def _coerce_success(value: Any) -> float | None:
        """Return a valid 0.0-1.0 success score, or None."""
        if isinstance(value, bool):
            return None
        try:
            score = float(value)
        except (TypeError, ValueError):
            return None
        if 0.0 <= score <= 1.0:
            return score
        return None

    def _extract_success(self, value: Any) -> float | None:
        """Find a success score in common memory payload shapes."""
        if isinstance(value, dict):
            if "success" in value:
                score = self._coerce_success(value.get("success"))
                if score is not None:
                    return score
            if "success_score" in value:
                score = self._coerce_success(value.get("success_score"))
                if score is not None:
                    return score
            for key in ("metadata", "key_value_pairs", "data"):
                nested = value.get(key)
                score = self._extract_success(nested)
                if score is not None:
                    return score
        return None

    def _collect_success_scores(self, memory_results: list[dict]) -> list[float]:
        """Extract valid calibration scores and ignore unrelated memories."""
        scores: list[float] = []
        for memory in memory_results:
            score = self._extract_success(memory)
            if score is not None:
                scores.append(score)
        return scores

    def estimate_sas_accuracy(self, memory_results: list[dict]) -> float:
        """Estimate SAS accuracy from stored outcome memories.

        Each memory dict should contain a ``success`` key with a float
        0.0-1.0. Missing, unparseable, or out-of-range values are
        ignored so unrelated memories do not look like failures.

        Returns the configured threshold when no usable calibration
        exists. Call ``evaluate`` when the eligibility decision needs
        to distinguish neutral/no-calibration from an observed threshold
        score.
        """
        scores = self._collect_success_scores(memory_results)
        if not scores:
            return self.threshold
        return sum(scores) / len(scores)

    def evaluate(self, memory_results: list[dict]) -> CapabilityAssessment:
        """Run the capability gate and return an assessment."""
        scores = self._collect_success_scores(memory_results)
        has_calibration = bool(scores)
        accuracy = sum(scores) / len(scores) if scores else None
        eligible = not has_calibration or accuracy < self.threshold

        if not has_calibration:
            reason = (
                "No valid SAS/MAS outcome calibration found; capability gate "
                "is neutral and MAS may proceed if task analysis passes"
            )
        elif eligible:
            reason = (
                f"SAS accuracy {accuracy:.3f} < {self.threshold} threshold "
                f"(beta={CAPABILITY_BETA}); MAS may improve outcomes"
            )
        else:
            reason = (
                f"SAS accuracy {accuracy:.3f} >= {self.threshold} threshold; "
                f"SAS sufficient, MAS overhead not justified"
            )

        return CapabilityAssessment(
            sas_accuracy_estimate=accuracy,
            threshold=self.threshold,
            mas_eligible=eligible,
            has_calibration=has_calibration,
            sample_count=len(scores),
            reason=reason,
        )
