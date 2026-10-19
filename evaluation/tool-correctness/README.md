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
before starting either image. The default workflow suite has 25 cases and 64 synthetic catalog distractors.
Cases cover tool-free arithmetic, long
history, actual clock reads, missing skills, dependent MCP reads, independent
reads, explicit tool errors, natural-language selection, forbidden/quoted tool names,
and a dependent multi-stage briefing with an unavailable source. Three paired
repetitions produce 150 attempts. Use `--suite basic --catalog-size 0` to reproduce
the original 20-case workload.
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
synthetic. A rollout is accepted only after all 60 assertions pass. Fixture success alone
does not establish full-catalog tool selection.

## Configuration and routing identity

Pass `--baseline-overlay` and `--candidate-overlay` YAML files to compare
workflow instructions, iteration/history limits and output-compaction settings
using the same immutable image. Overlays may contain only an allowlisted
`workflow` mapping; tool permissions, endpoints, credentials and model selection
cannot be overridden. For example:

```yaml
workflow:
  tool_output_compaction_enabled: false
```

The version 2 manifest records workload, image, effective workflow, overlay and
tool-schema digests. A transparent localhost proxy records each model call's
selected target, provider-reported model and usage when available. Provide
`--route-configmap CONTEXT NAMESPACE NAME` to resolve target IDs to configured
upstream model/effort and reject live ConfigMap drift before and after every
attempt. `--route-config PATH` instead checks a local snapshot; it cannot detect
remote changes. Unknown identity or usage remains null. No keys, headers beyond
the selected target, or model prompts are stored by this proxy.

Failures and stopped suites remain in their output directories. A new candidate
requires a new directory. Keep model routing and workload fixed when comparing
candidates; a provider may change underlying weights without changing its name.

## Research evidence recovery

Research mode is disabled by default. An experimental configuration must set
`enable_research_mode: true` on the webscrape function and include
`tool_output_retriever_tool`. The check below enables the flag only in its
isolated fixture. See [research workflows](../../docs/research-workflows.md)
for output and recovery contracts. Enabling production mode requires both the
research comparison and the broader paired correctness gate.

The built-image research check uses actual scrape conversion, output storage,
retrieval and both preparation paths, with only external source/model transports
scripted. It checks omitted Unicode evidence, attribution, final-answer binding,
user isolation, expired references and preservation on archive failure.

```bash
builder/.venv/bin/python builder/migration/research_check.py \
  --image <candidate-image> --redis-image <redis-image> \
  --report /tmp/research-contracts.json
```

Add `--live-base-url http://127.0.0.1:4000/v1 --model daedalus/high` to compare full
and research output modes over three alternating pairs with the real model and
a synthetic article. Set `TOOL_EVAL_API_KEY` through the environment. This mode
requires exact answers and retrieval of omitted evidence, preserves every
attempt, and reports recurring context size, usage and latency. These small
controlled trials do not establish general research quality or tail latency.

`research_workflow_check.py` extends that comparison to two available articles
and one unavailable source. A second workload injects steering after a completed
source read, requiring the agent to retain its receipt while adding sources.
Both workloads require exact JSON, correctly attributed Unicode facts, recovery
of evidence omitted from research previews and no repeated source fetches.

```bash
builder/.venv/bin/python builder/migration/research_workflow_check.py \
  --image <candidate-image> --redis-image <redis-image> \
  --source-revision <candidate-commit> \
  --base-url http://127.0.0.1:4000/v1 --model daedalus/high \
  --route-configmap <context> <namespace> <switchyard-configmap> \
  --output /tmp/research-workflows
```

Three alternating full/research pairs per workload produce 12 attempts. Frozen
limits allow 12 model calls, 12 tool calls and 90 seconds per attempt. Maximum
serialized model input is 200,000 characters for full mode and 60,000 for
research; research must also use at most 50% of full mode's maximum recurring
input within every pair. These measure fixture context size, not billing tokens
or a general context-window bound. Report latency separately: evidence recovery
can add model rounds. The run stops on the first failed assertion and preserves
all collected attempts. A new candidate requires a new output directory.

`make migration` runs the deterministic research and response-presentation
contracts; real-model experiments require a separately authorized gateway.
