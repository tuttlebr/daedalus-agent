# Exact responses and research workflow validation

The runtime previously exposed model narration from intermediate tool rounds as
part of an exact-output answer. Recovering the correct evidence was insufficient:
the accumulated answer still failed the requested format. Final-only presentation
now withholds those rounds and publishes the completed final answer without
rewriting it. See the [API contract](tool-correctness.md#final-only-answers).

Ordinary chat still streams incrementally. A caller can explicitly select
streaming or final-only presentation; auto recognizes common English exact-output
phrases in the latest user message and subsequent steering. This is a presentation
heuristic, not a permission decision or semantic answer validator.

## Deterministic validation

- Python: 1,926 tests passed, five skipped; 79.37% coverage.
- Rust: 106 tests passed, 22 service-dependent tests remain opt-in; formatting and
  Clippy passed.
- Built-image response contracts: 13 cases in each preparation mode. These cover
  multiple tool rounds, exact-output auto detection, explicit overrides, normal
  incremental streaming, incomplete output, retry without replay, cancellation,
  steering, the 1 MiB buffer limit and activity heartbeats. A deliberately
  malformed final answer remains malformed, proving the runtime does not clean
  up answers to pass the evaluator.
- Built-image research contracts passed in both preparation modes: attribution,
  omitted Unicode evidence recovery, user isolation, expired references and full
  source preservation when archiving fails. Precise label requests compact;
  exhaustive, verbatim and absence requests preserve complete source content.
- The runtime HTTP suite passed streaming, approval, recovery, call binding and
  control contracts. The deterministic response and research checks now run in
  `make migration`.

## Live research comparison

The original single-source workload passed all six full/research attempts,
including the three research trials that previously failed exact output. The
strict answer assertions were retained.

The expanded workload passed all 12 attempts: three alternating full/research
pairs for both multi-source comparison and steering after a completed source
read. Each run used two available articles and one unavailable source. Acceptance
required exact JSON, attributed Unicode labels, actual retrieval of facts omitted
from previews, matching call/result IDs and no duplicate source fetches.

The model alias was `daedalus/high`, resolving through the unchanged Switchyard
route configuration to Fireworks `accounts/fireworks/models/muse-spark-open` at
high effort. ConfigMap identity was checked before and after every attempt.
Provider-reported identity does not independently establish immutable weights.

Research mode's maximum recurring serialized input was at most 22.50% of full
mode within every pair: at least 77.5% smaller. Full-mode latency ranged from
15.6–29.4 seconds; research ranged from 18.9–35.1 seconds. No latency improvement
or billing savings is established by these small samples. Limits were frozen at
12 model calls, 12 tool calls and 90 seconds per attempt; context limits and the
50% paired reduction requirement are in the
[evaluation guide](../evaluation/tool-correctness/README.md#research-evidence-recovery).

The first expanded fixture used underscores in opaque labels, which Markdown
conversion escaped and the raw-evidence assertion did not account for. Its
failed attempt is retained as `workflows-v1`; labels now use Markdown-safe opaque
Unicode strings. The next full-mode attempt returned surplus citation fields and
failed exact JSON equality. Its prompt described a source URL without naming
the expected JSON key. The fixture now names the exact keys explicitly;
`workflows-v2` retains that failure. `workflows-v3` contains the complete passing
comparison. Neither assertion set nor acceptance budget was relaxed.

Raw synthetic attempts, manifests, routing checks and logs are retained outside
git in `/tmp/daedalus-response-research-20261017/`, with a persistent release copy
under the sibling `daedalus-agent-release-evidence` directory. Prompt source
snapshots accompany `workflows-v3`; future manifests include prompt bodies and
their digest directly.

## Promotion decision

Research mode remains disabled in production. The expanded 25-case paired
regression suite stopped on an unexpected tool call by the existing baseline:
`history-0` requested a value already present in conversation and prohibited
tools, but the model called `fixture__find_record` for an unrelated record.
The baseline passed 8/9 collected attempts; the candidate passed 8/8 before the
mandatory stop. `paired-v2` preserves every attempt and routing identity.

This incomplete comparison cannot establish the broader promotion gate. The
release carries the final-only response fix, deterministic CI coverage and the
research evaluator, while leaving the research capability gated. The next
promotion prerequisite is reliable no-tool/conversation-evidence behavior under
the expanded catalog. No model or prompt-only workaround is promoted here.

These fixtures bound individual workflows. A total context-window budget,
arbitrary research quality and real-world briefing coverage remain separate
work. Model routing and production tool-policy instructions are unchanged.
