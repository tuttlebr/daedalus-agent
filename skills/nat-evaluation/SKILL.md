---
name: nat-evaluation
description: Use when designing, configuring, running, or troubleshooting NeMo Agent Toolkit evaluations, datasets, evaluator selection, ATIF surfaces, quality gates, custom evaluators, and `nat eval`.
author: NVIDIA Corporation and Affiliates
license: Apache-2.0
---

# NeMo Agent Toolkit Evaluation

## Goal

Measure agent quality and behavior with the smallest evaluation surface that can
answer the user's question. Success means the dataset, evaluator choice,
quality gate, command, and artifact to inspect are explicit.

## Workflow

1. Decide the evaluation surface and output format.
2. Decompose quality goals into separate evaluators.
3. Choose built-in evaluators before writing custom evaluators.
4. Keep datasets small and explicit for local validation.
5. Run `nat eval` and inspect generated artifacts.

## Stop Rule

Stop and ask for the missing evaluation target when the workflow, dataset,
backend endpoint, or pass/fail criterion is not inferable from the repo or user
request.

## References

- `references/operating-mode.md`
- `references/methodology.md`
- `references/agent-eval-framework.md`
- `references/evaluation-surfaces.md`
- `references/evaluation-contract.md`
- `references/evaluators/`
- `references/code-patterns.md`
