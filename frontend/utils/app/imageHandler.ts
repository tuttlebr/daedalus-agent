import { Message } from '@/types/chat';
import { apiBase } from './api';
import { Logger } from '@/utils/logger';

const logger = new Logger('ImageHandler');

export interface ImageReference {
  imageId: string;
  sessionId: string;
  userId?: string; // Added to support user-specific image storage
  mimeType?: string;
  url?: string;
}

export interface ProcessedMessage extends Message {
  attachments?: Array<{
    content: string;
    type: string;
    imageRef?: ImageReference;
    imageRefs?: ImageReference[];
  }>;
}

// Blob cache for memory optimization
interface BlobCacheEntry {
  url: string;
  size: number;
  lastAccessed: number;
}

// Import visibility-aware timer for battery-efficient background operations
let visibilityAwareTimerModule: typeof import('./visibilityAwareTimer') | null = null;

class ImageBlobCache {
  private cache = new Map<string, BlobCacheEntry>();
  private weakCache = new WeakMap<object, string>(); // WeakMap for automatic GC
  private totalSize = 0;
  private readonly maxSize = this.isMobile() ? 2 * 1024 * 1024 : 3 * 1024 * 1024; // 2MB mobile, 3MB desktop
  private cleanupTimer: { stop: () => void } | null = null;
  private memoryTimer: { stop: () => void } | null = null;
  private referenceCount = new Map<string, number>(); // Track active references
  private memoryPressureThreshold = 70.0; // 70% memory usage triggers cleanup

  constructor() {
    // Use visibility-aware timers to save battery when app is backgrounded
    if (typeof window !== 'undefined') {
      import('./visibilityAwareTimer').then((module) => {
        visibilityAwareTimerModule = module;

        // Periodic cleanup of stale entries - pauses when app hidden
        // More frequent on desktop since it's less battery-sensitive
        this.cleanupTimer = module.createVisibilityAwareInterval(
          () => this.cleanupStaleEntries(),
          {
            interval: 60000, // 60s base
            mobileMultiplier: 2, // 120s on mobile
            pauseWhenHidden: true,
          }
        );

        // Monitor memory pressure - less frequently on mobile
        this.memoryTimer = module.createVisibilityAwareInterval(
          () => this.checkMemoryPressure(),
          {
            interval: 30000, // 30s base
            mobileMultiplier: 2, // 60s on mobile
            pauseWhenHidden: true,
          }
        );
      });
    }
  }

  private isMobile(): boolean {
    return typeof window !== 'undefined' && window.innerWidth <= 768;
  }

