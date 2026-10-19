# Research output and evaluation

Article research can use recoverable excerpts to reduce recurring tool-output
payloads. Research mode is opt-in, defaults to disabled, and is not enabled in
`backend/tool-calling-config.yaml`. It does not impose a total context-window
budget or make in-flight execution restartable.

## Output contract

Set `enable_research_mode: true` on the webscrape function to expose
`output_mode: research`; also register `tool_output_retriever_tool`. Both Rust
and Python preparation support the mode, including renamed scrape tools.
The default `full` mode uses its configured output-token limit.

Research mode retains the complete converted Markdown and source attribution
before the output layer selects verbatim excerpts. The user-scoped cache and
exact retriever recover omitted evidence. Archive failure preserves the source.
References expire; missing or expired evidence must be reported as unavailable.
A preview cannot establish absence. Full-text, verbatim, count and absence
questions retain the full-content path.

Compaction applies to individual tool results. It preserves tool receipts,
approvals, steering and call/result bindings. Inbound history limits do not bound
the growing transcript; see [long-running workflows](long-running-workflows.md).

For exact-output requests, [final-only presentation](tool-correctness.md#final-only-answers)
withholds text accompanying tool calls and publishes the completed final model
answer. Tool receipts and control events remain available. This does not rewrite
an incorrect answer into an evaluator pass.

## Configuration identity

Preparation logs include a versioned digest of selected instructions, schemas,
tool policy and context settings. Each model-call log identifies its advertised
catalog digest, including schemas added by discovery. Digest inputs exclude API
keys and conversation messages. Evaluation manifests record source and image
identity as well as the effective workflow and workload.

The [paired evaluator](../evaluation/tool-correctness/README.md) accepts
allowlisted workflow overlays and checks routing identity. Keep the model,
workload and routing fixed when comparing candidates. Missing provider identity,
usage or cache-hit evidence remains unknown. Service readiness alone does not
establish correct model generation, tool selection or result consumption.

## Validation and promotion

The deterministic built-image checks exercise actual conversion, storage,
retrieval and preparation with scripted external source/model transports:

```bash
builder/.venv/bin/python builder/migration/research_check.py \
  --image <candidate-image> --redis-image <redis-image> \
  --report /tmp/research-contracts.json
builder/.venv/bin/python builder/migration/response_check.py \
  --image <candidate-image> --redis-image <redis-image>
```

They check omitted Unicode evidence, attribution, final-answer binding,
cross-user isolation, expired references and preservation on archive failure.
Response checks also cover retries, cancellation, steering, heartbeat delivery
and incremental streaming. `make migration` includes both checks.

Before enabling research mode, run the real-model comparisons in the
[evaluation guide](../evaluation/tool-correctness/README.md#research-evidence-recovery)
as well as the broader paired correctness suite. The workloads cover multiple
sources, unavailable evidence, exact JSON, citation binding and steering after
completed reads. Required evidence must be retrieved without repeating source
fetches. A smaller payload does not compensate for a failed assertion.

Freeze acceptance limits before collecting results, retain every failed or
stopped attempt, and use a fresh output directory for each candidate. Store
manifests, logs, measurements and promotion decisions outside repository
documentation. Report serialized input, model/tool rounds, latency and usage
separately: a retrieval round can reduce recurring input while increasing
latency. Small synthetic trials do not establish billing savings, tail latency,
arbitrary research quality or complete real-world briefing coverage.
