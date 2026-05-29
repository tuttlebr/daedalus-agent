# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is the **Next.js 14 frontend** (`frontend/`) of the larger `daedalus-agent` monorepo. It handles auth, chat orchestration, multimodal uploads, conversation persistence, real-time sync, and PWA behavior on top of the NeMo Agent (NAT) backends. The Python backend lives in `../builder/`, runtime backend config in `../backend/`, Helm in `../helm/`. See `../AGENTS.md` for repo-wide guidelines and `README.md` for the full feature/env reference.

## Commands

Use **Node.js 22**. `legacy-peer-deps` is set in `.npmrc`, but install scripts still pass it explicitly.

```bash
npm ci --legacy-peer-deps        # install
npm run dev                      # dev server on port 5000 (Next.js only — see runtime note)
npm run build                    # next build + scripts/inject-precache.js (PWA precache manifest)
npm run lint                     # next lint (eslint)
npm run format                   # prettier --write .

npm test                         # vitest watch mode
npm test -- --run                # run suite once (CI)
npm test -- --run __tests__/utils/app/backendApi.test.ts   # single file
npm test -- -t "rejects expired"                            # single test by name
npm run coverage                 # vitest run --coverage (80% thresholds configured in vitest.config.ts; NOT run by CI/Makefile)
npm run analyze                  # ANALYZE=true next build (bundle analyzer)
```

Validation gate before committing (from `../AGENTS.md`): `npm run lint && npm test -- --run && npm run build`.

## Architecture

### Dual-process runtime

In production the container runs **two Node processes** via `scripts/start-runtime.js`:

- **Next.js** standalone (`server.js`, port 3000)
- **WebSocket sidecar** (`ws-server.js`, port 3001) — bundled from `ws-server.ts` by esbuild at build time

The wrapper exits the container if **either** process dies. `npm run dev` starts only Next.js; without the sidecar, real-time updates fall back to HTTP polling. nginx proxies `/` and `/api/*` to Next.js and `/ws` to the sidecar.

### Redis is the backbone

`server/session/redis.ts` is the central client. Redis stores sessions, conversations, attachments, async-job state, streaming state, autonomy state, and powers Pub/Sub fanout. Notable: IPv4-first DNS + a DNS cache (`server/session/dns-cache.ts`) to survive Kubernetes CoreDNS stalls, RedisJSON capability detection, dedicated pub/sub clients, and throttled error logging. Bounded retries/timeouts prevent API requests from hanging on Redis outages.

### Async job chat model (the primary path)

`pages/api/chat/async.ts` (~2900 lines) is the core orchestrator:

- `POST /api/chat/async` — stores job metadata, returns a `jobId` immediately, then opens a pinned backend stream (`/v1/chat/completions` for chat, `/v1/documents/ingest/stream` for document ingest) and persists tokens/intermediate-steps/status to Redis.
- `GET /api/chat/async?jobId=...` — returns live or finalized job state (polling fallback).
- Client side: `hooks/useAsyncChat.ts` owns job lifecycle, WebSocket subscription, polling fallback, and recovery of jobs interrupted by reload/offline.
- The legacy synchronous `pages/api/chat.ts` route is retired and returns **HTTP 410**.

### Real-time fanout

Backend tokens → Redis Pub/Sub → WS sidecar → browser, with HTTP polling fallback. Client transport is the `WebSocketManager` singleton in `services/websocket.ts`, surfaced via `hooks/useWebSocket.ts`.

### Backend routing

`utils/app/backendApi.ts` is the single source of truth for backend URLs. In Kubernetes it builds FQDNs like `{BACKEND_HOST}-default.{BACKEND_NAMESPACE}.svc.cluster.local`, supports per-pod discovery for pinned streams, and adapts payloads across NAT API formats (`/v1/chat/completions`, `/chat`, `/generate`). Trusted frontend→backend calls attach `DAEDALUS_INTERNAL_API_TOKEN` via `utils/server/backendAuth.ts`.

### Client state

Zustand stores in `state/` (`conversationStore`, `uiSettingsStore`, `imagePanelStore`), re-exported from `state/index.ts` with selectors and convenience hooks — import from `@/state`. Anything under `server/` is server-only and must never be imported into client bundles.

## Conventions & gotchas

- **`pages/api` route-inventory rule** (enforced by `__tests__/pages/api/routeInventory.test.ts`): every `.ts`/`.tsx` file under `pages/api` must `export default` a route handler. Shared server helpers must **not** live under `pages/api` — put them in `server/` (this is why `server/session/` exists alongside `pages/api/session/`).
- **Path alias** `@/*` maps to the frontend root (configured in both `tsconfig.json` and `vitest.config.ts`).
- **Strict TypeScript**; `next.config.js` sets `ignoreBuildErrors: false`, so the production build fails on any TS error.
- **Import ordering** is enforced by Prettier (`prettier.config.js`): react → next → hooks → services → utils → types → pages → components → relative, with blank-line separation. Single quotes, trailing commas (`all`), Tailwind class sorting.
- **Coverage thresholds** are 80% (lines/functions/branches/statements) over `utils`, `components`, `services`, `hooks`, `pages/api` — but only when you run `npm run coverage`. CI and `make frontend` run `npm test -- --run` (no `--coverage`), so the thresholds are **not** an enforced merge gate, and `server/**` is outside the coverage scope. Wiring coverage into CI is a follow-up decision (it currently won't pass because components/hooks are untested by design).
- **Tests** mirror source under `__tests__/` and are named `*.test.ts(x)`. `@testing-library/react` is **not** installed — hooks are tested through their delegated singletons/types, not `renderHook`.
- **Large uploads**: `next.config.js` sets bodyParser/serverActions to 300mb and `proxyTimeout` to 15 min; chat/document routes set `maxDuration: 900` — these must stay aligned with nginx timeouts.
- **CSP / security headers** are defined in `next.config.js` (`'unsafe-eval'` is required by mermaid.js diagram rendering; `'unsafe-inline'` by Next.js/styled-jsx).
- Runtime config comes from env vars / K8s secrets — see the table in `README.md` and `env.example`. `SESSION_SECRET` is required in production.
