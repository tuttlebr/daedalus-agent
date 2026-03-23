# Software Requirements Document: Daedalus Frontend

**Version:** 1.0
**Date:** 2026-03-15
**Audience:** Engineering Lead + implementing engineers
**Status:** Draft

---

## 1. Purpose

This document specifies the requirements for the Daedalus frontend — a chat-oriented progressive web app that serves as the primary user interface for a NeMo Agent Toolkit (NAT) application. The frontend must support multimodal input (images, documents, video), render agent-generated images, synchronize all state across devices via Redis, stream responses over WebSocket, and run efficiently on both phones and desktops.

This SRD is intended to be broken apart by an engineering lead and distributed to individual engineers or teams. Each numbered section maps to a discrete work area that can be assigned independently, with cross-cutting concerns called out explicitly.

---

## 2. System Context

### 2.1 Existing Architecture

```
┌──────────┐     ┌───────┐     ┌──────────┐     ┌──────────────────────┐
│  Client   │────▶│ NGINX │────▶│ Next.js  │────▶│ NAT Backend(s)       │
│  (PWA)    │◀────│       │◀────│ :5000    │     │  - tool-calling :8000│
│           │     │       │     │ WS :3001 │     │  - react-agent  :8001│
│           │     │       │     └────┬─────┘     └──────────────────────┘
│           │     └───────┘          │
│           │                   ┌────▼─────┐
│           │◀──── WebSocket ──▶│  Redis   │
│           │     (via NGINX)   │  Stack   │
│           │                   │ (JSON+   │
│           │                   │  Pub/Sub)│
│           │                   └──────────┘
└──────────┘
```

### 2.2 Existing Technology Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Framework | Next.js 14 (Pages Router) | Standalone output, port 5000 |
| UI | React 18, TypeScript, Tailwind CSS | Path alias `@/*` |
| State | React Context + Zustand | `home.context.tsx`, `home.state.tsx` |
| Realtime | WebSocket (primary), SSE (fallback) | WS sidecar on :3001 |
| Data | Redis Stack (RedisJSON + Pub/Sub) | `ioredis` client, user-scoped keys |
| PWA | Service Worker, Web App Manifest | LRU cache manager, offline fallback |
| Media processing | Sharp (server), client-side compression | Thumbnails, format detection |
| Testing | Vitest + coverage-v8 | Target >= 80% |

### 2.3 Existing Capabilities Already Implemented

The following are **already in the codebase** and should be extended, not rebuilt:

- **WebSocket manager** (`services/websocket.ts`): Singleton `WebSocketManager` class with ping/pong, exponential backoff, battery-aware reconnect, job subscriptions. NGINX proxies `/ws` to `:3001`.
- **SSE fallback** (`hooks/useRealtimeSync.ts`): Existing `EventSource`-based sync with identical callback signatures. Used as a fallback.
- **File uploads** (`hooks/useFileUpload.ts`, `constants/uploadLimits.ts`): Client-side validation up to 75MB images, 75MB video, 100MB documents. Base64 encoding with server-side limits at 100MB.
- **Image storage** (`pages/api/session/imageStorage.ts`): Redis-backed storage with Sharp processing, thumbnail generation, user-scoped keys, 7-day TTL.
- **Video storage** (`pages/api/session/videoStorage.ts`): Redis-backed storage with similar patterns.
- **Document storage** (`pages/api/session/documentStorage.ts`): Redis-backed with text extraction.
- **Async job processing** (`pages/api/chat/async.ts`): Background job execution with Redis-backed status, streaming state pub/sub, conversation persistence.
- **Session registry** (`hooks/useSessionRegistry.ts`): UUID-based sessions, visibility-aware heartbeats, `sendBeacon` for cleanup.
- **Background processing** (`hooks/useBackgroundProcessing.ts`): Wake Lock API, battery detection, IndexedDB streaming state recovery.
- **Service Worker** (`public/sw.js`): LRU cache manager with content-type-aware eviction, offline fallback, push notifications, background sync stub.
- **PWA manifest** (`public/manifest.json`): `display: standalone`, `orientation: any`, shortcuts, icons.
- **Conversation sync** (`hooks/useConversationSync.ts`): Hash-based change detection, debounced sync on visibility change.
- **Redis Pub/Sub** (`pages/api/session/redis.ts`): Dedicated publisher/subscriber clients, user-scoped channels, streaming state management.

---

## 3. Functional Requirements

### FR-1: Chat Interface

**Assignee profile:** Frontend engineer, React/TypeScript

