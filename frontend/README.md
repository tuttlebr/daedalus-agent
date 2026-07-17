# Daedalus Frontend

Next.js 15 frontend for Daedalus. It owns authentication, browser chat
orchestration, multimodal uploads, conversation persistence, real-time updates,
and PWA behavior on top of the NeMo Agent Toolkit backend.

## What It Does

- Renders chat, conversation history, settings, Create, Autonomy, and help
- Derives user identity from Redis-backed sessions and a signed identity cookie
- Enqueues chat and document-ingest jobs on a durable Redis Stream
- Runs backend streams in a dedicated worker with leases, heartbeats,
  cancellation, bounded reclaim, and graceful drain
- Publishes live tokens and status through Redis Pub/Sub and a WebSocket
  sidecar, with authenticated HTTP polling as recovery
- Streams document bytes through multipart upload into S3-compatible object
  storage while keeping only owner-scoped metadata and object references in
  Redis
- Retrieves authenticated Milvus collection metadata from the backend instead
  of deriving collection names in browser-facing code
- Runs as a PWA with an offline shell and interrupted-job recovery

## Runtime Model

The production frontend image serves three roles:

1. The frontend deployment runs the Next.js standalone server on port `3000`
   and the WebSocket sidecar on port `3001` through
   `scripts/start-runtime.js`.
2. The separate frontend stream-worker deployment runs `stream-worker.js` from
   the same image.
3. nginx proxies `/` and `/api/*` to Next.js and `/ws` to the WebSocket
   sidecar.

The normal chat path is:

1. `POST /api/chat/async` authenticates the caller, validates and bounds the
   request, writes job state, and appends the job ID to a Redis Stream.
2. The dedicated worker claims the entry, acquires a per-job lease, selects a
   backend pod, and opens `/v1/chat/completions` or the document-ingest stream.
3. The worker persists status and publishes live events. The browser consumes
   WebSocket events and polls `GET /api/chat/async?jobId=...` whenever the live
   channel is unavailable or stale.
4. `DELETE /api/chat/async?jobId=...` records a durable cancellation flag that
   the worker observes even when the API and worker run in different pods.

If a worker dies before backend execution starts, another worker may reclaim
the entry. If it dies after backend execution starts, the replacement fails the
job closed instead of replaying potentially mutating tools.

The Create image path is independently job-based:

- `POST /api/images/jobs` accepts a generate or edit request and returns a
  `jobId`
- `GET /api/images/jobs?jobId=...` returns progress, partial images, output IDs,
  and errors
- `/api/images/history` persists restorable jobs and can purge unreferenced
  generated assets when requested
- `/api/generated-image/:id?download=1` streams an authorized original asset

## Development

Use Node.js 22.

```bash
npm ci --legacy-peer-deps
npm run dev
npm run lint
npx tsc --noEmit --incremental false
npm run coverage
npm run build
npm run e2e
```

`npm run dev` starts only Next.js on port `5000`. It does not start Redis, the
backend, object storage, the WebSocket sidecar, or the durable stream worker.
Use the root Compose stack for an integrated local environment. The E2E command
builds the production frontend and starts isolated Redis, SeaweedFS, mock
backend, stream worker, WebSocket, and Next.js processes automatically.

## Important Environment Variables

The frontend reads runtime settings from environment variables and Kubernetes
Secrets. Browser-visible `NEXT_PUBLIC_*` limits are compiled into the bundle.

