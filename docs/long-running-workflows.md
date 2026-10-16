# Long-running agent workflows

Review performed October 16, 2026 UTC against the running backend, stream
workers, autonomous worker, current Rust runtime and Python tool service.
Measurements below are from content-free application counters; they do not
include prompts, results, identities or credentials.

## Observed workload

One completed research run took 938.8 seconds, with 31 model calls and 160 tool
calls: 133 scrapes and 27 sandbox calls. Scrape time summed to 98.0 seconds;
sandbox calls summed to 1.6 seconds. Model calls dominated the remaining time.
Reported input rose from 60,556 tokens on the first call to 576,392 on the last;
aggregate reported input was 10,332,489 tokens and output was 194,213 tokens.
These are provider-reported usage values, not measured billing or uncached
tokens. Prompt-cache affinity is already stable across rounds and turns, but
the logs do not establish a cache-hit rate.

A second run was still active during the initial inspection. It had completed
11 model rounds and 52 tool calls, with a scrape in progress. Scrapes from the
same batch ran serially, commonly taking 5–14 seconds each. Its latest model
round reported 302,429 input tokens. This observation established live work;
an idle log window alone would not establish completion. A later poll observed
its terminal `run_finished` event at 862.2 seconds, with 17 model calls and
78 tool calls.

Neither run emitted a `tool_output_compacted` event. That is consistent with
the current contract: generic scrape markdown, code and documents are preserved
in full. Only eligible structured results and attributed RSS article results
receive recoverable previews, after successful user-scoped Redis persistence.
Exact/exhaustive queries bypass lossy previews. Cache failures preserve output.

## Changes from this review

- Independent `webscrape` calls can overlap, with a configurable limit of 1–8
  and a default of 1. The shipped configuration uses 4. A shared Python
  semaphore bounds work across runs for each tool instance, including robots
  checks. Rust also bounds dispatch within a run; global per-run concurrency
  remains 8. Stateful tools and MCP groups retain serialization.
- ESPN, X, GitHub, Kubernetes and UniFi initially advertise discovery tools
  and capability descriptions. Their schemas load on demand for the remainder
  of the run. This reduces unrelated schema overhead on recurring model calls;
  it can add one model round when a group is first needed. Explicit API tool
  selection discovers the requested group eagerly in either preparation mode,
  retaining named-tool compatibility. Existing Hue discovery and immediately
  available common Hue operations remain configured.
- Removed the retired Python graph-message optimizer, its iteration cache and
  tests for that removed path. The Rust loop already compacts each completed
  output once. Python's single-result optimizer remains necessary for the
  explicit Python preparation fallback. Removed five unused registration shims;
  retained the fixed application registry and baseline-dependent shims. Removed
  the unused sandbox example for the retired `tool_calling_agent` runner and
  its package-data declaration.
- Updated architecture documentation to reflect native Rust tools and public
  APIs, Python leaf ownership, queue recovery and the current discovery path.

Tool registration changes require an HTTP request through the built hybrid
image. `builder/migration/leaf_check.py` covers scrape concurrency, serial
fallback, result binding and real conversion alongside verifier scheduling,
stateful serialization, steering and cancellation. One synthetic eight-scrape
sample took 1.35 seconds at concurrency 4 versus 2.32 seconds serially, using
the same image and limits. This is a scheduling measurement, not an end-to-end
research benchmark. Python tests additionally check admission across robots checks and permit release on cancellation.

## Bounds and remaining opportunities

`workflow.max_history` (50) and `workflow.max_history_tokens` (32,000) select
inbound conversation messages once during preparation. They do not bound the
growing model/tool transcript within a run, nor include system instructions or
tool schemas. The agent currently retains that transcript. Responses requests
send `truncation: auto`, which is a provider setting rather than an
application-owned evidence-retention policy. Chat Completions has no equivalent
setting here. The runtime allows 128 rounds in the shipped configuration and
enforces a 30-minute whole-run deadline even if a model timeout is longer.

