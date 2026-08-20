---
name: dynamo-frontend-benchmark
description: Benchmark and profile the Dynamo frontend against mock workers for throughput, A/B comparisons, CPU behavior, and bottlenecks.
allowed-tools: Read, Bash, WebFetch
license: Apache-2.0
metadata:
  author: NVIDIA Corporation and Affiliates <noreply@nvidia.com>
  version: 1.0.0
  tags:
    - dynamo
    - performance
    - benchmarking
    - profiling
    - frontend
    - kv-router
---

# Dynamo frontend benchmarking

## Purpose

End-to-end harness for measuring and profiling the Dynamo **frontend** under load
from a configurable client, served by **mock workers** so the backend isn't the
variable under test. Bundled scripts are in `scripts/`; they all
`source env.sh`, which requires `DYN_REPO` to point at your Dynamo checkout.

## Instructions

1. Start from a clean topology for every measured arm.
2. Keep load generation off the frontend cores.
3. Use ordinary on-CPU profiling by default.
4. Run cgroup or tracepoint operations only after approval of the narrow
   privileged scope.

## Examples

```bash
export DYN_REPO=/path/to/dynamo          # checkout with built .venv
# 0. one-time: request plane up, venv built, FlameGraph cloned (see Setup)
bash scripts/isolate.sh                  # optional; approved privileged shell
BLOCK_SIZE=512 bash scripts/start.sh     # frontend (pinned) + N mockers
WARMUP_REQUESTS=512 bash scripts/run_aiperf.sh   # one measured run
python3 scripts/extract_throughput.py $DYN_REPO/bench/results/aiperf-*  # robust numbers
bash scripts/stop.sh                     # teardown + etcd drain
```

For an A/B: **teardown + restart between every run**, interleave arms, take the
median of 3+. Use `profile_oncpu.sh` for ordinary user access. Run
`capture_offcpu.sh` only after the user approves its perf/BPF privilege scope.

## What this measures (and what it doesn't)

- **Frontend**: HTTP (axum/hyper), tokenization (fastokens or HF), KV-router
  block hashing + radix-tree scheduling, request dispatch, SSE response relay.
- **Mock workers** (`dynamo.mocker`): simulate generation with `--speedup-ratio`
  (e.g. 1e6 = ~instant) and KV-cache block bookkeeping. **Not** a real vLLM
  worker — no GPU compute. Use them to remove backend variance, not to model
  production backends.
