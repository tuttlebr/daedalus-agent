# Daedalus evaluation harness

Local-first evaluation for the Daedalus agent. Measures three things:

1. **Routing correctness** — does the orchestrator bypass MAS for direct
   SAS routes, call `mas_evaluate` for MAS candidates, and then delegate
   to the expected sub-agent or load the expected skill?
2. **Factuality (observational)** — when the agent naturally calls
   `source_verifier.verify_claim` before storing a finding, are the
   verdicts `supported`?
3. **Workflow audit contracts** — optional broader workflow cases that
   check required/forbidden tools, citations, output shape, latency budgets,
   token budgets, and tool-call counts.

Every run also records first-token latency, final latency, token usage
(reported when available, otherwise estimated), tool-call counts, unique tools,
and per-dataset p50/p95/p99 summaries.

## Quick start

```bash
./run-eval.sh                                  # default routing + factuality suite
./run-eval.sh --dataset routing                # one dataset
./run-eval.sh --dataset workflows              # broader audit suite; may invoke live tools
./run-eval.sh --case ops-001                   # one case
DAEDALUS_KUBE_NAMESPACE=daedalus ./run-eval.sh
DAEDALUS_KUBE_CONTEXT=my-context ./run-eval.sh
DAEDALUS_BACKEND_URL=https://<staging-or-prod-host> ./run-eval.sh
```

`run-eval.sh` assumes the Daedalus backend is running in Kubernetes. If
`DAEDALUS_BACKEND_URL` is unset, it opens a local `kubectl port-forward` to
`svc/daedalus-backend-default` in namespace `daedalus`, then runs the Dockerized
eval harness against that forwarded backend.

Useful Kubernetes defaults:

| var | default | purpose |
| --- | --- | --- |
| `DAEDALUS_KUBE_NAMESPACE` | `daedalus` | namespace containing the backend Service |
| `DAEDALUS_KUBE_BACKEND_SERVICE` | `daedalus-backend-default` | backend Service name |
| `DAEDALUS_KUBE_BACKEND_PORT` | `8000` | backend Service port |
| `DAEDALUS_EVAL_LOCAL_PORT` | `18000` | local port used for `kubectl port-forward` |
| `DAEDALUS_EVAL_PORT_FORWARD_ADDRESS` | `0.0.0.0` | bind address for `kubectl port-forward`; Docker needs a non-loopback bind |
| `DAEDALUS_KUBE_CONTEXT` | unset | optional kubectl context |

To bypass Kubernetes discovery and hit a specific backend directly:

```bash
DAEDALUS_BACKEND_URL=http://localhost:8000 python3 evals/runner.py --dataset workflows
DAEDALUS_BACKEND_URL=https://<staging-or-prod-host> ./run-eval.sh --dataset workflows
```

First run builds the image (~30s). Afterward, dataset and evaluator
edits on the host are picked up via volume mount — no rebuild needed.
If you change `requirements.txt` or the `Dockerfile`, rebuild with:

```bash
docker compose build evals
```

Results land in `evals/results/<timestamp>.json`. A markdown summary
prints to stdout; a non-zero exit code signals at least one failure.

Validate dataset and evaluator wiring without calling the backend:

```bash
python3 evals/runner.py --validate-only --dataset routing --dataset factuality --dataset workflows
```

### Native Python (optional)

If you already have Python and don't want Docker:

```bash
pip install -r evals/requirements.txt
python3 evals/runner.py --dataset routing
```

## Environment

| var | default | purpose |
| --- | --- | --- |
| `DAEDALUS_BACKEND_URL` | unset for `run-eval.sh`; `http://localhost:8000` for native runner | backend base URL |
| `DAEDALUS_EVAL_USER`   | `eval_user`              | user_id injected via `[IDENTITY]` |
| `DAEDALUS_EVAL_TIMEOUT` | `900` | per-request timeout (seconds) |
| `DAEDALUS_EVAL_PREFLIGHT_TIMEOUT` | `5` | backend reachability check timeout (seconds) |

The fixed eval user means memory accumulates across runs for that id.
If that becomes noisy, purge the user's memory between runs or switch
to a per-run id.

## How scoring works

The default run includes `routing` and `factuality`. The `workflows` dataset is
opt-in because it can invoke live integrations such as image generation and MCP
reads.

### Routing
The runner posts each case's `query` to `/chat/stream`, parses the SSE
for `intermediate_data:` tool events, and hands the trace to
`evaluators/routing.py`. It checks in order:

1. `mas_evaluate` was called only when expected; direct skill and direct
   single-domain SAS routes may bypass it
2. The mas_evaluate JSON matches the expected architecture label when present
3. The expected sub-agent appears as a `TOOL_START` event
4. The expected skill appears in an `agent_skills_tool` payload
5. No `forbidden_tools` were called

A case passes at `score >= 0.8`.

### Factuality
`evaluators/factuality.py` scans the trace for `verify_claim` /
`source_verifier` completions and aggregates verdicts:

```
score = (n_supported + 0.5 * n_partially_supported) / n_total
pass  = score >= min_supported_fraction AND n_total >= min_verifications
```

**Observational constraint:** the agent calls `verify_claim` only before
`add_memory` for findings (per the system prompt). Factuality cases must
be phrased to induce that behavior — e.g. "research X and remember the
answer". Cases that don't induce verification will fail with
`no source_verifier verdicts observed`.

### Workflow audit

`evaluators/workflow_audit.py` is deterministic. Each case can declare:

- `required_tools`
- `forbidden_tools`
- `min_tool_calls` / `max_tool_calls`
- `requires_citation`
- `response_contains`
- `response_regex`
- `max_latency_s`
- `max_total_tokens`

Use this suite to populate the workflow one-page audit in
`docs/agent-setup-audit.md`.

## Expanding the dataset

Start by editing `datasets/routing.yml` and `datasets/factuality.yml`.
Each file is a YAML list — add new entries with unique ids. Run a single
new case in isolation first:

```bash
./run-eval.sh --case <new-id>
```

Inspect `evals/results/<timestamp>.json` to see the full trace — the
`events` array shows every `TOOL_START` / `TOOL_END` and their payloads.
Use this to:
- Confirm your `expected` labels match what the agent actually does
- Debug misses (tool called under a different name, argument shape, etc.)

Good coverage targets:
- ~5 cases per sub-agent (research, ops, media, user_data) → 20
- ~5 skill-match cases (pr-monitor, debug-session, code-review, etc.)
- ~5 MAS cases (2-3 centralized, 2-3 decentralized)
- ~5 conversational / edge cases
- ~15 factuality cases (research-heavy, findings-inducing)
- p95 token and latency budgets per major workflow
- adversarial/messy inputs for every high-value workflow

## Known limitations (v1)

- **Stateful memory**: the eval user's memory grows across runs. Fine
  for now; revisit if results start drifting.
- **Factuality coverage** is bounded by whether the agent chooses to
  call `verify_claim`. A future iteration could post-hoc verify claims
  the agent made without citing — e.g. via a NAT-side wrapper that
  exposes `verify_claim` standalone.
- **Limited regression tracking**: `evals/results/` keeps dated runs and
  summary metrics, but there is no diffing UI yet. Compare JSONs manually or
  add a `compare.py` if trend tracking matters.
- **No parallelism**: cases run serially. Fine for ~30 cases; add
  asyncio or a thread pool if the dataset grows past ~100.
