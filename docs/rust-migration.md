# Runtime ownership and compatibility

The backend uses Rust for orchestration and native tools, with a Python service
for the remaining leaf tools and public adapters. Preserve frontend and service
contracts when changing either side of this boundary.

## Current ownership

The full backend runs the Rust agent with a loopback-only Python tool service.
The deployable configuration is `backend/tool-calling-config.yaml`, selected by
`deploy.sh` and Compose. `backend/local-chat-config.yaml` is a small development
profile and cannot establish production feature coverage.

| Area                                                                                                                     | Current owner                | Release evidence required                                                                                |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| Model orchestration, history, streaming, steering, Stop                                                                  | Rust                         | Built-image HTTP and real frontend stream-worker tests                                                   |
| MCP sessions, OAuth and exact approvals                                                                                  | Rust                         | Authorization, identity isolation, cancellation and rollback checks                                      |
| Clock, memory, output retrieval, document tools, domain retrieval, NVIDIA docs, Perplexity, skills, sandbox, NWS weather | Rust                         | Existing service and built-image contract suites, plus performance measurements for the selected release |
| RSS, webscrape, briefing rendering, source verification, visual media                                                    | Python                       | Preserve their current registered APIs; port only a measured bottleneck                                  |
| Autonomous worker                                                                                                        | Python                       | Preserve scheduling, queue ownership and durable records                                                 |
| Memory, profile import, document and collection HTTP APIs                                                                | Rust                         | Existing route, storage and browser compatibility checks                                                 |
| Remaining public adapters                                                                                                | Python behind the Rust proxy | Preserve their existing routes and authentication                                                        |

The Rust tool registry is in `builder/runtime/src/preparation.rs`; public route
ownership is in `builder/runtime/src/main.rs`. A `rust-minimal` image also exists
for configurations using only native tools. It does not support the complete
production configuration and is not the default deployment candidate.

## Performance decision

Benchmark the full hybrid image in both modes with identical CPU/memory limits,
synthetic model/service peers, and Redis. Comparing the same image isolates the
Rust preparation/authorization paths from dependency or image-version changes.
Use the retained production baseline for compatibility and rollback comparisons.
A passing regression budget alone is not evidence of a speedup.

`builder/migration/benchmark.py` records all requests, errors, application timing,
end-to-end latency, achieved throughput, readiness, CPU, resident memory, file
descriptors and threads. Its frozen workload uses concurrency 1, 4 and 8,
200 measured requests per group, three repetitions, warmups and 100 samples per
control phase. Throughput requests use independent synthetic users so the
intentional five-active-chat limit does not contaminate results with HTTP 429s.
Admission-limit correctness remains covered by the HTTP contract tests.

Treat a run with request failures or missing resource samples as invalid for a
performance claim. Retain failures and fix their cause before comparison. Report
latency and resource improvements separately, including regressions; synthetic
application overhead does not predict provider generation speed.

`builder/migration/retrieval_benchmark.py` separately compares cached-output
chunking and search in the final full image. It alternates Python and Rust twice,
uses the same compressed Unicode input and Redis writer, and requires identical
tool payloads for every request. Run it after other CPU-intensive checks:

```bash
builder/.venv/bin/python builder/migration/retrieval_benchmark.py \
  --image daedalus:performance-final --redis-image daedalus:redis-migration-check \
  --report /tmp/daedalus-migration-reports/retrieval-performance.json
```

## API and deployment guarantees

Frontend transports, model/tool schemas, error envelopes, identity derivation,
Redis keys, output compression and cache readers remain compatible. Tool and
provider changes require a request against the built image. Unit tests alone do
not establish integration compatibility. Cancellation must release owned work;
mutating operations must not be replayed after ambiguous responses.

Document ingestion cancellation has a phase-specific compatibility exception.
The retained Python SDK worker may continue indexing after its caller cancels
during extraction. Rust cancels extraction before indexing begins; once a Milvus
write starts, collection ownership remains held until that write finishes.
`document_tool_ingestion_check.py` verifies the extraction cancellation boundary,
exact upstream calls and unchanged in-progress receipt/replay protection;
`ingestion_check.py` verifies completion of an already-started write after
cancellation. Both checks retain the original Python write assertions.

Multi-document ingestion fixtures capture consecutive uploads with collection,
index, row, and SDK cache state retained between documents. Native uploads add
explicit index/load readiness and insert-schema reads; write RPCs retain their
exact captured order and bodies. During a held write, successor extraction may
perform its exact read-only preflight and NV-Ingest work before waiting for
collection ownership. The gate checks those reads separately and requires the
writer RPC sequence to remain unchanged until the held write is released.

Both public ingestion SSE adapters omit the processor's internal `indexing`
write-boundary event. Internal callbacks retain it for write ownership and retry
safety; Python rollback and native HTTP streams preserve the same progress
phases and terminal results.

The full image retains explicit deployment-time Python preparation and
authorization selectors for rollback. These are live compatibility paths, not
unused code. There is no per-request replay through Python. During cutover, stop
new work, drain or cancel active runs, preserve receipts and uncertain writes,
and restore the prior image/configuration if necessary. Never restore an old
Redis snapshot over newer production writes.

Keep the existing deployment topology. The full hybrid backend remains the
candidate while any configured tool or public adapter still requires Python.
Do not switch the autonomous worker or its queue ownership as part of unrelated
performance changes.

## Validation and release

Use Node 22, Python 3.12 and Rust 1.95.

Push and pull-request CI runs Rust formatting, Clippy, unit tests, protocol drift,
and coverage. The longer migration and candidate-image browser contracts run
only when manually requested through the **Rust Migration Contracts** GitHub
Actions workflow (`.github/workflows/rust-migration.yml`), or through the local
commands below. They are not included in `make ci`.

```bash
make rust-check
make rust-coverage
make migration MIGRATION_PYTHON="$PWD/builder/.venv/bin/python"
make candidate-browser MIGRATION_PYTHON="$PWD/builder/.venv/bin/python"
make migration-benchmark MIGRATION_PYTHON="$PWD/builder/.venv/bin/python"
```

The frozen contracts under `builder/runtime/tests/fixtures/` were exported from
the retained baseline image by the matching `builder/migration/export_*.py`
script (`export_baseline.py` writes `contracts.json`); each file records the
`baseline_sha` it came from. Regenerate a fixture only for a deliberate contract
change, from that script, and review the resulting diff as a behavior change
rather than accepting a candidate's output as the new expectation.

Run benchmarks after builds and CPU-intensive checks finish. Preserve source and
image digests with results. Existing reports for earlier revisions establish
historical behavior only; rerun affected checks on the final candidate.

Before commit and deployment:

- Confirm the retained Rust paths have a measured benefit and no unexplained API
  or performance regressions under the supported configuration.
- Finish removing abandoned modules, unused dependencies, fixtures, build hooks
  and stale documentation; inspect the final diff for unrelated changes.
- Run the required Rust, Python, frontend, integration, browser, Helm and security
  checks applicable to the final change, including changed-file pre-commit hooks.
- Verify the actual full image, service dependencies and rollback path, then use
  the canonical deployment command and check deployed health and user workflows.
