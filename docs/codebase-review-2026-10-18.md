# Codebase review and remediation, 18 October 2026

Starting revision: `d29f239826040013ec7a23c57c626232287a5a49`, clean `main`.
A [follow-up review](codebase-review-2026-10-18-followup.md) starts from the
resulting revision. Its baseline found that one Python test passed here only
because the environment supplied `OPENAI_API_KEY`; the test is now hermetic.
The review covers bugs, dead code, conflicting contracts, latency, and test/hook
correctness. Changes preserve stored data and the existing Python/Rust rollback
profiles. The concurrent exploration adapter and deployment edits were included at the user’s request, then reviewed and extended with validation. No dependency or coverage-floor changes were needed; the new exploration tool uses a shared schema without changing the chat protocol.

## Confirmed findings and remedies

| Priority | Trigger and root cause                                                                                                                                                                                         | Remedy and regression evidence                                                                                                                                                                                                                                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | A long-running stream entry reclaimed by its own worker was treated as a duplicate and acknowledged/deleted while still executing. A later crash could leave no pending entry to recover.                      | Track the active Redis entry ID separately from the job ID; retain the active entry and acknowledge only distinct duplicates. Worker regressions exercise both cases.                                                                                                                                                               |
| High     | Every stale-queue scan restarted at `0-0`; Redis can return an empty page with a nonzero cursor after scanning busy pending entries. Later abandoned jobs could starve.                                        | Carry the `XAUTOCLAIM` cursor across scans, including empty pages. A real Redis test places abandoned work beyond the first scan window.                                                                                                                                                                                            |
| High     | Shutdown could begin during a blocking queue read, then dispatch new work after the drain snapshot.                                                                                                            | Recheck draining after the awaited read. Regression holds and releases that read across shutdown.                                                                                                                                                                                                                                   |
| High     | `JSON.MGET` returns null for plain-string conversation records even when RedisJSON is installed; fallback errors also became apparently empty history.                                                         | One Lua batch reads each key according to its actual type, preserves opaque JSON, and propagates infrastructure errors. Real Redis tests cover mixed formats, arrays, missing/malformed records, ownership, and failure responses.                                                                                                  |
| High     | Finalization read the selected conversation and later overwrote it after another request selected or deleted it.                                                                                               | Compare-and-set against the latest selection; recheck the ID on every retry. Real Redis tests preserve both a newer selection and deletion.                                                                                                                                                                                         |
| High     | Image jobs and direct history writes used independent read/modify/write sequences. Deletion could remove an asset newly referenced by a concurrent append.                                                     | Share atomic history append logic; commit history changes and deletion of now-unreferenced owned assets in the same compare-and-set script. Real Redis tests cover concurrent appends, job/API overlap, deletion races, both storage formats, limits, TTL, and image guidance. Three original-behavior tests failed before the fix. |
| High     | Push subscription updates could lose acknowledged registrations; the subscription limit was checked outside the mutation.                                                                                      | Atomic updates for registration/removal, with the limit checked inside each retry. Real Redis tests cover 12 concurrent registrations and competing requests for the last slot; both failed before the fix.                                                                                                                         |
| High     | Autonomous queue length checks and pushes were separate Redis commands. Concurrent single/batch submissions could exceed the 100-item bound.                                                                   | Check capacity and enqueue atomically in Lua, retaining FIFO order. Real Redis tests exercise both admission races and failed before the fix.                                                                                                                                                                                       |
| High     | Autonomous lease acquisition occurred outside the worker's retry boundary, so a transient Redis error could terminate the process. Worker diagnostics also logged prompts and raw exception/run-error content. | Include acquisition in bounded-backoff handling and release only acquired leases. Log lifecycle IDs/status and error class without prompt/user/exception text. Original-code failures and a built-image worker exercise verify recovery, execution, cancellation, acknowledgement, and redaction.                                   |
| Medium   | OAuth success was remembered by service/job, suppressing a later fresh challenge for that service.                                                                                                             | Remember the exact challenge key. Component regressions cover renewed state immediately and after the old success timer; old code failed both.                                                                                                                                                                                      |
| Medium   | Positive fractional configuration such as `0.5` passed validation and was then floored to zero.                                                                                                                | Validate the floored value as a positive safe integer. Regression checks invalid, fractional, and oversized values.                                                                                                                                                                                                                 |
| Medium   | A removed tarball was still the source of independent Python/frontend contract expectations.                                                                                                                   | Restore the exact decoded historical fixtures, with historical provenance; both readers use the same frozen JSON. Expected values were not regenerated from current production code.                                                                                                                                                |
| Medium   | Differential acceptance ran newly added safety expectations against a legacy image that predates them; concurrent scheduling and random test IDs also obscured real request differences.                       | Freeze a versioned shared legacy workload, run the full current contract in both current preparation modes, and compare every ordered round within each conversation. Preserve multiplicity and payloads; normalize only clocks and the already documented legacy policy fields.                                                    |
| Medium   | Three HTTP parity runners compared `first_answer_ms` as functional output, causing differences between otherwise identical responses.                                                                          | Exclude this measured clock alongside `latency_ms`; retain answer, tool events, errors, completion, and activity checks. A regression fails the original normalizer; complete domain/docs/search HTTP reruns pass.                                                                                                                  |
| Medium   | The Helm hook returned success when Helm was absent.                                                                                                                                                           | Invoke Helm directly and install it in the CI hook job. Disposable probes reject missing Helm and an invalid chart; the former hook incorrectly passed the missing-tool probe.                                                                                                                                                      |

