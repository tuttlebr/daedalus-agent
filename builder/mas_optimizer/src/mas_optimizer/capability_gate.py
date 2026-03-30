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

# Paper-derived constant (Table 4)
CAPABILITY_BETA = -0.404


@dataclass(frozen=True, slots=True)
class CapabilityAssessment:
    """Result of the capability gate evaluation."""

    sas_accuracy_estimate: float
    threshold: float
    mas_eligible: bool
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

    def estimate_sas_accuracy(self, memory_results: list[dict]) -> float:
        """Estimate SAS accuracy from stored outcome memories.

        Each memory dict should contain a ``success`` key with a float
        0.0-1.0.  Missing or unparseable values are treated as 0.0.

        Returns 0.0 when no history exists (conservative: allows MAS).
        """
        if not memory_results:
            return 0.0

        total = 0.0
        count = 0
        for m in memory_results:
            try:
                val = float(m.get("success", 0))
            except (TypeError, ValueError):
                val = 0.0
            total += val
            count += 1

        return total / count if count else 0.0

    def evaluate(self, memory_results: list[dict]) -> CapabilityAssessment:
        """Run the capability gate and return an assessment."""
        accuracy = self.estimate_sas_accuracy(memory_results)
        eligible = accuracy < self.threshold

        if eligible:
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
            reason=reason,
        )