  async fetchAsBlob(imageRef: ImageReference, useThumbnail = false): Promise<string> {
    // Use different cache key for thumbnails vs full images
    const cacheKey = useThumbnail ? `${imageRef.imageId}-thumb` : imageRef.imageId;

    // Check if already cached
    const cached = this.cache.get(cacheKey);
    if (cached) {
      cached.lastAccessed = Date.now();
      // Increment reference count
      const refCount = this.referenceCount.get(cacheKey) || 0;
      this.referenceCount.set(cacheKey, refCount + 1);
      return cached.url;
    }

    // Fetch from Redis (with thumbnail parameter)
    const response = await fetch(getImageUrl(imageRef, useThumbnail));
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }

    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);

    // Add to cache with LRU eviction
    this.addToCache(cacheKey, blobUrl, blob.size);

    // Also store in WeakMap for automatic cleanup
    this.weakCache.set(imageRef as any, blobUrl);

    // Initialize reference count
    this.referenceCount.set(cacheKey, 1);

    return blobUrl;
  }

  private addToCache(key: string, url: string, size: number) {
    // Evict entries if needed
    while (this.totalSize + size > this.maxSize && this.cache.size > 0) {
      this.evictOldest();
    }

    this.cache.set(key, {
      url,
      size,
      lastAccessed: Date.now()
    });
    this.totalSize += size;
  }

  private evictOldest() {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    // Convert to array to avoid iterator issues
    const entries = Array.from(this.cache.entries());
    for (const [key, entry] of entries) {
      // Skip items that are still referenced
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
    }
  }

  revoke(imageId: string) {
    // Decrement reference count
    const refCount = this.referenceCount.get(imageId) || 0;
    if (refCount > 1) {
      this.referenceCount.set(imageId, refCount - 1);
      logger.debug('Decremented ref count for image', { imageId, newCount: refCount - 1 });
      return; // Don't actually revoke if still referenced
    }

    // Small delay to handle race conditions where image might still be loading
    setTimeout(() => {
      // Double-check reference count after delay
      const currentRefCount = this.referenceCount.get(imageId) || 0;
      if (currentRefCount > 0) {
        logger.debug('Image acquired new reference during delay, skipping revocation', { imageId });
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
          logger.error('Error revoking blob URL for image', { imageId, error: e });
        }
      }
    }, 100); // 100ms delay to allow for race conditions
  }

  clearAll() {
    // Convert to array to avoid iterator issues
    const values = Array.from(this.cache.values());
    for (const entry of values) {
      URL.revokeObjectURL(entry.url);
    }
    this.cache.clear();
    this.referenceCount.clear();
    this.totalSize = 0;

    // Stop visibility-aware timers
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
    if (typeof performance === 'undefined' || !(performance as any).memory) return;

    const memInfo = (performance as any).memory;
    const percentUsed = (memInfo.usedJSHeapSize / memInfo.jsHeapSizeLimit) * 100;

    if (percentUsed >= this.memoryPressureThreshold) {
      logger.warn('Memory pressure detected', { percentUsed: `${percentUsed.toFixed(1)}%` });

      // Aggressive cleanup - remove all unreferenced entries
      const entriesToRemove: string[] = [];
      this.cache.forEach((entry, key) => {
        const refCount = this.referenceCount.get(key) || 0;
        if (refCount === 0) {
          entriesToRemove.push(key);
        }
      });

      entriesToRemove.forEach(key => {
        const entry = this.cache.get(key);
        if (entry) {
          URL.revokeObjectURL(entry.url);
          this.totalSize -= entry.size;
          this.cache.delete(key);
          this.referenceCount.delete(key);
        }
      });

      if (entriesToRemove.length > 0) {
        logger.info('Emergency cleanup: removed image blobs', { count: entriesToRemove.length });
      }
    }
  }

  private cleanupStaleEntries() {
    const now = Date.now();
    const staleTime = this.isMobile() ? 2 * 60 * 1000 : 5 * 60 * 1000; // 2 minutes mobile, 5 minutes desktop
    const entriesToRemove: string[] = [];

    this.cache.forEach((entry, key) => {
      // Don't remove if still referenced
      const refCount = this.referenceCount.get(key) || 0;
      if (refCount > 0) return;

      if (now - entry.lastAccessed > staleTime) {
        entriesToRemove.push(key);
      }
    });

    entriesToRemove.forEach(key => {
      const entry = this.cache.get(key);
      if (entry) {
        URL.revokeObjectURL(entry.url);
        this.totalSize -= entry.size;
        this.cache.delete(key);
        this.referenceCount.delete(key);
      }
    });

    if (entriesToRemove.length > 0) {
      logger.info('Cleaned up stale image blobs', { count: entriesToRemove.length });
    }
  }
}

// Global blob cache instance
const blobCache = new ImageBlobCache();

// Clean up on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    blobCache.clearAll();
  });

  // Note: We intentionally do NOT clear the blob cache on visibility change.
  // Clearing all blobs when the page is hidden causes images to disappear
  // because the OptimizedImage components still reference those blob URLs.
  // The existing stale entry cleanup (every 30-60 seconds) and memory pressure
  // cleanup are sufficient for memory management without breaking displayed images.
}

// Upload image to Redis and return reference
export async function uploadImage(base64Data: string, mimeType: string = 'image/jpeg'): Promise<ImageReference> {
  try {
    // Server-side: directly call the storage function to avoid HTTP overhead and session issues
    if (typeof window === 'undefined') {
      const { storeImage } = await import('@/pages/api/session/imageStorage');
      const { randomUUID } = await import('crypto');

      // Generate a session ID for server-side image storage
      // This allows images to be stored without an actual HTTP session
      const sessionId = randomUUID();
      const userId = undefined; // Server-side generated images are not user-specific

      const imageId = await storeImage(sessionId, userId, base64Data, mimeType);

      return { imageId, sessionId, userId, mimeType };
    }

    // Client-side: use HTTP API
    const response = await fetch('/api/session/imageStorage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ base64Data, mimeType }),
    });

    if (!response.ok) {
      throw new Error('Failed to upload image');
    }

    const { imageId, sessionId, userId } = await response.json();
    return { imageId, sessionId, userId, mimeType };
  } catch (error) {
    logger.error('Error uploading image', error);
    throw error;
  }
}

