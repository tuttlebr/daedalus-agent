# Code audit — 2026-09-09

Status: complete. Corrections and independent review verified locally.
Starting revision: `a0aa413`, clean worktree.

This audit examines application correctness across the browser, API/worker,
Python tools, and their persistence/configuration boundaries. Local tests and
disposable services establish local behavior; they do not establish deployment.

## Hypotheses and distinguishing checks (before changes)

| Area                            | Likely mistake                                                                                                              | Alternative interpretation                                                                                     | Distinguishing check                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication lifetime         | An activity refresh recreates a logged-out or expired session                                                               | An in-flight request may finish, but must not restore future access                                            | Delete/expire the key after the read but before refresh; contrast with a live session just below, at, and above the refresh interval            |
| Job state transitions           | A stale status write overwrites a terminal result after its lock expires; a metadata-only patch bypasses the terminal guard | Terminal status is immutable, including metadata and OAuth fields                                              | Delay a nonterminal write across finalization, with and without a `status` field; compare completed/error and missing/finalized-at-zero records |
| Job ownership/recovery          | An old worker releases or completes a replacement worker's job                                                              | Ownership requires the current token, not only the job ID                                                      | Reclaim after lease loss; interleave stale refresh, release, completion, and backend-start attempts                                             |
| Stream framing/recovery         | Chunk boundaries, CRLF, or interleaved status snapshots lose or duplicate content                                           | Transport chunks carry no semantic boundaries; cumulative snapshots can lag deltas                             | Split UTF-8/framing boundaries; compare shorter matching vs divergent snapshots and overlapping vs gapped deltas                                |
| Context budgeting               | Trimming retains orphan tool results or drops the current request at an exact limit                                         | A contiguous suffix must respect the budget while retaining the current request and a valid conversation start | Asymmetric message sizes, Unicode byte lengths, exact budget +/- 1, count limits, and tool exchange boundaries                                  |
| Approval binding                | Equivalent arguments differ after defaults, or distinct users/actions/arguments share authority                             | One exact authorization can be consumed once; mismatched attempts may intentionally burn it                    | Permuted keys vs changed values, defaulted vs explicit arguments, expiry, reuse, and concurrent consumers                                       |
| Tool/data boundaries            | Redirects, private resource identifiers, or output compaction bypass ownership or alter meaning                             | Validation applies to the final resource and every user-specific lookup                                        | Allowed vs denied redirect targets, neighboring user IDs, sparse/nested structured results, and truncation boundaries                           |
| Configuration/runtime contracts | Tests assert a mock behavior different from deployed Redis or protocol semantics                                            | Both RedisJSON and plain-string storage must obey the same state rules                                         | Execute production operations against both key representations in disposable Redis; run repository regression gates                             |

## Verified corrections

1. **Logout/expiry resurrection.** Session activity refresh rewrote a stale
   object unconditionally. A logout or expiry between the read and write could
   restore authentication for another 24 hours. Refresh now reads and updates
   only a live record in one Redis operation, preserving a newer timestamp and
   the existing storage type. The 59,999/60,000/60,001 ms checks retain the
   existing strictly-greater-than refresh boundary.
2. **Terminal job overwrite.** A nonterminal update could pass its read guard,
   lose its three-second lock, and overwrite a cancellation. Metadata-only
   updates bypassed the guard entirely; terminal statuses without a timestamp
   and `finalizedAt: 0` were also mishandled. Live updates and OAuth completion
   now compare the exact stored snapshot atomically, retry conflicts, and reject
   all terminal records. JavaScript serialization preserves nested empty arrays.
   Publication runs within the same atomic write. Cached terminal responses
   still get presentation sanitization; that read no longer changes the durable
   outcome independently of its finalization journal.
3. **Stream line framing.** CRLF blank lines did not reset the event name, CR-only
   streams were not parsed, and fields without a space after the colon were
   silently ignored. The reader now handles those line/field forms, including a
   CRLF pair split between chunks and empty UTF-8 decoder output. This preserves
   NAT's existing per-line records; it is not a new full EventSource client.
   Reference: [SSE parsing rules](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream).
