# Independent audit reference

`code-audit-independent-20260909.json.gz` preserves the original JSON fixtures
from the isolated, contract-only review. Compression avoids checking in 1.7 MB
of repeated pretty-printed states and transport partitions. The uncompressed
SHA-256 is `854e10f07cc7904c2d38ca113166408e6fbe59fc120e4947f8bf86b35ea16865`.

The [derivation](../docs/code-audit-independent-review-2026-09-09.md) and
[separate amendment](../docs/code-audit-independent-amendment-2026-09-09.md)
explain assumptions and expected results. Expected values were not generated
from application helpers. Tests translate field names and position units to
the application API and compare the stored results with these fixed values.

Run the URL comparison through `builder/tests/test_independent_audit_contracts.py`.
The frontend coverage command runs the framing/error comparisons; with a
disposable `REDIS_URL`, `npm run test:integration` also runs persistence, session,
job, and journal comparisons. See the [audit report](../docs/code-audit-2026-09-09.md)
for validation results and the explicitly resolved contract ambiguities.
