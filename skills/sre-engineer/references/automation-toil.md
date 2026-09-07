# Bounded toil automation

Choose a repetitive, evidenced task with a known owner and measurable cost.
Define the desired postcondition before writing automation.

- Start with a read-only decision/dry run and exact target selection.
- Make execution idempotent where possible; bound concurrency, retries, time
  and blast radius. Preserve persistent data and unrelated resources.
- Distinguish product failures, access failures and transient transport errors.
  Inspect state after uncertain completion before retrying a mutation.
- Record actions/results and stop when the expected postcondition fails.
- Include rollback/recovery only when it is actually safe for the data/schema.

An error-rate threshold alone is not a reason to restart a deployment. Check
the diagnosed cause and existing controller behavior before proposing repair.
Never treat missing telemetry as a healthy default or repeatedly mutate until
a dashboard turns green.

For Daedalus autonomous runs, preserve the worker's non-interactive restrictions
and output contract. Do not initiate OAuth, ask for approval or send external
messages from a skill; report unavailable capabilities through the worker's
normal result. Durable verified findings follow the application's source
verification and identity rules.

Validate no-op, repeated execution, partial failure, timeout and postcondition
failure using isolated fixtures. Measure time/error reduction against the
original task, not the number of scripts added.
