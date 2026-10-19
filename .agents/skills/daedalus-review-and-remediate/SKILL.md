---
name: daedalus-review-and-remediate
description: Thoroughly review and remediate the Daedalus codebase for root-cause bugs, dead code, conflicting implementations, frontend/backend latency, and test and pre-commit correctness. Use for a requested comprehensive codebase audit or cleanup across these concerns; ordinary feature work and isolated bug fixes do not require this workflow.
---

# Daedalus review and remediation

Deliver verified fixes across all five review areas. Review and remediation are
the default: implement supported fixes instead of stopping at a findings list.
Honor an explicit review-only request or narrower scope. A clean test run alone
does not establish that the code or the tests are correct.

## Establish scope and coverage

Locate the Daedalus checkout from the working directory or user-provided path;
do not hardcode an installation path. Read applicable `AGENTS.md` files,
`CONTRIBUTING.md`, and `docs/architecture.md`. This repository maintenance skill
lives in `.agents/skills/`; the repository's `skills/` contains application
runtime instructions and has different discovery and execution rules.

Use [the repository guide](references/repository-guide.md) to locate contracts
and validation entry points. Confirm them against the current checkout before
using them; historical reviews are evidence to revisit, not current findings.

- Record the starting revision, working-tree changes, available toolchains and
  services, and relevant baseline failures. Preserve unrelated user changes.
- Inventory production entry points, routes, workers, configuration-selected
  tools, shared schemas, persisted data, deployment wiring, tests and hooks.
  Follow requests across language/process boundaries as well as within modules.
- Keep a review ledger in the working notes or a local report. Track each
  subsystem and test module as reviewed, outstanding, or blocked with a reason;
  track every configured hook separately. Track all five review areas for each
  applicable subsystem. Sampling alone cannot support an all-tests or
  whole-codebase completion claim.
- For each finding record location, triggering conditions, expected behavior,
  evidence, root cause, impact/priority, chosen remedy, and verification status.
  Separate confirmed defects from hypotheses and unmeasured opportunities.

Prioritize data loss, incorrect results, lifecycle races and user-visible stalls,
then work through the remaining inventory. Batch related fixes so each has an
understandable rationale and validation. Continue through the agreed scope;
do not stop after a few easy findings or invent defects to fill categories.

## 1. Bugs: establish the cause and fix it

Trace the triggering input through its actual callers, configuration and state
transitions. Reproduce failures with a focused test, synthetic request or minimal
trace; where reproduction is unavailable, identify the precise violated contract
and qualify the evidence. Check failure, timeout, cancellation, retry, reconnect,
duplicate-event and concurrent-user paths where the component supports them.

Fix the owning layer. A longer timeout, swallowed exception, broad retry or UI
workaround is not a root-cause fix unless evidence establishes that policy as the
cause. Preserve authenticated ownership, error semantics and durable state.
Add or repair behavior-level regression coverage; demonstrate that it detects
the original bug and passes with the fix when practical. Verify callers and
adjacent state transitions, not just the edited function.

## 2. Dead code: prove it is unused, then delete it

Use static analysis and reference searches to identify candidates, then inspect
runtime reachability. A missing import or an unfamiliar legacy name is not
proof: check Next.js file routes, YAML registrations, tool factory lists, dynamic
loading, package data, Docker stages, scripts/CLI entry points, generated code,
optional configurations, compatibility readers and migration fixtures.

Delete confirmed unreachable or superseded implementations and their exclusively
owned tests, imports, assets, configuration and dependencies. Update manifests
and lockfiles through the repository's normal tools when necessary. Regenerate
derived files from their source. Remove dependencies only after checking other
consumers. Preserve intentionally supported fallback and compatibility paths;
if reachability remains uncertain, record it rather than deleting speculatively.
Validate the supported configurations affected by each removal.

## 3. Contradictory decisions: choose and consolidate

Compare competing implementations of the same contract across UI, API, worker,
Rust, Python, schemas, persistence, tests and documentation. Distinguish deliberate
layer-specific policy from accidental disagreement. Identify the expected public
behavior and why each implementation exists before deciding which should survive.

Choose using correctness, supported users/configurations, data compatibility,
ownership, measured performance and maintenance cost. Prefer an existing sound
implementation; refactor shared logic or contracts when neither is adequate.
Do not assume the newest code, a particular language, or the majority of copies
is correct. Record the alternatives, decision and tradeoff. Update all affected
callers, generated types, tests and docs together. Keep stored/wire compatibility
or provide an explicit migration when the contract changes. Avoid a broad rewrite
or new dependency when focused consolidation resolves the contradiction.

## 4. Latency: follow the user's critical path

Trace submission to visible feedback, first useful content, completed answer and
durable/recoverable completion. Inspect both directions:
browser state/render -> Next.js API -> Redis admission/queue -> stream worker ->
Rust model/tools -> Python/service calls -> SSE -> Redis/WebSocket -> browser.

Use a representative, repeatable synthetic workload and existing safe timing
facilities. Record queue wait, connection/setup, service/model/tool time,
serialization/payload volume, transport buffering and browser update cost where
they contribute. Measure perceived responsiveness separately from total work;
an earlier spinner does not prove the answer arrives sooner.

