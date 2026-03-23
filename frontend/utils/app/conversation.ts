import { Conversation, Message } from '@/types/chat';
import toast from 'react-hot-toast';
import { apiGet, apiPut, apiPost, ConflictError } from '@/utils/app/api';
import { restoreMessageImages, cleanMessagesForStorage, stripBase64Content } from './imageHandler';
import { getUserSessionItem, setUserSessionItem, removeUserSessionItem } from './storage';
import {
  paginateConversation,
  loadConversationMessages,
  enforceConversationSizeLimit,
  cleanupOldConversations as cleanupOldConversationChunks,
  MESSAGES_IN_MEMORY,
  MAX_CONVERSATION_MESSAGES
} from './conversationPagination';

// Memory optimization constants
const MAX_MESSAGES_IN_MEMORY = 50; // Keep only last 50 messages in memory
const MAX_CONVERSATIONS_IN_MEMORY = 5; // Keep only 5 most recent conversations
// WeakMap for temporary data to allow garbage collection
const conversationCache = new WeakMap<Conversation, any>();

/**
 * Fire-and-forget notification to other devices/sessions via Redis pub/sub.
 * Failures are silently logged -- sync is best-effort.
 */
function notifySync(type: string, conversationId?: string, conversation?: Conversation) {
  apiPost('/api/sync/notify', { type, conversationId, conversation }).catch(err => {
    console.warn('Sync notification failed (best-effort):', err);
  });
}

export const updateConversation = (
  updatedConversation: Conversation,
  allConversations: Conversation[],
) => {
  // Limit messages in the conversation
  const limitedConversation = {
    ...updatedConversation,
    messages: updatedConversation.messages.slice(-MAX_MESSAGES_IN_MEMORY)
  };

  const updatedConversations = allConversations.map((c) => {
    if (c.id === limitedConversation.id) {
      return limitedConversation;
    }
    return c;
  });

  // Save operations - run concurrently but track for error handling
  // Using Promise.all to ensure both saves complete, but not blocking the return
  Promise.all([
    saveConversation(limitedConversation),
    saveConversations(updatedConversations)
  ]).catch((error) => {
    console.error('Failed to save conversation updates:', error);
  });

  return {
    single: limitedConversation,
    all: updatedConversations,
  };
};

export const saveConversation = async (conversation: Conversation) => {
  try {
    // Enforce conversation size limit
    await enforceConversationSizeLimit(conversation.id);

    // Paginate conversation to store older messages in IndexedDB
    const paginatedConversation = await paginateConversation(conversation);

    // Clean messages to remove base64 content before storing
    let cleanedConversation = {
      ...paginatedConversation,
      messages: cleanMessagesForStorage(paginatedConversation.messages),
    };

    // Aggressively strip any remaining base64 content as a safety measure
    cleanedConversation = stripBase64Content(cleanedConversation);

    // Cache in sessionStorage (best-effort — data is persisted server-side)
    setUserSessionItem('selectedConversation', JSON.stringify(cleanedConversation));

    // Save to individual conversation endpoint
    try {
      await apiPut(`/api/conversations/${conversation.id}`, cleanedConversation);
    } catch (error) {
      if (error instanceof ConflictError && error.serverState) {
        // Server has newer data — accept it and retry once with merged state
        console.warn('Conflict detected, accepting server state and retrying');
        const merged = {
          ...cleanedConversation,
          ...error.serverState,
          messages: error.serverState.messages?.length >= cleanedConversation.messages.length
            ? error.serverState.messages
            : cleanedConversation.messages,
        };
        await apiPut(`/api/conversations/${conversation.id}`, merged);
        setUserSessionItem('selectedConversation', JSON.stringify(merged));
      } else {
        throw error;
      }
    }

    // Also save to selectedConversation endpoint for cross-device synchronization
    await apiPut('/api/session/selectedConversation', cleanedConversation);

    // Notify other devices/sessions about the update
    notifySync('conversation_updated', conversation.id, cleanedConversation);
  } catch (error) {
    console.error('Failed to persist conversation to server', error);
    throw error;
  }
};

export const saveConversations = async (conversations: Conversation[]) => {
  try {
    // Sort by most recent and limit number of conversations
    const recentConversations = conversations
      .sort((a, b) => {
        const aTime = a.messages[a.messages.length - 1]?.id || a.id;
        const bTime = b.messages[b.messages.length - 1]?.id || b.id;
        return bTime.localeCompare(aTime);
      })
      .slice(0, MAX_CONVERSATIONS_IN_MEMORY);

    // Clean all conversations to remove base64 content before storing
    let cleanedConversations = recentConversations.map(conversation => ({
      ...conversation,
      messages: cleanMessagesForStorage(conversation.messages.slice(-MAX_MESSAGES_IN_MEMORY)),
    }));

    // Aggressively strip any remaining base64 content as a safety measure
    cleanedConversations = stripBase64Content(cleanedConversations);

    // Cache in sessionStorage (best-effort — data is persisted to Redis below).
    // If the payload still exceeds the quota after eviction, progressively
    // reduce what we cache locally until it fits or give up silently.
    cacheConversationsToSession(cleanedConversations);

    // Persist to Redis for cross-session persistence
    await apiPut('/api/session/conversationHistory', cleanedConversations);

    // Notify other devices that the conversation list has changed
    notifySync('conversation_list_changed');
  } catch (error) {
    console.error('Failed to persist conversations to server', error);
    throw error;
  }
};

