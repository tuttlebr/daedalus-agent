# Agent Setup Audit

This audit is measurement-first. Do not simplify prompts, tools, or agents
until a workflow has a baseline for correctness, token cost, p95 latency, and
failure modes.

## Audit Target

Use production traces when privacy-safe. If production traces are unavailable,
run the same commands against staging with the production backend config and
model endpoints.

Priority workflow slices:

| Priority | Workflow | Audience | Primary quality bar |
| --- | --- | --- | --- |
| 1 | Top-level chat routing | customer-facing | Correct simple/substantive split, correct SAS/MAS/skill route, no unnecessary tools |
| 2 | Research answers | customer-facing | Factual accuracy, source freshness, citation faithfulness, concise synthesis |
| 3 | Ops workflows | employee-facing | Correct read/write split, MCP tool success, guarded destructive actions |
| 4 | User documents | customer-facing | Per-user isolation, successful ingest/retrieval, graceful empty states |
| 5 | Media workflows | customer-facing | Correct media tool, verbatim image refs, transcript structure |
| 6 | MAS workflows | customer-facing | MAS only when it improves quality, verifier use, bounded coordination overhead |
| 7 | Autonomous agent | internal-only | High-signal memories, source verification, cycle completion before timeout |
| 8 | Deployment regression path | internal-only | Config/model version traceability, eval approval, rollback readiness |

Optimize for p95 behavior. Escalate to p99 or worst-case review for destructive
ops, memory deletion, privacy-sensitive uploads, and autonomous memory writes.

## Commands

Validate audit assets without calling a backend:

```bash
python3 evals/runner.py --validate-only --dataset routing --dataset factuality --dataset workflows
```

Run the default correctness suites:

```bash
./run-eval.sh --dataset routing --dataset factuality
```

Run the broader workflow audit suite. This can invoke live tools, including
image generation and MCP reads, so prefer staging first:

```bash
./run-eval.sh --dataset workflows
```

Run against a production or staging backend:

```bash
DAEDALUS_BACKEND_URL=https://<host> ./run-eval.sh --dataset workflows
```

By default, `run-eval.sh` assumes the backend is running in Kubernetes and
port-forwards `svc/daedalus-backend-default` from namespace `daedalus`. Override
with `DAEDALUS_KUBE_NAMESPACE`, `DAEDALUS_KUBE_BACKEND_SERVICE`,
`DAEDALUS_KUBE_BACKEND_PORT`, `DAEDALUS_EVAL_LOCAL_PORT`, or
`DAEDALUS_KUBE_CONTEXT` if your cluster naming differs. The port-forward binds
to `0.0.0.0` by default so the Dockerized eval runner can reach it through
`host.docker.internal`; override `DAEDALUS_EVAL_PORT_FORWARD_ADDRESS` if needed.

Results are written to `evals/results/<timestamp>.json`. Use:

- `datasets.*.metrics.latency_s.p95` for workflow p95 latency
- `datasets.*.metrics.total_tokens.p95` for p95 token cost
- `datasets.*.metrics.tool_call_count.p95` for orchestration overhead
- `datasets.*.metrics.by_workflow` for one-page workflow summaries
- `cases[*].events` for replay/debugging of route and tool decisions

## One-Page Workflow Report

Fill this out for each priority workflow after collecting traces:

```text
Workflow:
Owner:
Audience:
Business criticality:
Expected answer format:
Quality bar:
Failure tolerance:
Current p50/p95 latency:
Current avg/p95 token usage:
Current correctness score:
Top 3 failure modes:
Top 3 token sinks:
Top 3 latency sinks:
Unnecessary agents/tools:
Recommended changes:
Expected impact:
Regression tests/evals to add:
Rollout risk:
```

## Measurement Checklist

Correctness:

- Verify route decisions at every decision point: top-level classification,
  `mas_evaluate`, skill selection, sub-agent selection, tool choice, final
  synthesis, source verification, and post-processing.
- Score routing correctness, tool-use correctness, final-answer correctness,
  citation/source faithfulness, instruction following, safety/policy behavior,
  and schema/format adherence separately.
- Capture known bad answers, slow answers, expensive answers, and adversarial
  inputs in eval datasets.

Token cost:

- Break token cost down by system/developer prompt, user input, retrieved
  context, tool results, agent-to-agent messages, final answer, and retries.
- Identify prompts/tool descriptions included on every call but needed only on
  some paths.
- Replace raw tool outputs with filtered or distilled results where trace data
  shows repeated high-token sinks.

Latency:

- Measure time-to-first-token and time-to-final-answer separately.
- Attribute time to model inference, retrieval, external APIs, tool execution,
  agent handoffs, retries, and validation.
- Identify serial calls that have no real dependency and calls blocked only by
  implementation structure.

Architecture:

- Keep agents only where evals prove value over a cheaper path.
- Convert fixed workflows to direct tool calls or fixed DAGs when the route is
  deterministic.
- Use structured outputs or validators where correctness depends on format,
  schema, or tool arguments.

Deployment:

- Log workflow config version, prompt/config hash, model version, route
  decision, tool calls, tool results, retries, and final answer for every run.
- Gate prompt/config/model changes on eval pass rate plus p95 token and latency
  budgets.
- Make workflow config rollback independent from application code rollback.

## Current Repo Baseline

Observed from static repo inspection:

- Backend workflow is a single NeMo Agent Toolkit tool-calling config with
  four sub-agents: research, ops, media, and user data.
- `mas_optimizer` implements SAS/MAS routing, architecture selection, verifier,
  and outcome logging.
- Phoenix tracing is configured in `general.telemetry.tracing`.
- Existing evals cover routing and observational factuality; the workflow audit
  dataset adds broader runnable coverage.
- The checked-in eval result from 2026-04-18 is not a valid correctness
  baseline because the backend was unreachable.
- Frontend usage tracking can undercount intermediate/tool tokens, so final
  audit token baselines should come from NAT/Phoenix/profiler traces.
