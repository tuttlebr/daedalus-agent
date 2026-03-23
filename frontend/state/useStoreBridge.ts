/**
 * useStoreBridge - Bridge hook for gradual migration from HomeContext to Zustand
 *
 * This hook provides a compatibility layer that:
 * 1. Syncs state between HomeContext and Zustand stores
 * 2. Validates that both systems have consistent state (development only)
 * 3. Allows gradual migration of consumers from Context to Store
 *
 * Usage during migration:
 * ```tsx
 * // In a component that uses HomeContext
 * const { state, dispatch } = useContext(HomeContext);
 * const bridge = useStoreBridge(); // Optional: enables validation
 *
 * // The bridge will log warnings if Context and Store state diverge
 * ```
 *
 * After migration is complete, this file can be deleted.
 */

import { useEffect, useCallback, useRef } from 'react';
import { useConversationStore } from './conversationStore';
import { useUISettingsStore } from './uiSettingsStore';
import { Conversation } from '@/types/chat';
import { FolderInterface } from '@/types/folder';
import { Logger } from '@/utils/logger';

const logger = new Logger('StoreBridge');

interface BridgeOptions {
  /** Enable state validation (logs warnings on mismatch) */
  enableValidation?: boolean;
  /** Sync direction: 'context-to-store' | 'store-to-context' | 'bidirectional' */
  syncDirection?: 'context-to-store' | 'store-to-context' | 'bidirectional';
}

interface BridgeState {
  // From conversation store
  conversations: Conversation[];
  selectedConversationId: string | null;
  streamingConversationIds: Set<string>;

  // From UI settings store
  lightMode: 'light' | 'dark';
  showChatbar: boolean;
  useDeepThinker: boolean;
  enableIntermediateSteps: boolean;
  folders: FolderInterface[];
  searchTerm: string;
}

interface BridgeActions {
  // Conversation actions
  setConversations: (conversations: Conversation[]) => void;
  selectConversation: (id: string | null) => void;
  updateConversation: (id: string, updates: Partial<Conversation>) => void;
  setStreaming: (conversationId: string, isStreaming: boolean) => void;

  // UI actions
  setLightMode: (mode: 'light' | 'dark') => void;
  setShowChatbar: (show: boolean) => void;
  setUseDeepThinker: (enabled: boolean) => void;
  setFolders: (folders: FolderInterface[]) => void;
  setSearchTerm: (term: string) => void;
}

export interface StoreBridgeReturn extends BridgeState, BridgeActions {
  /** Sync HomeContext state to stores */
  syncFromContext: (contextState: any) => void;
  /** Get current store state (for syncing back to context) */
  getStoreState: () => BridgeState;
  /** Validate state consistency between context and store */
  validateConsistency: (contextState: any) => boolean;
}

/**
 * Bridge hook for gradual migration from HomeContext to Zustand stores
 */
