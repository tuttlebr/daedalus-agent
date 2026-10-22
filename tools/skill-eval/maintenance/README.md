# Maintenance-skill task evaluation

This adapter evaluates `.agents/skills/daedalus-review-and-remediate` on one
dimension: support verification and reporting claims with observed evidence.
Tasks are small, source-linked reductions of confirmed repository defects. They
do not measure comprehensive audits, deployment safety, or performance engineering.

The user explicitly approved hosted model inference through the existing Codex
connection. Task execution and grading use disposable Docker containers with
`--network=none`, read-only filesystems and workspace mounts, no host credentials,
and no evaluator files. Only model inference needs network access. `make eval`
continues to run the original completely offline scoreboard suite; it never
silently spends model calls on this adapter.

The actor receives the same task, workspace, check interface, model configuration
and step budget in both conditions. Installed runs additionally receive the
unchanged skill and its Markdown reference files as DATA-wrapped source material.
Absent runs omit both. Codex uses fresh ephemeral contexts, an empty temporary
working directory, no user config/rules/project instructions, and disabled native
execution, apps, plugins, host skill discovery and memory. The controller accepts
only structured replacements in case-declared files and the fixed unit-test check.
Unexpected native tool use invalidates the measurement. The existing CLI handles
authentication; its credentials are never copied into task workspaces or reports.

Codex noninteractive and structured-output behavior is documented in the
[official CLI guide](https://learn.chatgpt.com/docs/non-interactive-mode); feature
controls are described in the
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
The pinned local CLI/model configuration is recorded in `model.json`. Hosted model
revisions can change; an immutable provider revision is not measured. Repeated
task outcomes can differ, so observed absent-baseline drift invalidates a comparison
rather than being interpreted as skill improvement.

## Cases and grading

Case JSON declares `id`, `prompt`, an immutable Git `source`, `files`, `editable`,
`checks`, `unavailable_checks`, and `probes` containing input/expected JSON pairs.
The fixture's `component.py` implements `handle(value)`. All code is stdlib Python.
The only supported check is `python3 -m unittest discover -s tests -v`.
Expected probe outputs remain in the host verifier, outside model prompts and
candidate containers. The independently authored `heldout/` directory must never
be read by skill editors. Editors receive its aggregate outcomes only.

Each case earns one point only if all of these observable requirements hold:

- The final implementation passes independent input/output probes.
- The actor observed a failing check against the original component.
- The actor observed a passing check against the exact final workspace.
- The final tests fail when replayed against the original component and pass
  against the final component. This rejects zero-test and always-pass controls.
- The final structured report lists the actual run IDs/exit codes and explicitly
  records unavailable checks as `not run`.

The verifier uses process exit status owned by a separate executor, never a
candidate-written result file. Original-bug and deliberately broken-candidate
controls run in the offline test suite. Synthetic actors in those tests exercise
the machinery; their results are never recorded as model baselines.

## Record a baseline, then compare

Prepare the existing pinned image with `make skill-eval-image`. Then:

```sh
python3 tools/skill-eval/maintenance/run.py baseline --allow-model-network
# Review and commit baseline.json before any installed comparison.
python3 tools/skill-eval/maintenance/run.py reference --allow-model-network
# Review and commit reference.json before later regression checks.
python3 tools/skill-eval/maintenance/run.py run --allow-model-network
```

Baseline mode runs absent tasks only. Every comparison runs absent first and
installed second for every task. Reports bind the judge/case/skill/image/model
identities and include per-case outcomes plus aggregate deltas. Baseline/reference
files cannot be overwritten, and changing evaluator inputs requires separate
review. Full episode evidence stays in `.cache/skill-eval/maintenance/`; detailed
held-out traces belong to the independent judge and must not be loaded by editors.
Reports retain their hashes without exposing those traces.

Run offline machinery checks with:

```sh
python3 -m unittest discover -s tools/skill-eval/tests -p test_maintenance.py -v
```

The existing CI discovery command includes these tests without credentials or
model network access. Actual model runs remain an explicit operation. This adapter
does not add the maintenance skill to the optimizer's automatic allowlist. Its
shell/Git/deletion workflow requires human review of any exact skill diff plus a
passing independent held-out evaluation. This work authorizes measurement only;
the skill and standing instructions remain unchanged.
