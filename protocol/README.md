# Shared protocol contracts

`model-profile.schema.json` defines the optional interactive chat `model_profile`
enum. The same generator produces `frontend/types/modelProfile.ts` and
`nat_helpers/model_profile_types.py`; API and backend policy code validate JSON
at runtime. The effort levels are `max`, `xhigh`, `high`, `medium`, `low`,
and `instant`. Omit the field to use the configured main model (`daedalus` for
Switchyard automatic routing). `default`, `deep`, `deep_max`, and `none` are rejected,
including in stored jobs; remove or replace them before resubmission. No legacy
profile aliases or environment variables are translated silently.

An explicit level must exist in `workflow.model_routes` and remains fixed across
skill loads. The shipped DeepSeek workflow configures four distinct Switchyard profiles:
`instant`, `low`, `high`, and `max`. It leaves request/skill promotion unset, so
the gateway owns automatic selection. The generic schema retains `medium` and
`xhigh` for other providers, but they are unconfigured in the shipped workflow.
For this workflow, migrate explicit `medium`/`xhigh` requests to `high`, or omit
`model_profile` to use automatic routing. Replace matching custom request/skill
mappings as well. Direct custom gateway callers must likewise replace
`daedalus/medium` and `daedalus/xhigh` with `daedalus/high`. Deploy the matching
agent workflow and gateway routes together; the old gateway accepts `high`, but
its old DeepSeek default was incorrectly `low`, so do not claim the new effort
semantics until the gateway route configuration is updated.
An unconfigured level fails before model invocation.
Operators may map requests/skills to configured canonical levels; omission from
those maps preserves automatic routing. A successful mapped skill load selects
its level only while the run has no explicit or previously mapped selection.
This field does not select helper or separately configured autonomous models.

Roll out the backend contract and matching API/stream workers together. Older
queued jobs with explicit retired values fail validation and need resubmission;
clients must omit the field or use a configured canonical level. Existing gateway
aliases require no rollout for this removal. Remove retired model route and
request/skill mapping keys from custom workflow configs before starting the new
backend. Legacy `DAEDALUS_LLM_DEEP*_MODEL` overrides no longer configure routes.

`source-policy.schema.json` is the canonical source selection shape for Chat
and the autonomous worker. Generate the TypeScript interfaces, Python
TypedDict/constants, and Rust enums/structs for both schemas with
`python3 scripts/generate_protocol_types.py`. Commit all generated outputs,
including `builder/runtime/src/protocol.rs`. Run
`python3 scripts/generate_protocol_types.py --check` to detect drift; the builder
test suite and `make rust-check` enforce this check. Builder tests also check
source catalog membership.

The generation step needs only Python's standard library and does not run when
serving requests. It preserves the existing optional JSON fields and IDs.
Generated types are not runtime authorization: the existing sanitizers,
source-policy planner and approval gate remain responsible for their own
boundaries. Unknown stored fields remain compatible with current readers.

Streamed intermediate steps retain their compatibility envelope and tolerant UI
fallbacks; this generator does not define or validate the entire streaming API.
