# Mock frontend measurement protocol

## Freeze the study

Declare the user goal, baseline/candidate revision/builds, host/tool versions,
CPU/NUMA placement, model/tokenizer, workers, block size, prompt/output lengths,
prefix locality, turn count, concurrency, run length, warmups, arm order and
repetitions. Record budget and stopping conditions. Build both immutable arms
before measurement; do not compare moving checkouts or reused stale bindings.

The helpers' defaults use loopback port 8000, four mocks, frontend cores 0–3,
other cores 4–23, block size 64, and long shared-prefix multi-turn prompts.
Inspect `env.sh` and `run_aiperf.sh`; adapt mismatched host capacity and workload
parameters before the first measured run, identically across comparison arms.
A dedicated etcd/NATS plane is required because the helper assumes exclusive
ownership of its worker-registration prefix. It never deletes that prefix.

## Run and retain evidence

1. Verify the real services, build/CLI contract, free endpoint port and empty
   worker registration prefix. Service startup behavior is host-specific.
2. Start with `start.sh`; it records process birth identities and dedicated
   process groups or a task-unique systemd unit for optional full confinement.
3. Use `smoke.sh` and inspect returned content/tokens and error state. Matching
   frontend/mocker block sizes are required. Smoke each changed block size;
   historical hangs at a particular size are not universal version limits.
4. Run a declared warmup and measured arm with unique artifacts. Recreate the
   topology for the next arm with `stop.sh` then `start.sh` so accumulated cache
   state does not advantage later runs. Hold allocator choice constant unless
   allocator choice is the single studied variable.
5. Alternate/randomize arms and retain all attempted samples and process exit
   status. Repetitions and any cold-start warmups are predeclared. Use paired
   differences/ratios and uncertainty appropriate to the sample size.
6. Inspect raw `profile_export.jsonl` plus available finalized output.
   `extract_throughput.py` rejects ambiguous run directories and reports failed,
   cancelled, malformed and incomplete records; use `--expected-count` for a
   fixed-count run. Its observed success-window throughput is not complete-run
   goodput if attempts are missing or failed.
7. If a finalizer appears hung, inspect its live process, record count and output
   progress before stopping only that task. A timeout is not proof it stopped.
   Retain partial results and report the uncompleted phase.

## Interpretation

Fixed concurrency is closed-loop. In steady state, concurrency divided by mean
latency is a sanity estimate for request throughput, not an open-loop capacity
claim. TTFT and inter-token latency explain different waiting/queueing phases;
for N output tokens, generation gaps are approximately N-1 intervals.

Check both frontend cores and client/mocker cores for saturation. A busy load
generator can starve mockers and make a throughput collapse look like a frontend
regression. Smaller blocks increase both router and mocker bookkeeping. Mock
speedups do not reproduce a real backend's GPU timing or memory behavior.

Use CPU time per completed request as well as throughput when studying frontend
CPU efficiency. Do not carry old benchmark percentages into a new result.

## Profiling and host settings

On-CPU sampling uses the actually available perf permissions. DWARF unwinding
can help when release binaries lack frame pointers; verify stack quality before
attribution. Off-CPU tracepoints/BPF require the host's configured privileges;
do not weaken global sysctls automatically.

The profiling scripts drive their own load. Keep that traffic outside measured
arms and record target PID/birth, concurrency, capture duration and exit status.
In folded BCC stacks, the user frame before the kernel separator helps identify
the blocking call. Tokio parking/futex time can be idle workers; it is not alone
proof of lock contention. Inspect application lock frames and runnable load.

Optional `isolate.sh` confines system.slice/init.scope, adding user.slice with
`--full`. It requires `ISOLATION_STATE` naming a new task-owned recovery file.
`unisolate.sh` restores only recorded AllowedCPUs values and refuses later drift;
it does not revert unrelated systemd properties, IRQ affinity, or irqbalance.
Full confinement requires `ISOLATE=1` and the authorized privileged shell for
`start.sh` so the frontend can run outside confined user.slice.

Stop uses verified process records, not global name matches or stale PID files.
A missing/reused leader makes cleanup unverified; inspect surviving processes
before any further action. Preserve records on errors. Do not stop a shared
bench.slice or other user's AIPerf process. Retain measurement and recovery
evidence before removing only task-created scratch files.
