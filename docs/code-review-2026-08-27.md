# Daedalus Code Review — 2026-08-27

Full-stack review of the agentic chat path: frontend chat pipeline, builder
Python backend, workflow configs, and the Compose/Helm/nginx deployment layer.
This document records the root cause of the outage, every change made, and the
findings that were identified but deliberately not changed in this pass.

## Root cause: no LLM responses (HEAD /health → 405)

`frontend/server/chat/backendSelection.ts` gated every chat submit on a
backend reachability probe issued as `HEAD /health`, and required a 2xx
response before pinning a backend. The backend is FastAPI (NAT's FastAPI
front end plus repo-owned routes), and FastAPI does not register HEAD handlers
for GET-only routes — so every probe returned `405 Method Not Allowed`, every
candidate pod was classified unreachable, and after the retry budget the
submit failed with `502 backend_unavailable` before a single
`/v1/chat/completions` request was sent. This matches the pod logs exactly:
repeated `HEAD /health 405` in the retry cadence from the frontend pod, health
probes passing, and zero chat traffic.

Fix: the probe now issues `GET /health` (the endpoint's actual contract and
the same request the Kubernetes startupProbe makes). Tests asserting the
probe's method were updated accordingly.

## Contradictions fixed in this pass

1. **Config overlays silently disabled the MCP authorization policy.**
   NAT resolves `base:` config inheritance, but
   `configure_mcp_approval_policy` in `builder/mcp_patches.py` read only the
   single file it was given. Any overlay config (Helm's
   `backend.default.config.baseData` mechanism, or the former alias file)
   therefore produced an empty `function_groups` policy — under fail-closed
   gating, every MCP tool became approval-gated and per-user OAuth server
   binding lost its server list. The loader now resolves the `base:` chain
   with the same child-over-base deep-merge semantics NAT uses, with cycle and
   depth guards. `backend/tool-calling-responses-config.yaml` (a pure alias,
   referenced by no deployment path) was deleted.

2. **Readiness legacy shim vs. explicit policy.**
   `DAEDALUS_RAG_READINESS_ENABLED` was a legacy fallback that mapped to
   `required` — contradicting the explicit `DAEDALUS_RAG_READINESS_MODE`
   policy and set nowhere in any deployment. Removed (code, Helm env
   allowlist, tests).

3. **Memory budget timeout never backed off.**
   Pre-first-token memory enrichment is bounded by
   `DAEDALUS_MEMORY_CONTEXT_TIMEOUT_SECONDS` (2.5 s) via `asyncio.wait_for`,
   but the bootstrap negative-cache in
   `hindsight_memory_context.ensure_bank_initialized` only populated on
   `except Exception`. A timeout surfaces inside the task as `CancelledError`
   (a `BaseException`), so a slow Hindsight added the full budget as dead air
   on **every** turn, forever. The backoff cache now populates on
   `BaseException` (always re-raised).

4. **Autonomous worker init gate probed `/docs`.**
   The Swagger UI renders regardless of workflow health and is disabled in
   some deployments; every other layer gates on `/health` or `/health/ready`.
   The init container now probes `/health`.

5. **Stream-open fetch had no header timeout.**
   The one fetch that opens `/v1/chat/completions` used a bare `fetch` with
   only an abort signal; the idle timeout guards body reads *after* headers
   arrive. A backend that accepted the connection and never answered pinned a
   stream-worker slot at the OS socket default while the lease heartbeat kept
   renewing, leaving the job `pending` indefinitely. Added
   `STREAM_CONNECT_TIMEOUT_MS` (default 30 s, in `.env.template`) bounding the
   header wait.

6. **Streaming-state write raced its own teardown.**
   `POST /api/chat/async` enqueued the job before writing streaming state, so
   a fast worker could finalize and clear the state before it was written,
   orphaning a key (10-minute TTL) that feeds WS chat-subscription auth and
   the connect-time `streamingStates` payload. Streaming state now lands
   (concurrently with the two independent job-key writes) **before** enqueue,
   and the failure path clears it under the conversation guard.

7. **WS degrade leaked subscriptions.**
   When push delivery was lost mid-turn, the job was removed from the local
   WS-active set without unsubscribing, so the WebSocket manager re-sent the
   stale subscription on every reconnect and the server held the Redis channel
   refcount for the socket's life. The degrade path now unsubscribes from the
   job and chat channels explicitly.

8. **ws-server job fan-out scanned every user.**
   Job subscriptions are validated against the job owner, yet each status
   message iterated all connections of all users. Fan-out is now scoped to the
   owning user's connections, matching the chat-token handler.

9. **Compose nginx contradicted itself and the Helm chart.**
   The `403` edge-block regex for `/(v1|generate|chat|upload|tools|health|auth)`
   is evaluated before prefix locations, so ~130 lines of proxy blocks for
   those same paths (plus legacy `/session/*` mocks and a `/images/` alias
   shadowed by the static-asset regex) were unreachable. All removed; behavior
   is unchanged and now legible. Added the chart's `location = /sw.js`
   no-cache rule — Compose previously let the generic static rule cache the
   service worker as `immutable` for a year, which the chart explicitly calls
   out as unsafe. The writer-less `generated_images` volume (already disabled
   by default in Helm) is no longer provisioned.

