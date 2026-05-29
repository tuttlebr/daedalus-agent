import { Logger } from '@/utils/logger';

const logger = new Logger('ImageBlobCache');

export interface ImageReference {
  imageId: string;
  sessionId: string;
  userId?: string;
  mimeType?: string;
  url?: string;
}

interface BlobCacheEntry {
  url: string;
  size: number;
  lastAccessed: number;
}

export function getBlobCacheKey(
  imageRef: ImageReference,
  useThumbnail = false,
): string {
  return useThumbnail ? `${imageRef.imageId}-thumb` : imageRef.imageId;
}

export function getImageUrl(
  imageRef: ImageReference,
  useThumbnail = false,
): string {
  if (imageRef.sessionId === 'generated') {
    const thumbnailParam = useThumbnail ? '?thumbnail=true' : '';
    if (typeof window === 'undefined') {
      const port = process.env.PORT || '3000';
      return `http://127.0.0.1:${port}/api/generated-image/${imageRef.imageId}${thumbnailParam}`;
    }
    return `/api/generated-image/${imageRef.imageId}${thumbnailParam}`;
  }

  if (typeof window === 'undefined') {
    const port = process.env.PORT || '3000';
    const baseUrl = `http://127.0.0.1:${port}`;
    let url = `${baseUrl}/api/session/imageStorage?imageId=${imageRef.imageId}`;
    if (imageRef.sessionId) {
      url += `&sessionId=${imageRef.sessionId}`;
    }
    if (useThumbnail) {
      url += '&thumbnail=true';
    }
    return url;
  }

  let url = `/api/session/imageStorage?imageId=${imageRef.imageId}`;
  if (imageRef.sessionId) {
    url += `&sessionId=${imageRef.sessionId}`;
  }
  if (useThumbnail) {
    url += '&thumbnail=true';
  }
  return url;
}

class ImageBlobCache {
  private cache = new Map<string, BlobCacheEntry>();
  private temporaryUrls = new Set<string>();
  private totalSize = 0;
  private readonly maxSize = this.isMobile()
    ? 2 * 1024 * 1024
    : 3 * 1024 * 1024;
  private cleanupTimer: { stop: () => void } | null = null;
  private memoryTimer: { stop: () => void } | null = null;
  private referenceCount = new Map<string, number>();
  private memoryPressureThreshold = 70.0;

  constructor() {
    if (typeof window !== 'undefined') {
      import('./visibilityAwareTimer').then((module) => {
        this.cleanupTimer = module.createVisibilityAwareInterval(
          () => this.cleanupStaleEntries(),
          {
            interval: 60000,
            mobileMultiplier: 2,
            pauseWhenHidden: true,
          },
        );

        this.memoryTimer = module.createVisibilityAwareInterval(
          () => this.checkMemoryPressure(),
          {
            interval: 30000,
            mobileMultiplier: 2,
            pauseWhenHidden: true,
          },
        );
      });
    }
  }

  private isMobile(): boolean {
    return typeof window !== 'undefined' && window.innerWidth <= 768;
  }

