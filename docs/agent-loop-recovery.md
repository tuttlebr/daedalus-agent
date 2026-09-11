# Agent loop recovery

The shared Responses agent uses a fresh progress guard for each request. It
applies to every task using that workflow, including ordinary chat and backend
requests from background workers. The guard observes original tool messages
before output compaction. Prior conversation history does not consume the new
request's budget, and concurrent requests do not share counters.

The `workflow.loop_guard` settings in
[the backend configuration](../backend/tool-calling-config.yaml) control:

| Setting                  | Default    | Behavior                                                                                                                            |
| ------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `window`                 | 24         | Recent tool results considered for repetition.                                                                                      |
| `repeated_call_limit`    | 4          | Stop repeated identical arguments and results. Sandbox request IDs and timing do not make a result new; collected file contents do. |
| `repeated_error_limit`   | 4          | Stop recurring errors from the same tool even if arguments or numeric error offsets change.                                         |
| `repair_call_limit`      | 12         | Stop an unresolved repair after this many subsequent calls to the affected tool.                                                    |
| `final_response_timeout` | 30 seconds | Bound the final response after stopping tool execution.                                                                             |

An explicit validation pass or successful rerun of the failed command resolves a
sandbox repair. An exit-zero inspection or file write does not. Ordinary tools
can resolve an error with a successful result. These are conservative heuristics,
not a proof of semantic progress; repeated polling and unusually long repairs
may require operator tuning. Distinct successful research calls are not subject
to a small universal call budget. The existing 128-iteration limit remains the
final bound, including when `loop_guard.enabled` is false.

When a guard stops a run, the graph ends before another tool round. Ordinary
tasks get one bounded synthesis request with no tools; a timeout, exception, or
unexpected tool request produces a deterministic incomplete-response message.
Both streaming and non-streaming paths use this behavior. Stream closure releases
the request scope and closes the graph generator.

Every run writes a bounded outcome log with a run ID and model/tool counts. A
paired `daedalus.agent.outcome` custom event also goes through the NVIDIA NeMo
Agent Toolkit event stream, which the configured Phoenix exporter consumes. Its
metadata includes `outcome`, `failed`, and the toolkit workflow run ID. The outer
function span may still be `OK` when a failure is returned as text; inspect the
explicit outcome. Full transcript logging on every graph iteration is disabled
in the shipped workflow configuration.

## Briefing assembly

The [daily-summary skill](../skills/daily-summary/SKILL.md) submits its edition as
an object to `briefing_renderer_tool`. The backend serializes JSON and stages the
fixed policy, template, renderer, and validator in a unique conversation-sandbox
directory. Both canonical gates must pass, and the collected HTML must be complete.
The graph returns that exact document in the inline HTML fence, without another
model rewrite or a publication call.

Each request permits two rendering submissions. After the first failure, a
six-result phase budget also bounds auxiliary work; switching tools cannot evade
it. Parallel submissions share a request-local lock and the same budget. Missing
resources, an unavailable service, failed correction, or an exhausted phase
produces a compact HTML error edition. A terminal result cannot restart rendering.
This briefing-specific limit remains active if the general guard is disabled.

The renderer accepts an object rather than duplicating its full field schema in
the tool adapter. The canonical renderer remains authoritative for edition fields
and returns field-specific validation errors. This removes JSON string assembly
while preserving the existing editorial and HTML validation rules.

## Validation

Focused builder tests exercise repeated and changing arguments, misleading
exit-zero results, changing artifact contents, request isolation, exact resource
transfer, both quality gates, correction budgets, and truncated collections.
`builder/agent_loop_contract_check.py` additionally exercises the real installed
toolkit graph offline, including concurrent runs, finalizer failures/timeouts,
stream completion/closure, native outcome events, and tool registration. It is
also invoked by the image's runtime contract check.

The captured September 11 incident stops after 50 of its original 144 tool
results when replayed through the general guard. This is a deterministic replay,
not a new model evaluation or production deployment.