// Get image URL from reference
export function getImageUrl(imageRef: ImageReference, useThumbnail = false): string {
  // Generated images use the /api/generated-image/{id} endpoint
  if (imageRef.sessionId === 'generated') {
    const thumbnailParam = useThumbnail ? '?thumbnail=true' : '';
    if (typeof window === 'undefined') {
      const port = process.env.PORT || '3000';
      return `http://127.0.0.1:${port}/api/generated-image/${imageRef.imageId}${thumbnailParam}`;
    }
    return `/api/generated-image/${imageRef.imageId}${thumbnailParam}`;
  }

  // Server-side: need full URL for fetch
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

  // Client-side: use relative URL
  let url = `/api/session/imageStorage?imageId=${imageRef.imageId}`;
  if (imageRef.sessionId) {
    url += `&sessionId=${imageRef.sessionId}`;
  }
  if (useThumbnail) {
    url += '&thumbnail=true';
  }

  // Note: userId is handled server-side through authentication, not passed in URL
  return url;
}

// Export blob cache functions for use in components
export async function fetchImageAsBlob(imageRef: ImageReference, useThumbnail = false): Promise<string> {
  return blobCache.fetchAsBlob(imageRef, useThumbnail);
}

export function revokeImageBlob(imageId: string): void {
  blobCache.revoke(imageId);
}

export function clearAllImageBlobs(): void {
  blobCache.clearAll();
}

// Process message to replace base64 images with references
export async function processMessageImages(message: ProcessedMessage): Promise<ProcessedMessage> {
  if (!message.attachments || message.attachments.length === 0) {
    return message;
  }

  const processedAttachments = await Promise.all(
    message.attachments.map(async (attachment) => {
      if (attachment.type === 'image' && attachment.content) {
        try {
          // Check if it's already a reference (single or multiple)
          if (attachment.imageRef || attachment.imageRefs) {
            return attachment;
          }

          // Upload image and get reference
          const imageRef = await uploadImage(attachment.content);

          // Return attachment with reference instead of base64
          return {
            ...attachment,
            content: '', // Clear the base64 content
            imageRef,
          };
        } catch (error) {
          logger.error('Error processing image attachment', error);
          // Return original attachment if processing fails
          return attachment;
        }
      }
      return attachment;
    })
  );

  return {
    ...message,
    attachments: processedAttachments,
  };
}

