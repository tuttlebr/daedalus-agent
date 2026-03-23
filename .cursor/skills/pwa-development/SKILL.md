---
name: pwa-development
description: Optimize and develop the Daedalus Progressive Web App. Covers the custom service worker, caching strategies, background processing, battery-aware patterns, offline support, and PWA components. Use when working on service workers, caching, offline mode, install prompts, wake lock, background processing, async jobs, or any PWA-related feature.
---

# Daedalus PWA Development

Daedalus uses a fully custom PWA implementation with no third-party libraries (no next-pwa, no Workbox). All service worker logic, caching, and background processing is hand-written.

## Architecture Overview

### Key Files

| File | Purpose |
|------|---------|
| `frontend/public/sw.js` | Custom service worker with LRU cache manager |
| `frontend/public/manifest.json` | Web app manifest (standalone, NVIDIA theme) |
| `frontend/utils/app/pwa.ts` | SW registration, install prompt, offline detection |
| `frontend/utils/app/visibilityAwareTimer.ts` | Battery-efficient timers that pause when hidden |
| `frontend/hooks/useBackgroundProcessing.ts` | Wake Lock API with battery detection |
| `frontend/hooks/useAsyncChat.ts` | Async job polling with adaptive backoff |
| `frontend/hooks/useOrientation.ts` | PWA display-mode detection |
| `frontend/components/PWA/InstallPrompt.tsx` | A2HS prompt (iOS + Android/Desktop) |
| `frontend/components/PWA/OfflineIndicator.tsx` | Online/offline status banner |
| `frontend/components/PWA/BackgroundProcessingIndicator.tsx` | Wake lock + streaming status |
| `frontend/next.config.js` | PWA headers (Service-Worker-Allowed, Cache-Control) |

### Service Worker Caching Strategies

The service worker (`sw.js`) uses four distinct strategies based on request type:

1. **Cache-first** for static assets (`/favicon.png`, images) with background revalidation
2. **Stale-while-revalidate** for Next.js chunks (`/_next/static/`)
3. **Network-first** for HTML pages with App Shell (`/`) fallback when offline
4. **Network-first** for conversation API endpoints with offline cache fallback

### Cache Architecture

The `CacheManager` class in `sw.js` implements LRU eviction with IndexedDB metadata:

- Three named caches: `daedalus-v1` (static), `daedalus-runtime` (LRU), `daedalus-conversations-v1`
- Content-type-specific limits:
  - Images: 5 MB total, 10 items max
  - API responses: 5 MB total, 10 items max
  - Default: 15 MB total, 30 items max
- Items exceeding half the type limit are skipped
- LRU score: `age / (accessCount + 1)` (higher score = better eviction candidate)
- Memory pressure detection at 70% storage quota triggers aggressive cleanup

### Battery-Aware Patterns

Every timer and polling mechanism in the app is battery-conscious. When modifying or adding features, follow these patterns:

- **Visibility-aware timers**: Use `createVisibilityAwareInterval` from `visibilityAwareTimer.ts` instead of raw `setInterval`. These pause when the app is hidden and use a `mobileMultiplier` for longer intervals on mobile.
- **Wake Lock**: The `useBackgroundProcessing` hook checks battery level before acquiring wake lock (skips below 20%, limits below 50% when not charging). Has a 5-minute safety timeout.
- **Adaptive polling**: `useAsyncChat` uses exponential backoff (1.1x every 10 polls, max 4x), with additional slowdowns for mobile (2x), hidden tabs (4x), and low battery (skips poll entirely via `shouldRunExpensiveOperation`).
- **Service worker cleanup**: Memory pressure checks run every 5 minutes. Periodic cache cleanup runs every 4 hours. Both skip execution when background tasks are disabled.

## Development Guidelines

### Modifying the Service Worker

When editing `sw.js`:

1. Bump `CACHE_NAME` version (for example, `daedalus-v2`) when changing static asset lists or cache structure
2. Keep `self.skipWaiting()` in install and `self.clients.claim()` in activate for immediate updates
3. Never cache non-GET requests or WebSocket connections
4. Skip caching responses larger than 5 MB
5. Test cache eviction with Chrome DevTools Application > Storage to verify memory limits
6. The SW runs in a separate thread; use `self.addEventListener('message', ...)` for communication with the main thread

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