| ID | Requirement | Acceptance Criteria |
|----|------------|-------------------|
| FR-1.1 | Single-page chat layout with message list and input area | Renders conversation history with user/assistant messages; input area is always visible |
| FR-1.2 | Message input supports plain text with Shift+Enter for newlines | Textarea auto-resizes; Enter sends; Shift+Enter inserts newline |
| FR-1.3 | Markdown rendering in assistant messages | Renders GFM including code blocks, tables, LaTeX, and embedded media |
| FR-1.4 | Conversation sidebar with create/rename/delete | Sidebar collapses on mobile; conversation list is scrollable; current conversation is highlighted |
| FR-1.5 | Agent intermediate steps are collapsible | Each step shows tool name, input/output; collapsed by default; expand on click |
| FR-1.6 | Error states display inline with retry option | Network, backend, and timeout errors render in-place with a "Retry" button |

**Existing code to extend:** `components/Chat/`, `components/Chatbar/`, `components/Markdown/`

### FR-2: Multimodal Upload (Images, Documents, Video)

**Assignee profile:** Full-stack engineer (client upload + server storage)

| ID | Requirement | Acceptance Criteria |
|----|------------|-------------------|
| FR-2.1 | Drag-and-drop zone on chat input | Visual drop indicator; accepted types: images (png/jpg/gif/webp/avif), documents (pdf/docx/pptx/html), video (mp4/flv/3gp) |
| FR-2.2 | File picker button in input area | Opens native file dialog; supports multi-select for images (up to 15) and documents (up to 100); single video at a time |
| FR-2.3 | Client-side validation before upload | Enforce limits from `constants/uploadLimits.ts`: 75MB images, 75MB video, 100MB documents. Show human-readable error on violation |
| FR-2.4 | Upload progress indicator | Per-file progress bar; cancel button; batch progress for multi-file uploads |
| FR-2.5 | Image preview thumbnails in message | Uploaded images display as clickable thumbnails in the message; full-size on click |
| FR-2.6 | Document attachment badge in message | Document uploads display as filename + type icon badge in the message |
| FR-2.7 | Video attachment with playback | Uploaded videos display as inline player; play/pause controls; poster frame from first frame |
| FR-2.8 | Paste from clipboard | Ctrl/Cmd+V pastes images directly into chat input as an attachment |

**Existing code to extend:** `hooks/useFileUpload.ts`, `pages/api/session/imageStorage.ts`, `pages/api/session/videoStorage.ts`, `pages/api/session/documentStorage.ts`

**Key constraint:** All media is stored in Redis (base64-encoded) with user-scoped keys. The `attachments` field in the `Message` type (`types/chat.ts`) already supports `imageRef`, `videoRef`, and `documentRef`. Uploads must populate these fields so the backend receives storage references, not raw data.

### FR-3: Agent-Generated Image Rendering

**Assignee profile:** Frontend engineer

| ID | Requirement | Acceptance Criteria |
|----|------------|-------------------|
| FR-3.1 | Detect and render base64 images in assistant responses | Images embedded as `![](data:image/...)` in markdown are intercepted and rendered as `<img>` |
| FR-3.2 | Replace base64 with Redis references server-side | `processMarkdownImages()` in `async.ts` extracts base64 images, stores in Redis, replaces with `/api/generated-image/{id}` URLs |
| FR-3.3 | Progressive image loading | Thumbnails load first (via `?thumbnail=true`); full image loads on expand/click |
| FR-3.4 | Image gallery for multi-image responses | When assistant returns 2+ images, render as a scrollable gallery with lightbox |
| FR-3.5 | Image download button | Each generated image has a download button; uses `file-saver` |

**Existing code to extend:** `components/Chat/OptimizedImage.tsx`, `components/Markdown/MarkdownRenderer.tsx`, `pages/api/generated-image/`

### FR-4: Cross-Device Session Synchronization

**Assignee profile:** Full-stack engineer (Redis + realtime)

| ID | Requirement | Acceptance Criteria |
|----|------------|-------------------|
| FR-4.1 | All conversations persist in Redis under user-scoped keys | `conversation:{id}` keys with 7-day TTL; authenticated users see same data on any device |
| FR-4.2 | Real-time sync of conversation changes across devices | Conversation create/update/delete on Device A reflects on Device B within 2 seconds via WebSocket |
| FR-4.3 | Streaming state visible on all devices | When Device A is streaming a response, Device B shows a "streaming" indicator on that conversation |
| FR-4.4 | Selected conversation syncs across devices | The active conversation tracks to the user, not the device; opening on one device updates others |
| FR-4.5 | Conflict resolution: last-write-wins | If two devices edit the same conversation concurrently, the most recent `updatedAt` wins |
| FR-4.6 | Session registry tracks active devices | Each device/tab registers via `useSessionRegistry`; stale sessions expire after missed heartbeats |

