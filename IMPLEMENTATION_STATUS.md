# Implementation status

The implementation addresses the original review findings and the additional briefing-renderer request. Validation is **partial** while the explicitly blocked external-service and hardware checks remain outstanding. A verified item means its stated contract is supported by the recorded tests; it does not certify the entire deployment.

Baseline: branch `main`, commit `457d338ad9eec9a285a57436b37213b5ba577477`. The implementation began with only the three review reports and user `review.md` untracked. Those four files remain byte-identical. Production edits are in the shared working tree; final checks use `/tmp/daedalus-implementation-457d338`, a detached checkout containing only the intended source changes and test configuration. No local `.env` was copied into that checkout. That validation phase ended before committing; nothing was published or deployed. The subsequent local commit and fresh test results are recorded separately in `../daedalus-agent-artifacts/commit-testing-457d338/`.

Scope: **57 items** — RV-001 through RV-026 from the review, IR-001 through IR-029 for recommendations and coverage gaps outside the numbered findings, IR-030 for the subsequent briefing failure, and IR-031 for the requested amd64 Redis placement. Priority meanings are unchanged from the review. No finding was removed to obtain passing checks.

**Current disposition:** 7 Blocked; 1 Not applicable; 49 Verified.

## Changes with operational effects

- Update frontend, WebSocket and stream-worker processes together for conversation ownership fencing. Legacy unowned jobs are suppressed rather than recreating deleted records. Existing data needs no bulk rewrite; an older writer removes these guarantees.
- Restart every frontend/WebSocket process after account configuration changes. Removed accounts lose API/WebSocket eligibility; retained history and external OAuth grants have separate lifecycles.
- Interrupted image jobs become explicit unconfirmed failures after lease expiry. Retrying is a deliberate new submission because an external provider might already have acted. Failed chat cancellation retains tracking.
- Briefing sandbox transport/collection errors fall back to the same local canonical renderer and validator, preserving complete usable HTML. Invalid input or unsafe output is still rejected with a specific cause.
- Custom Kubernetes values require Redis to run on an amd64 node within the existing node allowlist. Other workloads keep their placement; architecture affinity does not migrate a node-bound Redis volume.
- Compose Redis now consumes the configured ACL and persists data. Push remains opt-in and requires matching provider egress. Apply the documented coordinated deployment settings when eventually releasing these changes.
- Source-object expiry and physical storage reclamation differ. The current application does not delete Milvus vectors. Quiesce writers before migration; new Auto-ID copy/resume preserves primary keys and rejects ambiguous nonempty legacy targets. Migration and rollback retain both collections.
- Updated image/dependency pins have explicit scan coverage. Seaweed retains one affected gRPC dependency with a digest/component/architecture-specific, expiring applicability record; review its expiry and upstream fix rather than treating it as a permanent exception.

Compatibility and operator procedures: [request/data contracts](docs/request-and-data-contracts.md), [frontend recovery](frontend/RELIABILITY.md), [backend recovery and migration](docs/backend-execution-recovery.md), [runtime images](docs/runtime-image-security.md), [Helm operations](helm/daedalus/README.md).

## Item ledger

File lists identify the implementation entry points, with associated regression files where practical. The full tracked/untracked source inventory and patch are preserved in the evidence bundle. Exact commands, runtime versions, first failures and final outcomes are in [IMPLEMENTATION_VALIDATION.md](IMPLEMENTATION_VALIDATION.md).

