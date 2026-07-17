---
name: nat-optimization
description: >-
  Use when configuring or running NeMo Agent Toolkit optimization with nat
  optimize, including Optuna hyperparameter tuning, prompt evolution via
  genetic algorithm, choosing n_trials and parallelism, the config-optimizer
  extra, defining the search space and optimizer dataset, and interpreting
  output artifacts before writing tuned values back to workflow YAML. Use
  nat-evaluation to define evaluators and measure quality, which optimization
  then consumes as objectives; do not use this skill for a one-off quality
  check or for latency/throughput profiling, which belongs to nat-telemetry.
author: NVIDIA Corporation and Affiliates
license: Apache-2.0
---

# NeMo Agent Toolkit Optimization

Use this skill when improving workflow quality through `nat optimize`.

## Workflow

1. Fix workflow correctness issues before optimizing.
2. Size the run and explain the chosen `n_trials`, parallelism, and stopping behavior.
3. Use separate evaluators for separate quality dimensions.
4. Run `nat optimize` with a generous timeout.
5. Inspect output artifacts before writing tuned values back to workflow YAML.

## Guardrail

Do not kill `nat optimize` mid-run unless the user asks. It writes final artifacts when the study finishes cleanly.

## References

- `references/overview.md`
- `references/choosing-parameters.md`
- `references/configuration.md`
- `references/output-and-cli.md`
- `references/complete-config-example.md`
- `references/optimizer_example_dataset.json`
