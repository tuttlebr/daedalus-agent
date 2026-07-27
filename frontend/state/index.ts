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
  // Types
  type ConversationState,
  type ConversationActions,
  type ConversationStore,
} from './conversationStore';

// UI Settings Store
export {
  useUISettingsStore,
  useLightMode,
  // Types
  type UISettingsState,
  type UISettingsActions,
  type UISettingsStore,
} from './uiSettingsStore';
