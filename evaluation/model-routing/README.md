# Frozen routing workload

This directory preserves historical evidence from the retired NeMo runtime.
The obsolete evaluator has been removed; its source remains in Git history at
`987e57f:evaluation/model-routing/legacy/evaluate_model_routing.py`. Reproducing
these results requires that evaluator and the original image recorded in
`provenance.json`. The current backend does not include its NeMo dependencies.

Use `builder/runtime_http_check.py` for current runtime integration checks and
[the runtime compatibility guide](../../docs/rust-migration.md) for performance
measurement procedures. The JSON results here do not benchmark the Rust runtime.

Frozen before candidate comparison on 2026-09-16: 24 synthetic tasks covering
routine lookups, daily-summary selection, fantasy finality and score arithmetic,
infrastructure diagnosis, synthesis, reasoning and one image input. Each task
has independently specified evidence and an exact JSON answer. Tasks read
evidence through tools; mapped tasks load main skill instructions before reading
evidence. No private conversations, live account data or external actions are
part of this workload.

Predeclared gates:

- Routing/isolation: 100% of deterministic HTTP and policy checks must pass.
- Quality: at least 95% exact correct answers and no reduction in successful
  tasks relative to baseline. Report failures; do not discard or silently retry.
- Schema: every successful answer must parse as the exact requested JSON shape.
- Tool use: report missing and extra evidence/skill calls independently of answer
  correctness. No generic model recovery is added for evaluation.
- Latency/cost: descriptive comparisons only, with no claimed SLA or savings
  threshold. Include every failed attempt and all observed model calls. Unknown
  usage/cache data yields unknown cost, never zero. Reasoning tokens included in
  output usage are not counted twice.

Compare the live baseline (`capable_first`, threshold 0.5, window 3) with an
isolated proposed `efficient_first` gateway and an isolated alternative whose
weak/strong targets are DeepSeek low/high. Production route configuration stays
unchanged during evaluation. The proposed and alternative applications use the
same request and skill policy. Record image/config/task hashes with results.

Run two repetitions per candidate (48 tasks each) with a rotated candidate order.
Report per-category correctness, completion count, call counts, first output and
total time, usage, and estimated cost per successful task. Include medians,
observed ranges and sample sizes; tail estimates from 48 synthetic tasks are
exploratory. Provider cache warming and network/gateway placement are potential
confounders. This controlled workload does not measure full daily-newspaper
renderer quality or production OAuth/MCP latency; those require separate
deployment acceptance runs. Renderer checks must be reported as unmeasured here.

Price assumptions are frozen in `prices.json` from the linked official Fireworks
model pages. They are standard token-price estimates, not an invoice, and exclude
infrastructure charges. Fixture tools perform no model calls; the recorded
main-agent calls therefore cover all model costs in this controlled workload.

## Provider compatibility

The compatibility probe uses only the Python standard library:

```bash
python3 scripts/smoke_model_routing.py \
  --base-url http://127.0.0.1:14001/v1 --output /tmp/routing-smoke.json
```

Set `OPENAI_API_KEY` in the environment if the gateway requires authentication.
This checks the provider transport; it does not rerun the historical workload.

Canonical JSON task hashes identify frozen content independently of formatting.
The saved results include an interrupted attempt with unknown cost. Preserve
that interruption and unknown cost when interpreting the evidence; neither is
a successful sample or a measured zero.