- **Closed-loop client** (aiperf): fixed `--concurrency`, so
  **throughput ≈ concurrency / request_latency** (Little's law). This is the
  single most important fact for interpreting results (see Pitfalls).

## Prerequisites

1. **Request plane** — Dynamo needs etcd (`:2379`) + NATS with JetStream (`:4222`):
   - etcd is often a systemd service (survives reboot). Check: `etcdctl endpoint health`.
   - **NATS is usually a user binary that does NOT auto-start on reboot.** Run
     `nats-server -js` in a dedicated terminal for the benchmark session, then
     confirm `ss -ltn | grep 4222`.
2. **Build the bindings** into a venv: `uv venv && source .venv/bin/activate &&
(cd lib/bindings/python && maturin develop --uv --release)`. Rust changes
   require rebuilding this; **never run a build concurrently with a benchmark** —
   it steals cores and contaminates results.
3. **aiperf**: `pip install aiperf` (the GenAI-perf successor) in some venv; set `AIPERF`.
4. **FlameGraph**: `git clone https://github.com/brendangregg/FlameGraph` and set
   `FLAMEGRAPH_DIR`.
5. **jemalloc** (optional, for the frontend): get a `libjemalloc.so` and pass it
   via `FRONTEND_LD_PRELOAD` to `start.sh`. Big alloc-churn reductions vs glibc.
6. **perf access** for on-CPU profiling: ask the host owner to approve the
   narrow `kernel.perf_event_paranoid=-1` and `kernel.kptr_restrict=0` settings.
   Off-CPU sched tracepoints and BPF require a pre-authorized privileged shell;
   the scripts do not elevate themselves.

## Topology & config (`env.sh`)

- `FRONTEND_CORES` (e.g. `0-3`), `OTHER_CORES` (e.g. `4-23`): frontend is pinned
  with `taskset`; mockers + client share `OTHER_CORES`. **Keep `FRONTEND_CORES`
  small so frontend CPU effects are observable**, but give `OTHER_CORES` enough
  headroom that the client doesn't starve the mockers (see Pitfalls).
- `BLOCK_SIZE`: **frontend `--kv-cache-block-size` and mocker `--block-size` MUST
  match.** Affects both sides — see "Block size" below.
- `DYN_TOKENIZER` = `fastokens` (PCRE2+rayon, fast) or `default` (HF tokenizers).
- `DYN_TOKENIZER_CACHE` / `_BYTES`: L1 prefix cache (helps with shared system prompts).

## Running a throughput benchmark — methodology

The harness encodes hard-won protocol. Follow it or results drift:

1. **Full teardown + fresh restart between every run** (`stop.sh` then `start.sh`).
   The KV router and tokenizer cache accumulate state across runs; reusing an
   instance inflates later runs.
2. **Drain etcd to 0 workers** between runs (`stop.sh` does this; verify with
   `count_workers`). Dead frontends/mockers leave lease-backed keys that expire,
   but verify the slate is clean before starting.
3. **Warmup** (`WARMUP_REQUESTS=512`) to prime the prefix cache + warm the
   allocator before the measured phase. The first run after a fresh build is
   still a cold-start outlier — discard it.
4. **jemalloc on the frontend** via `FRONTEND_LD_PRELOAD` for stable allocator behavior.
5. **A/B**: same binary serves both arms when the difference is a runtime flag;
   otherwise rebuild between arms (never during a run). **Interleave** arms
   (A,B,A,B,…) to cancel drift, run 3+ each, compare **medians** (means get
   dragged by the cold first run).

`run_aiperf.sh` knobs (env overrides): `CONCURRENCY`, `REQUEST_COUNT`,
`WARMUP_REQUESTS`. Default workload: shared-system-prompt 48000 +
user-context 12000 (≈60k-token prompts), output-tokens-mean 500,
conversation-turn-mean 4.

## Profiling

### On-CPU (where compute goes) — non-root

```bash
bash scripts/profile_oncpu.sh --frontend --conc 2048   # or --mocker, or --pid N --cores 0-3
python3 scripts/analyze_folded.py <out>/oncpu.folded
```

- Uses `perf record -F 99 --call-graph dwarf`. **DWARF is required**: release
  `.so`s have no frame pointers, so `-g` (FP unwinding) truncates Rust stacks.
- Also samples the target's cores (`mpstat`) and process CPU (`pidstat`) so you
  can see if it saturates. `analyze_folded.py` prints top **self-time** leaves.

### Off-CPU (what blocked threads wait on) — privileged trace access

```bash
DYN_REPO=$DYN_REPO bash scripts/capture_offcpu.sh --frontend --conc 2048
python3 scripts/analyze_folded.py <out>/offcpu_bcc.folded --offcpu
```

- Captures two ways: `offcputime-bpfcc -df` (duration-weighted, user+kernel,
  folded) and `perf -e sched:sched_switch --call-graph dwarf` (backup, reliable
  Rust user frames). bcc's folded format uses a literal `-` frame to separate
  user (root→leaf) from kernel stacks; the **innermost user frame before `-`** is
  what called into the blocking syscall — `analyze_folded.py --offcpu` aggregates by it.
- Interpreting categories: `futex/park` = tokio workers idle (no runnable task)
  OR mutex; `epoll` = waiting on network/backend; `__lll_lock_wait` = glibc
  malloc-arena contention; `rayon` = fastokens pool idle/spin. **Lock contention
  in app code shows as parking_lot/Mutex/RwLock frames** — if those are ~0%, the
  process is idle-waiting, not internally serialized.

## Analysis cheatsheet

- **Throughput**: `extract_throughput.py <artifact_dir>` — recompute from raw
  JSONL (do NOT trust the finalizer; see Pitfalls). Closed-loop sanity check:
  `throughput ≈ concurrency / mean_latency`.
- **Cores busy** (avg): from `mpstat` per-core `%idle` → `busy = 100 - idle`;
  or `cpu_ms_per_req × req_per_s / 1000`. Per-request CPU = Δ(utime+stime from
  `/proc/<pid>/stat`)/CLK_TCK ÷ requests.
- **Latency decomposition**: `request_latency ≈ TTFT + (output_tokens × ITL)`.
  If TTFT dominates and explodes under load → queueing upstream of generation.

## Troubleshooting

**Benchmark methodology**

- **Closed-loop, not open-loop.** Fixed concurrency means you measure
  `concurrency / latency`, NOT the server's max throughput. Idle frontend cores
  usually mean the system is **latency-bound** (each request spends most of its
  life waiting between streamed tokens), not that the frontend is slow. To push
  the frontend toward saturation: raise concurrency AND lower per-request
  latency (smaller block size → more frontend KV work; shorter outputs).
- **Congestion collapse at high concurrency.** Pushing concurrency too high can
  _lower_ throughput (latency explodes faster than concurrency rises). Sweep
  concurrency to find the knee; don't assume "more load = more throughput".
- **Client/server core contention.** aiperf is CPU-heavy (client-side tokenizes
  every prompt, manages every stream across ~25 procs). Co-located with the
  mockers on `OTHER_CORES`, it can saturate those cores and **starve the mockers**
  — making a "collapse" that's really the _load generator_ running out of CPU.
  Always check the CPU split (`pidstat` mocker vs `mpstat` on `OTHER_CORES`);
  if cores are pegged but the mocker is low, the client is the bottleneck.
- **Cold-start first run** is systematically slow even with warmup — discard it.
- **Don't build while benchmarking.** Compiles steal cores and ruin the run.

**aiperf**

- **The finalizer hangs/deadlocks on large runs** ("processing records…"). The
  per-request `profile_export.jsonl` is written incrementally — kill the
  finalizer and use `extract_throughput.py`. Don't wait for
  `profile_export_aiperf.json`.
- **Orphan processes.** aiperf's controller spawns many workers; killing the
  parent can orphan them. A privileged capture can also create workers owned by
  the capture identity. Stop only the task-created process tree from the same
  approved shell. Stray workers hold ZMQ/mmap resources and stall the next run.
- `--benchmark-duration N` (time-based) avoids the giant fixed `--request-count`
  - finalizer problem for profiling loads.

**Profiling**

- **Off-CPU needs root.** Tracepoints (`sched:sched_switch`) and BPF
  (`offcputime`) require root even at `perf_event_paranoid=-1` (tracefs event
  files are root-readable only). On-CPU `perf -F.. -g` works non-root at paranoid≤1.
- **Native `perf --off-cpu` is often NOT compiled in** (needs `BUILD_BPF_SKEL=1`);
  it silently no-ops with a warning. Use `offcputime-bpfcc` / bpftrace instead.
- **No frame pointers in release builds** → BPF user-stack walking truncates.
  Prefer `perf --call-graph dwarf`; bcc still gives good kernel stacks + partial
  user frames. `analyze_folded.py` handles the bcc `-` separator.
- Async-runtime off-CPU is dominated by **worker park (futex)** which is benign
  idle, not contention. Look for app-level lock frames (parking*lot/Mutex) to
  find real serialization. A blocked async \_task* ≠ a blocked _thread_.

**Topology / environment**

- **Block size must match** frontend and mocker. And **very large block sizes
  break the current mocker**: at `BLOCK_SIZE=2048` requests are received but the
  mocker never emits a token (40s hang → client cancel, `output_tokens=0`,
  "Failed to publish response"). 512 and 1024 work; 64 is realistic. Smoke-test
  a single request after any block-size change.
- **Block size is a lever, not just a detail.** Smaller blocks → more blocks per
  prompt → more frontend KV-routing work (radix tree, hashing) AND more mocker
  block bookkeeping. At bs=64 a 60k-token prompt is ~940 blocks and the mocker's
  KV bookkeeping can dominate (~48% of its CPU); at bs=512 (~117 blocks) it drops
  to ~3%. Pick the block size deliberately for what you're stressing.
- **CPU isolation doesn't survive reboot** (`isolate.sh` sets runtime cgroup
  cpusets on system.slice). Re-run `bash scripts/isolate.sh` from an approved
  privileged shell after every reboot. `unisolate.sh` reverts. Check:
  `cat /sys/fs/cgroup/system.slice/cpuset.cpus.effective`.
