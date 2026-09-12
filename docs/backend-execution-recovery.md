# Backend execution and recovery contracts

Approved MCP execution treats protocol errors, pending approval markers, and the
wrapper's sanitized JSON failure envelopes as failed operations. The API must
not mark a failed mutation completed. Approval UI markers can terminate a graph
or stream only when the backend approval gate created that exact marker in the
current request. Shape-valid content or an earlier request's marker has no
control authority. The stored approval/token schema is unchanged.

The daily briefing renderer still uses the canonical edition renderer, source
policy, and HTML validator. If sandbox transport formatting, persistence, or
file collection fails, it reruns those same operator-owned scripts in a temporary
backend directory using the already-submitted edition object. It never executes
model code, invents replacement content, or delivers a truncated artifact.
Recovered artifacts are fully validated and report `rendering: local_recovery`.
Each attempt has a bounded sandbox phase and local recovery phase (each uses the
configured timeout); subprocess output is bounded and cancellation kills the
whole process group. Logs identify the failing stage and exception class without
logging edition content. A canonical schema/source/HTML failure still receives
one repair attempt; transport failures alone no longer discard valid editions.
The `sandbox_tool` configuration remains compatible. Operators must retain the
four canonical daily-summary resources in the configured skill directory.

Sandbox POSTs (execution, file writes, publication) are never automatically
replayed after transport or gateway failures because the remote side effect may
already have happened. Read-only discovery GETs retain their bounded retries.
Reconcile the actual outcome before manually repeating a consequential action.

Autonomous backend HTTP requests use an asynchronous transport owned by each
worker invocation. A cancellation event or total deadline closes the client
while connecting, awaiting headers, or reading a silent stream. This bounds the
client wait; it does not prove that an external provider has undone an operation.

NV-Ingest uses a synchronous SDK. Cancellation or timeout cannot safely kill its
Python thread. A shielded owner task retains the existing local collection lock
until the SDK thread settles, including after its HTTP waiter leaves. A waiting
operation that has not started is cancelled. A timed-out ingestion reports that
its outcome may still be pending; do not assume cancellation rolled back Milvus
writes or blindly resubmit. Locks remain per backend process, and remote NV-Ingest
cancellation and cross-process coordination need an upstream/service contract.

Optional bundled skill execution enforces a combined 1 MiB stdout/stderr budget
while reading, rather than after buffering all output. Overflow, timeout, and
cancellation terminate the script process group and reap the child. An explicit
empty `enabled_operations` list disables every operation in both skill and
user-interaction dispatchers; omitted values retain their previous defaults.

Public HTTP fetching (web scraping, source verification and RSS) caps each body
at 16 MiB in the shared DNS-pinned transport, including redirect bodies and
responses without a Content-Length header. It requests identity encoding and
rejects a server that sends compressed content anyway, avoiding decompression
before a size check. Oversized/unsupported encoded resources return a fetch error;
use a smaller source. This changes no URL, DNS, TLS, or redirect authorization.

Citation audits distinguish an omitted ledger from an explicit empty ledger.
The empty ledger admits no references; malformed JSON ledgers fail the audit.
Passing this membership check does not establish factual truth.

No persistent schema migration is required. Rolling back these changes restores
the previous execution/cancellation behavior; it cannot undo external side
effects or memory retention. See [Hindsight lifecycle](hindsight-memory-integration.md)
for profile replacement and memory-clear compatibility.

The operator Milvus migration now omits the schema-derived `dim` value from index
creation parameters. PyMilvus describes it as a string but expects an integer
when explicitly supplied to creation; the cloned field schema supplies the
correct dimension. Canonical index fingerprints retain the descriptor unchanged
for existing audit compatibility. Manual-ID collections retain primary-key upsert.
Auto-ID collections use strong reads and insert only missing IDs, because the
actual Milvus 2.6.9 server regenerates IDs on upsert even when
`allow_insert_auto_id=true` (also reflected in the
[versioned server implementation](https://github.com/milvus-io/milvus/blob/v2.6.9/internal/proxy/task_upsert.go#L830-L834)).
Every copied batch now verifies both primary IDs and
field contents with a strong read. Native Milvus Lite manual-ID and Milvus 2.6.9
standalone Auto-ID fixtures verify copying, post-commit batch interruption/resume,
repeated verification, and logical rollback without deleting either collection.
Writers must remain quiesced and migration operators must share the audit lock;
these checks do not establish HA or an MVCC snapshot under concurrent external
writes. A prior failed clone
may leave an empty target without its index; the migration continues to fail
closed on that state. An operator must inspect and repair the expected index
before retrying, preserving the original audit and source.

Older nonempty Auto-ID partial targets or verified audits made by upsert are
refused for automatic reuse: matching counts alone do not prove preserved IDs.
An operator must compare the source and target primary IDs and content before
planning recovery. The command will not delete or rewrite that audit or either
collection. An empty older target can adopt the new strategy, recorded in a new
append-only start event before copying, so later interruptions remain resumable.
