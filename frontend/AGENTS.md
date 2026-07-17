# Repository Guidelines

## Project Structure

This is the Next.js 15 TypeScript frontend for Daedalus. Pages and API handlers
live in `pages/`. Reusable UI is grouped by domain in `components/`, browser
hooks in `hooks/`, Zustand stores in `state/`, shared application utilities in
`utils/app/`, and server-only helpers in `server/`. Tests mirror source areas
under `__tests__/`. Production browser tests and their isolated Compose harness
live in `e2e/`.

The frontend image has separate runtime roles. The frontend deployment starts
Next.js and the WebSocket sidecar through `scripts/start-runtime.js`. A distinct
stream-worker deployment starts `stream-worker.js` from the same image and
consumes durable Redis Stream entries. Keep worker lifecycle and execution out
of API request handlers.

## Build, Test, And Development Commands

Use Node.js 22 and install with:

```bash
npm ci --legacy-peer-deps
```

- `npm run dev` starts only Next.js on port `5000`.
- `npm run lint` runs Next.js ESLint checks.
- `npx tsc --noEmit --incremental false` performs a clean type check.
- `npm test -- --run` runs Vitest once. `npm test` starts watch mode.
- `npm run coverage` runs Vitest with enforced V8 coverage gates.
- `npm run build` builds the production app and injects the PWA precache
  manifest.
- `npm run e2e` builds production artifacts, starts isolated dependencies, and
  runs the Playwright Chromium suite.
- `npm run format` formats the package with Prettier.

## Coding Style And Boundaries

Write TypeScript and React with 2-space indentation, single quotes, trailing
commas, and semicolons as produced by Prettier. Use PascalCase for components
and camelCase for hooks and utilities.

Every TypeScript file under `pages/api` must default-export a route handler.
Place shared request logic in `server/`, not under `pages/api`. Never import a
server-only module into a browser bundle.

The `/api/chat/async` route authenticates and enqueues work. Backend streams
belong to `server/chat/streamWorker.ts`. Preserve the queue lease, heartbeat,
backend-start marker, cancellation, and fail-closed reclaim rules when changing
this path.

Document bytes belong in S3-compatible object storage, not Redis or JSON request
bodies. Store only owner-scoped references and metadata. Collection names come
from the authenticated backend metadata endpoint and must not be reconstructed
from a browser-controlled username.

## Testing Guidelines

Place tests under `__tests__/` using the source path as a guide. Add focused unit
tests for normal and failure paths. Use the real-Redis integration test for
consumer-group, reclaim, or lease behavior that mocks can't prove. Use the E2E
harness for user-visible login, streaming, cancellation, upload, approval, and
transport-recovery changes.

Coverage includes the broad frontend surface, all `server/chat` modules, and
explicit critical object-store, multipart, collection-metadata, and
conversation-state files. Thresholds in `vitest.config.ts` are CI regression
gates. Don't lower them to land a change.

## Pull Request And Security Guidance

Keep commits scoped. Pull requests should explain behavior changes and list the
commands run. Include screenshots or recordings for visual changes. Call out
changes to environment variables, auth, Redis state, WebSocket behavior, PWA
caching, upload limits, or object-store retention.

Don't commit secrets. Production values such as `SESSION_SECRET`, Redis
credentials, internal backend tokens, object-store credentials, and login
passwords must come from environment variables or deployment Secrets. Derive
identity and ownership from the authenticated session, and keep trusted backend
headers server-side.
