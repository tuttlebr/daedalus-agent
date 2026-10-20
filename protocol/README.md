# Shared protocol contracts

`model-profile.schema.json` defines the optional interactive chat `model_profile`
enum. The same generator produces `frontend/types/modelProfile.ts` and
`nat_helpers/model_profile_types.py`; API and backend policy code validate JSON
at runtime. Omission means automatic policy, while explicit `default` pins the
default route. This field does not select helper or autonomous-worker models.

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
