import { apiGet, apiPut, apiPost, ConflictError } from '@/utils/app/api';

import { Conversation } from '@/types/chat';

import {
  paginateConversation,
  loadConversationMessages,
  enforceConversationSizeLimit,
  cleanupOldConversations as cleanupOldConversationChunks,
  MESSAGES_IN_MEMORY,
  MAX_CONVERSATION_MESSAGES,
} from './conversationPagination';
import { sanitizeConversationAssistantReplays } from './conversationReplay';
import {
  restoreMessageImages,
  cleanMessagesForStorage,
  stripBase64Content,
} from './imageHandler';
import { setUserSessionItem } from './storage';

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
    // Enforce conversation size limit
    await enforceConversationSizeLimit(conversation.id);

    // Clean the complete conversation for the server. Local cache pagination
    // must not become the authoritative chat history sent to the backend.
    let cleanedConversation = sanitizeConversationAssistantReplays(
      stripBase64Content({
        ...conversation,
        messages: cleanMessagesForStorage(conversation.messages),
      }),
    );

    const cachedConversation = await paginateConversation(cleanedConversation);

    // Cache in sessionStorage (best-effort — data is persisted server-side)
    setUserSessionItem(
      'selectedConversation',
      JSON.stringify(cachedConversation),
    );

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
        setUserSessionItem('selectedConversation', JSON.stringify(merged));
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

export const loadConversation = async (
  loadAllMessages: boolean = false,
): Promise<Conversation | null> => {
  try {
    let conversation = await apiGet<Conversation | null>(
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

        // If requested, load all messages from IndexedDB
        if (
          loadAllMessages &&
          cleanedConversation.messages.length === MESSAGES_IN_MEMORY
        ) {
          try {
            const allMessages = await loadConversationMessages(
              cleanedConversation.id,
              0,
              MAX_CONVERSATION_MESSAGES,
            );
            if (allMessages.length > 0) {
              // Combine stored messages with recent messages
              cleanedConversation.messages = [
                ...allMessages,
                ...cleanedConversation.messages,
              ];
            }
          } catch (error) {
            console.error('Failed to load paginated messages:', error);
          }
        }
      }

      return cleanedConversation;
    }
    return conversation;
  } catch (e) {
    return null;
  }
};

// Add periodic cleanup of old conversations
// Uses visibility-aware timer to avoid waking CPU when app is backgrounded
if (typeof window !== 'undefined') {
  // Import dynamically to avoid circular dependencies
  import('./visibilityAwareTimer').then(({ createVisibilityAwareInterval }) => {
    // Run cleanup on page load
    cleanupOldConversationChunks().then((deletedCount) => {
      if (deletedCount > 0) {
        console.log(`Cleaned up ${deletedCount} old conversation chunks`);
      }
    });

    // Run cleanup every 12 hours, pauses when app is hidden
    createVisibilityAwareInterval(
      async () => {
        const deletedCount = await cleanupOldConversationChunks();
        if (deletedCount > 0) {
          console.log(
            `Periodic cleanup: removed ${deletedCount} old conversation chunks`,
          );
        }
      },
      {
        interval: 12 * 60 * 60 * 1000, // 12 hours
        pauseWhenHidden: true,
        runImmediatelyOnVisible: false,
      },
    );
  });
}
