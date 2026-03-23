# PWA Architecture Reference

Detailed reference for Daedalus PWA internals.

## Service Worker Message API

The main thread communicates with the service worker through `postMessage`:

| Message Type | Direction | Payload | Purpose |
|---|---|---|---|
| `SKIP_WAITING` | Main -> SW | none | Force SW activation |
| `SET_BACKGROUND_TASKS` | Main -> SW | `{ enabled: boolean }` | Enable/disable battery-hungry cleanup tasks |
| `INVALIDATE_CONVERSATION_CACHE` | Main -> SW | `{ conversationId: string }` | Purge stale conversation from cache |
| `CLEANUP_CACHE` | Main -> SW | none | Trigger manual LRU eviction (responds via MessagePort) |

## CacheManager Class (sw.js)

### Constructor

```javascript
new CacheManager(cacheName, maxSize, maxItems)
```

### Key Methods

| Method | Description |
|---|---|
| `init()` | Loads metadata from IndexedDB `DaedalusCacheDB` |
| `addToCache(cache, request, response)` | Adds response with size estimation, enforces type-specific limits |
| `enforceLimit(cache, newItemSize, contentType)` | Evicts LRU items until within budget |
| `updateAccess(url)` | Bumps access count and timestamp for LRU scoring |
| `cleanupExpiredItems(cache)` | Removes items older than `CACHE_EXPIRY_TIME` (24 hours) |
| `checkMemoryPressure()` | Aggressive cleanup when storage > 70% quota |

### Content Type Detection

Determined by response `Content-Type` header or URL pattern:

| Type | Detection | Max Size | Max Items |
|---|---|---|---|
| `image` | `image/*` header or image file extension | 5 MB | 10 |
| `api` | `application/json` header or `/api/` URL | 5 MB | 10 |
| `default` | Everything else | 15 MB | 30 |

## IndexedDB Databases

| Database | Object Store | Used By | Purpose |
|---|---|---|---|
| `DaedalusCacheDB` | `cache-metadata` | Service Worker | LRU cache metadata (url, size, timestamp, accessCount) |
| `DaedalusBackgroundDB` | `streamingState` | Main Thread | Persists streaming state for background recovery |

## localStorage Keys

| Key Pattern | Component | Purpose |
|---|---|---|
| `pwa-install-dismissed` | InstallPrompt | Timestamp of last dismiss (re-shows after 7 days) |
| `asyncJobs_{userId}` | useAsyncChat | Persisted job metadata for resume after backgrounding |

## Async Job Lifecycle

```
POST /api/chat/async  ->  jobId
         |
         v
  [pending] --> poll /api/chat/async?jobId=xxx
         |
         v
  [streaming] --> partialResponse growing, backoff resets
         |
         v
  [completed] --> wait for finalizedAt timestamp
         |
         v
  [finalized] --> onComplete callback, clear persisted state
```

### Polling Interval Formula

```
interval = baseInterval * backoffMultiplier * mobileSlowdown * visibilitySlowdown

baseInterval:       3000ms (desktop) | 5000ms (mobile)
backoffMultiplier:  min(4, 1.1^(floor(pollCount/10)))
mobileSlowdown:    2x when mobile + status is 'pending'
visibilitySlowdown: 4x when page is hidden
```

Backoff resets to 0 when:
- Status changes to `streaming`
- `partialResponse` length increases
- App returns to foreground

## Wake Lock Lifecycle

```
requestWakeLock()
    |
    +--> Check battery (skip if < 20%, limit if < 50% and not charging)
    |
    +--> Acquire navigator.wakeLock.request('screen')
    |
    +--> Set 5-minute safety timeout
    |
    +--> On release event: reset state, clear timeout
    |
releaseWakeLock()
    |
    +--> Decrement requestCount
    |
    +--> Only release when requestCount === 0
```

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

## PWA Meta Tags (_document.tsx)

The document head includes:
- `<link rel="manifest" href="/manifest.json">`
- `<meta name="theme-color" content="#76b900">`
- `<meta name="apple-mobile-web-app-capable" content="yes">`
- `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`
- Apple touch icon links for various sizes

## Optimization Checklist

When optimizing PWA performance:

- [ ] Verify cache sizes stay within budget (Chrome DevTools > Application > Storage)
- [ ] Check Lighthouse PWA score (should be 90+)
- [ ] Test offline flow: load app -> go offline -> navigate -> verify cached pages
- [ ] Test background processing: start AI task -> lock screen -> return -> verify completion
- [ ] Test install flow on Android (native prompt) and iOS (manual instructions)
- [ ] Verify battery impact: monitor polling frequency with DevTools Performance tab
- [ ] Check memory pressure handling: fill cache -> verify LRU eviction fires
- [ ] Test service worker update: change SW -> verify update prompt appears