// Clean messages for LLM (remove image data, keep only references)
export function cleanMessagesForLLM(messages: any[]): Message[] {
  const cleaned = messages.map((message) => {
    // Create a clean copy of the message
    const cleanedMessage: any = {
      role: message.role,
      content: message.content || '',
      id: message.id,
    };

    // Preserve metadata (includes useDeepThinker flag)
    if (message.metadata) {
      cleanedMessage.metadata = message.metadata;
    }

    // Clean up HTML comment markers but KEEP the extracted document text content
    // This allows the LLM to reference document content in subsequent messages
    if (typeof cleanedMessage.content === 'string') {
      cleanedMessage.content = cleanedMessage.content
        .replace(/<!-- DOCUMENT_EXTRACT_START -->/g, '\n--- Extracted Document Text ---\n')
        .replace(/<!-- DOCUMENT_EXTRACT_END -->/g, '\n--- End of Extracted Text ---\n')
        .trim();
    }

    // If message has attachments, preserve sanitized metadata and add text descriptions
    let sanitizedAttachments: any[] | undefined;

    if (message.attachments && message.attachments.length > 0) {
      sanitizedAttachments = message.attachments
        .filter((att: any) => Boolean(att))
        .map((att: any) => {
          if (att.type === 'image') {
            const result: Record<string, unknown> = {
              type: att.type,
              mimeType: att.mimeType,
            };
            if (att.imageRef) result.imageRef = att.imageRef;
            if (att.imageRefs && Array.isArray(att.imageRefs)) result.imageRefs = att.imageRefs;
            return result;
          }

          if (att.type === 'video') {
            const result: Record<string, unknown> = {
              type: att.type,
              mimeType: att.mimeType,
            };
            if (att.videoRef) result.videoRef = att.videoRef;
            if (att.videoRefs && Array.isArray(att.videoRefs)) result.videoRefs = att.videoRefs;
            return result;
          }

          if (att.type === 'document') {
            const result: Record<string, unknown> = {
              type: att.type,
              content: att.content,
              mimeType: att.mimeType,
            };
            if (att.documentRef) result.documentRef = att.documentRef;
            return result;
          }

          if (att.type === 'transcript') {
            const result: Record<string, unknown> = {
              type: att.type,
              mimeType: att.mimeType,
            };
            if (att.vttRef) result.vttRef = att.vttRef;
            return result;
          }

          return {
            type: att.type,
          };
        });

      if (message.role === 'user') {
        // Collect all image references from both imageRef (single) and imageRefs (array)
        const allImageRefs: any[] = [];
        message.attachments.forEach((att: any) => {
          if (att.type === 'image') {
            if (att.imageRef) allImageRefs.push(att.imageRef);
            if (att.imageRefs && Array.isArray(att.imageRefs)) {
              allImageRefs.push(...att.imageRefs);
            }
          }
        });

        // Collect all video references from both videoRef (single) and videoRefs (array)
        const allVideoRefs: any[] = [];
        message.attachments.forEach((att: any) => {
          if (att.type === 'video') {
            if (att.videoRef) allVideoRefs.push(att.videoRef);
            if (att.videoRefs && Array.isArray(att.videoRefs)) {
              allVideoRefs.push(...att.videoRefs);
            }
          }
        });

        // Calculate actual image count (number of image refs, not attachments)
        const imageCount = allImageRefs.length > 0 ? allImageRefs.length : message.attachments.filter((att: any) =>
          att.type === 'image' && att.content
        ).length;

        // Calculate actual video count
        const videoCount = allVideoRefs.length;

        let contentAdditions = '';

        if (imageCount > 0) {
          const imageText = imageCount === 1 ? '[Image attachment]' : `[${imageCount} image attachments]`;

          // Add structured imageRef data for the LLM to extract
          if (allImageRefs.length > 0) {
            // Format the imageRef in a way that's easier for the LLM to parse
            // Include both human-readable and structured formats
            const structuredRefs = allImageRefs.map((ref: any, index: number) => {
              const refObj = {
                imageId: ref.imageId,
                sessionId: ref.sessionId,
                mimeType: ref.mimeType || 'image/png',
                ...(ref.userId && { userId: ref.userId }),
              };
              return `[IMAGE_REFERENCE_${index + 1}]: ${JSON.stringify(refObj)}`;
            }).join('\n');

            // Also add a clear instruction for the LLM
            const imageInstructions = allImageRefs.length === 1
              ? `\n\n**Image Reference for Tools:**\nUse this imageRef parameter: ${JSON.stringify(allImageRefs[0])}`
              : `\n\n**Image References for Tools:**\n${allImageRefs.map((ref: any, i: number) => `Image ${i + 1}: ${JSON.stringify(ref)}`).join('\n')}`;

            contentAdditions += `${imageText}\n${structuredRefs}${imageInstructions}`;
          } else {
            contentAdditions += imageText;
          }
        }

        if (videoCount > 0) {
          const videoText = videoCount === 1 ? '[Video attachment]' : `[${videoCount} video attachments]`;

          // Add structured videoRef data for the LLM to extract
          if (allVideoRefs.length > 0) {
            const structuredRefs = allVideoRefs.map((ref: any, index: number) => {
              const refObj = {
                videoId: ref.videoId,
                sessionId: ref.sessionId,
                mimeType: ref.mimeType || 'video/mp4',
                filename: ref.filename,
                ...(ref.userId && { userId: ref.userId }),
              };
              return `[VIDEO_REFERENCE_${index + 1}]: ${JSON.stringify(refObj)}`;
            }).join('\n');

            // Also add a clear instruction for the LLM
            const videoInstructions = allVideoRefs.length === 1
              ? `\n\n**Video Reference for Tools:**\nUse this videoRef parameter: ${JSON.stringify(allVideoRefs[0])}`
              : `\n\n**Video References for Tools:**\n${allVideoRefs.map((ref: any, i: number) => `Video ${i + 1}: ${JSON.stringify(ref)}`).join('\n')}`;

            if (contentAdditions) contentAdditions += '\n';
            contentAdditions += `${videoText}\n${structuredRefs}${videoInstructions}`;
          } else {
            if (contentAdditions) contentAdditions += '\n';
            contentAdditions += videoText;
          }
        }

        // Collect all document references
        const allDocumentRefs: any[] = [];
        message.attachments.forEach((att: any) => {
          if (att.type === 'document' && att.documentRef) {
            allDocumentRefs.push({ ...att.documentRef, filename: att.content || att.documentRef?.filename });
          }
        });

        if (allDocumentRefs.length > 0) {
          const docText = allDocumentRefs.length === 1
            ? `[Document attachment: ${allDocumentRefs[0].filename || 'document'}]`
            : `[${allDocumentRefs.length} document attachments]`;

          const structuredRefs = allDocumentRefs.map((ref: any, index: number) => {
            return `[DOCUMENT_REFERENCE_${index + 1}]: ${JSON.stringify(ref)}`;
          }).join('\n');

          const docInstructions = allDocumentRefs.length === 1
            ? `\n\n**Document Reference for Tools:**\nUse this documentRef parameter: ${JSON.stringify(allDocumentRefs[0])}`
            : `\n\n**Document References for Tools:**\n${allDocumentRefs.map((ref: any, i: number) => `Document ${i + 1}: ${JSON.stringify(ref)}`).join('\n')}`;

          // Check if message metadata requests ingestion to a specific collection
          const targetCollection = message.metadata?.targetCollection;
          const ingestInstruction = targetCollection
            ? `\n\n**Ingestion Target:** Use the nv_ingest_postprocessing_tool to ingest this document into the "${targetCollection}" collection.`
            : '';

          if (contentAdditions) contentAdditions += '\n';
          contentAdditions += `${docText}\n${structuredRefs}${docInstructions}${ingestInstruction}`;
        }

        // Collect all VTT/transcript references
        const allVttRefs: any[] = [];
        message.attachments.forEach((att: any) => {
          if (att.type === 'transcript' && att.vttRef) {
            allVttRefs.push(att.vttRef);
          }
        });

        if (allVttRefs.length > 0) {
          const vttText = allVttRefs.length === 1
            ? `[Transcript attachment: ${allVttRefs[0].filename || 'transcript'}]`
            : `[${allVttRefs.length} transcript attachments]`;

          const structuredRefs = allVttRefs.map((ref: any, index: number) => {
            return `[VTT_REFERENCE_${index + 1}]: ${JSON.stringify(ref)}`;
          }).join('\n');

          const vttInstructions = allVttRefs.length === 1
            ? `\n\n**Transcript Reference for Tools:**\nUse this vttRef parameter: ${JSON.stringify(allVttRefs[0])}`
            : `\n\n**Transcript References for Tools:**\n${allVttRefs.map((ref: any, i: number) => `Transcript ${i + 1}: ${JSON.stringify(ref)}`).join('\n')}`;

          if (contentAdditions) contentAdditions += '\n';
          contentAdditions += `${vttText}\n${structuredRefs}${vttInstructions}`;
        }

        if (contentAdditions) {
          cleanedMessage.content = `${message.content}${message.content ? '\n' : ''}${contentAdditions}`;
        }
      }
    }

    // Remove any properties that might contain base64 data
    const keysToRemove = ['inputFileContent', 'inputFileContentCompressed'];
    keysToRemove.forEach(key => {
      if (key in cleanedMessage) {
        delete (cleanedMessage as any)[key];
      }
    });

    if (sanitizedAttachments && sanitizedAttachments.length > 0) {
      cleanedMessage.attachments = sanitizedAttachments;
    }

    return cleanedMessage;
  });

  // Log the cleaning operation for debugging
  logger.debug('cleanMessagesForLLM: Cleaned messages for LLM', { messageCount: messages.length });

  // Debug: Log messages with image references
  const messagesWithImages = cleaned.filter(msg =>
    msg.content && msg.content.includes('[IMAGE_REFERENCE')
  );
  if (messagesWithImages.length > 0) {
    logger.debug('Messages with image references', messagesWithImages.map(msg => ({
      role: msg.role,
      contentPreview: msg.content.substring(0, 200) + '...',
      attachments: msg.attachments
    })));
  }

  // Drop assistant messages with empty/whitespace-only content to prevent
  // 400 errors from LLMs that reject blank ContentBlock text fields.
  return cleaned.filter((msg) => {
    if (msg.role === 'assistant') {
      const content = typeof msg.content === 'string' ? msg.content.trim() : msg.content;
      if (!content || content === '') return false;
    }
    return true;
  });
}