The next substantial optimization is a measured context-compaction policy:
retain the user request, steering, approvals, call/result bindings, execution
receipts, active plans and artifact locations; archive older evidence under
exact retrievable references; prove the model can recover omitted details
before applying a hard budget. Simply deleting older messages risks repeated
mutations or unsupported answers. Generic scrape output must also remain exact
for code/document tasks. A future explicit article-research mode could reuse
the existing reversible excerpt mechanism with source and offset tests.

The initially active run also spent 98.7 seconds across ten `get_memory` calls.
Read-only memory concurrency is another candidate to measure, while preserving
mutation ordering and service capacity limits.

Measure catalogue bytes and provider cache-hit usage before deferring the
remaining frequently used mail/calendar/document groups. Use matched task
replays to assess whether schema savings exceed extra discovery rounds. Current
usage logs do not prove a provider cache benefit or an end-to-end improvement
for this configuration change.

Durable execution checkpoints are separate from the Redis job queue. Stream
worker leases and finalization are recoverable, but an already-started backend
request is never automatically replayed after worker loss. Restarting the
backend interrupts its in-memory model/tool state. Drain live work before a
rollout; extending timeouts alone cannot make runs restartable. If resumable
execution becomes necessary, checkpoint tool receipts and unresolved mutations
before designing replay or adoption.

## Deployment verification

The runtime change was committed as `16d977d` and deployed as Helm revision 78.
All six application deployments became available and application image digests
matched the release evidence. The mounted workflow verified scrape concurrency
4 and all five newly deferred groups. A normal automatic-selection clock
request completed through the live model and Rust tool path in 1.52 seconds.

Forced clock selection exposed a separate provider behavior: even when given
an empty-object schema and explicit instructions, the gateway/model proposed
`{"arguments":"{}"}`. The strict validator rejected it and terminated after
the bounded correction attempt. A direct synthetic request to the model
endpoint reproduced the wrapper without the agent runtime. This identifies
the upstream proposal as the source of the invalid shape; it does not isolate
the gateway from its model. Automatic tool selection succeeded. The runtime
continues to reject unsupported arguments rather than silently reinterpret
them. Both preparation modes passed the built-image named-tool contracts
against the scripted provider.

## Reproduce and validate

Read logs locally and project only content-free fields. The full log can
contain tool validation diagnostics; do not publish it as a benchmark artifact.

```bash
kubectl -n daedalus logs deploy/daedalus-backend-default -c backend --since=60m |
  jq -R 'fromjson? | select(.fields.event == "model_call_finished" or
    .fields.event == "tool_call_finished" or .fields.event == "run_finished") |
    {event: .fields.event, elapsed_ms: .fields.elapsed_ms,
     input_tokens: .fields.input_tokens, output_tokens: .fields.output_tokens,
     tool_calls: .fields.tool_calls, tool: .fields.tool}'

make rust-check
cd builder
uv run python -m pytest tests/test_webscrape_concurrency.py \
  tests/test_webscrape_utils.py tests/test_tool_output_compaction.py
cd ..
docker buildx build --load --target backend --build-context skills=./skills \
  -t daedalus:workflow-check ./builder
docker build -t daedalus:redis-migration-check ./redis
builder/.venv/bin/python builder/migration/leaf_check.py \
  --image daedalus:workflow-check --redis-image daedalus:redis-migration-check \
  --report /tmp/daedalus-workflow-leaf.json
```

Compare serial and concurrent scrape measurements from the same candidate
image. This isolates scheduling from image/dependency changes. Synthetic peers
prove bounds and call/result correctness; live task quality, cache hits and
overall latency need subsequent matched workload measurements.

Validation for this change passed Rust formatting, Clippy, protocol generation
and 103 Rust tests (22 existing service-specific tests remain opt-in); 1,901
Python tests with 79.39% coverage; 155 focused Python tests after the named-tool
compatibility change; built-image HTTP contracts in both preparation modes; all
ten built-image scheduling cases, including cross-user bounds, steering and
cancellation; Helm lint/render/security checks; and pre-commit hooks. This does
not establish live research quality or exercise every optional external service.