| ID                | Priority | Status         | Intended outcome                                                                                                                        | Dependencies                                                              |
| ----------------- | -------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [RV-001](#rv-001) | P1       | Verified       | Reserve and authorize conversation ownership atomically                                                                                 | None; current path revalidated                                            |
| [RV-002](#rv-002) | P1       | Verified       | Reject removed accounts at login and revoke active API/WebSocket sessions                                                               | None; current path revalidated                                            |
| [RV-003](#rv-003) | P1       | Verified       | Record approved MCP failures truthfully                                                                                                 | None; current path revalidated                                            |
| [RV-004](#rv-004) | P1       | Verified       | Make Compose Redis authenticate and preserve state                                                                                      | None; current path revalidated                                            |
| [RV-005](#rv-005) | P2       | Verified       | Serve new and legacy SVG content as inert raster images                                                                                 | None; current path revalidated                                            |
| [RV-006](#rv-006) | P2       | Verified       | Clear durable memory and owner-derived context together                                                                                 | None; current path revalidated                                            |
| [RV-007](#rv-007) | P2       | Verified       | Retain a replacement profile before deleting captured old documents                                                                     | None; current path revalidated                                            |
| [RV-008](#rv-008) | P2       | Verified       | Prevent automatic replay of consequential sandbox POSTs                                                                                 | None; current path revalidated                                            |
| [RV-009](#rv-009) | P2       | Verified       | Preserve concurrent goal, config and run-list updates                                                                                   | None; current path revalidated                                            |
| [RV-010](#rv-010) | P2       | Verified       | Preserve legitimate repeated assistant content                                                                                          | None; current path revalidated                                            |
| [RV-011](#rv-011) | P2       | Verified       | Recover interrupted image jobs without replaying provider calls                                                                         | None; current path revalidated                                            |
| [RV-012](#rv-012) | P2       | Verified       | Keep job tracking until cancellation is acknowledged                                                                                    | None; current path revalidated                                            |
| [RV-013](#rv-013) | P2       | Verified       | Interrupt silent autonomous HTTP waits on cancel or deadline                                                                            | None; current path revalidated                                            |
| [RV-014](#rv-014) | P2       | Verified       | Retain request deadlines through response-body consumption                                                                              | None; current path revalidated                                            |
| [RV-015](#rv-015) | P2       | Verified       | Require explicit document-ingestion completion                                                                                          | None; current path revalidated                                            |
| [RV-016](#rv-016) | P2       | Verified       | Display failures and retry before the first assistant token                                                                             | None; current path revalidated                                            |
| [RV-017](#rv-017) | P2       | Verified       | Accept only gate-created approval control markers                                                                                       | None; current path revalidated                                            |
| [RV-018](#rv-018) | P2       | Verified       | Enforce explicit empty and malformed citation ledgers                                                                                   | None; current path revalidated                                            |
| [RV-019](#rv-019) | P2       | Verified       | Restrict push registration and delivery to validated supported providers                                                                | None; current path revalidated                                            |
| [RV-020](#rv-020) | P2       | Verified       | Initialize rate-limit expiry atomically and repair legacy counters                                                                      | None; current path revalidated                                            |
| [RV-021](#rv-021) | P2       | Verified       | Track concurrent image blob ownership correctly                                                                                         | None; current path revalidated                                            |
| [RV-022](#rv-022) | P2       | Verified       | Terminate optional skill children on cancellation                                                                                       | None; current path revalidated                                            |
| [RV-023](#rv-023) | P2       | Verified       | Keep release and CI scan contracts consistent                                                                                           | None; current path revalidated                                            |
| [RV-024](#rv-024) | P2       | Verified       | Permit only configured push-provider egress                                                                                             | RV-019 endpoint policy                                                    |
| [RV-025](#rv-025) | P2       | Verified       | Scan all shipped images and update affected pins                                                                                        | None; current path revalidated                                            |
| [RV-026](#rv-026) | P3       | Verified       | Interpret explicit empty operation allowlists as deny-all                                                                               | None; current path revalidated                                            |
| [IR-001](#ir-001) | P2       | Blocked        | Full synthetic upload/ingest/embed/query/download/delete pipeline                                                                       | Disposable external-service equivalents                                   |
| [IR-002](#ir-002) | P2       | Blocked        | Prove NV-Ingest cancellation settles threaded work before collection reuse                                                              | Actual client/thread boundary                                             |
| [IR-003](#ir-003) | P2       | Verified       | Align configured source-object TTL and define reclamation                                                                               | Disposable accelerated retention experiment                               |
| [IR-004](#ir-004) | P2       | Blocked        | Establish external VLM URL/DNS/redirect protections                                                                                     | Disposable VLM-fetching service                                           |
| [IR-005](#ir-005) | P2       | Verified       | Bound public response buffering                                                                                                         | Synthetic response-size experiment                                        |
| [IR-006](#ir-006) | P2       | Verified       | Measure and bound repeated image-reference decoding                                                                                     | Synthetic image load experiment                                           |
| [IR-007](#ir-007) | P2       | Verified       | Bound optional child-script output while reading                                                                                        | RV-022                                                                    |
| [IR-008](#ir-008) | P2       | Verified       | Release image loads resolved after cancellation                                                                                         | RV-021                                                                    |
| [IR-009](#ir-009) | P2       | Verified       | Commit compressed browser snapshots without duplicate steps                                                                             | Native browser reproduction                                               |
| [IR-010](#ir-010) | P2       | Verified       | Document and test supported generic chat/image EOF contracts                                                                            | Provider contract fixtures                                                |
| [IR-011](#ir-011) | P2       | Verified       | Recheck initial browser login timeout without hiding first failure                                                                      | Final production build and browser matrix                                 |
| [IR-012](#ir-012) | P2       | Blocked        | Validate OAuth offline refresh/restart and remote IAM prerequisites                                                                     | Disposable OAuth/memory/object-store boundaries; live calls prohibited    |
| [IR-013](#ir-013) | P2       | Verified       | Verify actual push-policy enforcement                                                                                                   | RV-019/RV-024                                                             |
| [IR-014](#ir-014) | P2       | Blocked        | Validate arm64 runtime build/lock compatibility                                                                                         | Available emulator or arm64 runner                                        |
| [IR-015](#ir-015) | P2       | Blocked        | Record physical-device/PWA validation prerequisites and evidence                                                                        | Physical Apple device unavailable initially                               |
| [IR-016](#ir-016) | P2       | Verified       | Resolve current primary advisory applicability                                                                                          | Current maintainer advisories and resolved versions                       |
| [IR-017](#ir-017) | P3       | Verified       | Generate shared protocol types from one canonical source                                                                                | Separate refactoring after behavioral fixes                               |
| [IR-018](#ir-018) | P3       | Verified       | Centralize checked runtime image inventory                                                                                              | RV-025; separate refactoring                                              |
| [IR-019](#ir-019) | P3       | Not applicable | Expose operator capability/readiness detail matching request dependencies                                                               | Current readiness implementation evidence                                 |
| [IR-020](#ir-020) | P2       | Verified       | Document explicit retention/deletion contracts for objects, vectors, memory and caches                                                  | RV-006/RV-007 and retention verification                                  |
| [IR-021](#ir-021) | P3       | Verified       | Correct obsolete Responses-overlay documentation                                                                                        | Current runtime/config                                                    |
| [IR-022](#ir-022) | P3       | Verified       | Correct RSS structured response documentation                                                                                           | Actual registered tool schema                                             |
| [IR-023](#ir-023) | P2       | Verified       | Update vulnerable development dependency chains                                                                                         | Primary advisories and locked resolution; final Node build/tests          |
| [IR-024](#ir-024) | P3       | Verified       | Repair pre-existing worker formatting failure                                                                                           | Backend changes plus pinned Ruff/isort                                    |
| [IR-025](#ir-025) | P2       | Verified       | Close meaningful test-quality gaps in changed contracts                                                                                 | Regressions plus real Redis/native NAT/browser validation                 |
| [IR-026](#ir-026) | P3       | Verified       | Preserve reproducible evidence with implementation reports                                                                              | Exact commands, logs and durable regression sources                       |
| [IR-027](#ir-027) | P1       | Verified       | Run final repository CI, complete diff and cross-fix review                                                                             | All coherent changes stable                                               |
| [IR-028](#ir-028) | P2       | Verified       | Validate operator migration contracts with disposable database; prohibit live migration                                                 | Disposable Milvus fixture                                                 |
| [IR-029](#ir-029) | P3       | Blocked        | Characterize model/source quality and resource performance without unsupported claims                                                   | Synthetic measurements; real model unavailable initially                  |
| [IR-030](#ir-030) | P1       | Verified       | Fix recurring briefing renderer ValueError and preserve usable generated content; remove faulty recent rejection mechanism if warranted | Reproduce renderer failure; retain source/HTML safety                     |
| [IR-031](#ir-031) | P2       | Verified       | Require Redis to use an eligible x86/amd64 node in the selected Kubernetes deployment                                                   | User steering; existing global node allowlist and accessible Redis volume |

### RV-001

**Files:** [frontend/server/session/conversationStore.ts](frontend/server/session/conversationStore.ts), [frontend/pages/api/chat/async.ts](frontend/pages/api/chat/async.ts), [frontend/server/chat/finalization.ts](frontend/server/chat/finalization.ts), [frontend/server/session/conversationDeletion.ts](frontend/server/session/conversationDeletion.ts).

**Evidence:** [root/api-fourth.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/api-fourth.log):121pass, [root/security-redis-third.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/security-redis-third.log):29pass.

**Disposition and limits:** Legacy ownerless records are adopted only on an authorized write. Expired/deleted unowned jobs cannot recreate them. Deletion after an authorized final save can still race publication, memory retention or the selected cache; documented separately.

### RV-002

**Files:** [frontend/utils/auth/config.ts](frontend/utils/auth/config.ts), [frontend/utils/auth/users.ts](frontend/utils/auth/users.ts), [frontend/utils/auth/session.ts](frontend/utils/auth/session.ts), [frontend/ws-server.ts](frontend/ws-server.ts).

**Evidence:** [root/users-before.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/users-before.log):2failing, [root/users-after.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/users-after.log):5pass, [frontend/validation.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/validation.md):27focused/6realRedis sessionrevocation.

**Disposition and limits:** Restart every frontend/WebSocket process after account configuration changes. Retained history is preserved; changing only a password does not revoke existing sessions.

### RV-003

**Files:** [builder/mcp_patches.py](builder/mcp_patches.py), [builder/tests/test_mcp_approval_api.py](builder/tests/test_mcp_approval_api.py).

**Evidence:** [backend/rv003.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/rv003.log), [backend/native-mcp-result.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/native-mcp-result.log).

**Disposition and limits:** Focused regressions and native runtime probes passed; external provider behavior is limited to the fixtures detailed in backend/validation.md. Full isolated Python suite passed 1,404 tests.

### RV-004

**Files:** [redis/compose-entrypoint.sh](redis/compose-entrypoint.sh), [redis/Dockerfile](redis/Dockerfile), [docker-compose.yaml](docker-compose.yaml), [scripts/test_compose_redis.py](scripts/test_compose_redis.py).

**Evidence:** [operations/compose-redis-regression.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/compose-redis-regression.log), [operations/redis-upgrade.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/redis-upgrade.log).

**Disposition and limits:** Native AMD64 Compose authentication, JSON/stream persistence and ten-revision Kind upgrades passed. The selected custom Kubernetes deployment now requires amd64 Redis nodes. ARM64 server acceptance remains separately unverified under IR-014.

### RV-005

**Files:** [frontend/pages/api/session/imageStorage.ts](frontend/pages/api/session/imageStorage.ts), [frontend/e2e/tests/image-security.spec.ts](frontend/e2e/tests/image-security.spec.ts).

**Evidence:** [root/security-unit-second.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/security-unit-second.log), [root/final-browser-https.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-browser-https.log).

**Disposition and limits:** Actual Sharp regressions and authenticated direct-navigation Chromium checks pass for new and legacy SVG in the final HTTPS matrix. Cached pre-upgrade responses retain their previous lifetime. Earlier WebKit fixture failures and their follow-up are recorded under IR-011.

### RV-006

**Files:** [builder/nat_helpers/src/nat_helpers/memory_lifecycle.py](builder/nat_helpers/src/nat_helpers/memory_lifecycle.py), [builder/memory_api.py](builder/memory_api.py), [builder/user_interaction/src/user_interaction/user_interaction_function.py](builder/user_interaction/src/user_interaction/user_interaction_function.py).

**Evidence:** [backend/native-memory-clear.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/native-memory-clear.log).

**Disposition and limits:** Focused regressions and native runtime probes passed; external provider behavior is limited to the fixtures detailed in backend/validation.md. Full isolated Python suite passed 1,404 tests.

### RV-007

**Files:** [builder/profile_import_api.py](builder/profile_import_api.py), [builder/nat_helpers/src/nat_helpers/hindsight_client.py](builder/nat_helpers/src/nat_helpers/hindsight_client.py), [frontend/pages/api/profile/import.ts](frontend/pages/api/profile/import.ts).

**Evidence:** [backend/native-paths-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/native-paths-final.log), [backend/citations-profile-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/citations-profile-final.log).

**Disposition and limits:** Focused regressions and native runtime probes passed; external provider behavior is limited to the fixtures detailed in backend/validation.md. Full isolated Python suite passed 1,404 tests.

### RV-008

**Files:** [builder/llm_sandbox/src/llm_sandbox/llm_sandbox_function.py](builder/llm_sandbox/src/llm_sandbox/llm_sandbox_function.py), [builder/tests/test_llm_sandbox.py](builder/tests/test_llm_sandbox.py).

**Evidence:** [backend/native-sandbox-retry.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/native-sandbox-retry.log).

**Disposition and limits:** Focused regressions and native runtime probes passed; external provider behavior is limited to the fixtures detailed in backend/validation.md. Full isolated Python suite passed 1,404 tests.

### RV-009

**Files:** [frontend/server/atomicJson.ts](frontend/server/atomicJson.ts), [frontend/server/autonomy/store.ts](frontend/server/autonomy/store.ts), [frontend/pages/api/autonomy/goals.ts](frontend/pages/api/autonomy/goals.ts).

**Evidence:** [frontend/redis-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/redis-final.log), [root/final-frontend-redis.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-frontend-redis.log).

**Disposition and limits:** Concurrent real Redis updates pass for JSON and string storage. Python WATCH/MULTI uses the same representation; a mixed-language process race was not separately executed.

### RV-010

**Files:** [frontend/utils/app/conversationReplay.ts](frontend/utils/app/conversationReplay.ts), [frontend/**tests**/pages/api/chat/async.test.ts](frontend/__tests__/pages/api/chat/async.test.ts), [frontend/**tests**/pages/api/session/conversationHistory.test.ts](frontend/__tests__/pages/api/session/conversationHistory.test.ts), [frontend/**tests**/pages/api/session/selectedConversation.test.ts](frontend/__tests__/pages/api/session/selectedConversation.test.ts).

**Evidence:** [frontend/replay-callers-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/replay-callers-final.log), [root/api-fourth.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/api-fourth.log), [root/final-frontend-coverage-third.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-frontend-coverage-third.log).

**Disposition and limits:** Independent repeated provider text is preserved; transport identity/offset deduplication remains. Previously discarded text cannot be restored.

### RV-011

**Files:** [frontend/server/images/jobRecovery.ts](frontend/server/images/jobRecovery.ts), [frontend/pages/api/images/jobs.ts](frontend/pages/api/images/jobs.ts), [frontend/**tests**/server/images/jobRecovery.integration.test.ts](frontend/__tests__/server/images/jobRecovery.integration.test.ts).

**Evidence:** [frontend/redis-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/redis-final.log), [root/final-frontend-redis.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-frontend-redis.log).

**Disposition and limits:** Actual process kill, lease expiry and restart reconcile to an explicit interrupted/unconfirmed failure. Recovery does not replay a potentially completed provider operation.

### RV-012

**Files:** [frontend/hooks/useAsyncChat.ts](frontend/hooks/useAsyncChat.ts), [frontend/components/chat/ChatView.tsx](frontend/components/chat/ChatView.tsx), [frontend/**tests**/hooks/useAsyncChat.test.tsx](frontend/__tests__/hooks/useAsyncChat.test.tsx).

**Evidence:** [frontend/baseline-regressions.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/baseline-regressions.log), [frontend/focused-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/focused-final.log).

**Disposition and limits:** Failed cancellation preserves tracking and subsequent streamed tokens. Acknowledged cancellation does not undo completed external side effects.

### RV-013

**Files:** [builder/autonomous_agent/src/autonomous_agent/backend_client.py](builder/autonomous_agent/src/autonomous_agent/backend_client.py), [builder/autonomous_agent/pyproject.toml](builder/autonomous_agent/pyproject.toml), [builder/tests/test_backend_client_cancellation.py](builder/tests/test_backend_client_cancellation.py).

**Evidence:** [backend/autonomy-local-http.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/autonomy-local-http.log), [backend/coverage-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/coverage-final.log).

**Disposition and limits:** Focused regressions and native runtime probes passed; external provider behavior is limited to the fixtures detailed in backend/validation.md. Full isolated Python suite passed 1,404 tests.

### RV-014

**Files:** [frontend/utils/fetchWithTimeout.ts](frontend/utils/fetchWithTimeout.ts), [frontend/server/chat/backendSelection.ts](frontend/server/chat/backendSelection.ts), [frontend/**tests**/utils/fetchWithTimeout.body.test.ts](frontend/__tests__/utils/fetchWithTimeout.body.test.ts).

**Evidence:** [frontend/focused-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/focused-final.log), [frontend/baseline-regressions.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/baseline-regressions.log).

**Disposition and limits:** Actual loopback HTTP stalled-body deadline and caller cancellation pass. Callers must consume or cancel returned response bodies.

### RV-015

**Files:** [frontend/server/chat/documentIngest.ts](frontend/server/chat/documentIngest.ts), [frontend/**tests**/server/chat/documentIngest.protocol.test.ts](frontend/__tests__/server/chat/documentIngest.protocol.test.ts).

**Evidence:** [frontend/focused-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/focused-final.log), [root/api-fourth.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/api-fourth.log).

**Disposition and limits:** Actual loopback ingestion SSE requires explicit completion. Full external NV-Ingest execution remains under IR-001.

### RV-016

**Files:** [frontend/components/chat/MessageBubble.tsx](frontend/components/chat/MessageBubble.tsx), [frontend/**tests**/components/chat/MessageBubble.test.tsx](frontend/__tests__/components/chat/MessageBubble.test.tsx).

**Evidence:** [frontend/baseline-regressions.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/baseline-regressions.log), [frontend/focused-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/focused-final.log).

**Disposition and limits:** Actual MessageBubble rendering exposes pre-token failure and Retry; a genuinely empty placeholder remains hidden.

### RV-017

**Files:** [builder/nat_helpers/src/nat_helpers/approval_context.py](builder/nat_helpers/src/nat_helpers/approval_context.py), [builder/mcp_patches.py](builder/mcp_patches.py), [builder/nat_helpers/src/nat_helpers/agent_loop_guard.py](builder/nat_helpers/src/nat_helpers/agent_loop_guard.py), [builder/nat_helpers/src/nat_helpers/front_end.py](builder/nat_helpers/src/nat_helpers/front_end.py).

**Evidence:** [backend/native-paths-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/native-paths-final.log).

**Disposition and limits:** Focused regressions and native runtime probes passed; external provider behavior is limited to the fixtures detailed in backend/validation.md. Full isolated Python suite passed 1,404 tests.

### RV-018

**Files:** [builder/source_verifier/src/source_verifier/source_verifier_function.py](builder/source_verifier/src/source_verifier/source_verifier_function.py), [builder/tests/test_source_verifier_citation_audit.py](builder/tests/test_source_verifier_citation_audit.py).

**Evidence:** [backend/citations-profile-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/citations-profile-final.log).

**Disposition and limits:** Focused regressions and native runtime probes passed; external provider behavior is limited to the fixtures detailed in backend/validation.md. Full isolated Python suite passed 1,404 tests.

### RV-019

**Files:** [frontend/server/pushSubscriptions.ts](frontend/server/pushSubscriptions.ts), [frontend/pages/api/push/subscribe.ts](frontend/pages/api/push/subscribe.ts), [frontend/server/chat/finalization.ts](frontend/server/chat/finalization.ts).

**Evidence:** [root/security-unit-second.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/security-unit-second.log):52pass, [root/api-fourth.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/api-fourth.log):121pass, [operations/validation.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/validation.md):enforcingCNI HTTPSfixture.

**Disposition and limits:** Registration and delivery revalidate endpoints and keys. Enforcing CNI tests use actual web-push against synthetic TLS endpoints, never real subscribers.

### RV-020

**Files:** [frontend/server/redisCounter.ts](frontend/server/redisCounter.ts), [frontend/server/rateLimit.ts](frontend/server/rateLimit.ts), [frontend/pages/api/auth/login.ts](frontend/pages/api/auth/login.ts).

**Evidence:** [root/security-redis-third.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/security-redis-third.log):29pass, [root/security-unit-second.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/security-unit-second.log):52pass.

**Disposition and limits:** Actual Redis tests cover increments and repair of TTL-less legacy keys; rate-limit fail-open behavior on Redis outage is unchanged.

### RV-021

**Files:** [frontend/utils/app/imageBlobCache.ts](frontend/utils/app/imageBlobCache.ts), [frontend/**tests**/utils/app/imageHandlerBlobCache.test.ts](frontend/__tests__/utils/app/imageHandlerBlobCache.test.ts).

**Evidence:** [frontend/baseline-regressions.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/baseline-regressions.log), [frontend/focused-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/focused-final.log).

**Disposition and limits:** Concurrent consumers share one request and acquire separate references; independent release cannot revoke another active consumer.

### RV-022

**Files:** [builder/agent_skills/src/agent_skills/agent_skills_function.py](builder/agent_skills/src/agent_skills/agent_skills_function.py), [builder/tests/test_agent_skills_function.py](builder/tests/test_agent_skills_function.py).

**Evidence:** [backend/native-skills.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/native-skills.log), [backend/skills.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/skills.log).

**Disposition and limits:** Focused regressions and native runtime probes passed; external provider behavior is limited to the fixtures detailed in backend/validation.md. Full isolated Python suite passed 1,404 tests.

### RV-023

**Files:** [.github/workflows/release.yml](.github/workflows/release.yml), [builder/tests/test_ci_makefile_parity.py](builder/tests/test_ci_makefile_parity.py).

**Evidence:** [operations/focused-recheck.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/focused-recheck.log), [operations/upstream-gate-safe-logging.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/upstream-gate-safe-logging.log).

**Disposition and limits:** Release/CI parity tests and explicit inventory checks pass. No release job was dispatched or image published.

### RV-024

**Files:** [helm/daedalus/templates/networkpolicy-frontend.yaml](helm/daedalus/templates/networkpolicy-frontend.yaml), [helm/daedalus/templates/cilium-frontend.yaml](helm/daedalus/templates/cilium-frontend.yaml), [helm/daedalus/templates/frontend-deployment.yaml](helm/daedalus/templates/frontend-deployment.yaml), [helm/daedalus/templates/frontend-stream-worker.yaml](helm/daedalus/templates/frontend-stream-worker.yaml), [helm/daedalus/values.yaml](helm/daedalus/values.yaml).

**Evidence:** [operations/push-policy-live-second.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/push-policy-live-second.log), [operations/push-received.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/push-received.log), [operations/push-blocked-received.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/push-blocked-received.log).

**Disposition and limits:** Actual Cilium enforcement proves disabled, explicit CIDR and FQDN policies against a synthetic HTTPS provider; unrelated destinations remain blocked.

### RV-025

**Files:** [deployment-images.json](deployment-images.json), [scripts/check_image_inventory.py](scripts/check_image_inventory.py), [scripts/image_vex.py](scripts/image_vex.py), [security/image-vex.json](security/image-vex.json), [docker-compose.yaml](docker-compose.yaml), [helm/daedalus/values.yaml](helm/daedalus/values.yaml), [.github/workflows/ci.yml](.github/workflows/ci.yml), [.github/workflows/release.yml](.github/workflows/release.yml), [Makefile](Makefile).

**Evidence:** [operations/validation.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/validation.md), [operations/upstream-gate-both-platforms-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/upstream-gate-both-platforms-final.log), [operations/final-image-identities.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/final-image-identities.log), [operations/final-image-scan-summary.json](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/final-image-scan-summary.json).

**Disposition and limits:** All six application/Redis images build and scan on AMD64/ARM64. Both native backend contracts and frontend Node/Sharp probes pass. Upstream gates cover both platforms; the expiring exact-image gRPC applicability record preserves the affected dependency finding. The custom Kubernetes deployment requires amd64 Redis nodes; ARM64 server acceptance remains separately unverified under IR-014.

### RV-026

**Files:** [builder/agent_skills/src/agent_skills/agent_skills_function.py](builder/agent_skills/src/agent_skills/agent_skills_function.py), [builder/user_interaction/src/user_interaction/user_interaction_function.py](builder/user_interaction/src/user_interaction/user_interaction_function.py).

**Evidence:** [backend/native-skills.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/native-skills.log).

**Disposition and limits:** Focused regressions and native runtime probes passed; external provider behavior is limited to the fixtures detailed in backend/validation.md. Full isolated Python suite passed 1,404 tests.

### IR-001

**Files:** [docs/integration-acceptance.md](docs/integration-acceptance.md).

**Evidence:** [REVIEW_REPORT.md](REVIEW_REPORT.md):Full NV-Ingest pipeline gap, [backend/external-vlm-disposition.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/external-vlm-disposition.md).

**Disposition and limits:** Full disposable NV-Ingest extraction/embedding/Milvus pipeline not provisioned; component and frontend fixture tests do not prove full pipeline.

### IR-002

**Files:** [builder/nat_helpers/src/nat_helpers/threaded_work.py](builder/nat_helpers/src/nat_helpers/threaded_work.py), [builder/nat_nv_ingest/src/nat_nv_ingest/nat_nv_ingest.py](builder/nat_nv_ingest/src/nat_nv_ingest/nat_nv_ingest.py), [docs/integration-acceptance.md](docs/integration-acceptance.md).

**Evidence:** [backend/nv-thread.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/nv-thread.log).

**Disposition and limits:** Actual thread lock-lifetime bug fixed and tested. Remote NV-Ingest cancellation/late-write settlement remains unverified without external disposable pipeline.

### IR-003

**Files:** [docker-compose.yaml](docker-compose.yaml), [scripts/document_object_ttl.sh](scripts/document_object_ttl.sh), [builder/tests/test_document_object_ttl.py](builder/tests/test_document_object_ttl.py), [docs/runtime-image-security.md](docs/runtime-image-security.md).

**Evidence:** [operations/object-ttl-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/object-ttl-final.log), [operations/object-physical-reclamation-second.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/object-physical-reclamation-second.log), [operations/object-reclaim-service.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/object-reclaim-service.log).

**Disposition and limits:** Derived Compose TTL passes boundary tests and actual S3 expiry. One-minute idle volume became unreadable at 60.1 s and reclaimed allocated data by 125.2 s; shared later writes can delay physical reclamation. Existing objects keep previous TTL.

### IR-004

**Files:** [docs/integration-acceptance.md](docs/integration-acceptance.md).

**Evidence:** [backend/external-vlm-disposition.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/external-vlm-disposition.md).

**Disposition and limits:** External VLM URL fetcher not in checkout or disposable environment; caller guards do not establish service DNS/redirect behavior. No speculative change.

### IR-005

**Files:** [builder/nat_helpers/src/nat_helpers/safe_http.py](builder/nat_helpers/src/nat_helpers/safe_http.py), [builder/tests/test_public_fetch_limits.py](builder/tests/test_public_fetch_limits.py).

**Evidence:** [backend/fetch-buffer-baseline.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/fetch-buffer-baseline.log), [backend/native-fetch-buffer.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/native-fetch-buffer.log), [backend/public-fetch.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/public-fetch.log).

**Disposition and limits:** Focused regressions and native runtime probes passed; external provider behavior is limited to the fixtures detailed in backend/validation.md. Full isolated Python suite passed 1,404 tests.

### IR-006

**Files:** [builder/nat_helpers/src/nat_helpers/image_input_budget.py](builder/nat_helpers/src/nat_helpers/image_input_budget.py), [builder/image_api.py](builder/image_api.py), [builder/visual_media/src/visual_media/visual_media_function.py](builder/visual_media/src/visual_media/visual_media_function.py), [builder/tests/test_image_input_limits.py](builder/tests/test_image_input_limits.py).

**Evidence:** [root/image-budget-before.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/image-budget-before.log):2fail,16decodes,18208845peakbytes, [root/image-budget-after.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/image-budget-after.log):58pass,1decode,2449972peakbytes.

**Disposition and limits:** At most 16 inputs, a 64 MiB aggregate decoded-file budget and a separate 64 MiB multipart budget; identical authorized references reuse bytes within the request. Measurements cover Python file allocations, not pixel-decoder RSS.

### IR-007

**Files:** [builder/agent_skills/src/agent_skills/agent_skills_function.py](builder/agent_skills/src/agent_skills/agent_skills_function.py), [builder/tests/test_agent_skills_function.py](builder/tests/test_agent_skills_function.py).

**Evidence:** [backend/script-output-baseline.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/script-output-baseline.log), [backend/native-script-output.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/native-script-output.log).

**Disposition and limits:** Focused regressions and native runtime probes passed; external provider behavior is limited to the fixtures detailed in backend/validation.md. Full isolated Python suite passed 1,404 tests.

### IR-008

**Files:** [frontend/components/chat/OptimizedImage.tsx](frontend/components/chat/OptimizedImage.tsx), [frontend/**tests**/components/chat/OptimizedImage.lifecycle.test.tsx](frontend/__tests__/components/chat/OptimizedImage.lifecycle.test.tsx).

**Evidence:** [frontend/image-cancel-baseline-2.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/image-cancel-baseline-2.log), [frontend/focused-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/focused-final.log).

**Disposition and limits:** Deferred thumbnail/full-image loads resolving after unmount release their acquired URLs; actual component lifecycle regression passes.

### IR-009

**Files:** [frontend/utils/app/intermediateStepsDB.ts](frontend/utils/app/intermediateStepsDB.ts), [frontend/e2e/tests/intermediate-storage.spec.ts](frontend/e2e/tests/intermediate-storage.spec.ts).

**Evidence:** [frontend/idb-baseline.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/idb-baseline.log), [frontend/idb-delayed-compression-baseline.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/idb-delayed-compression-baseline.log), [frontend/storage-browser-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/storage-browser-final.log).

**Disposition and limits:** Native Chromium/WebKit compression, transaction commit, repeated/concurrent snapshots and Unicode tests pass without a database-version change. Physical devices remain IR-015.

### IR-010

**Files:** [docs/request-and-data-contracts.md](docs/request-and-data-contracts.md), [builder/tests/test_openai_images.py](builder/tests/test_openai_images.py).

**Evidence:** [root/eof-tests.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/eof-tests.log), [root/api-fourth.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/api-fourth.log):cleanEOF and explicitterminaltests.

**Disposition and limits:** Existing clean EOF compatibility is retained and documented. A stream exception does not promote a partial image. Silent upstream truncation cannot be distinguished from intentional EOF.

### IR-011

**Files:** [frontend/e2e/https-proxy.mjs](frontend/e2e/https-proxy.mjs), [frontend/e2e/helpers/auth.ts](frontend/e2e/helpers/auth.ts), [frontend/e2e/run-e2e.mjs](frontend/e2e/run-e2e.mjs), [frontend/e2e/start-e2e-app.mjs](frontend/e2e/start-e2e-app.mjs), [frontend/playwright.config.ts](frontend/playwright.config.ts), [frontend/e2e/tests/ui-layout.spec.ts](frontend/e2e/tests/ui-layout.spec.ts), [frontend/e2e/tests/agentic-app.spec.ts](frontend/e2e/tests/agentic-app.spec.ts), [frontend/e2e/README.md](frontend/e2e/README.md), [frontend/e2e/tests/image-security.spec.ts](frontend/e2e/tests/image-security.spec.ts).

**Evidence:** [root/final-browser.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-browser.log), [root/final-browser-second.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-browser-second.log), [frontend/mobile-login-diagnosis.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/mobile-login-diagnosis.md), [frontend/mobile-login-https.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/mobile-login-https.log), [frontend/https-harness-smoke-second.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/https-harness-smoke-second.log), [root/final-browser-https.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-browser-https.log).

**Disposition and limits:** The HTTP-loopback harness did not retain WebKit Secure sessions; synthetic HTTPS passed 3/3. Test-only HTTPS now verifies actual authenticated browser requests, WSS events and service-worker control. Corrected full matrix: 157 passed, 14 conditional skips, 6.8 min. Earlier intermittent route-transfer failures and a WebKit process crash remain preserved; their exact cause is not inferred from the cookie finding. Retries, timeouts and production Secure flags are unchanged.

### IR-012

**Files:** [docs/integration-acceptance.md](docs/integration-acceptance.md).

**Evidence:** [backend/native-contracts-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/native-contracts-final.log), [operations/backend-runtime-contract-second.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/backend-runtime-contract-second.log).

**Disposition and limits:** Native offline OAuth refresh and adapter contracts pass. Actual remote test-account grants, provider scopes and bucket/memory IAM after deployment restart remain unavailable; live calls are prohibited.

### IR-013

**Files:** [builder/tests/test_push_network_policy.py](builder/tests/test_push_network_policy.py), [helm/daedalus/templates/cilium-frontend.yaml](helm/daedalus/templates/cilium-frontend.yaml), [helm/daedalus/templates/networkpolicy-frontend.yaml](helm/daedalus/templates/networkpolicy-frontend.yaml).

**Evidence:** [operations/push-policy-live-second.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/push-policy-live-second.log).

**Disposition and limits:** Actual Cilium 1.20.1 policy enforcement against isolated DNS/TLS fixtures passed; render-only checks are not the evidence for this item.

### IR-014

**Files:** [docs/integration-acceptance.md](docs/integration-acceptance.md).

**Evidence:** [operations/status.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/status.md), [operations/validation.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/validation.md), [operations/arm64-system-vm-stopped/status.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/arm64-system-vm-stopped/status.md), [root/redis-amd64-placement/validation.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/redis-amd64-placement/validation.md).

**Disposition and limits:** All ARM64 images build and scan; actual backend contracts and frontend bindings pass. Redis server acceptance remains unverified: user-mode emulation failed its unchanged safety probe, and the full-system guest experiment was stopped at the user's request after a boot-filesystem failure before Redis. The selected custom Kubernetes deployment now requires amd64 Redis nodes under IR-031; no ARM64 runtime pass is claimed for unrestricted chart deployments.

### IR-015

**Files:** [docs/integration-acceptance.md](docs/integration-acceptance.md).

**Evidence:** [REVIEW_VALIDATION.md](REVIEW_VALIDATION.md):physical-device gap.

**Disposition and limits:** No physical iPhone/iPad or installed-PWA access. Linux WebKit does not prove physical-device behavior. Manual prerequisites documented in acceptance plan.

### IR-016

**Files:** [security/image-vex.json](security/image-vex.json), [docs/runtime-image-security.md](docs/runtime-image-security.md).

**Evidence:** [operations/upstream-gate-both-platforms-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/upstream-gate-both-platforms-final.log), [operations/validation.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/validation.md).

**Disposition and limits:** Current primary Apache Thrift and gRPC advisories checked. Separate exact-digest AMD64/ARM64 records verify ELF architecture and absence of vulnerable xDS server code while preserving the affected dependency finding. Expiry 2026-10-11; mismatch or missing proof fails closed.

### IR-017

**Files:** [protocol/source-policy.schema.json](protocol/source-policy.schema.json), [scripts/generate_protocol_types.py](scripts/generate_protocol_types.py), [frontend/types/sourcePolicy.ts](frontend/types/sourcePolicy.ts), [builder/nat_helpers/src/nat_helpers/source_policy_types.py](builder/nat_helpers/src/nat_helpers/source_policy_types.py), [builder/autonomous_agent/src/autonomous_agent/prompt.py](builder/autonomous_agent/src/autonomous_agent/prompt.py), [builder/tests/test_shared_protocol.py](builder/tests/test_shared_protocol.py).

**Evidence:** [root/protocol-tests.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/protocol-tests.log):54pass.

**Disposition and limits:** Separate refactor centralizes the duplicated source-policy shape and IDs. Generated artifact, TypeScript and Python drift checks pass. Existing sanitizers and upstream NAT event protocols retain their separate runtime semantics.

### IR-018

**Files:** [deployment-images.json](deployment-images.json), [scripts/check_image_inventory.py](scripts/check_image_inventory.py), [builder/tests/test_deployment_image_inventory.py](builder/tests/test_deployment_image_inventory.py).

**Evidence:** [operations/image-inventory-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/image-inventory-final.log), [operations/focused-recheck.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/focused-recheck.log).

**Disposition and limits:** Checked deployment-images.json is consumed by CI/Makefile/release gates; drift, missing images and scan failures are rejected.

### IR-019

**Files:** [docs/request-and-data-contracts.md](docs/request-and-data-contracts.md).

**Evidence:** [builder/nat_helpers/src/nat_helpers/front_end.py](builder/nat_helpers/src/nat_helpers/front_end.py):273-410, [frontend/pages/api/health.ts](frontend/pages/api/health.ts), [backend/approval-profile-citations.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/approval-profile-citations.log).

**Disposition and limits:** Existing endpoints already report required/optional MCP, RAG and Hindsight readiness plus frontend Redis/WebSocket health. Current code and tests support documenting their limits; another public diagnostics endpoint would duplicate existing behavior.

### IR-020

**Files:** [docs/request-and-data-contracts.md](docs/request-and-data-contracts.md), [docs/hindsight-memory-integration.md](docs/hindsight-memory-integration.md), [docs/runtime-image-security.md](docs/runtime-image-security.md).

**Evidence:** [operations/object-physical-reclamation-second.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/object-physical-reclamation-second.log), [backend/native-memory-clear.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/native-memory-clear.log), [docs/request-and-data-contracts.md](docs/request-and-data-contracts.md).

**Disposition and limits:** Documents independent object, vector, memory and browser lifetimes. Application APIs do not delete Milvus vectors; operator retention and backups require separate procedures.

### IR-021

**Files:** [README.md](README.md).

**Evidence:** [backend/tool-calling-config.yaml](backend/tool-calling-config.yaml), [README.md](README.md):canonical Responsesconfiguration description.

**Disposition and limits:** Removed obsolete overlay claim; legitimate general inheritance documentation retained.

### IR-022

**Files:** [builder/rss_feed/README.md](builder/rss_feed/README.md).

**Evidence:** [builder/rss_feed/src/rss_feed/rss_feed_function.py](builder/rss_feed/src/rss_feed/rss_feed_function.py):178-228,753-765.

**Disposition and limits:** Documents actual JSON string envelope, optional fields, success/error handling; no production change.

### IR-023

**Files:** [frontend/package.json](frontend/package.json), [frontend/package-lock.json](frontend/package-lock.json).

**Evidence:** [operations/npm-audit-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/npm-audit-final.log), [root/final-npm-ci.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-npm-ci.log), [root/final-frontend-coverage-third.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-frontend-coverage-third.log).

**Disposition and limits:** Fresh isolated npm ci, all/deployment audit, unit coverage and production build pass with updated Vitest/coverage and transitive development packages.

### IR-024

**Files:** [builder/autonomous_agent/src/autonomous_agent/worker.py](builder/autonomous_agent/src/autonomous_agent/worker.py).

**Evidence:** [root/final-ruff-format-second.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-ruff-format-second.log), [root/final-isort-second.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-isort-second.log).

**Disposition and limits:** Formatting only; exact pinned Ruff and isort --profile black -o redis checks pass. Initial default-isort invocation was a harness configuration error.

### IR-025

**Files:** [builder/tests](builder/tests), [frontend/**tests**](frontend/__tests__), [frontend/e2e/tests](frontend/e2e/tests), [frontend/e2e/helpers/auth.ts](frontend/e2e/helpers/auth.ts).

**Evidence:** [backend/validation.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/validation.md), [frontend/validation.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/validation.md), [root/security-redis-third.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/security-redis-third.log).

**Disposition and limits:** Meaningful regressions include actual threads, processes, HTTP, Redis, native NAT and browsers. Mocked-provider boundaries remain explicit. Final browser and image matrices are tracked separately.

### IR-026

**Files:** [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md), [IMPLEMENTATION_VALIDATION.md](IMPLEMENTATION_VALIDATION.md).

**Evidence:** [/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/MANIFEST.json](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/MANIFEST.json), [/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/scan/summary.json](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/scan/summary.json), [/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338.tar.gz.sha256](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338.tar.gz.sha256).

**Disposition and limits:** Curated original-review and implementation evidence, source patch/current files and original review reports are archived locally. Manifest hashes, archive checksum, original reports and source-patch applicability verify; default-config secret scans and private-value checks pass. Executable/dependency environments, private test keys, local .env and opaque archives are excluded with an explicit ledger; browser traces are expanded and scanned. This is reproducibility evidence, not a deployable or credential backup.

### IR-027

**Files:** No production change; validation-only scope..

**Evidence:** [root/final-python-third.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-python-third.log), [root/final-frontend-coverage-third.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-frontend-coverage-third.log), [root/final-frontend-redis.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-frontend-redis.log), [root/final-browser-https.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-browser-https.log), [operations/final-image-scan-summary.json](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/operations/final-image-scan-summary.json), [root/final-snapshot.json](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-snapshot.json), [root/final-static-combined.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-static-combined.log), [root/final-diff-check.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-diff-check.log), [backend/peer-review-final.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/peer-review-final.md), [backend/peer-implementation-reports.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/peer-implementation-reports.md), [frontend/security-peer-review.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/frontend/security-peer-review.md), [root/redis-amd64-placement/validation.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/redis-amd64-placement/validation.md).

**Disposition and limits:** Applicable local CI constituents and final cross-fix review pass: 1,404 Python, 860 frontend unit, 195 frontend plus four Python real-Redis tests, and 157 browser tests with 14 conditional skips. Six application/Redis images build and scan. All intended source files match the isolated validation checkout; original four review documents are unchanged. Six external/physical acceptance items and one alternate ARM64 Redis runtime item remain blocked; this status does not certify those checks. The later Redis-only scheduling change passes Helm lint, four renders and selector checks; application code and its prior test results are unchanged.

### IR-028

**Files:** [builder/milvus_collection_migration.py](builder/milvus_collection_migration.py), [builder/tests/test_milvus_collection_migration.py](builder/tests/test_milvus_collection_migration.py), [docs/backend-execution-recovery.md](docs/backend-execution-recovery.md).

**Evidence:** [backend/milvus-migration-standalone-fixed.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/milvus-migration-standalone-fixed.log), [backend/milvus-migration-manual-id-final-rerun.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/milvus-migration-manual-id-final-rerun.log), [root/final-python-third.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/final-python-third.log).

**Disposition and limits:** Actual Milvus 2.6.9 Auto-ID upsert corruption on retry was reproduced and fixed using strong reads plus insertion of missing IDs. Five IDs and contents survive committed-batch disconnect, resume, replay and logical rollback. Fifteen regressions pass. Writers must be quiesced; nonempty legacy Auto-ID targets require operator review. Neither collection is deleted.

### IR-029

**Files:** [docs/integration-acceptance.md](docs/integration-acceptance.md).

**Evidence:** [root/image-budget-before.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/image-budget-before.log), [root/image-budget-after.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/image-budget-after.log), [backend/fetch-buffer-baseline.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/fetch-buffer-baseline.log), [backend/native-fetch-buffer.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/native-fetch-buffer.log), [backend/script-output-baseline.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/script-output-baseline.log), [backend/native-script-output.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/native-script-output.log).

**Disposition and limits:** Bounded synthetic allocation experiments are complete. Real model/source quality and sustained service latency/RSS require isolated model resources not supplied here; those results are not claimed.

### IR-030

**Files:** [builder/nat_helpers/src/nat_helpers/briefing_renderer.py](builder/nat_helpers/src/nat_helpers/briefing_renderer.py), [builder/tests/test_briefing_renderer_tool.py](builder/tests/test_briefing_renderer_tool.py), [docs/backend-execution-recovery.md](docs/backend-execution-recovery.md).

**Evidence:** [backend/briefing-baseline.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/briefing-baseline.log), [backend/ir030.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/ir030.log), [backend/native-paths-final.log](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/backend/native-paths-final.log).

**Disposition and limits:** Native registered runner recovers malformed transport and truncated collected output with byte-identical complete canonical HTML. Invalid input/schema/source/HTML still fails explicitly; no live sandbox was called.

### IR-031

**Files:** [custom-values.yaml](custom-values.yaml), [helm/daedalus/values.yaml](helm/daedalus/values.yaml), [helm/daedalus/templates/\_helpers.tpl](helm/daedalus/templates/_helpers.tpl), [helm/daedalus/templates/redis-deployment.yaml](helm/daedalus/templates/redis-deployment.yaml), [helm/daedalus/README.md](helm/daedalus/README.md).

**Evidence:** [root/redis-amd64-placement/validation.md](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/redis-amd64-placement/validation.md), [root/redis-amd64-placement/commands.json](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/redis-amd64-placement/commands.json), [root/redis-amd64-placement/verify_placement.py](/volume2/daedalus/datasets/daedalus-agent-artifacts/implementation-evidence-457d338/evidence/root/redis-amd64-placement/verify_placement.py).

**Disposition and limits:** Required amd64 and hostname constraints are ANDed in one selector term. Custom values constrain Redis only; default chart architecture remains configurable. Helm lint, default/custom/architecture-only/empty-override renders and five-other-workload checks pass. No live scheduling, node labels or PVC placement was inspected; affinity does not migrate node-bound storage or prove ARM64 runtime compatibility.

## Remaining acceptance work

The blocked items have not been declared complete. [Integration acceptance](docs/integration-acceptance.md) records exact first-check commands, required disposable services/test accounts, observations and isolation conditions. ARM64 Redis remains unverified for unrestricted chart deployments; the selected custom deployment now requires amd64 nodes. The unfinished full-system emulation experiment was stopped at the user request. Physical iPhone/iPad PWA behavior cannot be established by Linux WebKit. Full model/source quality and sustained service load also remain unmeasured.

The next operator validation order is: provision a disposable full ingestion/model stack; test cancel/restart and cross-user retrieval through it; validate actual test-account OAuth/IAM and external VLM fetching; run physical-device acceptance and any future ARM64 Redis target checks; then measure model quality and sustained load. Live deployment, credential rotation and destructive data actions remain separate decisions.