**Existing code to extend:** `pages/api/session/redis.ts` (pub/sub, streaming state), `hooks/useConversationSync.ts`, `hooks/useSessionRegistry.ts`, `pages/api/sync/stream.ts`

**Key data flow:**
1. Mutation happens (new message, conversation edit)
2. API route writes to Redis
3. API route publishes event on `user:{userId}:updates` channel
4. WebSocket sidecar (or SSE stream handler) forwards event to all connected clients for that user
5. Client hooks receive the event and update local state

### FR-5: WebSocket Streaming

**Assignee profile:** Full-stack engineer (WebSocket sidecar + client)

| ID | Requirement | Acceptance Criteria |
|----|------------|-------------------|
| FR-5.1 | Chat responses stream token-by-token over WebSocket | User sees incremental text as the backend generates it; no full-page reload |
| FR-5.2 | Intermediate steps stream in real time | Agent tool calls appear as collapsible step cards while the response is still generating |
| FR-5.3 | WebSocket is the primary transport; SSE is fallback | `useWebSocket` is used by default; if WS connection fails 3 times, fall back to `useRealtimeSync` SSE |
| FR-5.4 | Job subscription via WebSocket | Async jobs (FR-2 large uploads, deep thinker) push status updates through `subscribe_job` / `job_status` messages |
| FR-5.5 | Reconnection with exponential backoff + jitter | Base delay 1s, max 30s, 20% jitter, as implemented in `WebSocketManager.scheduleReconnect()` |
| FR-5.6 | Graceful degradation on connection loss | If disconnected mid-stream, the client polls `/api/chat/async?jobId=...` for the final result; partial response is preserved via `useBackgroundProcessing` |

**Existing code to extend:** `services/websocket.ts`, `hooks/useWebSocket.ts`, `hooks/useStreamingChat.ts`, `pages/api/chat/async.ts`

**NGINX config:** `/ws` location block already proxies to `:3001` with `Upgrade` headers and 1-hour read timeout.

### FR-6: Progressive Web App

**Assignee profile:** Frontend engineer, PWA expertise

| ID | Requirement | Acceptance Criteria |
|----|------------|-------------------|
| FR-6.1 | Installable on iOS, Android, and desktop | Manifest is valid; "Add to Home Screen" prompt works; app launches in standalone mode |
| FR-6.2 | Offline shell with cached conversations | App shell loads offline; cached conversations are readable; new messages queue for sync |
| FR-6.3 | Background sync for queued messages | Service worker `sync` event replays queued messages when connectivity restores |
| FR-6.4 | Push notifications for completed background jobs | When a deep thinker or long-running job completes while app is backgrounded, push notification fires |
| FR-6.5 | App shortcuts | "New Chat" shortcut available from home screen icon long-press |
| FR-6.6 | Service worker update flow | New SW version detected → toast prompts user to reload; `SKIP_WAITING` message triggers activation |

**Existing code to extend:** `public/sw.js`, `public/manifest.json`, `next.config.js` (PWA headers)

---

## 4. Non-Functional Requirements

### NFR-1: Performance ("Buttery Smooth")

| ID | Requirement | Target | Measurement |
|----|------------|--------|------------|
| NFR-1.1 | First Contentful Paint | < 1.5s on 4G | Lighthouse |
| NFR-1.2 | Time to Interactive | < 3s on 4G | Lighthouse |
| NFR-1.3 | Chat scroll at 60fps | No dropped frames during scroll with 500+ messages | Chrome DevTools Performance panel |
| NFR-1.4 | Input latency | < 50ms from keystroke to rendered character | Input event profiling |
| NFR-1.5 | Streaming render | < 16ms per token append (60fps frame budget) | Performance.now() instrumentation |
| NFR-1.6 | Bundle size | < 300KB gzipped initial load | `next build` + bundle analyzer |
| NFR-1.7 | Message list virtualization | Only visible messages + buffer rendered in DOM | `VirtualMessageList.tsx` already exists; must handle variable-height messages |
| NFR-1.8 | Image lazy loading | Images below the fold use `loading="lazy"` + IntersectionObserver | No images load until within 2 viewport heights |
| NFR-1.9 | Code splitting | Markdown renderer, Chart.js, syntax highlighter are lazy-loaded | `LazyCodeBlock.tsx`, `LazyChart.tsx` already exist; extend to all heavy components |

