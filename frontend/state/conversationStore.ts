/**
 * Conversation Store - Zustand-based state management for conversations
 *
 * This store provides a single source of truth for conversation state,
 * replacing the previous combination of:
 * - HomeContext (conversations, selectedConversation)
 * - Refs (selectedConversationRef, conversationsRef, streamingByConversationIdRef)
 * - Local state (streamingByConversationId)
 *
 * Benefits:
 * - No stale closure bugs (refs not needed)
 * - Atomic updates
 * - Selective subscriptions (only re-render when needed)
 * - Persistence middleware ready
 * - DevTools integration
 *
 * @requires zustand - Run: npm install zustand
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { Conversation, Message } from '@/types/chat';
import { IntermediateStep } from '@/types/intermediateSteps';
import { Logger } from '@/utils/logger';

const logger = new Logger('ConversationStore');

// ============================================================================
// Types
// ============================================================================

export interface ConversationState {
  // Core state
  conversations: Conversation[];
  selectedConversationId: string | null;
  streamingConversationIds: Set<string>;

  // Loading states
  isLoading: boolean;
  isSyncing: boolean;

  // Error state
  error: string | null;

  // Computed (implemented as getters in the store)
  // - selectedConversation
  // - isSelectedConversationStreaming
  // - conversationCount
}

export interface ConversationActions {
  // Conversation CRUD
  setConversations: (conversations: Conversation[]) => void;
  addConversation: (conversation: Conversation) => void;
  updateConversation: (id: string, updates: Partial<Conversation>) => void;
  deleteConversation: (id: string) => void;
  clearConversations: () => void;

  // Selection
  selectConversation: (id: string | null) => void;

  // Messages
  addMessage: (conversationId: string, message: Message) => void;
  updateLastMessage: (conversationId: string, updates: Partial<Message>) => void;
  updateMessageIntermediateSteps: (
    conversationId: string,
    messageIndex: number,
    steps: IntermediateStep[]
  ) => void;

  // Streaming
  setStreaming: (conversationId: string, isStreaming: boolean) => void;
  isStreaming: (conversationId: string) => boolean;

  // Loading
  setLoading: (isLoading: boolean) => void;
  setSyncing: (isSyncing: boolean) => void;

  // Error
  setError: (error: string | null) => void;

  // Bulk operations
  replaceConversation: (id: string, conversation: Conversation) => void;
  upsertConversation: (conversation: Conversation) => void;

  // Reset
  reset: () => void;
}

export type ConversationStore = ConversationState & ConversationActions;

// ============================================================================
// Initial State
// ============================================================================

const initialState: ConversationState = {
  conversations: [],
  selectedConversationId: null,
  streamingConversationIds: new Set(),
  isLoading: false,
  isSyncing: false,
  error: null,
};

// ============================================================================
// Store
// ============================================================================

export const useConversationStore = create<ConversationStore>()(
  subscribeWithSelector(
    immer((set, get) => ({
      // Initial state
      ...initialState,

      // ========================================================================
      // Conversation CRUD
      // ========================================================================

      setConversations: (conversations) => {
        set((state) => {
          state.conversations = conversations;
          // Clear selection if selected conversation no longer exists
          if (
            state.selectedConversationId &&
            !conversations.some((c) => c.id === state.selectedConversationId)
          ) {
            state.selectedConversationId = null;
          }
        });
        logger.debug('Set conversations', { count: conversations.length });
      },

      addConversation: (conversation) => {
        set((state) => {
          // Add to beginning (most recent first)
          state.conversations.unshift(conversation);
        });
        logger.debug('Added conversation', { id: conversation.id, name: conversation.name });
      },

      updateConversation: (id, updates) => {
        set((state) => {
          const index = state.conversations.findIndex((c) => c.id === id);
          if (index !== -1) {
            state.conversations[index] = {
              ...state.conversations[index],
              ...updates,
              updatedAt: Date.now(),
            };
          }
        });
      },

      deleteConversation: (id) => {
        set((state) => {
          state.conversations = state.conversations.filter((c) => c.id !== id);
          if (state.selectedConversationId === id) {
            state.selectedConversationId = null;
          }
          state.streamingConversationIds.delete(id);
        });
        logger.debug('Deleted conversation', { id });
      },

      clearConversations: () => {
        set((state) => {
          state.conversations = [];
          state.selectedConversationId = null;
          state.streamingConversationIds.clear();
        });
        logger.debug('Cleared all conversations');
      },

      // ========================================================================
      // Selection
      // ========================================================================

      selectConversation: (id) => {
        set((state) => {
          state.selectedConversationId = id;
        });
        logger.debug('Selected conversation', { id });
      },

      // ========================================================================
      // Messages
      // ========================================================================

      addMessage: (conversationId, message) => {
        set((state) => {
          const conv = state.conversations.find((c) => c.id === conversationId);
          if (conv) {
            conv.messages.push(message);
            conv.updatedAt = Date.now();
          }
        });
      },

      updateLastMessage: (conversationId, updates) => {
        set((state) => {
          const conv = state.conversations.find((c) => c.id === conversationId);
          if (conv && conv.messages.length > 0) {
            const lastIndex = conv.messages.length - 1;
            conv.messages[lastIndex] = {
              ...conv.messages[lastIndex],
              ...updates,
            };
            conv.updatedAt = Date.now();
          }
        });
      },

      updateMessageIntermediateSteps: (conversationId, messageIndex, steps) => {
        set((state) => {
          const conv = state.conversations.find((c) => c.id === conversationId);
          if (conv && conv.messages[messageIndex]) {
            conv.messages[messageIndex].intermediateSteps = steps;
          }
        });
      },

      // ========================================================================
      // Streaming
      // ========================================================================

      setStreaming: (conversationId, isStreaming) => {
        set((state) => {
          if (isStreaming) {
            state.streamingConversationIds.add(conversationId);
          } else {
            state.streamingConversationIds.delete(conversationId);
          }
        });
      },

      isStreaming: (conversationId) => {
        return get().streamingConversationIds.has(conversationId);
      },

      // ========================================================================
      // Loading
      // ========================================================================

      setLoading: (isLoading) => {
        set((state) => {
          state.isLoading = isLoading;
        });
      },

      setSyncing: (isSyncing) => {
        set((state) => {
          state.isSyncing = isSyncing;
        });
      },

      // ========================================================================
      // Error
      // ========================================================================

      setError: (error) => {
        set((state) => {
          state.error = error;
        });
      },

      // ========================================================================
      // Bulk Operations
      // ========================================================================

      replaceConversation: (id, conversation) => {
        set((state) => {
          const index = state.conversations.findIndex((c) => c.id === id);
          if (index !== -1) {
            state.conversations[index] = conversation;
          }
        });
      },

      upsertConversation: (conversation) => {
        set((state) => {
          const index = state.conversations.findIndex((c) => c.id === conversation.id);
          if (index !== -1) {
            state.conversations[index] = conversation;
          } else {
            state.conversations.unshift(conversation);
          }
        });
      },

      // ========================================================================
      // Reset
      // ========================================================================

      reset: () => {
        set(initialState);
        logger.debug('Store reset');
      },
    }))
  )
);

// ============================================================================
// Selectors (for performance - prevents unnecessary re-renders)
// ============================================================================

/**
 * Get the currently selected conversation
 */