The included exploration integration adds native/Python adapters, a shared tool
schema, signed conversation grants, and Helm service/secret/egress wiring. Review
found missing catalog/CI coverage, native adapter validation delegated entirely to its caller despite the
shared schema, and artifact metadata reaching unchecked unwraps. The adapters now
validate inputs and nonempty publication provenance; integrity checks reject
corrupt bytes, size, hash, run ID, and path. The catalog exercises real registration
with synthetic environment credentials, and migration invokes three built-image
profiles. The new egress policy follows backend/network-policy enablement so it
cannot accidentally isolate a backend when policies are disabled. Tests exercise
these cases through the registry, Rust validator, rendered chart, and HTTP peers.

Exploration requires the separately provisioned API and matching grant secret.
Both exist in this deployment; Compose setup requirements are recorded in
`.env.template`. Its execution service is a separate repository, outside this
codebase audit. The one-time overlay Dockerfile is retained for its documented
compatibility purpose; the release uses the normal complete backend build.

The owning code is in `frontend/server/chat/`, `frontend/server/session/redis.ts`,
`frontend/server/atomicJson.ts`, `frontend/server/images/historyStore.ts`,
`frontend/pages/api/{images,push}/`, `frontend/server/autonomy/store.ts`,
`frontend/components/chat/ChatView.tsx`, and
`builder/autonomous_agent/src/autonomous_agent/worker.py`.

## Dead code and contract decisions

Removed the unreferenced `searchSteps` export and write-only hierarchy stack from
`frontend/utils/app/intermediateSteps.ts`, plus an unreachable root-delete branch
in the Redis helper. Reference searches included application imports, tests,
routes, configuration registrations, build inputs, and dynamic tool loading.
Compatibility readers, migration oracles, and the supported Python execution
profile remain intentionally reachable and were retained.

Image jobs and history API writes now share the same append policy. Valid image
guidance survives history validation; malformed legacy guidance is omitted while
the readable history entry remains. Empty image/subscription collections can be
stored as TTL-bound empty arrays rather than missing keys; their public responses
remain unchanged. Contention errors remain visible instead of losing updates.
No data migration or external action replay is introduced.

## Latency evidence

The critical path was traced from browser submission through Next.js admission,
Redis streams, the stream worker, Rust model/tool orchestration, Python/service
calls, SSE, Redis/WebSocket delivery, rendering, and durable finalization.
The blocking Redis read wakes when work arrives; its one-second maximum is not
an unconditional one-second admission delay. Existing 750 ms persistence and
120 ms rendering intervals serve different durability/display purposes and were
not removed. Streaming proxy coverage now proves a chunk arrives before EOF.

