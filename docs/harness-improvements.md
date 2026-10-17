# Harness improvements: implementation and validation

This implements the first experiments from the
[focused Harness2 review](harness-improvement-review.md). Automated proposal
generation, durable execution recovery and a total context-window budget remain
future work.

The [exact-response follow-up](research-response-validation.md) records the
subsequent runtime fix and expanded research workload results.

## Runtime changes

`webscrape_tool` can expose `output_mode: research` for article research when
its operator configuration sets `enable_research_mode: true`. This flag defaults
to false and remains disabled in the deployed configuration. The default tool
schema, description and output behavior remain unchanged. When enabled, research
mode retains the complete converted Markdown and attribution before the output layer selects
verbatim excerpts. The existing user-scoped cache and exact retriever provide
recovery. Persistence failure preserves the source. Default `full` mode retains
the previous behavior, including its configured output-token limit. Both Rust
and Python preparation paths support the new mode, including renamed scrape
tools. The experimental description explains when to use each mode.

This bounds individual research payloads rather than deleting transcript turns.
Tool receipts, approvals, steering and call/result bindings remain intact.
Retrieval references have a finite cache lifetime; missing or expired evidence
must be reported as unavailable. A preview cannot establish absence.

Preparation logs include a versioned digest of selected instructions, schemas,
tool policy and context settings. Each model-call log also identifies its
advertised catalog digest, preserving visibility when discovery changes it.
The implementation selects fields explicitly and excludes API keys and messages.
Image/source and gateway identity are recorded by the evaluation manifest.

The runtime now supports final-only presentation for exact-output requests; see
[the response contract](tool-correctness.md#final-only-answers). It withholds
text accompanying tool calls and emits only a completed final model answer.
Ordinary streaming, tool receipts and control events remain available. The
answer itself is never rewritten to satisfy an evaluator.

Explicit research mode also distinguishes precision requests (such as preserving
exact labels or reading each URL once) from exhaustive source reads. Full-text,
verbatim, count and absence questions retain the full-content path.

Production tool-policy instructions remain unchanged. Two prompt-only candidates
were evaluated and rejected; neither demonstrated complete correctness on the
expanded workload.

## Evaluation and deployment checks

The [paired evaluator](../evaluation/tool-correctness/README.md) supports
allowlisted per-arm workflow overlays, a larger synthetic catalog, natural
language tool selection, quoted/forbidden tool names and a dependent briefing
sequence with a missing source. It records effective configuration digests and
per-call model routing/usage. Live ConfigMap checks reject routing changes during
an experiment; missing provider identity and usage remain unknown.

The separate Switchyard repository now contains `scripts/check_capabilities.py`.
Its deployment script snapshots the route configuration and requires generation,
automatic and explicit tool selection, fresh result consumption and stream
completion before mutating deployment resources. All six currently configured
target combinations passed this gate. Availability checks remain separate from
Kubernetes readiness and semantic workload evaluation.

## Initial experiment failures

The first expanded paired run stopped when the candidate ignored a no-tool
instruction, queried an unrelated record and substituted its value for evidence
already present in conversation history. That prompted the explicit no-tool and
conversation-evidence contract clarification.

The next candidate recovered the omitted research fact but added commentary to
requests requiring only a value. Similar formatting failures appeared in
dependent reads and the briefing workload. Those attempts remain rejected. A second prompt clarification did not resolve
the formatting failures. An isolated built-gateway test confirms that system
instructions survive translation with tool history. The evaluator keeps the
original strict assertions; no partial answer is reclassified as a pass.

| Trial                                  | Baseline | Candidate    | Decision                                                                         |
| -------------------------------------- | -------- | ------------ | -------------------------------------------------------------------------------- |
| Expanded workflow, initial             | 9/9      | 8/9          | Stopped on candidate unexpected tool                                             |
| No-tool prompt clarification           | 34/40    | 34/40        | Stopped after observed formatting failures                                       |
| Additional output-format clarification | 28/34    | 31/34        | Stopped on baseline unexpected tool                                              |
| Research, each of two trials           | Full 3/3 | Research 0/3 | Reject promotion; omitted fact recovered but extra commentary fails exact output |

Counts include every collected attempt, including stopped suites. Raw synthetic
evidence remains in `/tmp/daedalus-harness-release-20261017/` under `paired-v2`,
`paired-v3`, `paired-v4`, `live-research.json` and `live-research-v2.json`. These
experiments do not support a model-quality or latency improvement claim.

## Initial validation scope

Python validation passed 1,913 tests with 79.36% coverage; five existing tests
were skipped. Rust validation passed 105 tests, with 22 service-dependent tests
remaining opt-in. The built-image HTTP suite exercised streaming, approvals,
recovery, call bindings, steering and cancellation. Helm checks passed.

The built-image research contracts passed in both preparation modes. They prove
recovery of omitted Unicode evidence, attribution, final-answer binding,
cross-user isolation, expiration and preservation on archive failure. In this
scripted sample, recurring serialized input fell from about 62,000 characters to
about 5,000–6,300, at the cost of one retrieval round. These are context-size
measurements, not billing estimates or live latency improvements.

Research mode must pass the live paired correctness and research comparisons
before enabling it in production. The fixtures cover bounded workflows; they
do not establish quality for every production integration or a complete
real-world daily briefing. The final-only follow-up adds multi-source research,
missing evidence, citation binding and steering checks to this release gate.
