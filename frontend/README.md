# Daedalus Frontend

Next.js 14 frontend for Daedalus. This app handles authentication, chat orchestration, multimodal uploads, conversation persistence, real-time sync, and PWA behavior on top of the NeMo Agent backends.

## What It Does

- Renders the chat UI, conversation sidebar, settings, Autonomy dashboard, and in-app help
- Authenticates users and keeps identity in Redis-backed sessions plus a signed identity cookie
- Submits chat primarily through `/api/chat/async`, which creates a frontend-managed job, opens a pinned backend stream, and returns a `jobId`
- Persists conversations, attachments, generated images, selected conversation state, and async job state in Redis
- Streams progress and intermediate steps back to clients through Redis Pub/Sub plus the WebSocket sidecar, with HTTP polling fallback
- Supports multimodal uploads for images, documents, videos, and transcripts
- Runs as a PWA with install prompts, offline shell support, and recovery of interrupted background jobs

## Runtime Model

In Kubernetes, the normal browser request path is:

1. Browser sends requests to nginx through the cluster ingress.
2. nginx proxies `/` and `/api/*` to this Next.js app.
3. The frontend authenticates the user, stores or reads session and conversation state from Redis, and submits work to the selected backend service.
4. Backend tokens, intermediate steps, and job status are persisted back through Redis and fanned out to clients over WebSocket or polling.

The primary chat path is frontend job-based:

- `POST /api/chat/async` stores job metadata and immediately returns a `jobId`
- `GET /api/chat/async?jobId=...` returns live or finalized job state
- A background stream reader opens `/v1/chat/completions` for normal chat turns
- Document ingestion opens `/v1/documents/ingest/stream` and forwards structured progress through job state
- NAT `/v1/workflow/async` remains only as a legacy document-ingest fallback
- The legacy `/api/chat` route is retired and returns HTTP 410

## Development

```bash
node --version # use Node.js 22
npm ci --legacy-peer-deps
npm run dev
npm run build
npm test -- --run
npm run coverage
npm run lint
npm run format
```

Default local dev port is `5000`.

## Important Environment Variables

The frontend consumes most of its runtime configuration through environment variables or Kubernetes secrets.

| Variable                                            | Purpose                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `REDIS_URL`                                         | Redis session, conversation, attachment, and job-state storage          |
| `BACKEND_HOST`                                      | Host-only backend service name used for in-cluster routing              |
| `BACKEND_NAMESPACE`                                 | Namespace used to build backend FQDNs                                   |
| `BACKEND_API_PATH`                                  | Default backend path for generated URLs, usually `/v1/chat/completions` |
| `NEXT_PUBLIC_HTTP_CHAT_COMPLETION_URL`              | Optional explicit backend URL override                                  |
| `NEXT_PUBLIC_UPLOAD_*`                              | Build-time upload validation limits for browser-side file checks        |
| `DAEDALUS_DIRECT_DOCUMENT_INGEST_STREAM`            | Set to `0` only to force legacy NAT async document ingestion            |
| `SESSION_SECRET`                                    | Required in production for signed identity cookies                      |
| `DAEDALUS_INTERNAL_API_TOKEN`                       | Shared token attached to trusted frontend-to-backend requests           |
| `AUTH_USERNAME`, `AUTH_PASSWORD`                    | Single-user auth                                                        |
| `AUTH_USER_*_*`                                     | Multi-user auth entries                                                 |
| `DAEDALUS_DEFAULT_USER`                             | Default selected user for initial login experience                      |
| `ADMIN_USERNAME`                                    | Admin username allowed to inspect all usage stats                       |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Optional web-push support                                               |

See [`../.env.template`](../.env.template), [`env.example`](env.example), and the top-level [`../README.md`](../README.md) for deployment setup.

## Key Areas

| Path                          | Responsibility                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `pages/api/chat.ts`           | Legacy direct streaming route that returns 410; async chat is the supported path |
| `pages/api/chat/async.ts`     | Async job submission, status polling, stream capture, finalization               |
| `pages/api/autonomy/`         | Autonomy dashboard API (config, goals, runs, feed items, approvals)              |
| `pages/api/conversations/`    | Conversation CRUD and persistence                                                |
| `pages/api/document/`         | Document upload, lookup, and ingestion progress                                  |
| `pages/api/session/`          | Session and attachment API routes                                                |
| `pages/api/sync/notify.ts`    | Best-effort cross-session sync notification publisher                            |
| `server/autonomy/store.ts`    | Redis-backed autonomous agent state store                                        |
| `server/session/`             | Redis, session, sanitization, and documentRef validation helpers                 |
| `ws-server.ts`                | WebSocket sidecar backed by Redis Pub/Sub                                        |
| `components/chat/`            | Main chat UI, async job integration, intermediate step rendering                 |
| `components/autonomy/`        | Autonomy dashboard UI                                                            |
| `hooks/useAsyncChat.ts`       | Job lifecycle, polling, WebSocket subscription, recovery                         |
| `hooks/useWebSocket.ts`       | WebSocket sync and token delivery                                                |
| `utils/app/`                  | Backend URL building, attachment helpers, conversation utilities                 |

## Major Features

- Async job execution with resumable status tracking
- WebSocket-first real-time updates with polling fallback
- Intermediate step visualization for backend tool execution
- Redis-backed authentication and conversation sync across devices
- Upload and rendering support for images, documents, videos, and generated media
- Document processing workflows that hand off uploaded files to backend tools
- Autonomy dashboard wired to the autonomous worker through Redis
- PWA install flow, offline shell, and interrupted-stream recovery
- Usage tracking, push subscription endpoints, and conversation import and export

## Testing And Verification

- `npm run test` runs Vitest in watch mode
- `npm test -- --run` runs the suite once (used by CI)
- `npm run coverage` runs the test suite with coverage
- `npm run lint` runs Next.js linting
- `npm run build` produces the production bundle and injects the precache manifest

## Related Docs

- [`../README.md`](../README.md) for full-stack setup and deployment
- [`pages/api/milvus/README.md`](pages/api/milvus/README.md) for the current Milvus collection helper status
