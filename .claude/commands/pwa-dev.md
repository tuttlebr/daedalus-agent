# Daedalus PWA Development

Guide for developing and optimizing the Daedalus Progressive Web App. Covers the custom service worker, caching strategies, background processing, battery-aware patterns, offline support, and PWA components.

Use when working on: service workers, caching, offline mode, install prompts, wake lock, background processing, async jobs, or any PWA-related feature.

---

## Architecture Overview

Daedalus uses a **fully custom PWA** — no third-party libraries (no next-pwa, no Workbox).

### Key Files

| File | Purpose |
|---|---|
| `frontend/public/sw.js` | Custom service worker with LRU cache manager |
| `frontend/public/manifest.json` | Web app manifest (standalone, NVIDIA theme) |
| `frontend/utils/app/pwa.ts` | SW registration, install prompt, offline detection |
| `frontend/utils/app/visibilityAwareTimer.ts` | Battery-efficient timers that pause when hidden |
| `frontend/hooks/useBackgroundProcessing.ts` | Wake Lock API with battery detection |
| `frontend/hooks/useAsyncChat.ts` | Async job polling with adaptive backoff |
| `frontend/hooks/useOrientation.ts` | PWA display-mode detection |
| `frontend/components/PWA/InstallPrompt.tsx` | A2HS prompt (iOS and Android/Desktop) |
| `frontend/components/PWA/OfflineIndicator.tsx` | Online/offline status banner |
| `frontend/components/PWA/BackgroundProcessingIndicator.tsx` | Wake lock and streaming status |
| `frontend/next.config.js` | PWA headers (Service-Worker-Allowed, Cache-Control) |

---

## Service Worker Caching Strategies

Four strategies based on request type:

1. **Cache-first** — static assets (`/favicon.png`, images) with background revalidation
2. **Stale-while-revalidate** — Next.js chunks (`/_next/static/`)
3. **Network-first** — HTML pages with App Shell (`/`) fallback when offline
4. **Network-first** — conversation API endpoints with offline cache fallback

### Cache Architecture

`CacheManager` in `sw.js` uses LRU eviction with IndexedDB metadata:

- Three named caches: `daedalus-v1` (static), `daedalus-runtime` (LRU), `daedalus-conversations-v1`
- Content-type-specific limits:

| Type | Detection | Max Size | Max Items |
|---|---|---|---|
| `image` | `image/*` header or image file extension | 5 MB | 10 |
| `api` | `application/json` header or `/api/` URL | 5 MB | 10 |
| `default` | Everything else | 15 MB | 30 |

- Items exceeding half the type limit are skipped
- LRU score: `age / (accessCount + 1)` (higher = better eviction candidate)
- Memory pressure detection at 70% storage quota triggers aggressive cleanup

---

## Battery-Aware Patterns

Every timer and polling mechanism is battery-conscious. Follow these patterns:

- **Visibility-aware timers**: Use `createVisibilityAwareInterval` from `visibilityAwareTimer.ts` instead of `setInterval`. These pause when the app is hidden.
- **Wake Lock**: `useBackgroundProcessing` skips below 20% battery, limits below 50% when not charging. Has a 5-minute safety timeout.
- **Adaptive polling**: `useAsyncChat` uses exponential backoff (1.1× every 10 polls, max 4×), with additional slowdowns for mobile (2×), hidden tabs (4×), and low battery (skips entirely).
- **SW cleanup**: Memory pressure checks every 5 minutes; periodic cache cleanup every 4 hours.

---

## Development Guidelines

### Modifying the Service Worker

1. Bump `CACHE_NAME` version (for example, `daedalus-v2`) when changing static asset lists or cache structure
2. Keep `self.skipWaiting()` in install and `self.clients.claim()` in activate for immediate updates
3. Never cache non-GET requests or WebSocket connections
4. Skip caching responses larger than 5 MB
5. Test cache eviction with Chrome DevTools > Application > Storage
6. Use `self.addEventListener('message', ...)` for main-thread communication

### Adding New Cacheable API Endpoints

Add regex patterns to `CACHEABLE_API_PATTERNS` in `sw.js`:

```javascript
const CACHEABLE_API_PATTERNS = [
  /\/api\/session\/conversationHistory$/,
  /\/api\/conversations\/[a-f0-9-]+$/,
  /\/api\/your-new-endpoint$/,  // new pattern
];
```

These use network-first strategy with offline cache fallback via `handleConversationApiRequest`.

### Adding PWA Components

PWA UI components live in `frontend/components/PWA/`. Patterns to follow:

- Components are self-contained with their own state management
- Use `liquid-glass-overlay` and `backdrop-blur` for glassmorphism
- Use NVIDIA green (`text-nvidia-green`, `bg-nvidia-green`) for status indicators
- Respect safe area insets: `env(safe-area-inset-top)`, `env(safe-area-inset-right)`
- Use Tabler icons (`@tabler/icons-react`) consistently

### Creating New Hooks with Periodic Operations

```typescript
import { createVisibilityAwareInterval, shouldRunExpensiveOperation } from '@/utils/app/visibilityAwareTimer';

// Periodic timer
createVisibilityAwareInterval(callback, {
  interval: 60000,
  mobileMultiplier: 2,
  pauseWhenHidden: true,
  runImmediatelyOnVisible: false,
});

// One-off expensive check
const shouldRun = await shouldRunExpensiveOperation();
if (!shouldRun) return; // low battery, skip
```

---

