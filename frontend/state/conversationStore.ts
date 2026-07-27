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
import { dedupeConversationsById } from '@/utils/app/conversationList';
import { Logger } from '@/utils/logger';

import { Conversation, Message } from '@/types/chat';
import { IntermediateStep } from '@/types/intermediateSteps';

import { enableMapSet } from 'immer';
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

// Enable immer support for Set and Map (required for streamingConversationIds)
enableMapSet();

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
  updateMessage: (
    conversationId: string,
    messageId: string,
    updates: Partial<Message>,
  ) => void;
  updateLastMessage: (
    conversationId: string,
    updates: Partial<Message>,
  ) => void;
  updateMessageIntermediateSteps: (
    conversationId: string,
    messageIndex: number,
    steps: IntermediateStep[],
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
          const dedupedConversations = dedupeConversationsById(conversations);
          // Preserve local state for active streams and for the selected local
          // draft. A history refresh can race initial selection and must not
          // silently remove the conversation that owns the visible input.
          const preservedLocal = new Map<string, Conversation>();
          for (const conv of state.conversations) {
            if (state.streamingConversationIds.has(conv.id)) {
              preservedLocal.set(conv.id, conv);
            }
          }
          const selectedLocal = state.selectedConversationId
            ? state.conversations.find(
                (conversation) =>
                  conversation.id === state.selectedConversationId,
              )
            : undefined;
          if (selectedLocal)
            preservedLocal.set(selectedLocal.id, selectedLocal);

          const incomingIds = new Set(
            dedupedConversations.map((c: Conversation) => c.id),
          );

          // Replace with incoming data, but keep local copies for streaming conversations
          state.conversations = dedupedConversations.map((c: Conversation) => {
            return preservedLocal.get(c.id) ?? c;
          });

          // Re-add preserved conversations missing from the incoming list.
          for (const [id, conv] of preservedLocal) {
            if (!incomingIds.has(id)) {
              state.conversations.unshift(conv);
            }
          }

          // Clear selection if selected conversation no longer exists
          if (
            state.selectedConversationId &&
            !state.conversations.some(
              (c: Conversation) => c.id === state.selectedConversationId,
            )
          ) {
            state.selectedConversationId = null;
          }
        });
        logger.debug('Set conversations', {
          count: dedupeConversationsById(conversations).length,
        });
      },

      addConversation: (conversation) => {
        set((state) => {
          const existingIndex = state.conversations.findIndex(
            (item) => item.id === conversation.id,
          );
          if (existingIndex === -1) {
            state.conversations.unshift(conversation);
          } else {
            state.conversations[existingIndex] = conversation;
          }
        });
        logger.debug('Added conversation', {
          id: conversation.id,
          name: conversation.name,
        });
      },

      updateConversation: (id, updates) => {
        set((state) => {
          const index = state.conversations.findIndex(
            (c: Conversation) => c.id === id,
          );
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
          state.conversations = state.conversations.filter(
            (c: Conversation) => c.id !== id,
          );
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
          const conv = state.conversations.find(
            (c: Conversation) => c.id === conversationId,
          );
          if (conv) {
            conv.messages.push(message);
            conv.updatedAt = Date.now();
          }
        });
      },

      updateMessage: (conversationId, messageId, updates) => {
        set((state) => {
          const conv = state.conversations.find(
            (c: Conversation) => c.id === conversationId,
          );
          if (!conv) return;

          const index = conv.messages.findIndex(
            (message: Message) => message.id === messageId,
          );
          if (index === -1) return;

          conv.messages[index] = {
            ...conv.messages[index],
            ...updates,
          };
          conv.updatedAt = Date.now();
        });
      },

      updateLastMessage: (conversationId, updates) => {
        set((state) => {
          const conv = state.conversations.find(
            (c: Conversation) => c.id === conversationId,
          );
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
          const conv = state.conversations.find(
            (c: Conversation) => c.id === conversationId,
          );
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
          const index = state.conversations.findIndex(
            (c: Conversation) => c.id === id,
          );
          if (index !== -1) {
            state.conversations[index] = conversation;
          }
        });
      },

      upsertConversation: (conversation) => {
        set((state) => {
          const index = state.conversations.findIndex(
            (c: Conversation) => c.id === conversation.id,
          );
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
    })),
  ),
);

// ============================================================================
// DevTools (development only)
// ============================================================================

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  // Expose store to window for debugging
  (window as any).__conversationStore = useConversationStore;
}
