# Daedalus Frontend: Backend Reference

**Source:** Extracted from the Daedalus Frontend Design Directive (formerly SRD-frontend.md). This document contains the data model, deployment configuration, and testing strategy that frontend engineers need for integration but that don't belong in the UX design directive.

---

## 1. Data Model

### 1.1 Redis Key Schema

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

### 1.2 Pub/Sub Channels

```
user:{userId}:updates    → All sync events (conversation CRUD, streaming state changes)
job:{jobId}:status       → Job status updates for WebSocket push
```

### 1.3 Core TypeScript Types

```typescript
// types/chat.ts
interface Message {
  id?: string;
  role: "user" | "assistant" | "agent" | "system";
  content: string;
  intermediateSteps?: IntermediateStep[];
  attachments?: Attachment[];
  metadata?: Record<string, any>;
}

interface Attachment {
  content: string; // Display content or filename
  type: string; // 'image' | 'video' | 'document'
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

## 2. Testing Strategy

### 2.1 Unit Tests (Vitest)

- All hooks (`use*.ts`) must have unit tests with mocked dependencies.
- Utility functions in `utils/` must have pure-function unit tests.
- Redux/Zustand store reducers tested in isolation.
- Target: >= 80% line coverage.

### 2.2 Component Tests (Vitest + React Testing Library)

- Message rendering (text, markdown, code blocks, images, video, attachments).
- Upload flow (file selection → validation → progress → completion).
- Error states and retry behavior.

### 2.3 Integration Tests

- WebSocket connection lifecycle (connect → message → reconnect → disconnect).
- Redis pub/sub event propagation (publish on one client → receive on another).
- Async job lifecycle (submit → streaming → completion → conversation save).

### 2.4 E2E Tests

- Full chat flow: send message → stream response → see in history.
- Upload image → send message with attachment → receive response referencing image.
- Open on two tabs → send message on tab A → see result on tab B.
- Kill network → see offline state → restore network → see recovery.

### 2.5 Performance Tests

- Lighthouse CI in CI/CD pipeline; fail build if LCP > 2.5s or CLS > 0.1.
- Scroll performance profiling with 1000-message conversations.
- Memory leak detection: open app, send 50 messages, check heap growth.

---

## 3. Deployment

### 3.1 Container Architecture

```
frontend:5000      # Next.js app server
frontend:3001      # WebSocket sidecar
nginx:80           # Reverse proxy (TLS termination in production)
redis:6379         # Redis Stack (RedisJSON + RediSearch)
backend:8000       # NAT tool-calling agent
```

### 3.2 Environment Variables

| Variable             | Purpose                           | Example              |
| -------------------- | --------------------------------- | -------------------- |
| `REDIS_URL`          | Redis connection string           | `redis://redis:6379` |
| `NEXT_PUBLIC_WS_URL` | WebSocket endpoint (if not `/ws`) | `/ws`                |
| `AUTH_SECRET`        | JWT signing key                   | (generate)           |
| `NVIDIA_API_KEY`     | NIM API key for backend           | (secret)             |

### 3.3 Helm Chart

Existing chart at `helm/daedalus/` includes:

- Frontend deployment with resource limits
- Redis deployment with PVC
- NGINX deployment with ConfigMap
- Backend deployment
- NetworkPolicy restricting backend access

---

## 4. Non-Functional Targets

### 4.1 Performance

| Metric                      | Target                       | Measurement              |
| --------------------------- | ---------------------------- | ------------------------ |
| First Contentful Paint      | < 1.5s on 4G                | Lighthouse               |
| Time to Interactive         | < 3s on 4G                  | Lighthouse               |
| Chat scroll                 | 60fps with 500+ messages    | Chrome DevTools          |
| Input latency               | < 50ms keystroke to render  | Input event profiling    |
| Streaming render            | < 16ms per token append     | Performance.now()        |
| Bundle size                 | < 300KB gzipped initial     | next build + analyzer    |

### 4.2 Security

- All uploads validated server-side (file type, size, magic bytes) — never trust client-side validation alone.
- Redis keys are user-scoped; no cross-user data leakage.
- JWT-based authentication; tokens stored in HTTP-only cookies, not localStorage.
- CSP headers set by NGINX and `next.config.js`; `dangerouslyAllowSVG` must have `sandbox` CSP.
- XSS protection: all user-generated content passes through `rehype-raw` with sanitization; no `dangerouslySetInnerHTML` without explicit sanitize.
- CORS: same-origin via NGINX; no explicit CORS headers needed.
- Referrer-Policy: `strict-origin-when-cross-origin` (already set in `next.config.js` headers).

### 4.3 Power Efficiency

- Background tab disconnects WebSocket within 5s of `visibilitychange` to `hidden`.
- Battery-aware reconnect: < 20% battery delays reconnect to 60s; < 10% stops auto-reconnect.
- Wake Lock only during active streaming with 5-minute safety timeout.
- Visibility-aware heartbeats pause when backgrounded; double interval on mobile.
- Service Worker cleanup every 4 hours; memory pressure check every 5 minutes.

### 4.4 Reliability

- Streaming interruption recovery: client recovers partial response from IndexedDB, then polls async job for completion.
- Redis connection resilience: `ioredis` configured with `maxRetriesPerRequest: 5`, `reconnectOnError: () => true`, `enableOfflineQueue: true`.
- Service worker serves cached shell when server is unreachable.
- Conversation history survives page reload (Redis is source of truth; no localStorage for conversation data).
