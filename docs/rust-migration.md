# Performance-driven Rust backend

The October 15, 2026 scope is to use Rust where measurements show an improvement
while preserving the frontend and dependent-service APIs. Rewriting the entire
Python backend is no longer a release requirement. Speech transcription is not
needed and is excluded. Unregistered experimental ports and their build assets
are removed instead of shipping unused code.

## Current ownership

The full backend runs the Rust agent with a loopback-only Python tool service.
The deployable configuration is `backend/tool-calling-config.yaml`, selected by
`deploy.sh` and Compose. `backend/local-chat-config.yaml` is a small development
profile and cannot establish production feature coverage.

| Area                                                                                                                                       | Current owner                | Release evidence required                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| Model orchestration, history, streaming, steering, Stop                                                                                    | Rust                         | Built-image HTTP and real frontend stream-worker tests                                                   |
| MCP sessions, OAuth, exact approvals and receipts                                                                                          | Rust                         | Authorization, identity isolation, cancellation and rollback checks                                      |
| Clock, memory, output retrieval, document tools, domain retrieval, NVIDIA docs, Perplexity, user interaction, skills, sandbox, NWS weather | Rust                         | Existing service and built-image contract suites, plus performance measurements for the selected release |
| RSS, webscrape, briefing rendering, source verification, visual media                                                                      | Python                       | Preserve their current registered APIs; port only a measured bottleneck                                  |
| Autonomous worker                                                                                                                          | Python                       | Preserve scheduling, queue ownership and durable records                                                 |
| Memory, profile import, document and collection HTTP APIs                                                                                  | Rust                         | Existing route, storage and browser compatibility checks                                                 |
| Remaining public adapters                                                                                                                  | Python behind the Rust proxy | Preserve their existing routes and authentication                                                        |

The Rust tool registry is in `builder/runtime/src/preparation.rs`; public route
ownership is in `builder/runtime/src/main.rs`. A `rust-minimal` image also exists
for configurations using only native tools. It does not support the complete
production configuration and is not the default deployment candidate.

The unfinished native RSS/article converter tree was test-only. It provided no
production speedup. Its custom Python-library ports, including speech, FTP,
codecs, spreadsheet/image internals, and the incomplete DNS helper, are outside
this performance-directed release. The existing Python converters continue to
provide the registered RSS and webscrape behavior.

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

The corrected October 15 comparison passed all 53 regression gates, with no
failed requests across 14,400 measured requests, 1,440 warmups and 600 control
samples. Both modes used the same full image
`sha256:2144f0ba4d155a6b588a234ab0fca7a2c7e36694a6788d273cc004e8396b900c`,
limited to two CPUs and 2 GiB. This image preceded removal of the unused Python
speech dependencies. Values below combine the three repetitions.

| Workload                          | Concurrency | Python p95 | Rust p95  | Python requests/s | Rust requests/s |
| --------------------------------- | ----------- | ---------- | --------- | ----------------- | --------------- |
| Text                              | 1           | 4.33 ms    | 2.11 ms   | 248.6             | 586.0           |
| Text                              | 8           | 17.96 ms   | 14.89 ms  | 587.2             | 713.3           |
| Clock                             | 1           | 12.12 ms   | 7.56 ms   | 111.1             | 190.7           |
| Unicode history                   | 8           | 42.52 ms   | 40.99 ms  | 284.9             | 302.8           |
| Memory context, independent users | 8           | 493.66 ms  | 383.17 ms | 17.9              | 21.2            |

Peak aggregate resident memory remained similar: 311–315 MiB for Python mode
and 307–309 MiB for Rust mode. Stop and steering p95 stayed below 42 ms. The
memory workload includes initialization for each synthetic user; it does not
represent a warmed per-user cache. The earlier single-user concurrency-eight
run hit admission limits and is excluded from performance claims.

`builder/migration/retrieval_benchmark.py` separately compares cached-output
chunking and search in the final full image. It alternates Python and Rust twice,
uses the same compressed Unicode input and Redis writer, and requires identical
tool payloads for every request. Run it after other CPU-intensive checks:

```bash
builder/.venv/bin/python builder/migration/retrieval_benchmark.py \
  --image daedalus:performance-final --redis-image daedalus:redis-migration-check \
  --report /tmp/daedalus-migration-reports/retrieval-performance.json
```

The final full image
`sha256:1bddb5dd18066493c0775ac9acda498d5ccc7deb346054e55ed416831da8c793`
passed all 800 measured retrieval calls and 80 warmups with identical payloads.
For 1,146,880 bytes of cached Unicode text, chunk p95 fell from 28.54 to 21.49 ms
and search p95 from 29.64 to 21.22 ms. These include the HTTP chat request and
scripted model round trips, at concurrency one with the same two-CPU limit.

## API and deployment guarantees

Frontend transports, model/tool schemas, error envelopes, identity derivation,
Redis keys, output compression and cache readers remain compatible. Tool and
provider changes require a request against the built image. Unit tests alone do
not establish integration compatibility. Cancellation must release owned work;
mutating operations must not be replayed after ambiguous responses.

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

Use Node 22, Python 3.12 and Rust 1.95. The active Rust code no longer needs the
experimental article parser, image libraries, ONNX assets or speech binaries.

```bash
make rust-check
make rust-coverage
make migration MIGRATION_PYTHON="$PWD/builder/.venv/bin/python"
make candidate-browser MIGRATION_PYTHON="$PWD/builder/.venv/bin/python"
make migration-benchmark MIGRATION_PYTHON="$PWD/builder/.venv/bin/python"
```

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

The October 15 candidate passed 102 Rust tests (59.84% line coverage), 1,898
Python tests (79.36% coverage), frontend lint/types/coverage, real Redis
integration, and five browser workflows against the full image. Twenty image
contract suites cover the retained tool/API ports and rollback. The 22 Rust
tests requiring external fixtures remain excluded from the unit-only run;
the corresponding image/service suites provide integration evidence. Helm
validation and the backend high/critical vulnerability scan also passed.