// Clean messages for storage (remove base64 content but keep image/video references for UI)
export function cleanMessagesForStorage(messages: any[]): any[] {
  return messages.map((message) => {
    if (!message.attachments || message.attachments.length === 0) {
      return message;
    }

    // Clean attachments to remove base64 content but keep references
    const cleanedAttachments = message.attachments.map((attachment: any) => {
      if (attachment.type === 'image') {
        // If attachment has base64 content, remove it but keep the reference
        if (attachment.content && (
          attachment.content.startsWith('data:image/') ||
          attachment.content.length > 1000 // Any large content is likely base64
        )) {
          return {
            ...attachment,
            content: '', // Remove base64 to prevent storage bloat
          };
        }
      }
      if (attachment.type === 'video') {
        // If attachment has base64 content, remove it but keep the reference
        if (attachment.content && (
          attachment.content.startsWith('data:video/') ||
          attachment.content.length > 1000 // Any large content is likely base64
        )) {
          return {
            ...attachment,
            content: '', // Remove base64 to prevent storage bloat
          };
        }
      }
      return attachment;
    });

    // Also remove any other properties that might contain base64
    const cleanedMessage = { ...message };
    const keysToRemove = ['inputFileContent', 'inputFileContentCompressed'];
    keysToRemove.forEach(key => {
      if (key in cleanedMessage) {
        delete cleanedMessage[key];
      }
    });

    return {
      ...cleanedMessage,
      attachments: cleanedAttachments,
    };
  });
}

