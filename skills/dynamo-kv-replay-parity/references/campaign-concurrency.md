# Campaign concurrency

Treat one engine/topology/frozen-configuration comparison row as the unit of node
placement. When scheduler capacity permits, allocate multiple nodes and assign independent
rows to them. The nodes do not need to be homogeneous because no individual comparison
crosses nodes. Keep the baseline, candidate, all determinism repetitions, and lifecycle
evidence for one row on the same node. Use the same prebuilt revision artifacts and inputs
throughout the campaign, and record the node characteristics and CPU placement for every
row.

Native replay is normally single-core: pin each native process to one physical core after
confirming that assumption during preflight. KVBM replay also owns a one-worker Tokio
runtime for background pipeline and session tasks. Pin each KVBM process to a fixed,
disjoint CPU set containing at least two physical cores for the main replay thread and the
background worker. Expand that set if thread inspection shows additional runnable workers.
Keep the CPU-set size, NUMA placement, and affinity identical between baseline and candidate
for a row.

For correctness, run the baseline and candidate repetitions for a row concurrently when
its node has sufficient resources. Pin concurrent processes to disjoint CPU sets, give each
process separate output paths, and ensure they do not share mutable state. Keep every
repetition in a separate process even when several repetitions run at the same time.

For performance, keep the entire row's warmups and 60-pair measurement series on
its assigned node. Execute only one performance invocation at a time on that node with a
fixed CPU placement, and keep each randomized baseline/candidate pair adjacent. Different
performance rows may run concurrently on different nodes, but do not pool one row's pairs
across heterogeneous nodes. Do not run another replay, build, profiler, or unrelated
workload concurrently on a node collecting performance samples.

Multi-node and within-node correctness parallelism are campaign throughput optimizations;
they must not change workload concurrency or weaken performance isolation.

Keep this scheduling detail subordinate to the frozen per-row contract in
`SKILL.md`. If cluster capacity cannot preserve the stated isolation, run fewer
rows concurrently rather than weakening a row's controls.
