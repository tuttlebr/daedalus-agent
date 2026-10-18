import { apiGet, apiPut, apiPost, ConflictError } from '@/utils/app/api';

import { Conversation } from '@/types/chat';

import { sanitizeConversationAssistantReplays } from './conversationReplay';
import {
  restoreMessageImages,
  cleanMessagesForStorage,
  stripBase64Content,
} from './imageHandler';
import { setUserSessionItem } from './storage';

const CACHED_MESSAGE_LIMIT = 50;

function cacheSelectedConversation(conversation: Conversation): void {
  try {
    setUserSessionItem(
      'selectedConversation',
      JSON.stringify({
        ...conversation,
        messages: conversation.messages.slice(-CACHED_MESSAGE_LIMIT),
      }),
    );
  } catch (error) {
    // Browser storage may be disabled. Redis remains the authoritative history.
    console.warn('Failed to cache selected conversation', error);
  }
}

/**
 * Fire-and-forget notification to other devices/sessions via Redis pub/sub.
 * Failures are silently logged -- sync is best-effort.
 */
function notifySync(
  type: string,
  conversationId?: string,
  conversation?: Conversation,
) {
  apiPost('/api/sync/notify', { type, conversationId, conversation }).catch(
    (err) => {
      console.warn('Sync notification failed (best-effort):', err);
    },
  );
}

export const saveConversation = async (conversation: Conversation) => {
  try {
    // Persist complete history; only the browser's selection cache is bounded.
    const cleanedConversation = sanitizeConversationAssistantReplays(
      stripBase64Content({
        ...conversation,
        messages: cleanMessagesForStorage(conversation.messages),
      }),
    );

    cacheSelectedConversation(cleanedConversation);

    let persistedConversation = cleanedConversation;

    // Save to individual conversation endpoint
    try {
      await apiPut(
        `/api/conversations/${conversation.id}`,
        cleanedConversation,
      );
    } catch (error) {
      if (error instanceof ConflictError && error.serverState) {
        const merged = {
          ...cleanedConversation,
          ...error.serverState,
          messages:
            error.serverState.messages?.length >=
            cleanedConversation.messages.length
              ? error.serverState.messages
              : cleanedConversation.messages,
        };
        await apiPut(`/api/conversations/${conversation.id}`, merged);
        persistedConversation = merged;
        cacheSelectedConversation(merged);
      } else {
        throw error;
      }
    }

    // Also save to selectedConversation endpoint for cross-device synchronization
    await apiPut('/api/session/selectedConversation', persistedConversation);

    // Notify other devices/sessions about the update
    notifySync('conversation_updated', conversation.id, persistedConversation);
  } catch (error) {
    console.error('Failed to persist conversation to server', error);
    throw error;
  }
};

export const loadConversation = async (): Promise<Conversation | null> => {
  try {
    const conversation = await apiGet<Conversation | null>(
      '/api/session/selectedConversation',
    );
    if (conversation) {
      // Strip any base64 content that might have been stored
      const cleanedConversation = sanitizeConversationAssistantReplays(
        stripBase64Content(conversation),
      );

      if (cleanedConversation && cleanedConversation.messages) {
        // Restore image references in loaded messages
        cleanedConversation.messages = restoreMessageImages(
          cleanedConversation.messages,
        );
      }

      return cleanedConversation;
    }
    return conversation;
  } catch (e) {
    return null;
  }
};
