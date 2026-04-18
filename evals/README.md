# Daedalus evaluation harness

Local-first evaluation for the Daedalus agent. Measures two things:

1. **Routing correctness** — does `mas_evaluate` run, return the expected
   SAS/MAS verdict, and does the orchestrator delegate to the expected
   sub-agent or load the expected skill?
2. **Factuality (observational)** — when the agent naturally calls
   `source_verifier.verify_claim` before storing a finding, are the
   verdicts `supported`?

## Quick start

```bash
./run-eval.sh                                  # full suite
./run-eval.sh --dataset routing                # one dataset
./run-eval.sh --case ops-001                   # one case
DAEDALUS_BACKEND_URL=http://10.0.2.61:8000 ./run-eval.sh
```

Only **Docker** is required on the host — no Python or pip install.
`run-eval.sh` launches `docker compose run --rm evals <args>`. The
service attaches to `daedalus-network` and reaches `backend:8000`
by DNS, so it works out of the box when the stack is up
(`docker compose up backend ...`).

First run builds the image (~30s). Afterward, dataset and evaluator
edits on the host are picked up via volume mount — no rebuild needed.
If you change `requirements.txt` or the `Dockerfile`, rebuild with:

```bash
docker compose build evals
```

Results land in `evals/results/<timestamp>.json`. A markdown summary
prints to stdout; a non-zero exit code signals at least one failure.

### Native Python (optional)

If you already have Python and don't want Docker:

```bash
pip install -r evals/requirements.txt
python3 evals/runner.py --dataset routing
```

## Environment

| var | default | purpose |
| --- | --- | --- |
| `DAEDALUS_BACKEND_URL` | `http://backend:8000` (Docker) / `http://localhost:8000` (native) | backend base URL |
| `DAEDALUS_EVAL_USER`   | `eval_user`              | user_id injected via `[IDENTITY]` |
| `DAEDALUS_EVAL_TIMEOUT` | `900` | per-request timeout (seconds) |

The fixed eval user means memory accumulates across runs for that id.
If that becomes noisy, purge the user's memory between runs or switch
to a per-run id.

## How scoring works

### Routing
The runner posts each case's `query` to `/chat/stream`, parses the SSE
for `intermediate_data:` tool events, and hands the trace to
`evaluators/routing.py`. It checks in order:

1. `mas_evaluate` was called (or, for `conversational_only`, wasn't)
2. The mas_evaluate JSON matches the expected architecture label
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

Good coverage targets for v2:
- ~5 cases per sub-agent (research, ops, media, user_data) → 20
- ~5 skill-match cases (pr-monitor, debug-session, code-review, etc.)
- ~5 MAS cases (2-3 centralized, 2-3 decentralized)
- ~5 conversational / edge cases
- ~15 factuality cases (research-heavy, findings-inducing)

## Known limitations (v1)

- **Stateful memory**: the eval user's memory grows across runs. Fine
  for now; revisit if results start drifting.
- **Factuality coverage** is bounded by whether the agent chooses to
  call `verify_claim`. A future iteration could post-hoc verify claims
  the agent made without citing — e.g. via a NAT-side wrapper that
  exposes `verify_claim` standalone.
- **No regression tracking**: `evals/results/` keeps dated runs but
  there's no diffing UI. Compare JSONs manually or build a small
  `compare.py` if trend tracking matters.
- **No parallelism**: cases run serially. Fine for ~30 cases; add
  asyncio or a thread pool if the dataset grows past ~100.