## Background Processing Flow

Long-running AI tasks complete even when the app is backgrounded:

1. `useAsyncChat.startAsyncJob()` posts to `/api/chat/async`, gets a `jobId`
2. Job metadata persisted to `localStorage` keyed by `userId`
3. Polling begins with adaptive intervals (3s desktop, 5s mobile)
4. `useBackgroundProcessing.requestWakeLock()` keeps screen on during streaming
5. Backgrounded app slows polling to 4× interval
6. On returning to foreground, backoff resets and `resumePollingIfNeeded()` fires
7. Orphaned jobs (>10 minutes) are cleaned up
8. Job completion requires `finalizedAt` timestamp, not just `status === 'completed'`

### Polling Interval Formula

```
interval = baseInterval × backoffMultiplier × mobileSlowdown × visibilitySlowdown

baseInterval:       3000ms (desktop) | 5000ms (mobile)
backoffMultiplier:  min(4, 1.1^(floor(pollCount/10)))
mobileSlowdown:    2× when mobile + status is 'pending'
visibilitySlowdown: 4× when page is hidden
```

Backoff resets to 0 when: status changes to `streaming`, `partialResponse` length increases, or app returns to foreground.

---

## Install Prompt Behavior

- **iOS**: Shows manual instructions (Share > Add to Home Screen) after 3-second delay
- **Android/Desktop**: Intercepts `beforeinstallprompt` event, shows native dialog
- Dismiss stores timestamp in `localStorage`; re-shows after 7 days
- "Don't show again" sets timestamp 1 year in the future
- Hidden when `isPWAInstalled()` returns true (checks `display-mode: standalone`)

---

## Manifest

`frontend/public/manifest.json`:
- `display: standalone` for native app feel
- `theme_color: #76b900` (NVIDIA green)
- `categories: ["productivity", "utilities", "artificial-intelligence"]`
- Shortcuts for "New Chat" with `/?action=new-chat`

When adding shortcuts or icons, provide multiple sizes (16×16 through 512×512). Use `purpose: "any maskable"` for the primary icon.

---

## Service Worker Message API

| Message Type | Direction | Payload | Purpose |
|---|---|---|---|
| `SKIP_WAITING` | Main → SW | none | Force SW activation |
| `SET_BACKGROUND_TASKS` | Main → SW | `{ enabled: boolean }` | Enable/disable battery-hungry cleanup |
| `INVALIDATE_CONVERSATION_CACHE` | Main → SW | `{ conversationId: string }` | Purge stale conversation |
| `CLEANUP_CACHE` | Main → SW | none | Trigger manual LRU eviction |

---

## IndexedDB Databases

| Database | Object Store | Used By | Purpose |
|---|---|---|---|
| `DaedalusCacheDB` | `cache-metadata` | Service Worker | LRU metadata (url, size, timestamp, accessCount) |
| `DaedalusBackgroundDB` | `streamingState` | Main Thread | Persists streaming state for background recovery |

Keep these separate — do not access `DaedalusCacheDB` from the main thread or `DaedalusBackgroundDB` from the service worker.

---

## localStorage Keys

| Key Pattern | Component | Purpose |
|---|---|---|
| `pwa-install-dismissed` | InstallPrompt | Timestamp of last dismiss |
| `asyncJobs_{userId}` | useAsyncChat | Persisted job metadata |

---

## Wake Lock Lifecycle

```
requestWakeLock()
    +--> Check battery (skip if < 20%, limit if < 50% and not charging)
    +--> Acquire navigator.wakeLock.request('screen')
    +--> Set 5-minute safety timeout
    +--> On release event: reset state, clear timeout

releaseWakeLock()
    +--> Decrement requestCount
    +--> Only release when requestCount === 0
```

---

## Testing PWA Features

1. **Service worker**: Chrome DevTools > Application > Service Workers (check "Update on reload" during development)
2. **Cache storage**: Application > Cache Storage to inspect cached items and sizes
3. **Manifest**: Application > Manifest to verify installability
4. **Offline**: Network tab > Offline checkbox to test fallback behavior
5. **Lighthouse**: Run PWA audit for installability, offline support, and performance
6. **Mobile**: Chrome remote debugging on Android; Safari Web Inspector on iOS

---

## Common Pitfalls

- **Stale service worker**: Always increment `CACHE_NAME` when changing cache structure
- **IndexedDB mix-up**: `DaedalusCacheDB` is SW-only; `DaedalusBackgroundDB` is main-thread-only
- **Wake lock re-acquisition**: Wake locks release when the page is hidden; `useBackgroundProcessing` re-acquires on visibility change
- **Reference counting**: Wake lock uses `requestCountRef` — only releases when all callers have released

---

## next.config.js PWA Headers

```javascript
{
  source: '/sw.js',
  headers: [
    { key: 'Service-Worker-Allowed', value: '/' },
    { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
  ],
}
```

---

## Optimization Checklist

- [ ] Cache sizes stay within budget (Chrome DevTools > Application > Storage)
- [ ] Lighthouse PWA score is 90+
- [ ] Offline flow: load → go offline → navigate → verify cached pages
- [ ] Background processing: start AI task → lock screen → return → verify completion
- [ ] Install flow on Android (native prompt) and iOS (manual instructions)
- [ ] Battery impact: monitor polling frequency with DevTools Performance tab
- [ ] Memory pressure: fill cache → verify LRU eviction fires
- [ ] SW update: change SW → verify update prompt appears