// Restore image/video references in messages (for loading from storage)
export function restoreMessageImages(messages: any[]): any[] {
  return messages.map((message) => {
    if (!message.attachments || message.attachments.length === 0) {
      return message;
    }

    // Ensure all image/video attachments have proper references and no base64 content
    const restoredAttachments = message.attachments.map((attachment: any) => {
      if (attachment.type === 'image') {
        // Remove any base64 content that might have been stored
        if (attachment.content && (
          attachment.content.startsWith('data:image/') ||
          attachment.content.length > 1000
        )) {
          return {
            ...attachment,
            content: '', // Clear base64 content
          };
        }
        return attachment;
      }
      if (attachment.type === 'video') {
        // Remove any base64 content that might have been stored
        if (attachment.content && (
          attachment.content.startsWith('data:video/') ||
          attachment.content.length > 1000
        )) {
          return {
            ...attachment,
            content: '', // Clear base64 content
          };
        }
        return attachment;
      }
      return attachment;
    });

    return {
      ...message,
      attachments: restoredAttachments,
    };
  });
}

// Aggressively remove any base64 content from objects (recursive)
export function stripBase64Content(obj: any): any {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => stripBase64Content(item));
  }

  const cleaned = { ...obj };

  const dataUrlRegex = /data:(image|video|application|text)\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;

  for (const [key, value] of Object.entries(cleaned)) {
    if (typeof value === 'string') {
      // Drop raw data URLs and strip embedded ones without nuking full content.
      if (
        value.startsWith('data:image/') ||
        value.startsWith('data:video/') ||
        value.startsWith('data:application/') ||
        value.startsWith('data:text/')
      ) {
        cleaned[key] = '';
        continue;
      }

      if (dataUrlRegex.test(value)) {
        cleaned[key] = value.replace(dataUrlRegex, '[base64 omitted]');
      }
    } else if (typeof value === 'object' && value !== null) {
      cleaned[key] = stripBase64Content(value);
    }
  }

  return cleaned;
}