PWA UI components live in `frontend/components/PWA/`. Follow existing patterns:

- Components are self-contained with their own state management
- Use `liquid-glass-overlay` and `backdrop-blur` classes for the glassmorphism design
- Use NVIDIA green (`text-nvidia-green`, `bg-nvidia-green`) for status indicators
- Respect safe area insets: `env(safe-area-inset-top)`, `env(safe-area-inset-right)`
- Use Tabler icons (`@tabler/icons-react`) consistently

### Creating New PWA Hooks

When building hooks that run periodic operations:

```typescript
import { createVisibilityAwareInterval, shouldRunExpensiveOperation } from '@/utils/app/visibilityAwareTimer';

// For periodic timers:
createVisibilityAwareInterval(callback, {
  interval: 60000,
  mobileMultiplier: 2,
  pauseWhenHidden: true,
  runImmediatelyOnVisible: false,
});

// For one-off expensive checks:
const shouldRun = await shouldRunExpensiveOperation();
if (!shouldRun) return; // low battery, skip
```

### Background Processing Flow

The async job system allows long-running AI tasks to complete even when the app is backgrounded:

1. `useAsyncChat.startAsyncJob()` posts to `/api/chat/async` and gets a `jobId`
2. Job metadata is persisted to `localStorage` keyed by `userId`
3. Polling begins with adaptive intervals (3s desktop, 5s mobile)
4. `useBackgroundProcessing.requestWakeLock()` keeps the screen on during streaming
5. If the app is backgrounded, polling slows down (4x interval)
6. On return to foreground, backoff resets and `resumePollingIfNeeded()` fires
7. Orphaned jobs (>10 minutes) are checked and cleaned up
8. Job completion requires `finalizedAt` timestamp (not just `status === 'completed'`)

### Install Prompt Behavior

The `InstallPrompt` component handles both platforms:

- **iOS**: Shows manual instructions (Share > Add to Home Screen) after 3-second delay
- **Android/Desktop**: Intercepts `beforeinstallprompt` event, shows native install dialog
- Dismiss stores timestamp in `localStorage`; re-shows after 7 days
- "Don't show again" sets timestamp 1 year in the future
- Hidden when `isPWAInstalled()` returns true (checks `display-mode: standalone`)

### Manifest Updates

The manifest at `frontend/public/manifest.json` uses:

- `display: standalone` for native app feel
- `theme_color: #76b900` (NVIDIA green)
- `categories: ["productivity", "utilities", "artificial-intelligence"]`
- `orientation: any` for responsive layout
- Shortcuts for "New Chat" with `/?action=new-chat`

When adding shortcuts or changing icons, provide multiple sizes (16x16 through 512x512). Use `purpose: "any maskable"` for the primary icon.

### Testing PWA Features

1. **Service worker**: Chrome DevTools > Application > Service Workers (check "Update on reload" during development)
2. **Cache storage**: Application > Cache Storage to inspect cached items and sizes
3. **Manifest**: Application > Manifest to verify installability
4. **Offline**: Network tab > Offline checkbox to test fallback behavior
5. **Lighthouse**: Run PWA audit for installability, offline support, and performance scores
6. **Mobile testing**: Use Chrome remote debugging on Android; Safari Web Inspector on iOS

### Common Pitfalls

- **Stale service worker**: Always increment `CACHE_NAME` version when changing cache structure
- **IndexedDB in SW**: The service worker uses `DaedalusCacheDB` for cache metadata; the main thread uses `DaedalusBackgroundDB` for streaming state. Keep these separate.
- **Wake lock re-acquisition**: Wake locks are released when the page is hidden. The `useBackgroundProcessing` hook re-acquires on visibility change if `wakeLockActive` was true.
- **Reference counting**: Wake lock uses request counting (`requestCountRef`). Multiple callers can request; lock is only released when all callers release.

## Additional Resources

For detailed architecture documentation, see [reference.md](reference.md).
