# Long-running agent workflows

Use this guide to diagnose slow runs and understand concurrency, context and
recovery limits. See [runtime logs](operations.md#runtime-logs) for event fields
and [runtime compatibility](rust-migration.md) for controlled benchmarks.

## Scheduling and output

Independent webscrape calls can overlap, with a configurable limit of 1–8 and a
default of 1. The shipped configuration uses 4. A shared Python semaphore bounds
work across runs for each tool instance, including robots checks. Rust also
bounds dispatch within a run; global per-run concurrency remains 8. Stateful
tools and MCP groups retain serialization.

ESPN, X, GitHub, Kubernetes and UniFi initially advertise discovery tools and
capability descriptions. Their schemas load on demand for the rest of the run.
This reduces recurring schema payloads but can add a model round when a group
is first needed. Explicit API tool selection discovers the requested group
eagerly in either preparation mode. Hue exposes selected common operations
immediately and discovers the rest on demand.

The output layer compacts each completed result once. Eligible structured
results and attributed RSS articles receive recoverable previews only after
successful user-scoped persistence. Generic scrape Markdown, code and documents
retain their full-content path unless explicit research mode is enabled.
Exact and exhaustive queries bypass lossy previews; cache failures preserve
output. Python's single-result optimizer supports Python preparation.

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
for code/document tasks. The opt-in [research mode](research-workflows.md)
archives complete articles before returning recoverable excerpts; it does not
bound the total transcript.

Measure catalogue bytes and provider cache-hit usage before deferring the
remaining frequently used mail/calendar/document groups. Use matched task
replays to assess whether schema savings exceed extra discovery rounds. Usage
logs alone do not establish a provider cache benefit or an end-to-end improvement.

Durable execution checkpoints are separate from the Redis job queue. Stream
worker leases and finalization are recoverable, but an already-started backend
request is never automatically replayed after worker loss. Restarting the
backend interrupts its in-memory model/tool state. Drain live work before a
rollout; extending timeouts alone cannot make runs restartable. If resumable
execution becomes necessary, checkpoint tool receipts and unresolved mutations
before designing replay or adoption.

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
