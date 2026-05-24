/**
 * Shared sanitization utilities for conversation data stored in Redis.
 * Used by conversationHistory, selectedConversation, and conversations/[id].
 */

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONV = 100;

/**
 * Recursively strip base64-encoded image data from an object to prevent
 * storage bloat and LLM context overflow.
 */
export function stripBase64FromObject<T>(obj: T): T {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => stripBase64FromObject(item)) as T;
  }

  const cleaned = { ...obj } as Record<string, unknown>;

  for (const [key, value] of Object.entries(cleaned)) {
    if (typeof value === 'string') {
      if (value.startsWith('data:image/') || (value.length > 1000 && value.includes('base64'))) {
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
 *  - All base64 content stripped.
 */
export function clampConversations<T extends { messages?: unknown[] }>(conversations: T[]): T[] {
  const trimmed = (conversations || []).slice(-MAX_CONVERSATIONS);
  return trimmed.map((c) => {
    const clamped = {
      ...c,
      messages: (c.messages || []).slice(-MAX_MESSAGES_PER_CONV),
    };
    return stripBase64FromObject(clamped);
  });
}