10. **Misleading docs/comments corrected.** Frontend README's chat-path
    description (backend pod is selected at submit, not by the worker; the
    browser always runs a safety-net poll; DELETE finalizes then flags),
    the adaptive-backoff comment (code is `1.1^(polls/10)` capped at 4×, not
    "double every 10 polls"), the Helm README's reference to a nonexistent
    `nfs-fix.sh`, and a stale cancel-path comment in `async.ts`.

## Dead code removed (all verified zero production references)

- `backend/tool-calling-responses-config.yaml` and its alias contract test.
- `isDocumentIngestionRequest` (`messagePreprocessing.ts`) — test-only; tests
  retargeted to the production entry point `getDocumentIngestJobRequest`.
- `isPolling` state + `clearPersistedJob` from `useAsyncChat`'s public return —
  no consumer; the state setter re-rendered `ChatView` per poll transition for
  a value nobody read.
- `max_reconnect_reached` event emission (`services/websocket.ts`) — zero
  listeners.
- `DAEDALUS_RAG_READINESS_ENABLED` shim (`front_end.py`, Helm allowlist).
- Dead store `final_answer_started = False` (`per_user_tool_calling.py`).
- `.env.template` keys read by nothing: `USAGE_TRACKING_INTERNAL_TOKEN`,
  `STREAM_ABORT_POLL_INTERVAL_MS`.
- Compose `generated_images` volume + mount; unreachable nginx location
  blocks and `/session/*` mocks (see item 9).

## Verification

- `tsc --noEmit` passes across the frontend (also proves the removed exports
  had no remaining references).
- The new `base:` policy-loader behavior was executed directly against the
  canonical config: overlay-equals-canonical, deep-merge override, circular
  rejection, and the pre-existing negative cases all pass. Equivalent pytest
  cases were added to `builder/tests/test_mcp_approval_gate.py`.
- `docker-compose.yaml` and the workflow config parse; the nginx conf is
  brace-balanced. Run `nginx -t` / `docker compose config` locally to confirm.
- Vitest and pytest could not be executed in the review sandbox (macOS-native
  `node_modules`; PyPI blocked). Run locally:
  `cd frontend && npm test` and `cd builder && pytest tests/`.

## Known issues intentionally not changed (ranked)

These are real findings from the review that need product decisions or larger
refactors; none block chat today.

1. **Per-user MCP auth failures poison process-global capability state**
   (`mcp_patches.py`: `_skipped_function_groups` et al.). One user's
   unauthorized Gmail/Calendar/Docs group marks the capability unavailable for
   every user on the pod, degrades `/health/ready`, and recovery is one-shot
   per process. Needs per-user scoping of skip/recovery state.
2. **Synchronous CPU on the event loop in the chat path**
   (`tool_output_compaction.py`, `tool_output_retriever.py`): multi-MB
   `json.dumps`/`sha256`/`zlib` runs stall all users' streams; memoization
   (added previously) removes repeat cost only. Offload to a thread or bound
   `tool_output_compaction_max_original_chars` (currently 4,000,000).
3. **Timeout-budget ladder**: LLM retries (60 s × 4) and
   `visual_media_tool` (300 s) meet or exceed the frontend's 300 s silent-read
   abort. Either raise `STREAM_READ_IDLE_TIMEOUT_MS` or emit keepalive
   progress from the backend during long tool calls.
4. **WS subscribe race**: `subscribe_job`/`subscribe_chat` sent in `onopen`
   can be dropped server-side before listeners attach; there is no ack in the
   protocol, so the turn silently degrades to the 15 s safety poll. Add a
   subscribe ack + client retry.
5. **Backend pod pinning is split-brain**: the submit route probes and pins,
   but the stream worker (a different process) opens the connection; each
   process keeps its own pin. Consider moving selection into the worker and
   dropping the probe from the submit hot path.
6. **`/health/ready` cost**: with `DAEDALUS_RAG_READINESS_MODE=degraded` and
   required collections configured, every 10 s probe performs real Milvus
   metadata calls on the request loop with no caching.
7. **Compose Redis ACL contradicts its own comment**: the init command grants
   `default on nopass ~* &* +@all` (published on loopback) while the comment
   claims the default user is reset; the Helm init locks it down. Align
   Compose with the chart or fix the comment.
8. **Duplicate sources of truth** to consolidate over time: workflow prompt
   guidance duplicated between `autonomous_agent/prompt.py` and the workflow
   YAML (test-enforced); `DOCUMENT_INGEST_*` env defaults duplicating
   `user_document_tool` config; Milvus credential precedence derived in two
   modules; three divergent copies of the job/event TypeScript types; two
   `getStreamingStates` implementations; nginx security headers present only
   in Compose and HSTS absent from the chart (the TLS deployment).
9. **Ingress vs. in-pod TLS**: `custom-values.yaml` enables the nginx HTTPS
   listener and NodePort 30443, but the Ingress routes to the plaintext port
   and terminates TLS itself with the same secret — one of the two paths is
   vestigial.
10. **nginx/frontend readiness coupling** (Helm): both probe
    `/api/health?ready=1`, so a 1 s Redis stall empties both endpoint pools at
    once; nginx readiness should use an nginx-local target.