4. **Nonpublic outbound addresses.** The URL guard permitted shared CGNAT
   `100.64.0.0/10` and deprecated IPv6 site-local addresses because they are not
   classified as private. It now requires global reachability and excludes
   site-local addresses, retaining the existing multicast/reserved exclusions.
   Tests cover both adjacent public IPv4 boundaries and mixed DNS answers.
   Reference: [Python address classification](https://docs.python.org/3/library/ipaddress.html#ipaddress.IPv4Address.is_global).
5. **Persistence regressions absent from CI.** Frontend Redis integration tests
   were skipped by the ordinary coverage suite and had no CI invocation.
   `npm run test:integration` explicitly enables them; the existing Redis CI job
   and local `make test-integration` now run both Python and frontend suites.
6. **Journal JSON corruption.** All eight direct production-path checks failed
   before correction: claiming a terminal result and marking phases, receipts,
   or events converted empty arrays into objects and rounded large exact
   integers. These paths now serialize in JavaScript and compare the original
   snapshot in Redis before atomically storing the replacement. Concurrent
   phases preserve each other's fields. A lost response after event publication
   does not cause publication again on retry. Existing corrupted records cannot
   have their original data reconstructed by this source correction.
7. **Reconnects on ordinary command errors.** The Redis client reconnected on
   every error, including the expected RedisJSON type error used to read legacy
   string records. Eight reads caused eight reconnects and took 1,623 ms; changing
   only that policy gave zero reconnects and 3 ms. Six regression checks failed
   before correction. Reconnection is now restricted to READONLY/MASTERDOWN
   topology errors, without automatic command replay. A production-helper
   integration check confirms successful fallback reads with no reconnects.
   Independent review further tightened the error-name separator to the Redis
   protocol's ASCII space or end of message; a tab was incorrectly accepted.
8. **Duplicate stream persistence after a lost reply.** A Redis append can
   commit before its reply is lost. The reader restored the unacknowledged
   buffer and appended it again during recovery. The before-fix check stored
   `First 🌍First 🌍`; the otherwise identical failure before the commit stored
   one copy. Response writes now carry an acknowledged UTF-8 byte offset, and
   step writes carry an acknowledged list offset. Matching overlap is verified
   and only its missing suffix is appended; gaps and conflicts reject without
   mutation. The final flush settles both independent writes before recovery.
   Reader-level lost-reply injection and real Redis schedules verify the result.
   Independent review found that a retry with reordered JSON object properties
   was incorrectly treated as conflicting data. A byte mismatch now falls back
   to semantic JSON comparison in JavaScript, followed by another atomic offset
   and value check. Stored encodings are retained, arrays and exact integers
   remain distinct, and a conflicting concurrent append cannot admit a suffix.

## Fresh-context verification

The user authorized one isolated reviewer. It received only the
[behavior brief](code-audit-review-contracts-2026-09-09.md), with no application
code, tests, prior conversation, audit report, or memory. Its
[original derivation](code-audit-independent-review-2026-09-09.md) covers all
seven high-risk contracts. The original JSON fixture bytes are preserved in
[`test-fixtures/code-audit-independent-20260909.json.gz`](../test-fixtures/code-audit-independent-20260909.json.gz),
with uncompressed SHA-256
`854e10f07cc7904c2d38ca113166408e6fbe59fc120e4947f8bf86b35ea16865`.

The comparison harness translates semantic field names, response positions, and
return labels into the application API; it does not derive expected stored data
from production helpers. It executes 396 seeded sequence operations, six explicit
sequence scenarios, four asymmetric paired flushes, job/session/journal schedules,
and 50 address/DNS cases. All 1,346 supplied stream partitions produce the expected
answer and intermediate-step payloads through the actual stream reader.

Two implementation mismatches were reproduced before correction: a tab-delimited
Redis error token and a reordered JSON-object retry. The initial comparison also
had 12 adapter failures: the oracle injects errors at an operation boundary even
for empty no-ops, while those application calls make no Redis command. Injection
was moved to the operation boundary without changing the oracle. Separate tests
continue to inject lost replies after real Redis commands commit.

The reviewer supplied a [separate amendment](code-audit-independent-amendment-2026-09-09.md)
without changing its original artifacts. It independently derives acceptance of
reordered object properties, rejection of changed array order/container types,
and rejection of a newly conflicting overlap after a stale inspection. All five
amendment comparisons pass against real Redis, including valid concurrent appends
and an injected external replacement of an existing step.

The amendment confirms that the brief did not uniquely choose the session lifetime
anchor. Existing behavior is preserved: the activity timestamp records request
time, while Redis starts the 24-hour TTL when the refresh takes effect. The
strict 60,000 ms throttle, current-record check, expiry/deletion protection, and
nondecreasing activity time match the independently derived requirements.
Malformed/null timestamps and unspecified stream EOF/BOM behavior are not assigned
new semantics by this audit. The raw fixture's abstract phase names map to the
application's separately recorded phase timestamps and retention receipt.

## Reviewed contracts requiring no production correction

- **Worker ownership:** current tokens fence renewal, release, and backend-start
  marking after a lease replacement. The added real Redis check verifies both
  the previous owner and replacement owner, including an absent start marker
  after the stale owner's attempt. Existing Python integration checks exercise
  autonomous-worker lease expiry, processing recovery, and atomic write receipts.
- **Approval binding:** the bound user may consume an exact authorization once.
  Another user cannot even consume it; an incorrect target attempted by the
  bound user intentionally consumes it. Real Redis checks cover explicit expiry
  and eight simultaneous consumers. Existing approval-gate tests cover changed
  arguments, canonical hashes, added schema defaults, exact successful receipts,
  and failed operations without a success receipt.
- **Document ownership:** reads and deletion consult stored ownership before
  accessing object storage. A bound record requires its user ID; only legacy
  records without a user ID use same-session compatibility. Reference validation
  replaces client-supplied metadata with the stored record and rejects malformed
  identifiers before lookup. The handler and reference suites passed; the delete
  denial also asserts neither object nor metadata deletion occurs.
- **Compaction:** previews require successful storage of the exact original
  under the authenticated user. Missing identity, storage errors, duplicate JSON
  keys, nonfinite JSON values, and unstructured content preserve the original or
  a lossless form. An exhaustive query keeps every row. Cache construction is
  scoped to the per-user workflow; retrieval enforces that same user and verifies
  the content digest. The 17 focused tests passed, including exact retrieval,
  changed-query cache behavior, and cross-user denial. This is a correctness
  review; no production-load compaction latency claim is made.
- **Per-user MCP discovery:** the older report's global skipped-group concern
  did not reproduce with the installed NAT runtime and current configuration.
  Gmail, Calendar, and Docs use `per_user_mcp_client`. Installed
  `PerUserWorkflowBuilder.get_tools` obtains these groups through its own
  per-user registry, outside the shared `WorkflowBuilder` patch. A network-disabled
  runtime probe with current patches verified both user orderings: one user's
  injected HTTP 401 did not hide another user's tool, change shared capability
  state, or prevent later recovery. This does not exercise live Google OAuth.

## Validation evidence

- Baseline: builder 1,225 passed / 3 skipped; frontend 775 passed / 4 skipped.
- Before corrections: 21 of 28 initial Redis boundary checks failed, all three
  new stream framing failures reproduced, and six URL boundary tests failed.
- Current frontend Redis integration command: **156 passed** across five suites,
  including 50 state-boundary and 103 independent-review cases (22 of the latter
  also run in ordinary coverage without Redis). The Python real-Redis suite:
  **4 passed**.
- Full builder suite: **1,288 passed / 4 skipped**, 76.24% coverage
  against the 65% gate. Latest frontend coverage: **813 passed / 135 skipped**,
  all coverage gates passed (47.67% lines). Redis suites run explicitly in the separate
  integration command rather than the ordinary coverage invocation.
- Context budget: 400 structured histories (Unicode, tool exchanges, asymmetric
  sizes, count limits, exact byte-budget boundaries) agree with an independently
  enumerated valid-suffix reference. No production change needed.
- Stream content: 48 structured byte-partition cases, including byte-at-a-time
  UTF-8 and CRLF splits, produce the separately specified concatenated answer.
- URL/DNS: 200 structured shared-address boundary cases use a direct octet-range
  reference rather than the production address-classification helper.
- Job state: 96 structured randomized schedules across plain-string and
  RedisJSON storage check first-terminal-writer behavior, immutable terminal
  metadata, missing keys, and conflicting OAuth callbacks.
- Stream persistence: 48 structured schedules compare the declared ordered
  sequence against persisted data through Unicode batches, overlapping/older
  retries, and one-position gaps/conflicts. Lost replies are injected after
  the actual Redis write and separately through the complete stream reader.
- Runtime image probe: all **50 independent address/DNS fixtures** passed under
  installed Python 3.12.3; the local builder test environment is Python 3.13.12.
- Full browser suite: **150 passed / 14 skipped**. After the journal/reconnect
  changes, the production rebuild and eight affected agentic workflows passed.
  A further production rebuild and all **8 affected workflows passed** after the
  append correction. Generated service-worker changes from the builds were removed.
  After the independent-review corrections, another production rebuild and all
  **8 affected workflows passed** on the final source.
- ESLint, TypeScript, 10 CI/Makefile contract tests, Helm lint, and both default
  and custom Helm renders passed. Scoped pre-commit hooks and final whitespace
  checks passed after formatting.

Detailed local logs are in `/tmp/daedalus-audit-*.log`, notably
`state-all`, `journal-before`, `append-before`, `append-after`,
`integration-final`, `builder-final`, `builder-redis`, `frontend-append`,
`e2e`, `e2e-final`, `e2e-append`, `contracts`, `mcp-runtime`, and `url-runtime`.
Final review logs use `builder-reviewed`, `frontend-reviewed`,
`integration-reviewed`, and `e2e-reviewed`. The separate
`/tmp/daedalus-independent-*.log` files record the before/after comparison,
types/lint/hooks, framing partitions, and Python/runtime address checks.
These logs are local evidence, not durable release artifacts.

## Completion and limits

- All audit requirements and the completion checklist below are satisfied.
  The independent-review Redis instance
  `daedalus-code-audit-review-redis-20260909` was removed after validation; it had
  no persistent volume. Generated service-worker changes were restored after
  the final build.
- This report covers local source validation; no publication or deployment was
  performed. Production images, cluster state, and persistent data are unchanged.
- Disposable Redis `daedalus-code-audit-redis-20260909` was removed after
  validation; it had no persistent volume. Browser-test services and volumes
  were removed by their harness. Docker image builds, security scans, Redis Helm upgrade tests,
  and live deployment checks were not run as part of this source audit; this is
  not a complete release/CI certification.

## Completion checklist

- [x] Review all areas above and record findings or evidence supporting no change.
- [x] Demonstrate each corrected runtime behavior failing before its fix.
- [x] Check high-risk behavior against independently derived expected outcomes,
      without using production helpers in the reference calculation.
- [x] Exercise meaningful structured randomized state/input sequences.
- [x] Run applicable unit, integration, lint, type, build, and configuration gates.
- [x] Review the final diff, limitations, and outstanding work.
