---
name: dynamo-kv-replay-parity
description: Run byte-parity and paired performance campaigns for Dynamo offline KV-aware replay across vLLM, SGLang, and KVBM paths.
license: Apache-2.0
metadata:
  author: Brandon Tuttle <tuttlebr@duck.com>
  version: 1.0.0
  tags:
    - dynamo
    - offline-replay
    - kv-router
    - kvbm
    - parity
    - performance
---

# Dynamo KV replay parity

Compare pinned revisions of offline KV-aware replay using deterministic
semantic reports and paired replay-loop timing. This is an offline simulator
campaign, not an HTTP frontend or live GPU benchmark.

## Before execution

Load [campaign-protocol](references/campaign-protocol.md) in full through
`agent_skills_tool(operation=load_skill, skill_name=dynamo-kv-replay-parity,
resource=references/campaign-protocol.md)`. It preserves the complete staged
qualification, matrix, semantic-exception and statistical gates.

Use an actual operator checkout/harness with the required Rust/Python tools,
trace files, CPU placement and storage. Daedalus's isolated sandbox does not
supply those implicitly. Inspect the pinned manifests/CLI before running; if a
named feature, report field or timing boundary changed, investigate/adapt the
protocol with evidence before collecting comparable results.

Resolve and freeze baseline/candidate SHAs, toolchain/features and binary
checksums, trace checksum/slice, row configurations, report exclusions,
run-order seed, CPU placement, timing scope, invalidation rules and run budget.
The full protocol is substantial; a smaller user-requested preflight remains
valid work but cannot be labeled the full campaign.

## Required outcomes

1. Internal determinism for both revisions in separate processes, with the
   closed exclusion allowlist and seeded routing assertion intact.
2. Qualified lifecycle coverage for each supported engine/topology/memory row.
   Reuse one frozen configuration per row for both revisions; do not tune them
   independently or infer queue/offload/preemption paths from completion.
3. Canonical byte parity or individually evidenced semantic improvements with
   regression coverage; unexplained differences fail.
4. Five alternating warmups per arm and the predeclared 60 paired samples per
   row. Use `replay_execution_ms` at the specified replay-loop boundary,
   fresh processes, fixed affinity and no concurrent performance work per node.
5. Separate semantic and performance dispositions, including inconclusive
   statistical assumptions/coverage, binary footprint and retained evidence.

Read [campaign-concurrency](references/campaign-concurrency.md) before assigning
rows to nodes and [golden-point seeds](references/internal-polynomial-golden-points.md)
only for that trace/harness family. Historical seeds require requalification.
Retain evidence needed to reproduce results; never delete supplied traces or
unrelated data as cleanup.

## Collaboration

Use [dynamo-frontend-benchmark](../dynamo-frontend-benchmark/SKILL.md) for a
requested mock-worker HTTP frontend study, and
[dynamo-router-starter](../dynamo-router-starter/SKILL.md) for a live router
smoke check. Do not substitute either for replay parity. Use current source and
`nvidia_docs_tool` for semantic contracts; keep research, build, measurement,
profiling and external publication distinct.

Return revisions/artifacts, frozen matrix and lifecycle evidence, canonical
digests/exceptions, every timing attempt and invalidation, confidence bounds,
footprint and limitations. Do not claim a pass for missing rows or weakened
protocol gates.