| Variable                                                | Purpose                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| `REDIS_URL`                                             | Sessions, conversations, attachment metadata, queue, leases, and job state  |
| `BACKEND_HOST`, `BACKEND_NAMESPACE`, `BACKEND_API_PATH` | In-cluster backend routing                                                  |
| `DAEDALUS_INTERNAL_API_TOKEN`                           | Trusted frontend and worker calls to the backend                            |
| `SESSION_SECRET`                                        | Signed identity cookies, required in production                             |
| `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_USER_*_*`       | Single-user or multi-user login entries                                     |
| `NEXT_PUBLIC_UPLOAD_*`                                  | Build-time browser upload and batch limits                                  |
| `DOCUMENT_UPLOAD_MAX_MB`                                | Raw multipart document limit, capped at 200 MiB                             |
| `DOCUMENT_UPLOAD_MAX_CONCURRENT_PER_USER`               | Atomic in-progress document upload slots, default `2`                       |
| `DOCUMENT_OBJECT_*`                                     | S3-compatible endpoint, credentials, bucket, prefix, and retention contract |
| `STREAM_WORKER_*`                                       | Worker concurrency, lease, heartbeat, reclaim, drain, and probe tuning      |
| `NEXT_PUBLIC_WEBSOCKET_URL`, `WS_*`                     | Browser WebSocket endpoint and sidecar bounds                               |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`     | Optional browser push notifications                                         |

Default browser file bounds are 7.5 MiB per image, 75 MiB per video, 200 MiB
per document, and 10 MiB per transcript. Image and video bounds reserve room
for their legacy base64 transport. Documents use raw multipart bytes. Server
routes enforce their own decoded or raw limits, so changing a public limit also
requires checking the corresponding API and proxy limit.

Document objects are temporary. Configure the selected bucket with lifecycle
expiration for `DOCUMENT_OBJECT_PREFIX` whose retention matches
`DOCUMENT_OBJECT_EXPIRY_SECONDS`, which defaults to seven days. Redis metadata
and object metadata carry the same expiry, but bucket lifecycle is the
authoritative cleanup for orphaned objects.

Local Compose uses the pinned SeaweedFS S3 endpoint at `object-store:8333` and
applies the seven-day prefix TTL during startup. Production stays
provider-neutral through `DOCUMENT_OBJECT_*`.

See [`../.env.template`](../.env.template), [`env.example`](env.example), and
the top-level [`../README.md`](../README.md) for the complete deployment setup.

## Key Areas

| Path                                   | Responsibility                                                      |
| -------------------------------------- | ------------------------------------------------------------------- |
| `pages/api/chat/async.ts`              | Authenticated submission, status polling, and cancellation          |
| `server/chat/streamQueue.ts`           | Redis Stream enqueue, claim, lease, and acknowledgement primitives  |
| `server/chat/streamWorker.ts`          | Durable execution, reclaim policy, cancellation, and drain          |
| `server/chat/streamReader.ts`          | Bounded backend stream parsing and live-event persistence           |
| `server/chat/streamState.ts`           | Append-only response deltas and normalized intermediate-step state  |
| `server/documentObjectStore.ts`        | Signed S3-compatible object operations                              |
| `server/multipartDocument.ts`          | Bounded streaming multipart parser                                  |
| `pages/api/session/documentStorage.ts` | Owner-scoped document upload, retrieval, and deletion               |
| `server/milvusMetadata.ts`             | Authenticated and schema-validated collection metadata client       |
| `pages/api/milvus/collections.ts`      | Session-protected metadata API for the browser                      |
| `server/autonomy/store.ts`             | Redis-backed autonomous-agent state                                 |
| `ws-server.ts`                         | Authenticated Redis Pub/Sub to WebSocket sidecar                    |
| `hooks/useAsyncChat.ts`                | Browser job lifecycle, live subscription, polling, and recovery     |
| `e2e/`                                 | Production-build browser harness with real Redis and object storage |

## Testing And Verification

- `npm test -- --run` runs Vitest once
- `npm run coverage` runs the instrumented suite and enforces regression gates
- `npm run lint` runs Next.js ESLint checks
- `npx tsc --noEmit --incremental false` runs a clean type check
- `npm run build` produces the standalone production bundle and injects the PWA
  precache manifest
- `npm run e2e` runs login, streaming, cancellation, multipart upload, approval,
  WebSocket outage, and disconnect-recovery flows in Chromium

The E2E runner removes its Compose services and volumes unless
`E2E_KEEP_SERVICES=1` is set. Set `E2E_SKIP_BUILD=1` only when the production
artifacts are already current.

## Related Docs

- [`../README.md`](../README.md) for full-stack setup and deployment
- [`pages/api/milvus/README.md`](pages/api/milvus/README.md) for the collection
  metadata trust boundary
