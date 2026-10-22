# Offline skill evaluation

`make eval` runs paired cases and writes `.cache/skill-eval/report.json` plus a
terminal summary. Prepare the runtime once with `make skill-eval-image`; the suite
itself uses `--pull=never --network=none`. Override `SKILL_EVAL_IMAGE` for an already
cached compatible Python 3.12 image. No source credentials, home directory, Docker
socket, evaluator, assertions, or sibling skills are mounted into the executor.

This first adapter tests the real fantasy scoreboard helper's input/output and
exit status. It measures the availability and behavior of that executable skill
resource. Without the skill the adapter reports `not run` and exits 2: it has no
scoreboard algorithm. This is an availability baseline, not an LLM ablation study.
Prose following, retrieval, and model quality are **not run** by this adapter.
Do not extrapolate these scores to other skills or model behavior.

Case files use JSON-form YAML (the strict JSON subset of YAML, parsed without a
third-party YAML dependency). Each has `id`, `prompt`, `input`, and nonempty
`assertions`. Assertions carry a behavioral `claim`, `kind` (`exit_code` or
`json_equal`), `equals`, and a JSON `path` for equality. Optional `workspace`
assertions use `kind: file_json_equal`, a relative `file`, `path`, `equals`, and
`claim`. Every claim must pass to earn the case's single rubric point. Unknown
assertions fail closed. Tests passing can be represented by the task process's
exit code; arbitrary verifier commands from cases are never executed.

The committed absent baseline is measured first. The separate installed reference
records which cases already pass. Regression means losing a previously passing
case or changing the absent baseline. A known failing regression case may exist
before its fix; it earns zero until an observed run passes. A broken helper fails
against the installed reference even when it cannot score below the absent floor.

The evaluator, adapter, case files, baseline, and installed reference are protected
inputs, outside the optimizer's editable surface. The optimizer may propose only
bounded replacements in one skill, excluding `evals/`. It must call the trusted
host evaluator, mounting only the candidate skill into the isolated executor.
Changing any protected input requires separate human review, never an optimization
round. Public regression cases do not substitute for private held-out tasks.

An independent judge authors held-out cases in `tools/skill-eval/heldout/`, outside
the skill and optimizer surfaces. Editors must never load that directory; the
gate returns only aggregates. The deterministic editor accepts bounded textual
replacements and cannot access judge data or change the judge.
Run with `--private --cases /judge/cases` to emit only aggregate results; any failing
held-out assertion rejects the candidate. Never send case contents or diagnostics
to the editor. If exposed, retire that holdout and obtain an independently authored
replacement. A general editor with unrestricted host access is outside this trust
boundary; production enforcement needs a separate judge account/runner and a
required branch check. A local report file is evidence, not an unforgeable approval.

The repository maintenance skill has a separate
[reviewed optimization path](../skill-loop/README.md#repository-maintenance-skill).
`maintenance_bridge.py` supplies registered candidate skill bytes to the unchanged
maintenance evaluator. Its output paths are restricted to fresh controller-owned
cache files; it cannot overwrite a committed baseline or reference. The reviewed
gate keeps human approval outside the editor, binds it to the measured diff, and
validates the resulting commit receipt in the existing CI admission command.
