// Service Worker for Daedalus PWA
const CACHE_NAME = 'daedalus-v2';
const RUNTIME_CACHE = 'daedalus-runtime';
const CONVERSATION_CACHE = 'daedalus-conversations-v1';

// Standardized logging for service worker
const swLog = {
  info: (msg, data) => console.log(`[INFO] [SW] ${msg}`, data !== undefined ? data : ''),
  warn: (msg, data) => console.warn(`[WARN] [SW] ${msg}`, data !== undefined ? data : ''),
  error: (msg, data) => console.error(`[ERROR] [SW] ${msg}`, data !== undefined ? data : ''),
  debug: (msg, data) => console.log(`[DEBUG] [SW] ${msg}`, data !== undefined ? data : ''),
};

// Optimized cache configuration for lower memory footprint
const MAX_CACHE_SIZE = 15 * 1024 * 1024; // Reduced to 15MB max cache size
const MAX_CACHE_ITEMS = 30; // Reduced maximum number of cached items
const CACHE_EXPIRY_TIME = 24 * 60 * 60 * 1000; // Reduced to 1 day
const MAX_IMAGE_CACHE_SIZE = 5 * 1024 * 1024; // 5MB for images specifically
const MAX_IMAGE_ITEMS = 10; // Max 10 cached images
const MAX_CONVERSATION_CACHE_SIZE = 10 * 1024 * 1024; // 10MB for conversations
const MAX_CONVERSATION_ITEMS = 50; // Max 50 cached conversations

// API endpoints to cache for offline support
const CACHEABLE_API_PATTERNS = [
  /\/api\/session\/conversationHistory$/,
  /\/api\/conversations\/[a-f0-9-]+$/,
];

// Assets to cache on install
const STATIC_ASSETS = [
  '/',
  '/favicon.png',
  '/manifest.json'
];

// LRU Cache Manager with memory pressure detection
class CacheManager {
  constructor(cacheName, maxSize, maxItems) {
    this.cacheName = cacheName;
    this.maxSize = maxSize;
    this.maxItems = maxItems;
    this.cacheMetadata = new Map();
    this.memoryPressureThreshold = 70.0; // 70% memory usage triggers cleanup
    this.contentTypeLimits = {
      'image': { maxSize: MAX_IMAGE_CACHE_SIZE, maxItems: MAX_IMAGE_ITEMS },
      'api': { maxSize: 5 * 1024 * 1024, maxItems: 10 },
      'default': { maxSize: maxSize, maxItems: maxItems }
    };
  }

  async init() {
    // Load metadata from IndexedDB if available
    if ('indexedDB' in self) {
      try {
        const db = await this.openDB();
        const tx = db.transaction(['cache-metadata'], 'readonly');
        const store = tx.objectStore('cache-metadata');
        const allData = await this.promisifyRequest(store.getAll());

        allData.forEach(item => {
          this.cacheMetadata.set(item.url, {
            size: item.size,
            timestamp: item.timestamp,
            accessCount: item.accessCount || 0
          });
        });
      } catch (err) {
        swLog.warn('Failed to load cache metadata', err);
      }
    }
  }