- **NATS doesn't auto-start after reboot** (user binary); etcd usually does
  (systemd). After a reboot, restart NATS before `start.sh`.
- **jemalloc is frontend-only** here (via `FRONTEND_LD_PRELOAD`); the mocker runs
  on glibc, so its alloc churn can show glibc-arena lock contention
  (`__lll_lock_wait` under `__libc_free`/`Vec::finish_grow`) in off-CPU. Preload
  jemalloc on the mocker too if that matters.
- `DYN_RUNTIME_NUM_WORKER_THREADS` may be **ignored** (the runtime can be reused
  via `runtime_from_existing`, bypassing `from_settings`). Verify thread counts
  in `/proc/<pid>/task` rather than assuming the env var took effect.

**Known result (calibration)**: with mock workers, the Dynamo **frontend is
rarely the bottleneck** — it's latency/IO-bound, sitting ~60–85% of its pinned
cores with ~0 internal lock contention. Frontend micro-opts therefore show flat
e2e throughput on this setup; their value is CPU-efficiency/headroom. To make
the frontend the bottleneck, use small block size + high concurrency, or
real backends, or move the client off-box.

## Limitations

- Measures the frontend and mock-worker request plane, not real GPU backend performance.
- CPU isolation and off-CPU capture require explicit host-owner approval and elevated capabilities.
- Closed-loop aiperf results cannot be presented as open-loop capacity.

## Available Scripts

| Script                       | Purpose                        | Arguments                          |
| ---------------------------- | ------------------------------ | ---------------------------------- |
| `env.sh`                     | Load benchmark configuration   | Environment overrides              |
| `start.sh`                   | Start frontend and mockers     | Environment overrides              |
| `stop.sh`                    | Stop the task-created topology | None                               |
| `run_aiperf.sh`              | Run one measured campaign      | Environment overrides              |
| `isolate.sh`, `unisolate.sh` | Apply or revert CPU isolation  | Optional `--full`                  |
| `smoke.sh`                   | Send one loopback request      | None                               |
| `profile_oncpu.sh`           | Capture on-CPU perf data       | Target selector                    |
| `capture_offcpu.sh`          | Capture off-CPU perf/BPF data  | Target selector, `--conc`, `--cap` |
| `analyze_folded.py`          | Summarize folded stacks        | Stack file, optional `--offcpu`    |
| `extract_throughput.py`      | Parse raw aiperf JSONL         | Artifact path, optional `--conc`   |

Invoke scripts through the agentskills.io protocol when available:

```python
run_script("scripts/start.sh", args=[])
run_script("scripts/extract_throughput.py", args=["/path/to/aiperf-artifacts"])
```
