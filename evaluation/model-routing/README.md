# Frozen routing workload

This is historical evidence from the NeMo runtime. Reproduce these published
results using the original image recorded in `provenance.json` and the archived
runner in `legacy/`. It is not a benchmark of the current Rust runtime. Use
`builder/runtime_http_check.py` for current runtime integration checks.

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

## Reproduce

First build the backend image and run its deterministic HTTP checks as described
in [the operator guide](../../docs/model-routing.md#verification). Prepare three
reachable Switchyard endpoints using the routes/targets recorded in
`provenance.json`: deployed baseline, isolated proposed policy and isolated
DeepSeek low/high alternative. Supply the normal transport and credentials
through each gateway's existing configuration mechanism. Never change production
policy merely to run this evaluation.

The compatibility probe uses only the Python standard library:

```bash
python3 scripts/smoke_model_routing.py \
  --base-url http://127.0.0.1:14001/v1 --output /tmp/routing-smoke.json
```

Set `OPENAI_API_KEY` in the environment if the gateway requires authentication.
The evaluator uses packages installed in the backend image and writes bounded
results after every completed sample:

```bash
mkdir -p /tmp/routing-results
docker run --rm --network host --entrypoint python \
  --user "$(id -u):$(id -g)" -e OPENAI_API_KEY \
  -v "$PWD/evaluation/model-routing/legacy/evaluate_model_routing.py:/evaluation_runner.py:ro" \
  -v "$PWD/evaluation/model-routing:/evaluation:ro" \
  -v /tmp/routing-results:/results \
  ORIGINAL_NEMO_BACKEND_IMAGE /evaluation_runner.py \
  --fixtures /evaluation \
  --baseline-url http://127.0.0.1:14000/v1 \
  --proposed-url http://127.0.0.1:14001/v1 \
  --deepseek-url http://127.0.0.1:14002/v1 \
  --output /results/results.json --repeats 2
```

`--resume` preserves completed samples and rejects changed task or price
assumptions. If a process is interrupted during a provider call, record that
candidate's unmeasured attempt under `harness_interruptions` in the saved report;
its total cost must remain unknown. A timeout does not authorize silently
discarding attempts or restarting the entire comparison.

The saved run's JSON schema describes nullable winner fields as `string or null`
without revealing the expected value. One in-flight attempt was interrupted to
correct this schema description before any winner task ran; all 20 unaffected
completed samples were retained. Its unmeasured cost remains in the report.
Canonical JSON task hashes identify the frozen content independently of
formatting. Results and deployment limitations are discussed in the
[verification report](../../docs/model-routing-validation.md).