  async openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('DaedalusCacheDB', 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('cache-metadata')) {
          db.createObjectStore('cache-metadata', { keyPath: 'url' });
        }
      };
    });
  }

  promisifyRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  getContentType(request, response) {
    // Check response content type
    const contentType = response.headers.get('content-type');
    if (contentType) {
      if (contentType.includes('image/')) return 'image';
      if (contentType.includes('application/json')) return 'api';
    }

    // Check URL patterns
    const url = request.url;
    if (/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(url)) return 'image';
    if (/\/api\//i.test(url)) return 'api';

    return 'default';
  }

  async addToCache(cache, request, response) {
    const url = request.url;
    const clonedResponse = response.clone();
    const contentType = this.getContentType(request, response);

    // Get content-type specific limits
    const limits = this.contentTypeLimits[contentType] || this.contentTypeLimits.default;

    // Estimate size from content-length header or response
    let size = 0;
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      size = parseInt(contentLength, 10);
    } else {
      // Estimate size from response body
      try {
        const blob = await clonedResponse.blob();
        size = blob.size;
      } catch (err) {
        size = 1024; // Default 1KB estimate
      }
    }

    // Skip caching if item is too large for its type
    if (size > limits.maxSize / 2) {
      swLog.debug(`Skipping cache for large ${contentType} item: ${url} (${(size / 1024).toFixed(1)}KB)`);
      return;
    }

    // Check if we need to evict items
    await this.enforceLimit(cache, size, contentType);

    // Add to cache
    await cache.put(request, response);

    // Update metadata
    this.cacheMetadata.set(url, {
      size,
      timestamp: Date.now(),
      accessCount: 1,
      contentType
    });

    await this.saveMetadata(url);
  }

  async enforceLimit(cache, newItemSize, contentType = 'default') {
    const limits = this.contentTypeLimits[contentType] || this.contentTypeLimits.default;
    let totalSizeByType = { image: 0, api: 0, default: 0 };
    let itemCountByType = { image: 0, api: 0, default: 0 };

    // Calculate current cache size by type
    for (const [url, metadata] of this.cacheMetadata.entries()) {
      const type = metadata.contentType || 'default';
      totalSizeByType[type] = (totalSizeByType[type] || 0) + metadata.size;
      itemCountByType[type] = (itemCountByType[type] || 0) + 1;
    }

    // Add new item to counts
    totalSizeByType[contentType] += newItemSize;
    itemCountByType[contentType] += 1;

    // Evict items if necessary for specific content type
    while ((totalSizeByType[contentType] > limits.maxSize ||
            itemCountByType[contentType] > limits.maxItems) &&
           this.cacheMetadata.size > 0) {
      const urlToEvict = this.findLRUItemByType(contentType);
      if (!urlToEvict) break;

      const metadata = this.cacheMetadata.get(urlToEvict);
      if (metadata) {
        const type = metadata.contentType || 'default';
        totalSizeByType[type] -= metadata.size;
        itemCountByType[type] -= 1;
      }

      await cache.delete(urlToEvict);
      this.cacheMetadata.delete(urlToEvict);
      await this.deleteMetadata(urlToEvict);

      swLog.debug(`Evicted ${contentType} from cache: ${urlToEvict}`);
    }
  }

  findLRUItem() {
    let lruUrl = null;
    let lruScore = -1;

    for (const [url, metadata] of this.cacheMetadata.entries()) {
      if (STATIC_ASSETS.some(asset => url.includes(asset))) continue;

      // Higher score = older and less accessed = better eviction candidate
      const age = Date.now() - metadata.timestamp;
      const score = age / ((metadata.accessCount || 0) + 1);

      if (score > lruScore) {
        lruScore = score;
        lruUrl = url;
      }
    }

    return lruUrl;
  }

  findLRUItemByType(contentType) {
    let lruUrl = null;
    let lruScore = -1;

    for (const [url, metadata] of this.cacheMetadata.entries()) {
      // Only consider items of the specified content type
      if ((metadata.contentType || 'default') !== contentType) continue;

      // Skip static assets
      if (STATIC_ASSETS.some(asset => url.includes(asset))) continue;

      // Calculate LRU score (higher is better candidate for eviction)
      const age = Date.now() - metadata.timestamp;
      const score = age / ((metadata.accessCount || 0) + 1);

      if (score > lruScore) {
        lruScore = score;
        lruUrl = url;
      }
    }

    return lruUrl;
  }

  async updateAccess(url) {
    const metadata = this.cacheMetadata.get(url);
    if (metadata) {
      metadata.accessCount++;
      metadata.timestamp = Date.now();
      await this.saveMetadata(url);
    }
  }

  async saveMetadata(url) {
    if (!('indexedDB' in self)) return;

    try {
      const db = await this.openDB();
      const tx = db.transaction(['cache-metadata'], 'readwrite');
      const store = tx.objectStore('cache-metadata');

      const metadata = this.cacheMetadata.get(url);
      if (metadata) {
        await this.promisifyRequest(store.put({
          url,
          ...metadata
        }));
      }
    } catch (err) {
      swLog.error('Failed to save cache metadata', err);
    }
  }

  async deleteMetadata(url) {
    if (!('indexedDB' in self)) return;

    try {
      const db = await this.openDB();
      const tx = db.transaction(['cache-metadata'], 'readwrite');
      const store = tx.objectStore('cache-metadata');
      await this.promisifyRequest(store.delete(url));
    } catch (err) {
      swLog.error('Failed to delete cache metadata', err);
    }
  }

  async cleanupExpiredItems(cache) {
    const now = Date.now();
    const expiredUrls = [];

    for (const [url, metadata] of this.cacheMetadata.entries()) {
      if (now - metadata.timestamp > CACHE_EXPIRY_TIME) {
        expiredUrls.push(url);
      }
    }

    for (const url of expiredUrls) {
      await cache.delete(url);
      this.cacheMetadata.delete(url);
      await this.deleteMetadata(url);
      swLog.info(`Cleaned up expired cache item: ${url}`);
    }
  }

  async checkMemoryPressure() {
    // Check if we're approaching storage quota
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      try {
        const estimate = await navigator.storage.estimate();
        if (estimate.usage && estimate.quota) {
          const usageRatio = estimate.usage / estimate.quota;

          if (usageRatio > this.memoryPressureThreshold) {
            swLog.warn(`Memory pressure detected: ${(usageRatio * 100).toFixed(1)}% of quota used`);

            // Aggressively clean up cache
            const cache = await caches.open(this.cacheName);

            // Remove different percentages based on content type
            const removalTargets = {
              image: 0.8,  // Remove 80% of images
              api: 0.5,    // Remove 50% of API responses
              default: 0.6 // Remove 60% of other content
            };

            let totalRemoved = 0;
            for (const [contentType, removalRatio] of Object.entries(removalTargets)) {
              const itemsOfType = Array.from(this.cacheMetadata.entries())
                .filter(([_, meta]) => (meta.contentType || 'default') === contentType);

              const itemsToRemove = Math.ceil(itemsOfType.length * removalRatio);

              for (let i = 0; i < itemsToRemove; i++) {
                const urlToEvict = this.findLRUItemByType(contentType);
                if (urlToEvict) {
                  await cache.delete(urlToEvict);
                  this.cacheMetadata.delete(urlToEvict);
                  await this.deleteMetadata(urlToEvict);
                  totalRemoved++;
                }
              }
            }

            swLog.info(`Cleared ${totalRemoved} items due to memory pressure`);
          }
        }
      } catch (error) {
        swLog.error('Error checking storage estimate', error);
      }
    }
  }
}