**Implementation guidance:**
- Use `React.memo` and `useMemo` aggressively for message components — messages are immutable once received.
- Debounce textarea resize calculations.
- Use `will-change: transform` on scrolling containers; avoid layout thrashing during streaming.
- `modularizeImports` in `next.config.js` already tree-shakes `@tabler/icons-react`, `lucide-react`, `lodash`.

### NFR-2: Power Efficiency

| ID | Requirement | Target | Measurement |
|----|------------|--------|------------|
| NFR-2.1 | Background tab disconnects WebSocket when not streaming | WS closes within 5s of `visibilitychange` to `hidden` | Console logs from `useWebSocket.ts` |
| NFR-2.2 | Battery-aware reconnect policy | < 20% battery → delay reconnect to 60s; < 10% → stop auto-reconnect entirely | Battery API checks in `WebSocketManager.scheduleReconnect()` |
| NFR-2.3 | Wake Lock only during active streaming | Wake Lock acquired on stream start, released on stream end; 5-minute safety timeout | `useBackgroundProcessing.ts` reference-counted wake lock |
| NFR-2.4 | Visibility-aware heartbeats | Session heartbeats pause when backgrounded; double interval on mobile | `useSessionRegistry.ts` already uses `createVisibilityAwareInterval` |
| NFR-2.5 | Service Worker cleanup frequency | Memory pressure check every 5 min (not 1); periodic cleanup every 4 hours (not 1) | `sw.js` intervals already adjusted |
| NFR-2.6 | No unnecessary re-renders | Message list does not re-render when typing in input; sidebar does not re-render on message append | React Profiler flamegraph |

**Implementation guidance:**
- Use `document.visibilityState` as the single source of truth for background detection.
- Page Visibility API controls all timers, not just WebSocket.
- The Battery API (`navigator.getBattery()`) is used by both `WebSocketManager` and `useBackgroundProcessing`; consider a shared `useBattery` hook to avoid duplicate API calls.

### NFR-3: Responsive Design (Phone + Desktop)

| ID | Requirement | Target |
|----|------------|--------|
| NFR-3.1 | Mobile breakpoint | `< 768px`: sidebar hidden by default; full-width chat; bottom-anchored input |
| NFR-3.2 | Desktop breakpoint | `>= 768px`: sidebar visible; chat area fills remaining width; input area centered with max-width |
| NFR-3.3 | Tablet | `768px–1024px`: sidebar collapsible; chat fills available width |
| NFR-3.4 | Safe area insets | Respect `env(safe-area-inset-*)` for notched devices |
| NFR-3.5 | Orientation changes | Layout adjusts without content loss; `useOrientation.ts` hook already exists |
| NFR-3.6 | Virtual keyboard handling | Input area stays visible above virtual keyboard; `useVisualViewport.ts` already handles this |
| NFR-3.7 | Touch targets | All interactive elements >= 44x44px on mobile |
| NFR-3.8 | Font scaling | Respect system font size preferences; no fixed `px` for body text |

**Implementation guidance:**
- Tailwind responsive prefixes (`sm:`, `md:`, `lg:`) for layout.
- `useVisualViewport` hook already handles iOS virtual keyboard avoidance.
- Test on Safari iOS (keyboard behavior), Chrome Android, and desktop Chrome/Firefox/Safari.

### NFR-4: Security

| ID | Requirement |
|----|------------|
| NFR-4.1 | All uploads validated server-side (file type, size, magic bytes) — never trust client-side validation alone |
| NFR-4.2 | Redis keys are user-scoped; no cross-user data leakage |
| NFR-4.3 | JWT-based authentication; tokens stored in HTTP-only cookies, not localStorage |
| NFR-4.4 | CSP headers set by NGINX and `next.config.js`; `dangerouslyAllowSVG` must have `sandbox` CSP |
| NFR-4.5 | XSS protection: all user-generated content passes through `rehype-raw` with sanitization; no `dangerouslySetInnerHTML` without explicit sanitize |
| NFR-4.6 | CORS: same-origin via NGINX; no explicit CORS headers needed |
| NFR-4.7 | Referrer-Policy: `strict-origin-when-cross-origin` (already set in `next.config.js` headers) |

### NFR-5: Reliability