export const selectSelectedConversation = (
  state: ConversationStore
): Conversation | undefined => {
  if (!state.selectedConversationId) return undefined;
  return state.conversations.find((c) => c.id === state.selectedConversationId);
};

/**
 * Check if selected conversation is streaming
 */
export const selectIsSelectedStreaming = (state: ConversationStore): boolean => {
  if (!state.selectedConversationId) return false;
  return state.streamingConversationIds.has(state.selectedConversationId);
};

/**
 * Check if any conversation is streaming
 */
export const selectIsAnyStreaming = (state: ConversationStore): boolean => {
  return state.streamingConversationIds.size > 0;
};

/**
 * Get conversation by ID
 */
export const selectConversationById = (
  state: ConversationStore,
  id: string
): Conversation | undefined => {
  return state.conversations.find((c) => c.id === id);
};

/**
 * Get streaming status for a specific conversation
 */
export const selectStreamingStatus = (
  state: ConversationStore,
  id: string
): boolean => {
  return state.streamingConversationIds.has(id);
};

/**
 * Get conversations in a specific folder
 */
export const selectConversationsByFolder = (
  state: ConversationStore,
  folderId: string | null
): Conversation[] => {
  return state.conversations.filter((c) => c.folderId === folderId);
};

/**
 * Get conversation count
 */
export const selectConversationCount = (state: ConversationStore): number => {
  return state.conversations.length;
};

/**
 * Get conversations sorted by update time
 */
export const selectSortedConversations = (
  state: ConversationStore
): Conversation[] => {
  return [...state.conversations].sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );
};

// ============================================================================
// Hooks for common patterns
// ============================================================================

/**
 * Hook to get selected conversation with auto-subscription
 */
export const useSelectedConversation = () => {
  return useConversationStore(selectSelectedConversation);
};

/**
 * Hook to check if selected conversation is streaming
 */
export const useIsSelectedStreaming = () => {
  return useConversationStore(selectIsSelectedStreaming);
};

/**
 * Hook to get all conversations
 */
export const useConversations = () => {
  return useConversationStore((state) => state.conversations);
};

/**
 * Hook to get streaming conversation IDs
 */
export const useStreamingIds = () => {
  return useConversationStore((state) => state.streamingConversationIds);
};

// ============================================================================
// DevTools (development only)
// ============================================================================

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  // Expose store to window for debugging
  (window as any).__conversationStore = useConversationStore;
}