// Delete image from storage
export async function deleteImage(imageId: string): Promise<void> {
  try {
    const response = await fetch(`/api/session/imageStorage?imageId=${imageId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error('Failed to delete image');
    }
  } catch (error) {
    logger.error('Error deleting image', error);
    throw error;
  }
}

// Process markdown content to extract and store base64 images, replacing them with references
export async function processMarkdownImages(content: string): Promise<string> {
  if (!content || typeof content !== 'string') {
    return content;
  }

  // Regex to match markdown images: ![alt](url)
  // We use a non-greedy match for the URL part to handle standard markdown links
  // This is more robust than matching specifically for data:image inside the regex
  const markdownImageRegex = /!\[([^\]]*)\]\((.*?)\)/g;

  let processedContent = content;
  const matches = Array.from(content.matchAll(markdownImageRegex));

  // Process each image sequentially to avoid race conditions
  for (const match of matches) {
    try {
      const fullMatch = match[0];
      const altText = match[1] || 'Generated image';
      const url = match[2];

      // Check if URL is a data URI with base64 image
      // We trim whitespace to handle potential formatting issues
      if (url && url.trim().startsWith('data:image/') && url.includes('base64,')) {
        const base64Data = url.trim();

        // Extract mime type from data URL
        const mimeTypeMatch = base64Data.match(/data:(image\/[a-zA-Z0-9+.-]+);base64,/);
        const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : 'image/png';

        // Upload to Redis
        const imageRef = await uploadImage(base64Data, mimeType);

        // Create a reference URL that can be rendered
        const imageUrl = getImageUrl(imageRef);

        // Replace the base64 image with the reference URL
        processedContent = processedContent.replace(fullMatch, `![${altText}](${imageUrl})`);

        logger.debug('Processed markdown image', { altText, imageId: imageRef.imageId });
      }
    } catch (error) {
      logger.error('Failed to process markdown image', error);
      // Keep the original base64 image if processing fails
    }
  }

  return processedContent;
}

// Extract image IDs from message content and attachments
export function extractImageReferences(messages: any[]): string[] {
  const imageIds: string[] = [];
  const seenIds = new Set<string>();

  for (const message of messages) {
    // Extract from attachments
    if (message.attachments && Array.isArray(message.attachments)) {
      for (const attachment of message.attachments) {
        if (attachment.type === 'image') {
          // Single imageRef
          if (attachment.imageRef?.imageId && !seenIds.has(attachment.imageRef.imageId)) {
            imageIds.push(attachment.imageRef.imageId);
            seenIds.add(attachment.imageRef.imageId);
          }
          // Multiple imageRefs
          if (attachment.imageRefs && Array.isArray(attachment.imageRefs)) {
            for (const ref of attachment.imageRefs) {
              if (ref.imageId && !seenIds.has(ref.imageId)) {
                imageIds.push(ref.imageId);
                seenIds.add(ref.imageId);
              }
            }
          }
        }
      }
    }

    // Extract from message content (markdown image URLs)
    if (message.content && typeof message.content === 'string') {
      // Match image storage URLs: /api/session/imageStorage?imageId=...
      const urlPattern = /\/api\/session\/imageStorage\?imageId=([a-f0-9]+)/g;
      let match;
      while ((match = urlPattern.exec(message.content)) !== null) {
        const imageId = match[1];
        if (!seenIds.has(imageId)) {
          imageIds.push(imageId);
          seenIds.add(imageId);
        }
      }

      // Match generated image URLs: /api/generated-image/{uuid}
      const generatedPattern = /\/api\/generated-image\/([a-f0-9-]+)/g;
      while ((match = generatedPattern.exec(message.content)) !== null) {
        const imageId = match[1];
        if (!seenIds.has(imageId)) {
          imageIds.push(imageId);
          seenIds.add(imageId);
        }
      }

      // Also match IMAGE_REFERENCE patterns from LLM context
      const refPattern = /\[IMAGE_REFERENCE_\d+\]:\s*(\{[^}]+\})/g;
      while ((match = refPattern.exec(message.content)) !== null) {
        try {
          const refObj = JSON.parse(match[1]);
          if (refObj.imageId && !seenIds.has(refObj.imageId)) {
            imageIds.push(refObj.imageId);
            seenIds.add(refObj.imageId);
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    }
  }

  return imageIds;
}
