"""Factuality evaluator — observational.

Reads source_verifier verdicts that the agent itself produced during
the run (it calls verify_claim before add_memory for findings). This is
production-parity: we measure the same verifier the agent uses.

Dataset cases should be crafted to induce findings / memory storage,
otherwise the agent will not call verify_claim and no verdicts will
exist to score.

Dataset schema per case:

    - id: <string>
      query: <string>
      min_verifications: 1  # optional, default 1
      min_supported_fraction: 0.8  # optional, default 0.8
"""

from __future__ import annotations

from evaluators._common import EvalScore, parse_json_blob

SUPPORTED = {"supported"}
PARTIAL = {"partially_supported"}
UNSUPPORTED = {"unsupported", "source_unreachable", "insufficient_context", "error"}

VERIFIER_NAMES = ("source_verifier", "verify_claim")


def _is_verify_claim_event(name: str) -> bool:
    lowered = name.lower()
    return any(v in lowered for v in VERIFIER_NAMES)


def score(case: dict, trace) -> EvalScore:
    min_verifications = int(case.get("min_verifications", 1))
    threshold = float(case.get("min_supported_fraction", 0.8))

    verdicts: list[dict] = []
    for ev in trace.events:
        if ev.event_type != "TOOL_END":
            continue
        if not _is_verify_claim_event(ev.name):
            continue
        parsed = parse_json_blob(ev.payload)
        if parsed:
            verdicts.append(parsed)

    if not verdicts:
        return EvalScore(
            score=0.0,
            passed=False,
            detail={
                "reasons": [
                    "no source_verifier verdicts observed; "
                    "prompt may not have triggered a finding-type add_memory"
                ],
                "n_verifications": 0,
            },
        )

    n_sup = sum(1 for v in verdicts if (v.get("verdict") or "").lower() in SUPPORTED)
    n_partial = sum(1 for v in verdicts if (v.get("verdict") or "").lower() in PARTIAL)
    n_unsup = sum(
        1 for v in verdicts if (v.get("verdict") or "").lower() in UNSUPPORTED
    )
    n_total = len(verdicts)

    score_val = (n_sup + 0.5 * n_partial) / n_total

    reasons: list[str] = []
    if n_total < min_verifications:
        reasons.append(
            f"only {n_total} verdicts, expected at least {min_verifications}"
        )

    unsupported = [
        v for v in verdicts if (v.get("verdict") or "").lower() in UNSUPPORTED
    ]
    if unsupported:
        samples = "; ".join(
            (v.get("reasoning") or v.get("evidence") or "(no detail)")[:120]
            for v in unsupported[:3]
        )
        reasons.append(f"{len(unsupported)} unsupported: {samples}")

    passed = (score_val >= threshold) and (n_total >= min_verifications)

    return EvalScore(
        score=round(score_val, 3),
        passed=passed,
        detail={
            "reasons": reasons,
            "n_verifications": n_total,
            "n_supported": n_sup,
            "n_partial": n_partial,
            "n_unsupported": n_unsup,
            "verdicts": [
                {
                    k: v.get(k)
                    for k in ("verdict", "source_url", "confidence", "reasoning")
                }
                for v in verdicts[:20]
            ],
        },
    )
