# Daedalus Evaluation Harness

Local-first evaluation for the Daedalus agent. The harness posts queries to the
backend SSE endpoint, parses tool-call traces and final responses, and scores
them against three evaluators:

1. **Routing correctness** — does the orchestrator call the expected direct
   leaf tool or load the expected skill?
2. **Factuality (observational)** — when the agent naturally calls
   `source_verifier.verify_claim` before storing a finding, are the
   verdicts `supported`?
3. **Workflow audit contracts** — broader workflow cases that check
   required and forbidden tools, citations, output shape, latency
   budgets, token budgets, and tool-call counts.

Every run also records first-token latency, final latency, token usage
(reported when available, otherwise estimated), prompt-cache hit counts when
reported, tool-call counts, unique tools, and per-dataset p50/p95/p99 summaries.

## Quick Start

```bash
./run-eval.sh                                  # default routing + factuality suite
./run-eval.sh --dataset routing                # one dataset
./run-eval.sh --dataset workflows              # broader audit suite; may invoke live tools
./run-eval.sh --dataset routing --export-atof  # also emit ATOF JSONL traces
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

| Variable                             | Default                    | Purpose                                                                   |
| ------------------------------------ | -------------------------- | ------------------------------------------------------------------------- |
| `DAEDALUS_KUBE_NAMESPACE`            | `daedalus`                 | Namespace containing the backend Service                                  |
| `DAEDALUS_KUBE_BACKEND_SERVICE`      | `daedalus-backend-default` | Backend Service name                                                      |
| `DAEDALUS_KUBE_BACKEND_PORT`         | `8000`                     | Backend Service port                                                      |
| `DAEDALUS_EVAL_LOCAL_PORT`           | `18000`                    | Local port used for `kubectl port-forward`                                |
| `DAEDALUS_EVAL_PORT_FORWARD_ADDRESS` | `0.0.0.0`                  | Bind address for `kubectl port-forward`; Docker needs a non-loopback bind |
| `DAEDALUS_KUBE_CONTEXT`              | unset                      | Optional kubectl context                                                  |

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

### ATOF, ATIF, and Phoenix Exports

The runner can emit one NeMo Agent Toolkit ATOF v0.1 JSONL event stream per eval
case. This makes Daedalus traces usable with the toolkit's ATOF-to-ATIF
converter and Phoenix trajectory exporter.

```bash
./run-eval.sh --dataset routing --export-atof
python3 evals/runner.py --dataset routing --export-atof --export-atof-dir /tmp/daedalus-atof
```

Add `--export-atif` to convert those JSONL files to ATIF JSON. The native
runner environment needs `nvidia-nat-atif[full]` installed for this path.
The default Docker eval image stays lightweight and only supports direct ATOF
JSONL export unless you extend it with the optional NeMo Agent Toolkit ATIF and
Phoenix packages.

```bash
python3 evals/runner.py --dataset routing --export-atof --export-atif
```

Add `--export-phoenix` to send the converted ATIF files to Phoenix. Configure
the target with `--phoenix-endpoint`, `--phoenix-project`,
`DAEDALUS_PHOENIX_ENDPOINT`, or `PHOENIX_PROJECT_NAME`.

```bash
python3 evals/runner.py --dataset routing --export-phoenix
```

### Native Python (Optional)

If you already have Python and don't want Docker:

```bash
pip install -r evals/requirements.txt
python3 evals/runner.py --dataset routing
```

## Environment

| Variable                          | Default                                                                | Purpose                                       |
| --------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| `DAEDALUS_BACKEND_URL`            | unset for `run-eval.sh`; `http://localhost:8000` for the native runner | Backend base URL                              |
| `DAEDALUS_EVAL_USER`              | `eval_user`                                                            | user_id injected via `[IDENTITY]`             |
| `DAEDALUS_EVAL_TIMEOUT`           | `900`                                                                  | Per-request timeout in seconds                |
| `DAEDALUS_EVAL_PREFLIGHT_TIMEOUT` | `5`                                                                    | Backend reachability check timeout in seconds |
| `DAEDALUS_PHOENIX_ENDPOINT`       | `http://localhost:6006/v1/traces` for native Phoenix export            | Phoenix OTLP endpoint for `--export-phoenix`  |
| `PHOENIX_PROJECT_NAME`            | `daedalus-evals` for native Phoenix export                             | Phoenix project for `--export-phoenix`        |

The fixed eval user means memory accumulates across runs for that id.
If that becomes noisy, purge the user's memory between runs or switch
to a per-run id.

## How Scoring Works

The default run includes `routing` and `factuality`. The `workflows` dataset is
opt-in because it can invoke live integrations such as image generation and MCP
reads.

### Routing

The runner posts each case's `query` to `/chat/stream`, parses the SSE
for `intermediate_data:` tool events, and hands the trace to
`evaluators/routing.py`. It checks in order:

1. The expected leaf tool appears as a `TOOL_START` event
2. The expected skill appears in an `agent_skills_tool` payload
3. No `forbidden_tools` were called

A case passes at `score >= 0.8`.

### Factuality

`evaluators/factuality.py` scans the trace for `verify_claim` and
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

### Workflow Audit

`evaluators/workflow_audit.py` is deterministic. Each case can declare:

- `required_tools`
- `forbidden_tools`
- `min_tool_calls` / `max_tool_calls`
- `requires_citation`
- `response_contains`
- `response_regex`
- `max_latency_s`
- `max_total_tokens`

## Expanding The Dataset

Start by editing `datasets/routing.yml` and `datasets/factuality.yml`.
Each file is a YAML list — add new entries with unique ids. Run a single
new case in isolation first:

```bash
./run-eval.sh --case <new-id>
```

Inspect `evals/results/<timestamp>.json` to see the full trace — the
`events` array shows every `TOOL_START` and `TOOL_END` and their payloads.
Use this to:

- Confirm your `expected` labels match what the agent actually does
- Debug misses (tool called under a different name, argument shape, etc.)

Good coverage targets:

- ~5 cases per major direct route (research, ops, media, user_data) → 20
- ~5 skill-match cases (pr-monitor, debug-session, code-review, etc.)
- ~5 conversational and edge cases
- ~15 factuality cases (research-heavy, findings-inducing)
- p95 token and latency budgets per major workflow
- Adversarial and messy inputs for every high-value workflow

## Known Limitations

- **Stateful memory:** the eval user's memory grows across runs. Fine
  for now; revisit if results start drifting.
- **Factuality coverage** is bounded by whether the agent chooses to
  call `verify_claim`. A future iteration could post-hoc verify claims
  the agent made without citing — e.g. via a NAT-side wrapper that
  exposes `verify_claim` standalone.
- **Limited regression tracking:** `evals/results/` keeps dated runs and
  summary metrics, but there is no diffing UI yet. Compare JSONs manually or
  add a `compare.py` if trend tracking matters.
- **No parallelism:** cases run serially. Fine for ~30 cases; add
  asyncio or a thread pool if the dataset grows past ~100.

## Related Docs

- [`../README.md`](../README.md) for top-level setup and deployment
- [`../builder/source_verifier/`](../builder/source_verifier/) for the verifier the factuality evaluator inspects