/**
 * Attempt to write conversation list to sessionStorage with progressive
 * size reduction.  Tries the full list first, then halves the message
 * count per conversation, then reduces conversation count, and finally
 * stores only metadata (no messages) so the sidebar still renders.
 */
function cacheConversationsToSession(conversations: Conversation[]): void {
  const write = (data: Conversation[]) =>
    setUserSessionItem('conversationHistory', JSON.stringify(data));

  // 1. Full payload
  if (write(data(conversations, MAX_MESSAGES_IN_MEMORY))) return;

  // 2. Half the messages per conversation
  if (write(data(conversations, Math.ceil(MAX_MESSAGES_IN_MEMORY / 2)))) return;

  // 3. Fewer conversations (top 2) with minimal messages
  if (write(data(conversations.slice(0, 2), 10))) return;

  // 4. Metadata only — sidebar labels still render
  const metadataOnly = conversations.map(c => ({
    ...c,
    messages: [],
  }));
  write(metadataOnly);
}

function data(conversations: Conversation[], msgLimit: number): Conversation[] {
  return conversations.map(c => ({
    ...c,
    messages: c.messages.slice(-msgLimit),
  }));
}

export const loadConversation = async (loadAllMessages: boolean = false): Promise<Conversation | null> => {
  try {
    let conversation = await apiGet<Conversation | null>('/api/session/selectedConversation');
    if (conversation) {
      // Strip any base64 content that might have been stored
      const cleanedConversation = stripBase64Content(conversation);

      if (cleanedConversation && cleanedConversation.messages) {
        // Restore image references in loaded messages
        cleanedConversation.messages = restoreMessageImages(cleanedConversation.messages);

        // If requested, load all messages from IndexedDB
        if (loadAllMessages && cleanedConversation.messages.length === MESSAGES_IN_MEMORY) {
          try {
            const allMessages = await loadConversationMessages(cleanedConversation.id, 0, MAX_CONVERSATION_MESSAGES);
            if (allMessages.length > 0) {
              // Combine stored messages with recent messages
              cleanedConversation.messages = [...allMessages, ...cleanedConversation.messages];
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

export const loadConversations = async (): Promise<Conversation[]> => {
  try {
    let conversations = await apiGet<Conversation[]>('/api/session/conversationHistory');
    // Strip any base64 content and restore image references in all loaded conversations
    conversations = stripBase64Content(conversations);
    return conversations.map(conv => {
      if (conv.messages) {
        conv.messages = restoreMessageImages(conv.messages);
      }
      return conv;
    });
  } catch (e) {
    return [];
  }
};

// Cleanup function for old messages and conversations
export const cleanupOldConversations = (conversations: Conversation[]): Conversation[] => {
  return conversations
    .sort((a, b) => {
      const aTime = a.messages[a.messages.length - 1]?.id || a.id;
      const bTime = b.messages[b.messages.length - 1]?.id || b.id;
      return bTime.localeCompare(aTime);
    })
    .slice(0, MAX_CONVERSATIONS_IN_MEMORY)
    .map(conversation => ({
      ...conversation,
      messages: conversation.messages.slice(-MAX_MESSAGES_IN_MEMORY)
    }));
};

// Add periodic cleanup of old conversations
// Uses visibility-aware timer to avoid waking CPU when app is backgrounded
if (typeof window !== 'undefined') {
  // Import dynamically to avoid circular dependencies
  import('./visibilityAwareTimer').then(({ createVisibilityAwareInterval }) => {
    // Run cleanup on page load
    cleanupOldConversationChunks().then(deletedCount => {
      if (deletedCount > 0) {
        console.log(`Cleaned up ${deletedCount} old conversation chunks`);
      }
    });

    // Run cleanup every 12 hours, pauses when app is hidden
    createVisibilityAwareInterval(async () => {
      const deletedCount = await cleanupOldConversationChunks();
      if (deletedCount > 0) {
        console.log(`Periodic cleanup: removed ${deletedCount} old conversation chunks`);
      }
    }, {
      interval: 12 * 60 * 60 * 1000, // 12 hours
      pauseWhenHidden: true,
      runImmediatelyOnVisible: false,
    });
  });
}