// Initialize cache manager
const cacheManager = new CacheManager(RUNTIME_CACHE, MAX_CACHE_SIZE, MAX_CACHE_ITEMS);

// Track if we should run background tasks (battery-aware)
let backgroundTasksEnabled = true;

// Listen for messages to enable/disable background tasks
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SET_BACKGROUND_TASKS') {
    backgroundTasksEnabled = event.data.enabled;
    swLog.info(`Background tasks ${backgroundTasksEnabled ? 'enabled' : 'disabled'}`);
  }
});

// Check memory pressure periodically - reduced frequency for battery efficiency
// Only runs every 5 minutes instead of every minute
setInterval(() => {
  if (backgroundTasksEnabled) {
    cacheManager.checkMemoryPressure();
  }
}, 5 * 60000); // Check every 5 minutes (reduced from 1 minute)

// Install event - cache static assets and App Shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then((cache) => {
        return cache.addAll(STATIC_ASSETS);
      }),
      cacheManager.init()
    ])
  );
  // Skip waiting and activate immediately
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME && name !== RUNTIME_CACHE && name !== CONVERSATION_CACHE)
            .map((name) => caches.delete(name))
        );
      }),
      // Clean up expired items on activation
      caches.open(RUNTIME_CACHE).then((cache) => {
        return cacheManager.cleanupExpiredItems(cache);
      })
    ])
  );
  // Take control of all pages immediately
  self.clients.claim();
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Pass non-GET requests (POST, PUT, DELETE, etc.) directly to the network.
  // IMPORTANT: On iOS Safari in standalone PWA mode, a bare `return` without
  // `event.respondWith()` can silently swallow the request. Explicitly proxying
  // through `fetch(request)` ensures the request always reaches the server.
  if (request.method !== 'GET') {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: 'Network request failed' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // Skip websocket connections
  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    return;
  }

  // Handle cacheable API endpoints (conversation data) with network-first strategy
  if (url.pathname.startsWith('/api/')) {
    const isCacheableApi = CACHEABLE_API_PATTERNS.some(pattern => pattern.test(url.pathname));

    if (isCacheableApi) {
      event.respondWith(
        handleConversationApiRequest(request, url)
      );
      return;
    }

    // Skip other API calls
    return;
  }

  // Next.js static chunks - Stale-While-Revalidate strategy
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        // Return cached response immediately if available
        const fetchPromise = fetch(request).then(async (networkResponse) => {
          if (networkResponse.status === 200) {
            const cache = await caches.open(RUNTIME_CACHE);
            // Use cacheManager to add with LRU
            await cacheManager.addToCache(cache, request, networkResponse.clone());
          }
          return networkResponse;
        });

        return cachedResponse || fetchPromise;
      })
    );
    return;
  }

  // Network-first strategy for HTML pages with App Shell fallback
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.status === 200) {
            const cache = await caches.open(RUNTIME_CACHE);
            await cacheManager.addToCache(cache, request, response.clone());
          }
          return response;
        })
        .catch(async () => {
          // Fallback to cache
          const cachedResponse = await caches.match(request);
          if (cachedResponse) return cachedResponse;

          // If not in cache and it's a navigation, return App Shell (root)
          if (request.mode === 'navigate') {
             const appShell = await caches.match('/');
             if (appShell) return appShell;
          }

          // Return a proper error response instead of null (null is not a valid
          // Response and causes a TypeError inside respondWith).
          return new Response('Offline - no cached version available', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          });
        })
    );
    return;
  }

  // Cache-first strategy for static assets with LRU
  event.respondWith(
    caches.match(request).then(async (cachedResponse) => {
      if (cachedResponse) {
        // Update access count for LRU
        cacheManager.updateAccess(request.url);

        // Return cached version and update cache in background
        event.waitUntil(
          fetch(request).then(async (response) => {
            if (response.status === 200) {
              const cache = await caches.open(RUNTIME_CACHE);
              await cacheManager.addToCache(cache, request, response.clone());
            }
          }).catch(() => {/* Ignore network errors */})
        );
        return cachedResponse;
      }

      // Not in cache, fetch from network
      return fetch(request).then(async (response) => {
        // Skip caching for large responses
        const contentLength = response.headers.get('content-length');
        const size = contentLength ? parseInt(contentLength, 10) : 0;

        // Don't cache responses larger than 5MB
        if (response.status === 200 && size < 5 * 1024 * 1024) {
          const cache = await caches.open(RUNTIME_CACHE);
          await cacheManager.addToCache(cache, request, response.clone());
        }
        return response;
      });
    })
  );
});

