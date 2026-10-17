# Focused Harness2 review for Daedalus

Reviewed October 17, 2026 against Daedalus `f8a85c8` and
[Harness2 `1cfe254`](https://github.com/google-research/harness2/tree/1cfe254e8d25b15f37048c3730134686abe60335).
This records the design review and original experiment plan. See
[implementation and validation](harness-improvements.md) for the resulting
changes, observed failures and release evidence.

The most useful transfer is to make a proposed agent configuration a small,
identifiable experiment with preserved execution evidence and an explicit
acceptance decision. Daedalus already owns its model/tool loop, permissions,
discovery and recoverable output storage. Those are useful foundations for
testing individual improvements.

## Recommended order

| Priority | Change                                                                   | Reason                                                                                                   | First boundary to change                                                        |
| -------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1        | Gate model changes with a real generation/tool canary                    | Catalog availability and healthy pods did not predict a working model endpoint during the recent outage. | Switchyard deployment checks, then a request through the built Daedalus backend |
| 2        | Extend paired evaluation to configuration changes and complete workflows | Both isolated checks and the bounded live suite have missed real failures.                               | `evaluation/tool-correctness/run.py` and its workload fixtures                  |
| 3        | Experiment with exact research artifacts and smaller recurring context   | Research transcripts grow substantially despite existing inbound history limits.                         | `builder/runtime/src/output.rs`, `output_retriever.rs`, then `agent.rs`         |

Priority 1 addresses availability. Priority 2 supplies the evidence needed to
accept changes such as priority 3. None requires another orchestration service.

## 1. Test the model behavior required by the agent

The Rust [`/health` route](../builder/runtime/src/main.rs) reports process
health. Readiness checks application dependencies; it does not attempt model
generation. [Frontend selection](../frontend/server/chat/backendSelection.ts)
deliberately uses `/health`. Switchyard's deployment script also ends with a
health check. These checks have legitimate purposes, but cannot establish that
an advertised upstream model can execute a request.

Add a bounded pre-promotion canary against each changed provider/model/API/effort
combination. Exercise text generation, automatic tool selection, explicit tool
selection, and a tool-result-to-final-answer round trip. Generate a fresh marker
inside a synthetic read-only tool result and require the final answer to return
it exactly. Verify call IDs, argument shape and the streaming terminal event.
Then exercise the candidate route through a built Daedalus backend before
accepting the deployment.

Reject promotion on a failed required check. Preserve the working route and
record the tested route/configuration identity. After deployment, a low-frequency
bounded canary can report model availability separately from process health.
Avoid adding paid model calls to each Kubernetes readiness probe: an upstream
outage should not remove every otherwise functioning application pod.

This is a Daedalus extension motivated by the outage. Harness2's
[preflight](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/preflight.py)
checks local prerequisites and explicitly says its offline checks cannot prove
that an account can serve a model. It does not provide this live capability gate.
Any later failover design must preserve tool receipts and avoid replaying
uncertain mutations; a canary alone does not solve in-flight recovery.

**Acceptance:** scripted unavailable-model, malformed-tool and missing-terminal
cases fail the gate; an actual supported endpoint passes the full exchange;
failed pre-promotion checks leave the active route unchanged. Report service
availability and task correctness separately.

## 2. Evaluate the configuration and the complete workflow

The current [paired evaluator](../evaluation/tool-correctness/run.py) already
freezes workloads, alternates baseline/candidate attempts, records failures and
checks actual tool results. It builds the same small workflow configuration for
both images: clock, skill lookup and a synthetic read-only MCP group, with eight
iterations and synthetic instructions. Its CLI selects images but has no
per-arm configuration input. Configuration-only experiments therefore lack a
direct, controlled path through this evaluator.

The missing coverage has concrete consequences:

- The [first rejected rollout](../evaluation/tool-correctness/live-rejected-2026-10-12.json)
  passed 60/60 isolated attempts, then only 54/60 with the production catalog.
  Failures invented timestamps without calling the clock.
- A [later rollout](../evaluation/tool-correctness/menu-results-2026-10-12.json)
  passed all 60 bounded production checks, but failed during a longer briefing
  after exhausting a global correction allowance. Current
  [`Recovery`](../builder/runtime/src/tool_contracts.rs) is already per-tool;
  this historical failure demonstrates the workload gap, not an unfixed global
  allowance in today's code.
- The same evaluation record documents a changed gateway configuration between
  studies, preventing attribution of those cross-study differences to the patch.

Start with optional, validated per-arm configuration overlays on the existing
fixture runner. For configuration experiments use the same immutable image and
change one component at a time. Keep fixture endpoints, credentials and tool
authorization outside the candidate-editable fields. Record the fully resolved
configuration identity before either arm starts.

Use a versioned, allowlisted manifest with runtime image/source, workflow
instruction revision, tool-policy revision, tool schema digest, context-policy
settings, bundled instruction digest, gateway route revision and workload hash.
Record the actual selected model and effort per call when the gateway exposes
them, including any within-run promotion. An alias alone cannot establish model
identity. Mark unavailable identity fields as unknown and invalidate attribution
when route configuration drifts during a comparison. Endpoint identity still
does not guarantee that a provider's underlying weights are immutable.

Hash only explicitly selected configuration fields. `PreparedRun` contains an
API key and conversation messages, so serializing it as a manifest would leak
secrets and private content. Keep attempt evidence access-controlled and publish
only content-free summaries.

Harness2 provides a useful precedent in its
[validated editable surface](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/tree.py)
and [configuration-bound completion markers](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/runmark.py).
For Daedalus, extend identity to routing and workload conditions. A completed
trial marker permits reuse of that trial; it does not checkpoint a running agent.

Add these workload families before judging a candidate:

| Workload                                         | What must be observed                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Production-scale catalog with synthetic services | Natural-language requests select the correct tool; deferred discovery works; quoted or forbidden tool names do not trigger execution.                  |
| Complete briefing sequence                       | Several dependent rounds, correction at two separated stages, one unavailable source, and final synthesis preserve completed evidence and report gaps. |
| Research with omitted evidence                   | A required fact near the middle or end of a long source is retrieved exactly and attributed correctly.                                                 |
| Steering after completed actions                 | Updated intent is applied while existing receipts prevent repeated actions; cancellation still terminates work.                                        |

Use deterministic built-image provider fixtures for injected faults and live
model trials for tool choice and synthesis. A sanitized catalog fixture can
test scale reproducibly; retain a separate authenticated live-catalog check
because fixtures cannot prove production behavior. Existing
[`runtime_http_check.py`](../builder/runtime_http_check.py) contracts should
continue to own mutation, approval and malformed-provider invariants.

**Acceptance:** preserve all attempts; require candidate correctness and no
per-case regressions; retain the baseline when the candidate fails. Freeze
latency/token budgets before collection and compare within workload families.
Small smoke suites cannot establish reliable tail-latency improvements. Maintain
held-out tasks for promotion so repeated tuning does not merely fit the visible
fixtures. Account for evaluation/proposal work and missing usage explicitly.

## 3. Make research evidence retrievable before bounding context

The [long-running workflow review](long-running-workflows.md) recorded a run with
31 model calls whose reported input grew from 60,556 to 576,392 tokens. Aggregate
reported input was 10,332,489 tokens. These are provider usage counters, not
billed or uncached tokens. They identify a substantial optimization opportunity
without establishing a cost saving.

[`preparation.rs`](../builder/runtime/src/preparation.rs) applies history limits
at preparation. [`agent.rs`](../builder/runtime/src/agent.rs) retains subsequent
model/tool messages and clones that history into later requests. Current output
compaction preserves generic scrape markdown, so the observed research runs
produced no compaction events.

Harness2's [evidence context tree](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/context.py)
gives an improvement agent file references to trajectories, deliverables and
candidate configurations. This separates stored evidence from the initial
prompt. Its adapters can still truncate individual observations; the file tree
itself is not a runtime context-budget guarantee.

Adapt that separation through Daedalus's existing
[`OutputStore`](../builder/runtime/src/output.rs) and
[exact retriever](../builder/runtime/src/output_retriever.rs). The writer already
persists originals under user-scoped references before replacing eligible output
with previews, and preserves full content when persistence fails. The retriever
already supports literal search and exact Unicode-aware paging.

The first experiment should be an explicit read-only article-research output
mode: store the exact original, return source identity plus a bounded preview
and retrieval reference, and keep the reference available throughout the run.
Start with output payloads rather than deleting whole transcript turns. Preserve
call/result bindings, steering, approvals and execution receipts. Keep exact
code/document workflows on their existing path. Test retrieval failure and
expiration as well as successful retrieval; the current cache lifetime is finite
and does not establish durable evidence across arbitrary later turns.

After this experiment proves evidence recovery, design an application-owned
total request budget covering instructions, schemas and growing history. Reserve
space for the answer and tool recovery. If evidence cannot be archived, preserve
it and surface the limit rather than silently dropping it. Provider-side
`truncation: auto` cannot enforce these retention invariants.

**Acceptance:** omitted facts are recovered exactly; exhaustive questions do
not infer absence from a preview; citations remain correct; archive failure
preserves original content; cross-user retrieval fails. In paired long-research
trials, demonstrate lower recurring input with no correctness regression and
report retrieval rounds and end-to-end latency, including any overhead.

## What to defer

Keep automated configuration proposals offline until the richer evaluation can
reject them reliably. Harness2's
[experience prompt](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/prompts.py)
asks for evidence of an edit's effect, allows uncertainty and permits no lesson
to be recorded. That is a useful future review format. A selected answer alone
does not prove that a changed instruction helped or should become durable memory.

Two upstream choices need deliberate adaptation:

- Harness2's [final selection pool](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/selection.py)
  excludes baseline executions. Daedalus promotion should explicitly retain the
  working baseline when no candidate clears acceptance.
- Its [core budget](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/ledger.py)
  is four times the candidate count in rollouts and three times that count in
  improvement stages, with selection and reflection accounted separately.
  Measure this overhead in offline experiments before considering any user-facing
  adaptation loop.

Avoid expanding lazy discovery solely to reduce schema bytes. Initial menu
narrowing and several deferred groups already exist; additional deferral must
earn its extra discovery round on the richer workload. Similarly, durable
in-flight recovery needs persisted execution state and mutation receipts, beyond
Harness2's completed-trial reuse.
