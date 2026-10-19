# Independent regression contracts

These fixtures preserve independently authored expectations from
`test-fixtures/code-audit-independent-20260909.json.gz` at commit `bee1ddc`.
That provenance identifies the frozen oracle; do not regenerate expectations
from the implementation under test.

`reference.json` lists four framing files in
place of its embedded `framing.streams` array. Hexadecimal byte strings are grouped
with spaces so the generic API-key hook does not mistake encoded transport data
for credentials. Loading those files and removing spaces from the hex fields
reconstructs the original decoded document exactly; expectations and partitions
were not regenerated from the implementation. Each file stays below the
repository's ordinary 1 MiB size limit.

Consumers are the Python independent URL-validation tests and the frontend
independent persistence and chat-stream tests. Treat expected results as a
contract, and investigate regressions before changing them.
