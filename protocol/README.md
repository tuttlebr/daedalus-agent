# Shared protocol contracts

`source-policy.schema.json` is the canonical source selection shape for Chat
and the autonomous worker. Generate its TypeScript interface and Python
TypedDict/constants with `python3 scripts/generate_protocol_types.py`. Commit
both generated outputs. Run `python3 scripts/generate_protocol_types.py --check`
to detect drift; the normal builder test suite enforces this check and source
catalog membership.

The generation step needs only Python's standard library and does not run when
serving requests. It preserves the existing optional JSON fields and IDs.
Generated types are not runtime authorization: the existing sanitizers,
source-policy planner and approval gate remain responsible for their own
boundaries. Unknown stored fields remain compatible with current readers.

This separate refactoring starts with the duplicated source-policy contract.
NAT intermediate steps remain an upstream-versioned protocol with tolerant UI
fallbacks; this generator does not claim to own or validate the entire NAT API.
