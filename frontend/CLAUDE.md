# CLAUDE.md

This file gives implementation guidance for the `frontend/` package in the
Daedalus monorepo. It is a Next.js 15 Pages Router application that owns login,
chat submission and recovery, multimodal uploads, conversation persistence,
real-time fanout, and PWA behavior. Python backend code lives in `../builder/`,
runtime workflow config in `../backend/`, and Kubernetes packaging in
`../helm/`.

## Commands

Use Node.js 22. The repository's `.npmrc` enables legacy peer dependency
resolution, and CI passes the option explicitly.

```bash
npm ci --legacy-peer-deps
npm run dev
npm run lint
npx tsc --noEmit --incremental false
npm test -- --run
npm run coverage
npm run build
npm run e2e
```

Focused Vitest examples:

```bash
npm test -- --run __tests__/server/chat/streamWorker.test.ts
npm test -- -t "rejects expired"
```

CI runs lint, a clean type check, coverage gates, a production build, and a
separate real-browser E2E job.

## Production Roles

The production image contains three entry points:

- `scripts/start-runtime.js` supervises the Next.js standalone server
  (`server.js`, port `3000`) and WebSocket sidecar (`ws-server.js`, port `3001`)
  in the frontend deployment.
- `stream-worker.js` runs in a separate Kubernetes deployment from the same
  image. It must not be added to `start-runtime.js` because the worker has its
  own replica count, probes, drain policy, and disruption budget.
- nginx sends `/` and `/api/*` to Next.js and `/ws` to the WebSocket sidecar.

`npm run dev` starts only Next.js on port `5000`. Use root Compose for the full
local stack or `npm run e2e` for the isolated production-build harness.

## Durable Chat Execution

`pages/api/chat/async.ts` is the authenticated HTTP boundary:

- `POST` validates the request, writes owner-scoped job state and payload, then
  appends the job ID to the Redis Stream in `server/chat/streamQueue.ts`.
- `GET` returns sanitized live or terminal state for the job owner.
- `DELETE` records a durable abort flag and claims terminal state atomically.

`server/chat/streamWorker.ts` owns backend execution. It uses a Redis consumer
group, per-job ownership leases, heartbeats, bounded concurrency, cancellation
polling, stale-entry reclaim, and graceful drain. A reclaimed entry is safe to
retry only before the backend-start marker exists. After that marker, the
worker fails the job closed because backend tool execution is not resumable.

`server/chat/streamReader.ts` parses the pinned backend stream.
`server/chat/streamState.ts` appends only new response bytes and intermediate
steps, so live progress doesn't rewrite a growing JSON document on every
flush. Live events are published through Redis Pub/Sub to the WebSocket
sidecar. `hooks/useAsyncChat.ts` owns subscription, polling fallback, idle
detection, cancellation, and reload recovery in the browser.

## Redis Boundaries

`server/session/redis.ts` is the central client. Redis stores sessions,
conversations, attachment metadata, async job state, queue entries, leases,
autonomy state, and Pub/Sub events. It supports RedisJSON with a compatibility
fallback, dedicated subscribers, bounded command retries, IPv4-first DNS, and
throttled error logging.

Keep server helpers outside `pages/api`. The route-inventory test requires each
TypeScript file under `pages/api` to default-export a route handler.

## Documents And Collection Metadata

New document uploads are authenticated multipart streams. The API parses a
single bounded file with `server/multipartDocument.ts`, writes it to the
configured S3-compatible store through `server/documentObjectStore.ts`, and
keeps only owner-scoped metadata and an immutable object reference in Redis.
Legacy base64 records are read-only compatibility data.

`server/milvusMetadata.ts` calls the backend's authenticated
`/v1/metadata/collections` endpoint with the trusted internal token and user
identity. It validates the returned schema and rejects shared collections as
writable targets. `pages/api/milvus/collections.ts` exposes that metadata to an
authenticated browser session with `Cache-Control: private, no-store` and
returns `503` when the backend source of truth is unavailable.

## Conventions And Guardrails

- `@/*` maps to the frontend root in TypeScript and Vitest.
- TypeScript is strict and production builds don't ignore type errors.
- Anything under `server/` is server-only and must not enter client bundles.
- Trusted backend calls use `DAEDALUS_INTERNAL_API_TOKEN` through
  `utils/server/backendAuth.ts`. Never accept user identity from a request body
  when a session-derived value exists.
- Upload limits are split by transport. Documents are raw multipart bytes;
  images and videos still reserve room for base64 encoding. Keep browser,
  route, nginx, and object-store limits consistent.
- `next.config.js` sets a 15-minute proxy timeout for long document operations.
  Individual routes own their body limits. There is no global 300 MB parser.
- Security headers are defined in `next.config.js`. Mermaid currently requires
  `unsafe-eval`, and Next.js and styled-jsx require `unsafe-inline`.
- Prettier enforces single quotes, trailing commas, import ordering, and
  Tailwind class sorting.

## Coverage And E2E

`vitest.config.ts` instruments the broad frontend surface plus the critical
durable-chat, object-store, multipart, Milvus-metadata, and conversation-state
modules. Its thresholds are measured regression gates, not an aspirational
80 percent claim. CI runs `npm run coverage` and fails when they regress.

The E2E harness builds the production app and bundles the WebSocket sidecar and
stream worker. It starts isolated Redis and SeaweedFS containers, plus a
deterministic trusted-context mock backend. The Chromium suite covers login,
streaming, cancellation, byte-for-byte multipart storage, redacted approval
denial, WebSocket-unavailable polling, and live-disconnect recovery.
