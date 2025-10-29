// Service Worker for Daedalus PWA
const CACHE_NAME = 'daedalus-v1';
const RUNTIME_CACHE = 'daedalus-runtime';

// Optimized cache configuration for lower memory footprint
const MAX_CACHE_SIZE = 15 * 1024 * 1024; // Reduced to 15MB max cache size
const MAX_CACHE_ITEMS = 30; // Reduced maximum number of cached items
const CACHE_EXPIRY_TIME = 24 * 60 * 60 * 1000; // Reduced to 1 day
const MAX_IMAGE_CACHE_SIZE = 5 * 1024 * 1024; // 5MB for images specifically
const MAX_IMAGE_ITEMS = 10; // Max 10 cached images

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
    this.memoryPressureThreshold = 0.7; // 70% memory usage triggers cleanup
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
        console.log('Failed to load cache metadata:', err);
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
      console.log(`Skipping cache for large ${contentType} item: ${url} (${(size / 1024).toFixed(1)}KB)`);
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

      console.log(`Evicted ${contentType} from cache:`, urlToEvict);
    }
  }

  findLRUItem() {
    let lruUrl = null;
    let lruScore = Infinity;

    for (const [url, metadata] of this.cacheMetadata.entries()) {
      // Skip static assets
      if (STATIC_ASSETS.some(asset => url.includes(asset))) continue;

      // Calculate LRU score (lower is better)
      const age = Date.now() - metadata.timestamp;
      const score = age / (metadata.accessCount + 1);

      if (score < lruScore) {
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
      console.error('Failed to save cache metadata:', err);
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
      console.error('Failed to delete cache metadata:', err);
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
      console.log('Cleaned up expired cache item:', url);
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
            console.warn(`Memory pressure detected: ${(usageRatio * 100).toFixed(1)}% of quota used`);

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

            console.log(`Cleared ${totalRemoved} items due to memory pressure`);
          }
        }
      } catch (error) {
        console.error('Error checking storage estimate:', error);
      }
    }
  }
}

// Initialize cache manager
const cacheManager = new CacheManager(RUNTIME_CACHE, MAX_CACHE_SIZE, MAX_CACHE_ITEMS);

// Check memory pressure periodically
setInterval(() => {
  cacheManager.checkMemoryPressure();
}, 60000); // Check every minute

// Install event - cache static assets
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
            .filter((name) => name !== CACHE_NAME && name !== RUNTIME_CACHE)
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

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip API calls and websocket connections
  if (url.pathname.startsWith('/api/') || url.protocol === 'ws:' || url.protocol === 'wss:') {
    return;
  }

  // Network-first strategy for HTML pages
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
        .catch(() => caches.match(request))
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
  // This would sync any queued messages when connection is restored
  // Implementation depends on your offline queue storage
  console.log('Syncing offline messages...');
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

// Message event handler for cache management
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
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

// Periodic cleanup task (runs every hour)
setInterval(() => {
  caches.open(RUNTIME_CACHE).then((cache) => {
    cacheManager.cleanupExpiredItems(cache);
    console.log('Periodic cache cleanup completed');
  }).catch((error) => {
    console.error('Periodic cache cleanup failed:', error);
  });
}, 60 * 60 * 1000); // 1 hour
