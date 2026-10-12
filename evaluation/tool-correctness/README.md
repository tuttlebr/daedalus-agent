# Paired tool correctness evaluation

Run with the builder environment, Docker, two backend images, and an authorized
model gateway. Set `TOOL_EVAL_API_KEY` through your secret source; never put it in
command arguments or committed files.

```bash
builder/.venv/bin/python evaluation/tool-correctness/run.py \
  --baseline-image <immutable-baseline> \
  --candidate-image <candidate-image> \
  --baseline-source-revision <baseline-commit> \
  --candidate-source-revision <candidate-commit> \
  --base-url http://127.0.0.1:4000/v1 \
  --model daedalus \
  --output /tmp/tool-correctness-evaluation
```

The output directory must not exist. The harness freezes the workload and gates
before starting either image. Twenty cases cover tool-free arithmetic, long
history, actual clock reads, missing skills, dependent MCP reads, independent
reads, and explicit tool errors. Three paired repetitions produce 120 attempts.
Each request has a 60-second budget and the suite has a 30-minute limit. Unexpected
tool execution stops the evaluation. Failed attempts remain in the evidence.

The native tools run inside the real images. MCP is a synthetic read-only peer;
its values and identifiers are supplied by actual tool results. The model path
is real. Memory is disabled and no production MCP services are connected. This
boundary proves behavior on this controlled workload, not every production tool.
Use `builder/runtime_http_check.py` for deterministic mutation, approval,
cancellation, and malformed-provider contracts.

Review `baseline.json`, `candidate.json`, and `attempts.jsonl`. Acceptance requires
all candidate correctness assertions and no per-case regressions. Measure
HTTP request-to-backend-terminal latency; this is not browser/UI completion.
Use the performance skill's comparison helper for paired latency analysis, with
thresholds chosen before the experiment. Preserve the frozen workload and all
attempts when iterating on a candidate.

## Production catalog acceptance

`live.py` preserves the original 20-case production workload: arithmetic, long
history, exact clock reads, and one intentionally missing skill per case, each
repeated three times. It connects to an already deployed backend and uses its
complete mounted configuration. It exits unsuccessfully for any failed assertion
or incomplete suite and emits every attempt as JSONL. Supply the deployed source,
image, workflow, and route versions; credentials come only from
`DAEDALUS_INTERNAL_API_TOKEN`. Use `--help` for arguments.

Run with a fresh `synthetic-` identity and unique request prefix. These requests
may populate that identity's memory; delete only its synthetic memory bank and
clear its cache afterward, and verify absence. Keep the JSONL and release evidence
outside git because they contain full tool payloads, even though the workload is
synthetic. A rollout is accepted only after all 60 assertions pass. The rejected
first rollout is recorded in `live-rejected-2026-10-12.json`; fixture success alone
did not predict full-catalog tool selection.