| ID | Requirement |
|----|------------|
| NFR-5.1 | Streaming interruption recovery: if connection drops mid-stream, client recovers partial response from IndexedDB (`useBackgroundProcessing`), then polls async job for completion |
| NFR-5.2 | Redis connection resilience: `ioredis` configured with `maxRetriesPerRequest: 5`, `reconnectOnError: () => true`, `enableOfflineQueue: true` |
| NFR-5.3 | Service worker serves cached shell when server is unreachable |
| NFR-5.4 | Conversation history survives page reload (Redis is source of truth; no localStorage for conversation data) |

---

## 5. Data Model

### 5.1 Redis Key Schema

```
conversation:{conversationId}         → JSON (Conversation object, 7-day TTL)
user:{userId}:conversations           → Sorted Set of conversation IDs by updatedAt
user:{userId}:selectedConversation    → JSON (currently active conversation)
user:{userId}:image:{imageId}         → JSON (StoredImage, 7-day TTL)
user:{userId}:images                  → Set of image IDs
user:{userId}:video:{videoId}         → JSON (StoredVideo, 7-day TTL)
user:{userId}:document:{documentId}   → JSON (StoredDocument, 7-day TTL)
streaming:user:{userId}:conversation:{conversationId} → JSON (StreamingState, 10-min TTL)
session:{sessionId}                   → JSON (session metadata)
async-job-request:{jobId}             → JSON (AsyncJobRequest, 1-hour TTL)
async-job-status:{jobId}              → JSON (AsyncJobStatus, 1-hour TTL)
```

### 5.2 Pub/Sub Channels

```
user:{userId}:updates    → All sync events (conversation CRUD, streaming state changes)
job:{jobId}:status       → Job status updates for WebSocket push
```

### 5.3 Core TypeScript Types

```typescript
// types/chat.ts
interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'agent' | 'system';
  content: string;
  intermediateSteps?: IntermediateStep[];
  attachments?: Attachment[];
  metadata?: Record<string, any>;
}

interface Attachment {
  content: string;       // Display content or filename
  type: string;          // 'image' | 'video' | 'document'
  imageRef?: MediaRef;
  imageRefs?: MediaRef[];
  videoRef?: VideoRef;
  videoRefs?: VideoRef[];
  documentRef?: DocumentRef;
}

interface Conversation {
  id: string;
  name: string;
  messages: Message[];
  folderId: string | null;
  updatedAt?: number;
}
```

---

## 6. API Surface

### 6.1 REST Endpoints (Next.js API Routes)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/chat/async` | Submit chat message for async processing |
| GET | `/api/chat/async?jobId=` | Poll job status |
| GET | `/api/conversations` | List user's conversations |
| GET | `/api/conversations/{id}` | Get single conversation |
| POST | `/api/session/imageStorage` | Upload image to Redis |
| GET | `/api/session/imageStorage?imageId=` | Retrieve image (supports `?thumbnail=true`) |
| POST | `/api/session/videoStorage` | Upload video to Redis |
| POST | `/api/session/documentStorage` | Upload document to Redis |
| POST | `/api/session/registry` | Register session |
| PUT | `/api/session/registry` | Session heartbeat |
| DELETE | `/api/session/registry` | Unregister session |
| GET | `/api/sync/stream` | SSE stream (fallback) |
| POST | `/api/sync/notify` | Trigger sync event |
| GET | `/api/generated-image/{id}` | Serve agent-generated image from Redis |
| POST | `/api/document/process` | Extract text from uploaded document |

### 6.2 WebSocket Messages

**Client → Server:**

| Type | Payload | Purpose |
|------|---------|---------|
| `ping` | — | Keep-alive (every 30s) |
| `subscribe_job` | `{ jobId }` | Start receiving job status pushes |
| `unsubscribe_job` | `{ jobId }` | Stop receiving job status pushes |

**Server → Client:**

| Type | Payload | Purpose |
|------|---------|---------|
| `pong` | `{ ts }` | Keep-alive response |
| `connected` | `{ userId, streamingStates }` | Initial connection with current streaming state |
| `conversation_updated` | `{ conversationId, conversation }` | Conversation data changed |
| `conversation_deleted` | `{ conversationId }` | Conversation removed |
| `conversation_list_changed` | — | Conversation list needs refresh |
| `streaming_started` | `{ conversationId, sessionId }` | Backend started generating |
| `streaming_ended` | `{ conversationId, sessionId }` | Backend finished generating |
| `job_status` | `{ jobId, status, ... }` | Async job progress update |
| `error` | `{ message }` | Server-side error |

---

## 7. Implementation Priorities

