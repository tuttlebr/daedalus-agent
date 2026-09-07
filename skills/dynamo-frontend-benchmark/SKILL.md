---
name: dynamo-frontend-benchmark
description: Benchmark and profile the Dynamo frontend against mock workers for throughput, A/B comparisons, CPU behavior, and bottlenecks.
license: Apache-2.0
metadata:
  author: Brandon Tuttle <tuttlebr@duck.com>
  version: 2.0.0
  tags:
    - dynamo
    - performance
    - benchmarking
    - profiling
    - frontend
    - kv-router
---

# Dynamo frontend benchmark

Measure the NVIDIA Dynamo HTTP frontend with mock workers, keeping GPU backend
compute out of the variable under test. For offline replay revision parity use
[dynamo-kv-replay-parity](../dynamo-kv-replay-parity/SKILL.md). For real model
serving capacity, define a separate live-backend study; do not substitute mocks.

## Required environment and scope

This harness needs an actual operator host with a Dynamo checkout/build,
Python, etcd/NATS request plane, AIPerf, CPU affinity tools and optional perf.
Daedalus's sandbox does not inherit any of these, host services, GPUs or paths.
Use `agent_skills_tool` to inspect bundled scripts as text; production script
execution is disabled. If execution is unavailable, prepare the campaign and
analyze supplied artifacts without claiming a run.

Read [benchmark-protocol](references/benchmark-protocol.md) through
`agent_skills_tool(operation=load_skill, skill_name=dynamo-frontend-benchmark,
resource=references/benchmark-protocol.md)` before launching load or profiling.
Verify flags against the pinned checkout/CLI and use `nvidia_docs_tool` with
`product=dynamo` or `aiperf` for current documented behavior.

## Workflow

1. Freeze baseline/candidate revision, builds, tokenizer, model, endpoint,
   workers, block size, workload, concurrency, warmups, repetitions, CPU sets,
   measurement window, run budget and invalidation rules. Honor explicit user
   choices; helper defaults are examples, not the study specification.
2. Use a dedicated request plane/registration namespace and task-owned output
   directory. Check that the HTTP port and instance prefix are free; do not
   stop unrelated workers or delete discovery keys to make room.
3. Start the topology and send a bounded smoke request. Require returned tokens
   and no request error before measured traffic.
4. Recreate the topology/cache state between measured arms, apply the declared
   warmups and interleave arms. Do not build, profile or run competing samples
   while collecting performance evidence.
5. Inspect raw records, cancellations, errors, completeness and client/worker
   saturation. Keep every attempt; do not drop a slow first measured run after
   seeing its value. Predeclared warmups are separate from measurements.
6. Profile a representative bottleneck only when the scope includes it. Use
   available on-CPU permissions; privileged CPU confinement or off-CPU tracing
   needs the corresponding existing host authorization.
7. Stop only recorded task processes and restore only the task's recorded CPU
   settings. Retain artifacts and report a cleanup failure explicitly.

## Helpers and output

All helpers are relative to this skill's `scripts/` directory. Set `DYN_REPO`
to the actual checkout, and use unique `LOG_DIR`/`RESULTS_DIR` per campaign.

| Helper                                                                                         | Purpose                                                                   |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [env.sh](scripts/env.sh)                                                                       | Configuration/defaults and worker registration count                      |
| [start.sh](scripts/start.sh), [stop.sh](scripts/stop.sh)                                       | Tracked topology lifecycle                                                |
| [smoke.sh](scripts/smoke.sh)                                                                   | Bounded streaming request                                                 |
| [run_aiperf.sh](scripts/run_aiperf.sh)                                                         | Measured workload; inspect its declared defaults                          |
| [extract_throughput.py](scripts/extract_throughput.py)                                         | Observed raw-record metrics and incomplete/error counts                   |
| [profile_oncpu.sh](scripts/profile_oncpu.sh), [capture_offcpu.sh](scripts/capture_offcpu.sh)   | Explicit profiling traffic/captures                                       |
| [analyze_folded.py](scripts/analyze_folded.py)                                                 | Self-time/blocked-user-frame summaries                                    |
| [isolate.sh](scripts/isolate.sh), [unisolate.sh](scripts/unisolate.sh)                         | Optional authorized runtime CPU confinement with an exact recovery record |
| [process_control.py](scripts/process_control.py), [cpu_isolation.py](scripts/cpu_isolation.py) | Process identity and scoped restoration                                   |

Return the frozen setup, revisions/artifacts, complete/failed attempts, paired
results, measurement assumptions, bottleneck evidence and cleanup state.
Separate observed closed-loop throughput from open-loop capacity. A flamegraph,
HTTP 200, model listing, or parser exit zero cannot establish overall run success.
