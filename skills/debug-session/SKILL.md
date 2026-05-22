---
name: debug-session
description: Set up a structured debugging session for an issue in the Dynamo ecosystem — creates a worklog file, gathers environment details (KV cache, backends like SGLang/vLLM/TensorRT-LLM, ZMQ, GPU state via nvidia-smi), captures the bug report and reproduction steps, and frames the investigation. Use whenever the user says "start a debug session", "set up a worklog", "investigate this Dynamo bug", "debug DYN-NNN", "reproduce this issue", "framework regression", or otherwise wants a tracked, multi-step investigation against the Dynamo runtime, KV router, block manager, or one of the SGLang/vLLM/TensorRT-LLM backends — as opposed to a quick one-off fix.
user-invocable: true
disable-model-invocation: true
---

# Start Debug Session

> **Related skills:** `dynamo-bug` (file the bug as a GitHub issue once root cause is known), `dynamo-docs` (record findings or workarounds in the Dynamo Fern docs).

Create a structured debugging session for an issue in the Dynamo ecosystem.

## Step 1: Get the Bug Report

Ask the user how they want to provide the bug:

**Option A: Linear ticket**
- User provides ticket ID (e.g., "DYN-123")
- Fetch via Linear MCP tools
- Extract: title, description, reproduction steps

**Option B: GitHub issue**
- User provides issue URL
- Fetch via `gh issue view <url>`
- Extract: title, description, reproduction steps

**Option C: Paste**
- Ask user to paste the bug report directly
- Parse out the key details

## Step 2: Discover Environment

Gather environment information:

!`nvidia-smi --query-gpu=name,count --format=csv,noheader 2>/dev/null || echo "No GPU detected"`

!`uname -a`

!`which python && python --version`

This tells you:
- GPU type and count (L40s, H100s, etc.)
- OS/platform
- Python environment

**Note**: The user's `~/.claude/CLAUDE.md` may have more details about their dev environment (paths, aliases, preferences). Check there for additional context.

## Step 3: Create Worklog

Create a worklog file to track the investigation:

- **Filename**: if a ticket ID is known, use `<TICKET-ID>-<slug>.md` (e.g. `DYN-2204-trtllm-throughput-drop.md`) so future you can find it via the ticket. Otherwise use `<issue-slug>.md`. Place in the current directory.
- Template:

```markdown
# Debug: [Issue Title]

**Date**: [today's date]
**Source**: [Linear ticket / GitHub issue / user report]
**Status**: investigating
**Environment**: [GPU type/count from nvidia-smi]

## Versions
- **Dynamo runtime**: [e.g. 0.3.0]
- **Suspected-bad release**: [version where bug appeared, if regression]
- **Last known-good release**: [if regression]
- **Backend / framework**: [trtllm 0.13, vllm 0.6.4, sglang 0.4.1, etc.]

## Problem
[Description of the issue]

## Reproduction Steps
1. [Step to reproduce]
2. ...

## Expected vs Actual
- **Expected**:
- **Actual**:

## Investigation Log

### [timestamp]
[Notes on what you tried/found]

## Root Cause
[Fill in when found]

## Fix
[Fill in when implemented]
```

## Step 4: Set Up Testing

### Build Commands

Rebuild Dynamo after making changes:
```bash
cd lib/bindings/python && maturin develop --uv && cd ../../.. && uv pip install -e .
```

If a framework change is required (sglang, vllm, trtllm), check the user's `~/.claude/CLAUDE.md` for rebuild instructions specific to that framework.

### Running Examples

Examples live under `<dynamo-repo-root>/examples/backends/`. Find the repo root with:

```bash
git rev-parse --show-toplevel 2>/dev/null || find ~ -maxdepth 4 -name 'dynamo' -type d 2>/dev/null | head -1
```

Available backends under `examples/backends/`:
- `sglang/launch/` - SGLang backend examples
- `vllm/launch/` - vLLM backend examples
- `trtllm/launch/` - TensorRT-LLM backend examples

Based on the bug report, determine which backend is relevant:
- If unclear, **ask the user** which backend/example to run
- Run the example in the background
- Wait for model to be ready

### Confirm Reproduction Before Investigating

A `/v1/models` check or a single curl is a smoke test, not a reproduction. **Before moving to Step 5**, confirm the bug actually reproduces — for a throughput regression that means running a load probe (not one request), for a correctness bug that means triggering the exact wrong-output path. If the reproduction doesn't fire, stop and re-examine the env/version assumptions before going deeper.

### Verifying the Model is Up

```bash
curl localhost:8000/v1/models
```

### Testing with a Request

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<model-name-from-above>",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 50
  }'
```

## Step 5: Begin Investigation

### Dynamo Infrastructure Debugging

**KV cache and routing issues:**
- Check KV event logs in `lib/llm/src/block_manager/kv_consolidator/tracker.rs`
- Look at block manager state and consolidation behavior
- Inspect routing decisions in the KV-aware router

**ZMQ / networking issues:**
- Check ZMQ socket configuration and endpoint bindings
- Look for connection timeouts or message drops
- Verify nats/etcd connectivity for service discovery

**Multi-node / disaggregated issues:**
- Check prefill/decode worker assignment
- Verify DGD (disaggregated) status reporting
- Inspect inter-node communication via `nvidia-smi` on each node
- Check NCCL and GPU direct RDMA status

**Process inspection:**
- `ps aux | grep dynamo` - check running processes
- `nvidia-smi` - GPU utilization and memory
- `ss -tlnp | grep 8000` - check port bindings
- `journalctl -u dynamo` - systemd logs if applicable

**Performance / throughput regression (when the symptom is "X% slower" or "lower tokens/sec"):**
- **Bisect**: identify the last known-good release tag and the first bad one. `git bisect start <bad> <good>` between dynamo release tags, run a fixed-concurrency benchmark per step, narrow to the offending commit.
- **Concurrency probe**: a single curl is not a throughput test. Use `oha` / `wrk` / dynamo-bench / `vegeta` against `/v1/chat/completions` at multiple concurrencies (1, 4, 16, 64) and record tokens/sec at each.
- **GPU dwell**: `nvidia-smi dmon -s pucvmet -d 1` during the load probe to see SM utilization, memory bandwidth, NVLink usage; compare against the known-good run.
- **Traces**: `nsys profile -o /tmp/dynamo-bad.nsys ...` for short windows (5-10s); the Nsight Systems UI surfaces kernel/idle gaps quickly.
- **Backend-specific knobs**:
  - **trtllm**: engine build cache hit/miss (rebuild can dominate first-iteration), executor config (max_batch_size, max_num_tokens), in-flight batching mode, paged KV cache settings.
  - **vllm**: enforce_eager vs CUDA graphs, max_num_seqs, max_model_len, kv-cache fraction.
  - **sglang**: chunked-prefill, mem-fraction-static, schedule policy.

### General Debugging Workflow

1. **Reproduce first** - verify you can trigger the bug before attempting fixes
2. **Document as you go** - update the worklog with findings
3. **Minimal changes** - fix the bug, do not refactor surrounding code
4. **Verify the fix** - confirm the reproduction case now passes

Performance-critical code - avoid unnecessary abstractions or comments.