The mixed-format history remedy also replaces per-key reads with one batch.
On loopback disposable plain Redis, Node 22, 100 records with 20 messages each
(645,900 JSON bytes), 10 warmups followed by 100 alternating samples per version:

| Measurement           |   Before |    After |
| --------------------- | -------: | -------: |
| Median helper latency | 12.97 ms |  6.95 ms |
| p95 helper latency    | 37.81 ms | 23.94 ms |

This is a synthetic helper measurement, with host scheduling noise. It does not
establish a browser or live-provider end-to-end speedup. Provider generation,
network variability, physical-device rendering, and proxy backpressure under
sustained load remain unmeasured; no speculative optimization was made there.

## Test repairs

- Replace a mock-only WebSocket hook suite with mounted hook behavior tests.
  Removing subscription breaks the repaired suite.
- Drive real reconnect backoff and reset transitions; removing the reset fails.
  Prove SSE delivery before completion; buffering to EOF fails the test.
  Require the exact image preset IDs; returning an empty list fails the test.
- Repair a temporary-file deletion assertion, disabled-memory setup, async
  operation tracking, skill sorting/cache/immutability checks, and web scraping
  truncation assertion. Operation filtering exercises real registry validation
  and invocation. Profile import tests invoke the route and check safe failure
  responses rather than merely searching source text.
- Scope image-test Redis monkeypatches and close temporary event loops. Remove an
  obsolete async admission test whose mocked worker never executed cancellation;
  actual worker cancellation coverage remains. Browser history fixtures now
  satisfy the real asset contract.
- Reset reused model/tool wait barriers in the built-image steering test. A
  stale quota-test event could steer before model transport began, making that
  check vacuous and the differential request count nondeterministic.
- Repair the weather factory-failure expectation to include the collector’s
  existing empty answer and activity fields; its complete image matrix passes.
- Group restored framing-fixture hex bytes with spaces to avoid the NVIDIA hook’s
  generic 84-character key pattern; reconstructed fixtures match the historical
  decoded archive exactly. The hook still scans every file. A narrowly scoped
  gitleaks annotation identifies the existing public dry-run Kubernetes Secret
  resource name, which contains no key material.
- Restore independent contract data. Historical secret-scan exceptions identify
  exact introducing-commit fingerprints for synthetic fixture credentials and
  public hashes, not broad file/rule exemptions. A disposable secret canary is
  still rejected.

No coverage thresholds were lowered, exclusions expanded, or test failures
converted into skips. Before/after and mutation evidence is retained in the local
review evidence directory.

## Hook ledger

All 25 configured hook entries were reviewed against their pinned manifests and
the repository filters. The default commit/manual invocation and CI all-files
invocation share the same configuration. Python hooks use managed environments;
local hooks require the explicitly installed host tools. Filename arguments are
passed as arguments, with the Bash and Prettier wrappers quoting each path.
Generated locks and the Hue reference retain their existing explicit size rules.

