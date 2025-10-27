import { Message } from '@/types/chat';
import { apiBase } from './api';

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
  }>;
}

// Blob cache for memory optimization
interface BlobCacheEntry {
  url: string;
  size: number;
  lastAccessed: number;
}

class ImageBlobCache {
  private cache = new Map<string, BlobCacheEntry>();
  private totalSize = 0;
  private readonly maxSize = 10 * 1024 * 1024; // 10MB max cache size

  async fetchAsBlob(imageRef: ImageReference): Promise<string> {
    const cacheKey = imageRef.imageId;

    // Check if already cached
    const cached = this.cache.get(cacheKey);
    if (cached) {
      cached.lastAccessed = Date.now();
      return cached.url;
    }

    // Fetch from Redis
    const response = await fetch(getImageUrl(imageRef));
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }

    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);

    // Add to cache with LRU eviction
    this.addToCache(cacheKey, blobUrl, blob.size);

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
      console.log(`Evicted image ${oldestKey} from blob cache`);
    }
  }

  revoke(imageId: string) {
    const entry = this.cache.get(imageId);
    if (entry) {
      URL.revokeObjectURL(entry.url);
      this.totalSize -= entry.size;
      this.cache.delete(imageId);
    }
  }

  clearAll() {
    // Convert to array to avoid iterator issues
    const values = Array.from(this.cache.values());
    for (const entry of values) {
      URL.revokeObjectURL(entry.url);
    }
    this.cache.clear();
    this.totalSize = 0;
  }
}

// Global blob cache instance
const blobCache = new ImageBlobCache();

// Upload image to Redis and return reference
export async function uploadImage(base64Data: string, mimeType: string = 'image/jpeg'): Promise<ImageReference> {
  try {
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
    console.error('Error uploading image:', error);
    throw error;
  }
}

// Get image URL from reference
export function getImageUrl(imageRef: ImageReference): string {
  // Include both sessionId and userId in the URL for maximum compatibility
  let url = `/api/session/imageStorage?imageId=${imageRef.imageId}`;

  if (imageRef.sessionId) {
    url += `&sessionId=${imageRef.sessionId}`;
  }

  // Note: userId is handled server-side through authentication, not passed in URL
  return url;
}

// Export blob cache functions for use in components
export async function fetchImageAsBlob(imageRef: ImageReference): Promise<string> {
  return blobCache.fetchAsBlob(imageRef);
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
          // Check if it's already a reference
          if (attachment.imageRef) {
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
          console.error('Error processing image attachment:', error);
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

    // If message has attachments, preserve sanitized metadata and add text descriptions
    let sanitizedAttachments: any[] | undefined;

    if (message.attachments && message.attachments.length > 0) {
      sanitizedAttachments = message.attachments
        .filter((att: any) => Boolean(att))
        .map((att: any) => {
          if (att.type === 'image') {
            return {
              type: att.type,
              imageRef: att.imageRef ?? null,
              mimeType: att.mimeType,
            };
          }

          return {
            type: att.type,
          };
        });

      if (message.role === 'user') {
        const imageCount = message.attachments.filter((att: any) =>
          att.type === 'image' && (att.imageRef || att.content)
        ).length;

        if (imageCount > 0) {
          // Include imageRef metadata in content so LLM can access it for tool calls
          const imageRefs = message.attachments
            .filter((att: any) => att.type === 'image' && att.imageRef)
            .map((att: any) => att.imageRef);

          const imageText = imageCount === 1 ? '[Image attachment]' : `[${imageCount} image attachments]`;

          // Add structured imageRef data for the LLM to extract
          if (imageRefs.length > 0) {
            // Format the imageRef in a way that's easier for the LLM to parse
            // Include both human-readable and structured formats
            const structuredRefs = imageRefs.map((ref: any, index: number) => {
              const refObj = {
                imageId: ref.imageId,
                sessionId: ref.sessionId,
                mimeType: ref.mimeType || 'image/png'
              };
              return `[IMAGE_REFERENCE_${index + 1}]: ${JSON.stringify(refObj)}`;
            }).join('\n');

            // Also add a clear instruction for the LLM
            const imageInstructions = imageRefs.length === 1
              ? `\n\n**Image Reference for Tools:**\nUse this imageRef parameter: ${JSON.stringify(imageRefs[0])}`
              : `\n\n**Image References for Tools:**\n${imageRefs.map((ref: any, i: number) => `Image ${i + 1}: ${JSON.stringify(ref)}`).join('\n')}`;

            cleanedMessage.content = `${message.content}${message.content ? '\n' : ''}${imageText}\n${structuredRefs}${imageInstructions}`;
          } else {
            cleanedMessage.content = `${message.content}${message.content ? '\n' : ''}${imageText}`;
          }
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
  console.log('cleanMessagesForLLM: Cleaned', messages.length, 'messages for LLM');

  // Debug: Log messages with image references
  const messagesWithImages = cleaned.filter(msg =>
    msg.content && msg.content.includes('[IMAGE_REFERENCE')
  );
  if (messagesWithImages.length > 0) {
    console.log('Messages with image references:', messagesWithImages.map(msg => ({
      role: msg.role,
      contentPreview: msg.content.substring(0, 200) + '...',
      attachments: msg.attachments
    })));
  }

  return cleaned;
}

// Clean messages for storage (remove base64 content but keep image references for UI)
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

// Restore image references in messages (for loading from storage)
export function restoreMessageImages(messages: any[]): any[] {
  return messages.map((message) => {
    if (!message.attachments || message.attachments.length === 0) {
      return message;
    }

    // Ensure all image attachments have proper references and no base64 content
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

  for (const [key, value] of Object.entries(cleaned)) {
    if (typeof value === 'string') {
      // Remove base64 image data
      if (value.startsWith('data:image/') || (value.length > 1000 && value.includes('base64'))) {
        cleaned[key] = '';
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
    console.error('Error deleting image:', error);
    throw error;
  }
}

// Process markdown content to extract and store base64 images, replacing them with references
export async function processMarkdownImages(content: string): Promise<string> {
  if (!content || typeof content !== 'string') {
    return content;
  }

  // Regex to match markdown images with base64 data
  const markdownImageRegex = /!\[([^\]]*)\]\((data:image\/[a-zA-Z]+;base64,[^\)]+)\)/g;

  let processedContent = content;
  const matches = Array.from(content.matchAll(markdownImageRegex));

  // Process each image sequentially to avoid race conditions
  for (const match of matches) {
    try {
      const fullMatch = match[0];
      const altText = match[1] || 'Generated image';
      const base64Data = match[2];

      // Extract mime type from data URL
      const mimeTypeMatch = base64Data.match(/data:(image\/[a-zA-Z]+);base64,/);
      const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : 'image/png';

      // Upload to Redis
      const imageRef = await uploadImage(base64Data, mimeType);

      // Create a reference URL that can be rendered
      const imageUrl = getImageUrl(imageRef);

      // Replace the base64 image with the reference URL
      const replacement = `![${altText}](${imageUrl})`;
      processedContent = processedContent.replace(fullMatch, replacement);

      console.log(`Processed markdown image: ${altText}, stored as ${imageRef.imageId}`);
    } catch (error) {
      console.error('Failed to process markdown image:', error);
      // Keep the original base64 image if processing fails
    }
  }

  return processedContent;
}
