/**
 * Shared sanitization utilities for conversation data stored in Redis.
 * Used by conversationHistory, selectedConversation, and conversations/[id].
 */
import { hasBoundedHtmlImages } from '@/utils/app/embeddedHtmlImages';

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONV = 100;

/**
 * Recursively strip attachment data while retaining bounded assistant HTML
 * display artifacts. Model preparation separately removes inline image bytes.
 */
export function stripBase64FromObject<T>(obj: T): T {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => stripBase64FromObject(item)) as T;
  }

  const cleaned = { ...obj } as Record<string, unknown>;

  for (const [key, value] of Object.entries(cleaned)) {
    if (typeof value === 'string') {
      if (
        key === 'content' &&
        cleaned.role === 'assistant' &&
        hasBoundedHtmlImages(value)
      ) {
        continue;
      }
      // Strip embedded image data URLs and long base64 blobs, but match the
      // actual data-URL marker (`;base64,`) rather than the substring "base64"
      // so long legitimate prose that merely mentions base64 isn't destroyed
      // (F-020).
      if (
        value.startsWith('data:image/') ||
        (value.length > 1000 && value.includes(';base64,'))
      ) {
        cleaned[key] = '';
      }
    } else if (typeof value === 'object' && value !== null) {
      cleaned[key] = stripBase64FromObject(value);
    }
  }

  return cleaned as T;
}

/**
 * Clamp a conversation list to safe sizes:
 *  - At most MAX_CONVERSATIONS conversations (keep most recent).
 *  - At most MAX_MESSAGES_PER_CONV messages per conversation (keep most recent).
 *  - Attachment blobs stripped; bounded assistant HTML photos retained.
 */
export function clampConversations<T extends { messages?: unknown[] }>(
  conversations: T[],
): T[] {
  const trimmed = (conversations || []).slice(-MAX_CONVERSATIONS);
  return trimmed.map((c) => {
    const clamped = {
      ...c,
      messages: (c.messages || []).slice(-MAX_MESSAGES_PER_CONV),
    };
    return stripBase64FromObject(clamped);
  });
}