### Wave 1 — Foundation (Parallel)

These can be assigned to different engineers simultaneously:

| Work Item | Dependencies | Engineer Profile |
|-----------|-------------|-----------------|
| FR-1 Chat Interface polish | None | Frontend |
| FR-4 Cross-device sync hardening | None | Full-stack |
| NFR-1 Performance baseline (Lighthouse, bundle analysis) | None | Frontend |

### Wave 2 — Streaming + Media (Parallel)

| Work Item | Dependencies | Engineer Profile |
|-----------|-------------|-----------------|
| FR-5 WebSocket streaming (token-by-token) | FR-1 | Full-stack |
| FR-2 Multimodal upload improvements | FR-1 | Full-stack |
| FR-3 Agent-generated image rendering | FR-1 | Frontend |

### Wave 3 — PWA + Polish (Parallel)

| Work Item | Dependencies | Engineer Profile |
|-----------|-------------|-----------------|
| FR-6 PWA offline + push notifications | FR-5 | Frontend (PWA) |
| NFR-2 Power efficiency audit | FR-5 | Frontend |
| NFR-3 Responsive design QA pass | FR-1, FR-2 | Frontend |

### Wave 4 — Hardening

| Work Item | Dependencies | Engineer Profile |
|-----------|-------------|-----------------|
| NFR-4 Security audit | All | Security |
| NFR-5 Reliability testing (network interruption, Redis failure) | All | QA/Full-stack |
| Test coverage to >= 80% | All | All |

---

## 8. Testing Strategy

### 8.1 Unit Tests (Vitest)

- All hooks (`use*.ts`) must have unit tests with mocked dependencies.
- Utility functions in `utils/` must have pure-function unit tests.
- Redux/Zustand store reducers tested in isolation.
- Target: >= 80% line coverage.

### 8.2 Component Tests (Vitest + React Testing Library)

- Message rendering (text, markdown, code blocks, images, video, attachments).
- Upload flow (file selection → validation → progress → completion).
- Error states and retry behavior.

### 8.3 Integration Tests

- WebSocket connection lifecycle (connect → message → reconnect → disconnect).
- Redis pub/sub event propagation (publish on one client → receive on another).
- Async job lifecycle (submit → streaming → completion → conversation save).

### 8.4 E2E Tests

- Full chat flow: send message → stream response → see in history.
- Upload image → send message with attachment → receive response referencing image.
- Open on two tabs → send message on tab A → see result on tab B.
- Kill network → see offline state → restore network → see recovery.

### 8.5 Performance Tests

- Lighthouse CI in CI/CD pipeline; fail build if LCP > 2.5s or CLS > 0.1.
- Scroll performance profiling with 1000-message conversations.
- Memory leak detection: open app, send 50 messages, check heap growth.

---

## 9. Deployment

### 9.1 Container Architecture

```
frontend:5000      # Next.js app server
frontend:3001      # WebSocket sidecar
nginx:80           # Reverse proxy (TLS termination in production)
redis:6379         # Redis Stack (RedisJSON + RediSearch)
backend:8000       # NAT tool-calling agent (default)
backend:8001       # NAT react agent (deep thinker)
```

### 9.2 Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `REDIS_URL` | Redis connection string | `redis://redis:6379` |
| `NEXT_PUBLIC_WS_URL` | WebSocket endpoint (if not `/ws`) | `/ws` |
| `AUTH_SECRET` | JWT signing key | (generate) |
| `NVIDIA_API_KEY` | NIM API key for backend | (secret) |

### 9.3 Helm Chart

Existing chart at `helm/daedalus/` includes:
- Frontend deployment with resource limits
- Redis deployment with PVC
- NGINX deployment with ConfigMap
- Backend deployments (default + deep thinker)
- NetworkPolicy restricting backend access

---

## 10. Glossary

| Term | Definition |
|------|-----------|
| **NAT** | NeMo Agent Toolkit — the backend agent framework |
| **Deep Thinker** | The ReAct agent backend (Claude Opus 4.5 via OpenRouter) for complex reasoning |
| **Default Backend** | The tool-calling agent backend (GPT-OSS 120B via NVIDIA NIM) for fast responses |
| **Async Job** | A long-running chat request processed in the background with status tracking |
| **Streaming State** | Redis-tracked flag indicating a conversation is currently receiving an agent response |
| **Session Registry** | System tracking which devices/tabs are active for a user |
| **Intermediate Step** | An agent's tool call or reasoning step, displayed as a collapsible card in the UI |
