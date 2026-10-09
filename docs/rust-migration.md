# Rust migration: P0 and P1

Implementation tracking: [issue 2](https://github.com/tuttlebr/daedalus-agent/issues/2).
The retained source baseline is `7dc4e1d7ba8e6bea3018e5cc2d29d9870d46c36b`.
This release moves preparation into Rust. It does **not** claim the Rust core or
complete backend milestone: the full image still contains the Python executor,
API adapters, and autonomous worker. The separate `rust-minimal` image starts,
prepares memory context, chats, calls its native clock, steers, and stops without
Python. Configuring another required tool in that image fails startup.

## Implementation and rollback boundaries

The existing Cargo package contains configuration/YAML, preparation, memory,
output storage, Redis, generated protocol, telemetry, and agent modules. Rig
remains pinned at 0.43.0. Model prompts, provider endpoints, frontend transports,
Redis key derivation, output compression, and OAuth ownership remain unchanged.

`DAEDALUS_PREPARATION=rust` is the default. The Rust run owns model selection,
history budgeting, memory insertion, tool exposure, accumulated tool state,
compaction, and its terminal telemetry span. The clock runs inside Rust.
Python returns schemas from `/runtime/v1/catalog` and executes bounded leaf
calls at `/runtime/v1/tools/call`. Both endpoints require internal authentication
and remain blocked on the public port. The versioned call context contains the
query, explicitly exposed tool names, and per-executor state. Identity comes
from authenticated headers. Python constructs an ephemeral call context; it
does not create an authoritative run or select the next model. State updates
return to Rust even when a leaf reports an error. Calls sharing a native factory
or MCP group serialize their state updates. Stop closes the owning transport.

The full image retains its Python supervisor and broad public API proxy until
P3/P4. OAuth callback and approval polling URLs continue to use the originating
backend. Never distribute a run, its controls, approval polling, and OAuth
continuation across versions without proven affinity. Use a drained cutover.

Rollback uses the retained baseline image and compatible configuration. An
operator can also select `DAEDALUS_PREPARATION=python` on the full candidate
image at deployment time. There is no per-request fallback or automatic replay
through Python. Stop new work, drain/cancel active runs, retain receipts and
uncertain writes, and restore the image/configuration. Do not restore an old
Redis snapshot over newer production writes. P1 keeps the worker implementation
and queue formats unchanged; P4 must implement fenced worker handover.

The direct minimal entrypoint is `/workspace/daedalus-runtime`. It handles
SIGTERM, cancels active runs, and bounds telemetry shutdown. Readiness checks
the internal credential and configured Redis; Hindsight follows the existing
`degraded`/`required` policy. Unsupported public capabilities return HTTP 503
with `capability_unavailable`; internal migration routes return 404.

## P0 baseline and decisions

The fixtures in
[`builder/runtime/tests/fixtures`](../builder/runtime/tests/fixtures/) contain
57 synthetic baseline contracts, installed descriptions/schemas for all 18
configured native tools, route/configuration/dependency inventories, and frozen
budgets. Each golden case identifies its matrix IDs; the file records its
source SHA, version, and owning test. `inventory.py` also checks five active
Python source hashes against the immutable baseline image. The image lacks a
Git revision label, so those matching hashes are evidence of correspondence,
not a claim that every byte was rebuilt from the SHA.

Retain these immutable image digests in the deployment registry:

| Artifact           | SHA-256 manifest digest                                            |
| ------------------ | ------------------------------------------------------------------ |
| Backend and worker | `a9ad2c70aa992f54fdda50b781fa95320b76707f035499e932dbfd02c0d38ca1` |
| Frontend           | `971750633513ea6bdb8ea46cc1b197a99f87f347214d7d20b53e543d709a26a6` |
| Redis              | `18e7e25d7c9b98cd32837a4409b1841ea0868b5d474bbd9018d2c8877b02b7ea` |

The registry also retains these manifests at
`daedalus.ddns.me:5050/btuttle/daedalus:migration-baseline-7dc4e1d-{backend,frontend,redis}`.
Each retention tag was checked against the immutable digest before release.
The inventory records baseline Cargo packages, production lockfile hashes,
uncompressed image size, and compressed layer bytes for `linux/amd64`.

The P0 dependency results select interfaces, not application parity:

| Dependency       | Probe, packaging and license                                                                                                                                                                                                                                                      | Decision and remaining work                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP `rmcp` 3.5.1 | Compiled Streamable HTTP discovery/call and OAuth PKCE, wrong-state rejection, token exchange/refresh against scripted peers. Dev dependency only; MIT.                                                                                                                           | Use this pinned release as the P2 candidate. Application sessions, grants, concurrent refresh, approval policy and uncertain mutations still require C05-C08. Keep Python MCP until then.                        |
| `redis` 1.7.1    | Real TLS Redis with separate backend/admin ACLs; old/new compressed output reads, TTL, forbidden-key rejection, and 32 concurrent atomic consumes. Rustls; BSD-3-Clause.                                                                                                          | Adopt for P1 caches. Preserve URL CA handling and hostname verification. P2 grants and P4 worker scripts remain separate acceptance work.                                                                        |
| Milvus REST v2   | Authenticated collection listing reached the deployed service. Temporary collection creation timed out; reconciliation confirmed no probe collections remained. Existing gRPC reader remained usable. HTTP client already packaged; Milvus Apache-2.0.                            | Defer REST adoption. Retain current adapter; P5 must resolve DDL behavior and prove dimensions, roles, tenant ownership and search before selecting REST or generated gRPC. This failed spike is not C11 parity. |
| NV-Ingest 26.3.0 | Pinned Python client captured a synthetic TXT extraction request. Rust submitted that request through `submit_job`/`fetch_job` and received matching extracted text. No embedding, collection write, or production document. HTTP client already packaged; API/client Apache-2.0. | Direct service protocol is viable. Retain Python integration until extraction options, cancellation, embedding, partial failures and object cleanup pass C11. Capture is in `nvingest.json`.                     |
| Images and C2PA  | Actual SDK signing/verification tests cover PNG/JPEG/WebP, pixels, attribution, tamper detection and failure before storage, using ephemeral certificates. Installed Python bindings report Rust SDK 0.90.19; SDK MIT/Apache-2.0.                                                 | Native Rust SDK is the P5 candidate; direct Rust signing/provider workflows remain unported. Preserve the current adapter until C12 passes. Do not infer that Python is unavoidable.                             |
| YAML             | `yaml-rust2` 0.13, MIT/Apache-2.0; explicit PyYAML scalar/merge compatibility layer and differential fixtures.                                                                                                                                                                    | Preserve parse-then-expand inheritance. Keep the legacy tool registry loader for Python leaf configuration; do not silently unify its validation behavior.                                                       |

Primary protocol references: [Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk/blob/main/crates/rmcp/README.md),
[NV-Ingest 26.3.0 Python API](https://docs.nvidia.com/nemo/retriever/26.3.0/extraction/nv-ingest-python-api/index.html),
[Milvus REST collection API](<https://milvus.io/api-reference/restful/v2.6.x/v2/Collection%20(v2)/Create.md>),
[C2PA Rust SDK](https://opensource.contentauthenticity.org/docs/rust-sdk/docs/context-settings/).

Select a separate worker binary in this Cargo package for P4, used consistently
by Compose, Helm, and tests. Validate `linux/amd64`; ARM locks do not establish
ARM release support. Use the existing deployment topology with drained cutover,
without new canary routing or frontend changes.

Brandon Tuttle is the accountable maintainer for backend, authorization,
integration, test, and release review in issue 2. These role assignments do not
create additional staffing. Planning ranges for later implementation are P2
5-10 engineering days, P3 10-20, P4 5-10, and P5 10-25, assuming dedicated
engineering time and working disposable services. The Milvus failure increases
P5 uncertainty. These are provisional effort estimates, not delivery dates.

The full-profile exceptions are all owned by the backend maintainer: native
tools/API adapters (existing Python image cost; reconsider in P3), MCP/OAuth/
approvals (existing sessions/Redis; P2), autonomous worker (existing worker
replica; P4), and document/retrieval/media/C2PA (existing service dependencies;
P5). No new specialized service is deployed by P1. A later isolated adapter
must record its separate image/resources and remain optional for core readiness.

## Matrix ownership and test layers

The owner for every row is Brandon Tuttle, acting in the role below. P0 captures
existing evidence and gaps for every row; it does not require the future Rust
implementation of C01-C16. Existing Python tests alone never satisfy a candidate
case. The following is also the fixture work queue for P2-P5.

| Case                | Owner role    | P0/P1 evidence and planned surviving layer                                                                                                                                                                                                     |
| ------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 configuration   | Backend       | Frozen inheritance/expansion/scalar/numeric fixtures, invalid redacted config, both shipped config dry runs; Rust and differential image tests. Non-string YAML keys, recursive aliases and resource limits are rejected at the Rust boundary. |
| C02 models/history  | Backend       | Frozen history/profile cases; full-image scripted provider/skill routing; exact memory requests and context against baseline; Responses and Chat Completions image tests.                                                                      |
| C03 streams/retries | Test          | Full-image differential covers split/partial frames, Unicode, retries, exhaustion and nonstreaming; preserve the HTTP suite for later phases.                                                                                                  |
| C04 lifecycle       | Backend       | Full-image model/tool steering and Stop; minimal-image memory cancellation and lock release; bounded control unit tests and synthetic timing. Continue adding shutdown/queue fault barriers as shared state changes.                           |
| C05 identity/access | Authorization | Real HTTP missing token, cross-user control, internal-route blocking; user-scoped cache read/ACL rejection. Full-image existing tool authorization stays active.                                                                               |
| C06 MCP             | Integration   | Baseline/full-candidate HTTP discovery/deferred/connect/cancellation and SDK spike. P2 must replace Python transport and prove per-user session expiry/reconnect.                                                                              |
| C07 OAuth           | Authorization | Known legacy key vectors and stored-reader source tests; SDK PKCE/refresh probe. Real grant refresh/rotation/mixed-version reader fixtures remain P2 work.                                                                                     |
| C08 approvals       | Authorization | Full-image real Redis approval execution and replay checks, atomic Redis probe. Authorization remains Python; P2 needs Rust races and commit/response-loss barriers.                                                                           |
| C09 tools/skills    | Integration   | All 18 installed schemas, native clock image calls, skill routing, lossless and reversible output goldens and rollback cache reads. Port remaining operations in P3.                                                                           |
| C10 memory/content  | Integration   | Actual TLS/ACL Redis plus scripted Hindsight baseline comparison, cancellation and bounded payload goldens. Existing content/SSRF/sandbox suites remain until P3 replacements.                                                                 |
| C11 documents       | Integration   | Existing baseline integration tests; synthetic service probes and captured NV-Ingest wire fixture. Rust document ownership/extraction/TTL acceptance remains P3/P5.                                                                            |
| C12 media/C2PA      | Integration   | Existing real SDK signing tests with ephemeral credentials; image/browser fixtures remain baseline evidence. Rust provider/media acceptance remains P3/P5.                                                                                     |
| C13 worker          | Backend       | Existing schedule/store/recovery tests retained. Plan two-worker real Redis barriers, DST and uncertain-write tests for P4.                                                                                                                    |
| C14 observability   | Test          | Runtime HTTP secret redaction and real OTLP collector decoding for complete/error/cancel metrics. P1 run spans move to service.name `daedalus-runtime`; Python leaf spans retain their service.                                                |
| C15 packaging       | Release       | Direct minimal image, no Python executable/packages, non-root launch, readiness, real TLS/ACL fixture; full image and deployment checks retained. Full Python-free core is P4.                                                                 |
| C16 upgrade/browser | Release       | Old/new exact-output reads/TTLs, real frontend/worker against minimal image for login, chat, persistence, Stop and steering. Complete stored-record/worker rollback is required before P4.                                                     |

Configuration compatibility intentionally rejects cyclic/deep inheritance,
non-string mapping keys, recursive aliases and unsupported YAML tags with
content-free errors. Shipped workflows and overlays use string-keyed mappings.
Golden cases preserve accepted numeric coercions (including numeric truncation
and rejection of fractional strings during preparation), null/default behavior,
Unicode, object order, descriptions, and exact output hashes. Stored readers
stay permissive independently of strict incoming requests.

## Reproduction and release evidence

```bash
make rust-check
make rust-coverage
make migration MIGRATION_PYTHON="$PWD/builder/.venv/bin/python"
make candidate-browser MIGRATION_PYTHON="$PWD/builder/.venv/bin/python"
make migration-benchmark MIGRATION_PYTHON="$PWD/builder/.venv/bin/python"
```

Set `MIGRATION_BASELINE_IMAGE` to a retained immutable reference to use it instead
of rebuilding the frozen source archive. `make migration` builds the full and
minimal candidates plus disposable Redis, compares all scripted model requests
between isolated baseline/candidate environments, and runs cache rollback with
real TLS/ACL Redis. Only clock instants are normalized in the HTTP comparison;
scripted identities and affinity IDs remain deterministic. Tool calls, arguments,
errors, ownership decisions and completed evidence must remain equal. The fixture
exporter runs inside the baseline image with `--network none`.

The dedicated CI migration job uses the same Make targets. Rust coverage starts
at a 40% line floor (the initial P1 measurement is 44.31%);
authorization/state-machine cases remain mandatory even when coverage passes.
Preserve the Python 65% and existing frontend floors.
The benchmark is a separate gate run on an idle host; shared CI runners are not
the fixed host required by the budget. It records 200 samples per workload at
concurrency 1, 4 and 8, repeated three times after warmup, plus 100 samples per
cancellable control phase. Every sample and failure is retained. Both images
use the same two-CPU/2 GiB limits, Redis TLS fixture and synthetic peers. RSS,
CPU time, file descriptors and process thread counts are sampled throughout.
The 24-hour staging soak and full live answer-quality release gate apply to P4.
No performance improvement is claimed merely because ownership moved.

Reports default to `/tmp/daedalus-migration-reports`. Retain those reports with
source/image digests and fixture/config hashes for review. Run `make ci`, image
scans and the deployment provenance checks before release. The restored
compressed audit oracle and two stale test mocks repair existing baseline test
inputs. A workspace count badge uses primary text to pass the existing contrast
gate. Frontend contracts and coverage thresholds remain unchanged.

The full-image HTTP acceptance must continue passing with
`DAEDALUS_PREPARATION=python` as an explicit rollback profile. Deleting the
legacy implementation or its tests is outside P1.

## Validation record: October 9, 2026

The implementation passed 57 frozen baseline cases, the built-image HTTP
differential with both candidate preparation profiles, TLS/ACL Redis cache
compatibility, and the Python-free image's memory, cancellation and SIGTERM
checks. The real frontend/stream worker candidate test passed login, clock,
saved conversation, Stop and steering. Rust unit/spike tests passed; the three
service-dependent tests are opt-in and their separate evidence is described
above. Measured Rust line coverage was 44.37% against the 40% initial floor.

All 53 frozen synthetic performance gates passed on the final candidate. Each
image completed 7,200 measured requests, 720 warmups and 300 control samples.
Candidate control p95 was 41.2-41.6 ms, cold readiness was 5.0-5.2 seconds, and
peak aggregate RSS was 311.4-311.8 MB under the two-CPU/2 GiB fixture limits.
These are fixture measurements, not live provider latency or a speedup claim.
The earlier invocation with a missing candidate tag remains in the evidence;
the complete comparison was rerun with the correct immutable image ID.

The retained suites passed: 1,858 Python tests (five skips, 78.81% coverage),
948 frontend unit tests (197 skips), 218 frontend and five Python persistence
tests, and 208 browser cases (68 platform-specific skips). Helm rendering,
pod security, and the disposable Redis upgrade/certificate-rotation/rollback
rehearsal passed. Skips remain visible and do not satisfy future acceptance
cases. Both shipped configurations passed the built Rust parser.

Release validation found pre-existing dependency failures in nginx, SeaweedFS,
Next.js 15.5.24 and the development AnyIO lock. A separate security follow-up
updates Next.js to 15.5.27 and AnyIO to 4.14.2, pins the clean unprivileged nginx
slim image for Helm, and retains reproducible Compose vendor patches described
in [vendor-images/README.md](../vendor-images/README.md). The SeaweedFS patch
passed baseline-write/candidate-read and candidate-write/rollback-read checks
against disposable S3 storage. Both nginx configurations passed syntax checks.

All `make ci` targets passed across the retained runs. After the security edits,
Python/frontend/Helm checks were rerun, followed by integration, both browser
suites, application image checks, all six vendor image/architecture scans, and
repository security checks. Unaffected Rust/migration and Redis upgrade targets
reuse their earlier passing evidence. Production npm audit and image/filesystem
scans pass their existing thresholds; no vulnerability exception or reduced
gate was added. Five additional inventory regression cases passed with the
existing inventory/CI parity suite (24 cases). The one new Gitleaks fingerprint
identifies a verified public source hash in the committed baseline inventory.
Deployment and live semantic evidence are recorded separately in the
implementation issue and retained release report.