// Background sync for offline messages
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-messages') {
    event.waitUntil(syncOfflineMessages());
  }
});

async function syncOfflineMessages() {
  swLog.info('Syncing offline messages...');

  const DB_NAME = 'DaedalusOfflineDB';
  const STORE_NAME = 'pendingMessages';

  try {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
    });

    const items = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getAll = store.getAll();
      getAll.onsuccess = () => resolve(getAll.result);
      getAll.onerror = () => reject(getAll.error);
    });

    if (!items || items.length === 0) {
      swLog.info('No offline messages to sync');
      db.close();
      return;
    }

    swLog.info(`Syncing ${items.length} offline messages`);
    let successCount = 0;

    for (const item of items) {
      try {
        const response = await fetch('/api/chat/async', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(item.message),
        });

        if (response.ok) {
          // Delete sent message from queue
          const deleteTx = db.transaction(STORE_NAME, 'readwrite');
          deleteTx.objectStore(STORE_NAME).delete(item.id);
          successCount++;
        } else {
          swLog.warn(`Failed to send offline message ${item.id}: ${response.status}`);
        }
      } catch (err) {
        swLog.error(`Error sending offline message ${item.id}`, err);
      }
    }

    db.close();
    swLog.info(`Synced ${successCount}/${items.length} offline messages`);

    // Notify clients
    const clients = await self.clients.matchAll();
    for (const client of clients) {
      client.postMessage({ type: 'SYNC_COMPLETE', count: successCount });
    }
  } catch (err) {
    swLog.error('Failed to sync offline messages', err);
  }
}