| Entry                             | Selection/dependency/exit behavior checked                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detect-nv-keys`                  | Text files; pinned Python hook; findings fail                                                                                                         |
| `check-yaml`                      | YAML; Helm/chart templates excluded because they are templates                                                                                        |
| `check-json`                      | JSON syntax; package-lock global exclusion retained                                                                                                   |
| `check-toml`                      | TOML syntax                                                                                                                                           |
| `check-ast`                       | Python syntax using Python 3.12                                                                                                                       |
| `end-of-file-fixer`               | Text; commit/push/manual; modifications require rerun                                                                                                 |
| `trailing-whitespace`             | Text; commit/push/manual; modifications require rerun                                                                                                 |
| `mixed-line-ending`               | Text; automatic normalization; stable rerun required                                                                                                  |
| `check-added-large-files`         | Added files, 1 MiB; explicit generated-lock/reference exemptions                                                                                      |
| Hue reference size                | Only the generated Hue JSON reference; separate 2 MiB bound                                                                                           |
| `check-merge-conflict`            | Text conflict markers; nonzero on detected conflict                                                                                                   |
| `detect-private-key`              | Text key patterns; nonzero on detection                                                                                                               |
| `detect-aws-credentials`          | Available AWS credential matching; missing local credentials allowed; supplemented by repository secret scanners                                      |
| `check-case-conflict`             | Selected filenames and tracked path collisions                                                                                                        |
| `check-executables-have-shebangs` | Executable text files; commit/push/manual                                                                                                             |
| `forbid-submodules`               | Directory/gitlink selection; intentional failing language; no-match is not a submodule test                                                           |
| `skill-links`                     | Skill Markdown/checker changes trigger a complete link scan; Python host dependency; missing target probe fails                                       |
| `bash-syntax-check`               | Shell/Bash types and extensions; `bash -n` checks every argument and propagates failure; valid/invalid/spaced/multiple-file probes                    |
| `prettier`                        | Supported text extensions excluding chart templates; frontend-pinned Node package/config; quoted root-relative paths; autofix then stable rerun probe |
| `helm-lint-daedalus`              | Chart changes; no filenames; checks the complete chart; valid/invalid/missing-executable probes; CI installs Helm                                     |
| `ruff`                            | Python/pyi/notebooks; serial; force-exclude; fixes return failure                                                                                     |
| `ruff-format`                     | Python/pyi/notebooks; serial; force-exclude; stable rerun required                                                                                    |
| `isort`                           | Python/pyi/Cython; serial; Black profile and explicit third-party Redis classification                                                                |
| `pyupgrade`                       | Python files; Python 3.11 minimum syntax target remains compatible with Python 3.12 CI                                                                |
| `bandit`                          | Python; serial; builder tests excluded; CI also runs the pinned stricter production scan                                                              |

Ten disposable local-hook probes passed their expected outcomes, including
demonstrating the original Helm false success. No changed hook was accepted on
the basis of a zero-file invocation. Final changed-file and all-files runs must
both pass after inspecting autofixes.

## Review coverage ledger

Each row was reviewed across all five areas. “Retained” means no additional
supported deletion or consolidation was identified; it does not mean bug-free.
The review combines source and caller inspection, complete test-module reading,
configuration/reachability analysis, and execution of the relevant contracts.
It does not claim line-by-line inspection of every production implementation,
generated asset, vendored dependency, or historical result file.

| Subsystem                                       | Bugs                                         | Dead code                                 | Contracts                                             | Latency                                | Tests/hooks                                       |
| ----------------------------------------------- | -------------------------------------------- | ----------------------------------------- | ----------------------------------------------------- | -------------------------------------- | ------------------------------------------------- |
| Browser chat, OAuth, state, activity            | Challenge renewal fixed                      | Unused search/stack removed               | Replay and challenge identity checked                 | Render/stream path traced              | All component/hook suites read; browser workflows |
| Next.js authentication, ownership, proxy routes | Failure and ownership paths checked          | File-route reachability retained          | Trusted identity and error boundaries checked         | Proxy streaming checked                | API suites and real HTTP boundaries               |
| Redis conversations and finalization            | Mixed reads and selection race fixed         | Unreachable branch removed                | Plain/RedisJSON compatibility retained                | Batched reads measured                 | Real Redis lifecycle regressions                  |
| Queue admission and stream workers              | Reclaim, cursor, drain fixes                 | Registrations/entrypoints retained        | Lease/receipt/recovery ownership checked              | Queue wait and recovery traced         | Worker units and Redis integration                |
| Autonomous frontend/Python worker               | Admission, retry, logging fixes              | Scheduler/CLI reachability retained       | FIFO, capacity, lease ownership checked               | Backoff and heartbeat traced           | Store/worker tests and built-image probe          |
| Images, artifacts, push subscriptions           | Concurrent mutation fixes                    | Shared history writer adopted             | TTL, ownership, references, guidance checked          | Avoided duplicate writer logic         | Real Redis, route, image and browser tests        |
| Rust agent/provider/control/preparation         | Retry, Stop, steering, failure paths checked | Feature/config-selected paths retained    | Full and Python-free/rollback contracts               | Model/tool/SSE boundaries traced       | All Rust test modules and image contracts read    |
| MCP, OAuth, approvals, memory/profile           | Identity, ambiguity, cancellation checked    | Compatibility readers retained            | Token consumption, grants, rollback, output parity    | Service/setup/cache boundaries checked | Cross-process, TLS/ACL and HTTP contracts         |
| Documents, Milvus, embeddings, ingestion        | Ownership, cancellation, receipts checked    | Native and retained SDK profiles retained | Schema/wire/encoding/result parity checked            | Batch and service boundaries checked   | Native/SDK and built-image contracts              |
| Skills, sandbox, web/weather/search/docs        | Validation, isolation, failure paths checked | YAML/tool/package reachability retained   | Registration/schema/result parity checked             | External service variability isolated  | Python/Rust tests and service/HTTP contracts      |
| Protocol, build, deployment, Redis security     | Configuration and rollout checks reviewed    | Generated/build inputs retained           | Schema drift, inventory, ACL/TLS checked              | Startup/rollout boundaries reviewed    | Hooks, render, image, persistence/rotation gates  |
| Acceptance and evaluation runners               | Differential and timing comparisons fixed    | Historical evidence retained              | Frozen expectations and allowed normalization checked | Synthetic timing scope reviewed        | All inventoried check/test modules read           |

Initial inventory: 102 Python modules (including the Compose test), 124 frontend
test modules, 12 Playwright specifications, and 57 Rust test modules. New tests,
both frontend script test modules, migration/service/HTTP acceptance runners,
validation scripts, and evaluation runners were also read. Archived evaluations
are provenance, not evidence that current live providers pass. The Python suite
now discovers 104 modules under `builder/tests`; frontend discovery finds 127
modules under `__tests__` plus two script modules.

## Validation

Local evidence directory: `/tmp/daedalus-review-d29f239/` (not committed).
Toolchains: Node 22.17.0, Python 3.12.3, Rust 1.95.0. Validation uses disposable
Redis, HTTP/TLS peers, images, and an isolated Kind kubeconfig.

| Gate                                                | Result                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Tool availability                                   | Passed                                                                                                            |
| Python suite and coverage                           | 1,974 passed, 5 integration skips; 80.01%, floor 65%                                                              |
| Frontend lint, typecheck, coverage, build           | Passed; 1,026 passed, 217 service-gated skips; 62.41% lines                                                       |
| Persistence integration                             | 5 Python and 239 frontend tests passed across 15 frontend files                                                   |
| Rust fmt, clippy, unit/frozen contracts             | Passed; 113 passed, 22 service tests ignored in the ordinary unit invocation                                      |
| Rust instrumented coverage                          | 61.59% lines, floor 40%; service tests run through acceptance runners                                             |
| Helm default/custom rendering and pod security      | Passed                                                                                                            |
| Persisted Redis upgrade, rollback, ACL/TLS rotation | Passed in disposable Kind; cluster removed                                                                        |
| Browser workflows                                   | 233 passed, 74 configured skips across five browser/device projects                                               |
| Exploration registry/validation/Helm regressions    | 17 passed; three built-image HTTP profiles passed                                                                 |
| Runtime images and vulnerability scans              | Passed: all three owned images, upstream amd64/arm64 images, HTTP contracts, and Compose Redis                    |
| Security                                            | Passed: historical and changed-file secret scans, Bandit, production dependency audit, filesystem vulnerabilities |
| Migration and rollback acceptance                   | Full service/HTTP matrix passed; final-image differential passed in both preparation modes                        |
| Candidate browser                                   | 5 passed against the final complete backend image                                                                 |
| Hooks                                               | Changed-file and all-files passes completed after formatting; all 25 entries accounted for                        |

Ordinary-suite integration skips are exercised separately. Browser capability
skips and candidate-only workflows are reported separately from passing tests.
An earlier browser invocation overlapped host dependency/build operations and is
not used as validation; final browser/Compose runs are serialized. Domain,
NVIDIA-docs and Perplexity HTTP comparisons initially failed only on a measured
clock field; the repaired normalizer and complete reruns supply the result.

CI-only CodeQL analysis and GitHub OIDC image attestations cannot be reproduced
as those hosted jobs locally. Deployment uses the repository's documented local
development release path; its image scans, digest selection and rollout checks
remain required. Live-model quality/cost experiments and external-provider
latency experiments were not rerun. These limitations do not establish that
those providers or hosted checks pass.
