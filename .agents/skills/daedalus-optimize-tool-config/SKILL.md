---
name: daedalus-optimize-tool-config
description: Maintain backend/tool-calling-config.yaml as Daedalus capabilities change, and optimize tool descriptions and system prompts for brevity, accurate tool selection, and reliable execution. Use for workflow capability alignment or prompt efficiency work, including updating this skill from verified project changes; excludes unrelated infrastructure hardening.
---

# Daedalus tool config optimization

Keep the deployed workflow accurate at the lowest useful context cost. Optimize
for successful human requests and dependable service work: shorter text is an
improvement only when selection, arguments, evidence, and completion remain correct.
Do not promise a globally shortest prompt or savings that were not measured.

This is a repository maintenance skill. Reconcile on each invocation and when
relevant capability changes occur; it does not install a scheduler or run between
coding sessions. Read [the repository map](references/repository-map.md) first,
then only the sources relevant to the changed capabilities.

## Establish the actual contract

- Inspect the working diff and current configuration before editing. Preserve a
  local baseline of the current files, including uncommitted changes; keep any
  private snapshots outside tracked paths. Record revision and evaluation scope.
- Trace each affected capability from implementation and registered schema to
  workflow exposure, discovery/overrides, prompt instructions, and consumers.
  Distinguish implemented, exposed, authorized, and reachable. A package or
  reachable service alone does not make a capability available to the model.
- Inspect the effective instructions and advertised catalog, including runtime
  additions, deferred discovery, loaded skills, and autonomous prompts. Identify
  conflicting or redundant instructions before compressing them. Follow the
  current loader; do not revive retired configuration fields.
- For each proposed edit, identify the source contract, observed mismatch or
  repetition, intended behavior, and a check that could reject the change.
  Unavailable remote schemas remain unverified; do not invent tool arguments or
  remove a configured integration because its service is temporarily offline.

## Make targeted improvements

Own the workflow YAML and directly related descriptions/prompts. Change another
source only when tracing proves it owns the affected behavior; apply its local
instructions. Keep runtime mechanics in code and task-specific procedures in
loadable skills where supported, while retaining the short routing cue needed to
find them. Do not turn this task into a general rewrite or runtime migration.

- Descriptions should distinguish **when to choose the tool**, its operation,
  necessary argument traps, and consequential output/side-effect limits. Remove
  duplicated schema prose, marketing, repeated examples, and generic advice.
  Preserve exact identifiers, units, JSON-string requirements, dependencies,
  recovery handles, and limitations the schema cannot express.
- Keep global instructions focused on role, completion, evidence, authorization,
  recovery, and output. Retain untrusted-content boundaries and user-scoped data
  isolation. Preserve the user's communication preferences: concise
  ordinary chat, complete requested deliverables, and no routine backend narration.
  Do not shorten replies by suppressing failures or claiming unverified success.
- Prefer one authoritative instruction for each behavior. Verify all callers
  before removing repetition: separately invoked tools or workers may not receive
  the same system prompt. Compress whole instructions rather than cryptic fragments.
- Update capability exposure only with implementation/schema evidence and within
  existing authorization. Text optimization does not justify changing permissions,
  approval policy, credentials, source selections, model routing, or execution
  limits. Preserve working endpoints, ports, and service connections. Any necessary
  incompatible network change follows the user's standing approval requirement.
- Preserve discovery and access to infrequent tools. Do not delete capabilities
  or lower history/output limits merely to obtain a smaller payload. Retain
  retrieval of compacted evidence and actual publication checks for deliverables.

## Measure and validate

Use [validation and comparison](references/validation.md) for the text inventory,
contract checks, and paired behavior cases. Compare the same model, routing,
workload, and configuration state before/after. Measure configured text separately
from the actual advertised schemas and serialized model input; track model/tool
rounds, latency, and usage independently when available.

Work in bounded, reviewable candidates. Keep a candidate only when relevant
contracts pass and its claimed benefit is supported. Repair a failing candidate
when the evidence identifies a concrete correction; otherwise revert only your
rejected edits, retaining the evidence. Stop when no supported improvement remains,
progress stalls, or additional measurement is unavailable; report the limitation
instead of repeatedly paraphrasing or weakening checks.
Local static success alone does not establish model behavior or deployment success.

## Evolve this skill with the project

On each use, check whether its paths, ownership, config keys, validation commands,
and behavioral assumptions still match the repository. Update the smallest
affected reference, helper, or instruction in the same change when source evidence,
a reproducible failure, or an explicit user correction warrants it. Remove obsolete
guidance and duplicate rules instead of appending a history of patches. Revalidate
changed helpers and links; keep repository facts in references, workflow here.

For a behavioral instruction change, replay the motivating case plus a distinct
case that could regress. Use independent evaluation for substantial changes when
available and authorized; report unavailable behavioral coverage. Keep evaluator
assertions, baselines, approval gates, and standing user instructions outside the
self-editing surface. Do not register this skill for automatic promotion or alter
those controls as part of self-evolution. See the existing tooling boundaries in
the validation reference.

Finish with changed surfaces, capability/wording rationale, measured before/after
results, checks run, unresolved gaps, and rollback location. Put detailed evidence
in local Markdown or other local artifacts, never hosted documents. Deployment,
external writes, and continuous automation require their own task authorization.
