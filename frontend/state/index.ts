/**
 * State Management Index
 *
 * Exports all Zustand stores and utilities for state management.
 *
 * @requires zustand - Run: npm install zustand immer
 *
 * Installation:
 * ```bash
 * npm install zustand immer
 * ```
 */

// Conversation Store
export {
  useConversationStore,
  // Selectors
  selectSelectedConversation,
  selectIsSelectedStreaming,
  selectIsAnyStreaming,
  selectConversationById,
  selectStreamingStatus,
  selectConversationsByFolder,
  selectConversationCount,
  selectSortedConversations,
  // Convenience hooks
  useSelectedConversation,
  useIsSelectedStreaming,
  useConversations,
  useStreamingIds,
  // Types
  type ConversationState,
  type ConversationActions,
  type ConversationStore,
} from './conversationStore';

// UI Settings Store
export {
  useUISettingsStore,
  // Selectors
  selectLightMode,
  selectShowChatbar,
  selectUseDeepThinker,
  selectEnableIntermediateSteps,
  // Convenience hooks
  useLightMode,
  useShowChatbar,
  useDeepThinker,
  useFolders,
  useSearchTerm,
  // Types
  type UISettingsState,
  type UISettingsActions,
  type UISettingsStore,
} from './uiSettingsStore';

// Migration Bridge (for gradual HomeContext migration)
export {
  useStoreBridge,
  useContextSync,
  type StoreBridgeReturn,
} from './useStoreBridge';