export function useStoreBridge(options: BridgeOptions = {}): StoreBridgeReturn {
  const {
    enableValidation = process.env.NODE_ENV === 'development',
    syncDirection = 'context-to-store',
  } = options;

  const lastSyncRef = useRef<number>(0);
  const validationCountRef = useRef<number>(0);

  // Conversation store
  const conversations = useConversationStore((s) => s.conversations);
  const selectedConversationId = useConversationStore((s) => s.selectedConversationId);
  const streamingConversationIds = useConversationStore((s) => s.streamingConversationIds);
  const setConversations = useConversationStore((s) => s.setConversations);
  const selectConversation = useConversationStore((s) => s.selectConversation);
  const updateConversation = useConversationStore((s) => s.updateConversation);
  const setStreaming = useConversationStore((s) => s.setStreaming);

  // UI settings store
  const lightMode = useUISettingsStore((s) => s.lightMode);
  const showChatbar = useUISettingsStore((s) => s.showChatbar);
  const useDeepThinker = useUISettingsStore((s) => s.useDeepThinker);
  const enableIntermediateSteps = useUISettingsStore((s) => s.enableIntermediateSteps);
  const folders = useUISettingsStore((s) => s.folders);
  const searchTerm = useUISettingsStore((s) => s.searchTerm);
  const setLightMode = useUISettingsStore((s) => s.setLightMode);
  const setShowChatbar = useUISettingsStore((s) => s.setShowChatbar);
  const setUseDeepThinker = useUISettingsStore((s) => s.setUseDeepThinker);
  const setFolders = useUISettingsStore((s) => s.setFolders);
  const setSearchTerm = useUISettingsStore((s) => s.setSearchTerm);

  /**
   * Sync state from HomeContext to Zustand stores
   */
  const syncFromContext = useCallback(
    (contextState: any) => {
      if (syncDirection === 'store-to-context') {
        return; // Don't sync in this direction
      }

      const now = Date.now();
      // Throttle syncs to avoid infinite loops
      if (now - lastSyncRef.current < 100) {
        return;
      }
      lastSyncRef.current = now;

      // Sync conversations
      if (contextState.conversations) {
        const currentConvs = useConversationStore.getState().conversations;
        if (JSON.stringify(currentConvs) !== JSON.stringify(contextState.conversations)) {
          setConversations(contextState.conversations);
        }
      }

      // Sync selected conversation
      const contextSelectedId = contextState.selectedConversation?.id ?? null;
      if (selectedConversationId !== contextSelectedId) {
        selectConversation(contextSelectedId);
      }

      // Sync streaming state
      if (contextState.streamingByConversationId) {
        Object.entries(contextState.streamingByConversationId).forEach(
          ([id, isStreaming]) => {
            const currentlyStreaming = streamingConversationIds.has(id);
            if (currentlyStreaming !== isStreaming) {
              setStreaming(id, isStreaming as boolean);
            }
          }
        );
      }

      // Sync UI settings
      if (contextState.lightMode && contextState.lightMode !== lightMode) {
        setLightMode(contextState.lightMode);
      }
      if (contextState.showChatbar !== undefined && contextState.showChatbar !== showChatbar) {
        setShowChatbar(contextState.showChatbar);
      }
      if (contextState.useDeepThinker !== undefined && contextState.useDeepThinker !== useDeepThinker) {
        setUseDeepThinker(contextState.useDeepThinker);
      }
      if (contextState.folders) {
        const currentFolders = useUISettingsStore.getState().folders;
        if (JSON.stringify(currentFolders) !== JSON.stringify(contextState.folders)) {
          setFolders(contextState.folders);
        }
      }
      if (contextState.searchTerm !== undefined && contextState.searchTerm !== searchTerm) {
        setSearchTerm(contextState.searchTerm);
      }
    },
    [
      syncDirection,
      selectedConversationId,
      streamingConversationIds,
      lightMode,
      showChatbar,
      useDeepThinker,
      searchTerm,
      setConversations,
      selectConversation,
      setStreaming,
      setLightMode,
      setShowChatbar,
      setUseDeepThinker,
      setFolders,
      setSearchTerm,
    ]
  );

  /**
   * Get current store state for syncing back to context
   */
  const getStoreState = useCallback((): BridgeState => {
    return {
      conversations,
      selectedConversationId,
      streamingConversationIds,
      lightMode,
      showChatbar,
      useDeepThinker,
      enableIntermediateSteps,
      folders,
      searchTerm,
    };
  }, [
    conversations,
    selectedConversationId,
    streamingConversationIds,
    lightMode,
    showChatbar,
    useDeepThinker,
    enableIntermediateSteps,
    folders,
    searchTerm,
  ]);

  /**
   * Validate consistency between context and store state
   */
  const validateConsistency = useCallback(
    (contextState: any): boolean => {
      if (!enableValidation) return true;

      validationCountRef.current++;
      // Only validate every 10th call to reduce noise
      if (validationCountRef.current % 10 !== 0) return true;

      let isConsistent = true;

      // Check conversation count
      if (contextState.conversations?.length !== conversations.length) {
        logger.warn('State mismatch: conversation count', {
          context: contextState.conversations?.length,
          store: conversations.length,
        });
        isConsistent = false;
      }

      // Check selected conversation
      const contextSelectedId = contextState.selectedConversation?.id ?? null;
      if (contextSelectedId !== selectedConversationId) {
        logger.warn('State mismatch: selected conversation', {
          context: contextSelectedId,
          store: selectedConversationId,
        });
        isConsistent = false;
      }

      // Check deep thinker
      if (contextState.useDeepThinker !== useDeepThinker) {
        logger.warn('State mismatch: useDeepThinker', {
          context: contextState.useDeepThinker,
          store: useDeepThinker,
        });
        isConsistent = false;
      }

      return isConsistent;
    },
    [enableValidation, conversations.length, selectedConversationId, useDeepThinker]
  );

  return {
    // State
    conversations,
    selectedConversationId,
    streamingConversationIds,
    lightMode,
    showChatbar,
    useDeepThinker,
    enableIntermediateSteps,
    folders,
    searchTerm,

    // Actions
    setConversations,
    selectConversation,
    updateConversation,
    setStreaming,
    setLightMode,
    setShowChatbar,
    setUseDeepThinker,
    setFolders,
    setSearchTerm,

    // Bridge utilities
    syncFromContext,
    getStoreState,
    validateConsistency,
  };
}

/**
 * Hook to automatically sync HomeContext state to stores
 * Use this in a component that has access to HomeContext
 */
export function useContextSync(contextState: any) {
  const bridge = useStoreBridge();

  useEffect(() => {
    bridge.syncFromContext(contextState);
  }, [contextState, bridge]);

  // Validate in development
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      bridge.validateConsistency(contextState);
    }
  }, [contextState, bridge]);

  return bridge;
}

export default useStoreBridge;