  async fetchAsBlob(
    imageRef: ImageReference,
    useThumbnail = false,
  ): Promise<string> {
    const cacheKey = getBlobCacheKey(imageRef, useThumbnail);

    const cached = this.cache.get(cacheKey);
    if (cached) {
      cached.lastAccessed = Date.now();
      const refCount = this.referenceCount.get(cacheKey) || 0;
      this.referenceCount.set(cacheKey, refCount + 1);
      return cached.url;
    }

    const response = await fetch(getImageUrl(imageRef, useThumbnail));
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }

    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);

    const cachedBlob = this.addToCache(cacheKey, blobUrl, blob.size);
    if (!cachedBlob) {
      this.temporaryUrls.add(blobUrl);
      return blobUrl;
    }

    return blobUrl;
  }

  private addToCache(key: string, url: string, size: number): boolean {
    if (size > this.maxSize) {
      logger.debug('Image exceeds blob cache budget, using temporary URL', {
        imageId: key,
        size,
        maxSize: this.maxSize,
      });
      return false;
    }

    while (this.totalSize + size > this.maxSize && this.cache.size > 0) {
      if (!this.evictOldest()) {
        break;
      }
    }

    if (this.totalSize + size > this.maxSize) {
      logger.debug('No unreferenced image blobs available for eviction', {
        imageId: key,
        size,
        totalSize: this.totalSize,
        maxSize: this.maxSize,
      });
      return false;
    }

    this.cache.set(key, {
      url,
      size,
      lastAccessed: Date.now(),
    });
    this.totalSize += size;
    this.referenceCount.set(key, 1);
    return true;
  }

  private evictOldest(): boolean {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    const entries = Array.from(this.cache.entries());
    for (const [key, entry] of entries) {
      const refCount = this.referenceCount.get(key) || 0;
      if (refCount > 0) continue;

      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.cache.get(oldestKey)!;
      URL.revokeObjectURL(entry.url);
      this.totalSize -= entry.size;
      this.cache.delete(oldestKey);
      this.referenceCount.delete(oldestKey);
      logger.debug('Evicted image from blob cache', { imageId: oldestKey });
      return true;
    }
    return false;
  }

  revoke(imageId: string, url?: string) {
    if (!this.cache.has(imageId)) {
      if (url && this.temporaryUrls.delete(url)) {
        URL.revokeObjectURL(url);
      } else if (
        imageId.startsWith('blob:') &&
        this.temporaryUrls.delete(imageId)
      ) {
        URL.revokeObjectURL(imageId);
      } else if (url?.startsWith('blob:') && !this.isCachedUrl(url)) {
        URL.revokeObjectURL(url);
      }
      return;
    }

    const refCount = this.referenceCount.get(imageId) || 0;
    if (refCount > 1) {
      this.referenceCount.set(imageId, refCount - 1);
      logger.debug('Decremented ref count for image', {
        imageId,
        newCount: refCount - 1,
      });
      return;
    }
    if (refCount === 1) {
      this.referenceCount.set(imageId, 0);
    }

    setTimeout(() => {
      const currentRefCount = this.referenceCount.get(imageId) || 0;
      if (currentRefCount > 0) {
        logger.debug(
          'Image acquired new reference during delay, skipping revocation',
          { imageId },
        );
        return;
      }

      const entry = this.cache.get(imageId);
      if (entry) {
        try {
          URL.revokeObjectURL(entry.url);
          this.totalSize -= entry.size;
          this.cache.delete(imageId);
          this.referenceCount.delete(imageId);
          logger.debug('Revoked blob URL for image', { imageId });
        } catch (e) {
          logger.error('Error revoking blob URL for image', {
            imageId,
            error: e,
          });
        }
      }
    }, 100);
  }

  private isCachedUrl(url: string): boolean {
    return Array.from(this.cache.values()).some((entry) => entry.url === url);
  }

  clearAll() {
    const values = Array.from(this.cache.values());
    for (const entry of values) {
      URL.revokeObjectURL(entry.url);
    }
    this.cache.clear();
    this.referenceCount.clear();
    const temporaryUrls = Array.from(this.temporaryUrls);
    for (const url of temporaryUrls) {
      URL.revokeObjectURL(url);
    }
    this.temporaryUrls.clear();
    this.totalSize = 0;

    if (this.cleanupTimer) {
      this.cleanupTimer.stop();
      this.cleanupTimer = null;
    }
    if (this.memoryTimer) {
      this.memoryTimer.stop();
      this.memoryTimer = null;
    }
  }

  private checkMemoryPressure() {
    if (typeof performance === 'undefined' || !(performance as any).memory)
      return;

    const memInfo = (performance as any).memory;
    const percentUsed =
      (memInfo.usedJSHeapSize / memInfo.jsHeapSizeLimit) * 100;

    if (percentUsed >= this.memoryPressureThreshold) {
      logger.warn('Memory pressure detected', {
        percentUsed: `${percentUsed.toFixed(1)}%`,
      });

      const entriesToRemove: string[] = [];
      this.cache.forEach((entry, key) => {
        const refCount = this.referenceCount.get(key) || 0;
        if (refCount === 0) {
          entriesToRemove.push(key);
        }
      });

      entriesToRemove.forEach((key) => {
        const entry = this.cache.get(key);
        if (entry) {
          URL.revokeObjectURL(entry.url);
          this.totalSize -= entry.size;
          this.cache.delete(key);
          this.referenceCount.delete(key);
        }
      });

      if (entriesToRemove.length > 0) {
        logger.info('Emergency cleanup: removed image blobs', {
          count: entriesToRemove.length,
        });
      }
    }
  }

  private cleanupStaleEntries() {
    const now = Date.now();
    const staleTime = this.isMobile() ? 2 * 60 * 1000 : 5 * 60 * 1000;
    const entriesToRemove: string[] = [];

    this.cache.forEach((entry, key) => {
      const refCount = this.referenceCount.get(key) || 0;
      if (refCount > 0) return;

      if (now - entry.lastAccessed > staleTime) {
        entriesToRemove.push(key);
      }
    });

    entriesToRemove.forEach((key) => {
      const entry = this.cache.get(key);
      if (entry) {
        URL.revokeObjectURL(entry.url);
        this.totalSize -= entry.size;
        this.cache.delete(key);
        this.referenceCount.delete(key);
      }
    });

    if (entriesToRemove.length > 0) {
      logger.info('Cleaned up stale image blobs', {
        count: entriesToRemove.length,
      });
    }
  }
}

const blobCache = new ImageBlobCache();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    blobCache.clearAll();
  });
}

export async function fetchImageAsBlob(
  imageRef: ImageReference,
  useThumbnail = false,
): Promise<string> {
  return blobCache.fetchAsBlob(imageRef, useThumbnail);
}

export function revokeImageBlob(imageId: string, url?: string): void {
  blobCache.revoke(imageId, url);
}

export function clearAllImageBlobs(): void {
  blobCache.clearAll();
}