// Push notifications
self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();
  const options = {
    body: data.body,
    icon: '/favicon.png',
    badge: '/favicon.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    },
    actions: [
      {
        action: 'view',
        title: 'View'
      },
      {
        action: 'close',
        title: 'Close'
      }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Daedalus', options)
  );
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'view') {
    event.waitUntil(
      clients.openWindow('/')
    );
  }
});

// Network-first strategy for conversation API requests with offline fallback
async function handleConversationApiRequest(request, url) {
  const cacheKey = url.pathname;

  try {
    // Try network first
    const networkResponse = await fetch(request);

    if (networkResponse.ok) {
      // Cache successful responses
      const cache = await caches.open(CONVERSATION_CACHE);

      // Clone response before caching (can only be read once)
      const responseToCache = networkResponse.clone();

      // Store in cache with timestamp metadata
      cache.put(request, responseToCache);

      swLog.info(`Cached conversation data: ${cacheKey}`);
      return networkResponse;
    }

    // Network returned error, try cache fallback
    throw new Error(`Network returned ${networkResponse.status}`);
  } catch (error) {
    swLog.debug(`Network failed for ${cacheKey}, trying cache: ${error.message}`);

    // Try to get from cache
    const cache = await caches.open(CONVERSATION_CACHE);
    const cachedResponse = await cache.match(request);

    if (cachedResponse) {
      swLog.info(`Serving from cache: ${cacheKey}`);
      return cachedResponse;
    }

    // Return offline response
    return new Response(
      JSON.stringify({ error: 'Offline', message: 'No cached data available' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

// Invalidate conversation cache entry
async function invalidateConversationCache(conversationId) {
  try {
    const cache = await caches.open(CONVERSATION_CACHE);
    const keys = await cache.keys();

    for (const key of keys) {
      const url = new URL(key.url);
      // Match specific conversation or conversation history
      if (url.pathname.includes(conversationId) || url.pathname.endsWith('/conversationHistory')) {
        await cache.delete(key);
        swLog.info(`Invalidated cache: ${url.pathname}`);
      }
    }
  } catch (error) {
    swLog.error('Error invalidating conversation cache', error);
  }
}

// Message event handler for cache management
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  // Handle conversation cache invalidation from real-time sync
  if (event.data && event.data.type === 'INVALIDATE_CONVERSATION_CACHE') {
    const { conversationId } = event.data;
    if (conversationId) {
      invalidateConversationCache(conversationId);
    }
  }

  // Trigger manual cache cleanup
  if (event.data && event.data.type === 'CLEANUP_CACHE') {
    caches.open(RUNTIME_CACHE).then(async (cache) => {
      await cacheManager.cleanupExpiredItems(cache);
      if (event.ports[0]) {
        event.ports[0].postMessage({ success: true });
      }
    }).catch((error) => {
      if (event.ports[0]) {
        event.ports[0].postMessage({ success: false, error: error.message });
      }
    });
  }
});

// Periodic cleanup task - reduced frequency for battery efficiency
// Runs every 4 hours instead of every hour, only when background tasks enabled
setInterval(() => {
  if (backgroundTasksEnabled) {
    caches.open(RUNTIME_CACHE).then((cache) => {
      cacheManager.cleanupExpiredItems(cache);
      swLog.info('Periodic cache cleanup completed');
    }).catch((error) => {
      swLog.error('Periodic cache cleanup failed', error);
    });
  }
}, 4 * 60 * 60 * 1000); // 4 hours (increased from 1 hour for battery efficiency)