Look for redundant round trips, duplicate fetching/polling, serial independent
I/O, repeated preprocessing, avoidable payload copying, synchronous event-loop
work, queue contention, buffering/debounce delays, and unnecessary React renders.
Attribute delays before optimizing. Preserve bounded concurrency, call/result
ordering, backpressure, cancellation, deadlines, user-scoped caches, authorization
and durable recovery. Do not remove required persistence or replay started remote
actions to make a benchmark faster.

Compare before and after under matched input, service/model, cache, load and
build conditions. Report sample count and appropriate distributions (for example,
median and p95 with enough samples), not a claimed percentile from a tiny run.
Label synthetic timing and estimates; isolate external provider variability and
state what user-facing effects remain unmeasured. Do not claim an end-to-end
improvement from a microbenchmark alone.

## 5. Tests and pre-commit: verify what they actually enforce

Inventory all test modules and runners, including Python, Rust, Vitest,
Playwright, integration, migration/built-image contracts and validation scripts.
Compare discovery rules, CI commands, Make targets, coverage includes/excludes,
markers, environment gates and fixtures to the production behavior they claim
to protect. Read every in-scope test module; record gaps instead of declaring
untouched suites relevant because they pass.

For each suite, check that assertions can detect the intended regression, code
under test is real, fixtures reflect supported contracts, and mocks stop at the
appropriate boundary. Inspect unawaited work, assertions inside unexecuted
callbacks, ineffective exception assertions, snapshots of obsolete behavior,
shared state, fake timers, nondeterminism, unconditional skips and expected
failures. Examine tests that assert only source text or mock calls: replace them
when they cannot establish the claimed behavior; structural checks may still be
valid for actual structural requirements.

Repair invalid tests and add missing regression coverage. Remove obsolete tests
only with evidence that their supported behavior is retired or retained coverage
is equivalent. Do not lower coverage floors, expand exclusions, blindly accept
snapshots, skip failures or change correct expectations to match broken code.
For important or suspicious checks, demonstrate a failure with the original bug
or a controlled invalid input/mutation in an isolated workspace. Restore any
temporary mutation before running the final checks.

Audit `.pre-commit-config.yaml` and every local hook implementation: file/type
filters, exclusions, stages, working directory, filename handling, dependency
availability, language versions, exit-status propagation, autofixes and CI parity.
Use disposable representative valid/invalid files to prove questionable or
changed hooks select the intended files and reject the intended faults. A hook
that silently skips a missing dependency or processes no files is not evidence
that its check passed. Inspect formatting hooks for repeated incompatible edits.
Keep `Makefile` and CI consistent when changing validation commands.

## Keep documentation aligned with code

For each code change, check whether it affects documented behavior, interfaces,
configuration, architecture, or development and operational workflows. Update
the affected documentation in the same change, including examples and references
to renamed or removed functionality. Keep edits scoped to the change; leave
documentation unchanged when it remains accurate.

Verify documented commands, paths, defaults and examples against the resulting
implementation. Regenerate generated documentation from its source when needed.
Treat stale documentation introduced by a fix as unfinished remediation.

## Keep this skill current

This skill is versioned with the repository. Drift between the checkout and
[the repository guide](references/repository-guide.md) is part of the review;
neither source is authoritative until confirmed against current code.

- Update the guide in the same change when entry points move, ownership shifts
  between the frontend, Rust and Python, or CI jobs, Make targets, hooks, test
  layout, toolchain versions or coverage floors change.
- Change this file only when the workflow itself must change, such as a review
  area, gate or safety boundary. Keep repository facts in the guide.
- Write repository paths in full inside backticks and name gates by their `make`
  targets. `scripts/check_maintenance_skills.py` fails when such a reference
  disappears; it cannot detect outdated descriptions.
- Keep findings, measurements and dated results in the review report, docs or
  pull request, not in this skill.

## Validate and finish

Run focused regressions as fixes land, then the relevant repository gates from
the guide. For a comprehensive audit, account for every CI job and run all
applicable feasible gates, including whole-suite coverage and hooks. Use local
disposable services; creating this skill or invoking a code review does not
authorize deployment, live-data changes, publishing, or external messages.

Tool registration/provider/runtime changes need a request against the built
backend image as required by the repository. Test-stub success cannot substitute
for that evidence. Shared protocol changes need regeneration and drift checks.
Run pre-commit on changed files and an all-files hook pass for the full audit;
inspect autofixes and rerun affected checks until the result is stable.

Review the final diff for incomplete migrations, stranded callers, stale
documentation, weakened assertions, accidental generated artifacts and unrelated
edits. Revisit the ledger to ensure all five areas and all test modules/hooks are
accounted for.
Finish when the agreed inventory is reviewed, confirmed in-scope fixes are
implemented, and required checks pass or have explicit unresolved blockers.
If a dependency or user decision blocks one area, continue independent work and
report the exact remaining scope; do not claim complete remediation.

Report:

- Fixes and removals with root causes, affected paths and regression evidence.
- Design decisions and compatibility consequences.
- Latency measurements, comparison conditions and limits of the evidence.
- Test/hook repairs and commands run, including failures, skips and blockers.
- Coverage of the review and any residual findings, risks or decisions needed.
- Documentation updated to match code changes, or why no updates were needed.
- Updates made to this skill or its guide to match the current repository.

An empty category is valid when supported by a completed review. Do not claim
the codebase is bug-free or all tests verified without evidence for that scope.
