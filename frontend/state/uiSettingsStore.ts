/**
 * UI Settings Store - Zustand-based state management for UI preferences
 *
 * This store manages UI-related state that was previously in HomeContext,
 * keeping it separate from conversation data for cleaner separation of concerns.
 *
 * @requires zustand - Run: npm install zustand
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { subscribeWithSelector } from 'zustand/middleware';
import { IntermediateStepCategory } from '@/types/intermediateSteps';
import { FolderInterface } from '@/types/folder';
import { getDefaultChatCompletionUrl } from '@/utils/app/backendApi';

// ============================================================================
// Types
// ============================================================================

export type AppView = 'chat' | 'create';

export interface UISettingsState {
  // Theme
  lightMode: 'light' | 'dark';

  // Primary view tab
  activeView: AppView;

  // Chat UI
  showChatbar: boolean;
  chatbarWidth: number;
  chatHistory: boolean;
  autoScroll: boolean;

  // Intermediate Steps
  enableIntermediateSteps: boolean;
  expandIntermediateSteps: boolean;
  intermediateStepOverride: boolean;
  intermediateStepsView: 'timeline' | 'category';
  intermediateStepsFilter: IntermediateStepCategory[];

  // Background Processing
  enableBackgroundProcessing: boolean;

  // Performance
  energySavingMode: boolean;

  // Folders
  folders: FolderInterface[];
  currentFolder: FolderInterface | undefined;

  // Search
  searchTerm: string;

  // Chat Endpoint
  chatCompletionURL: string;

  // Additional config
  additionalConfig: Record<string, unknown>;
}

export interface UISettingsActions {
  // Theme
  setLightMode: (mode: 'light' | 'dark') => void;
  toggleLightMode: () => void;

  // View tab
  setActiveView: (view: AppView) => void;

  // Chat UI
  setShowChatbar: (show: boolean) => void;
  toggleChatbar: () => void;
  setChatbarWidth: (width: number) => void;
  setChatHistory: (enabled: boolean) => void;
  setAutoScroll: (enabled: boolean) => void;

  // Intermediate Steps
  setEnableIntermediateSteps: (enabled: boolean) => void;
  setExpandIntermediateSteps: (expanded: boolean) => void;
  setIntermediateStepOverride: (override: boolean) => void;
  setIntermediateStepsView: (view: 'timeline' | 'category') => void;
  setIntermediateStepsFilter: (filter: IntermediateStepCategory[]) => void;
  toggleIntermediateStepCategory: (category: IntermediateStepCategory) => void;

  // Background Processing
  setEnableBackgroundProcessing: (enabled: boolean) => void;

  // Performance
  setEnergySavingMode: (enabled: boolean) => void;

  // Folders
  setFolders: (folders: FolderInterface[]) => void;
  addFolder: (folder: FolderInterface) => void;
  updateFolder: (id: string, updates: Partial<FolderInterface>) => void;
  deleteFolder: (id: string) => void;
  setCurrentFolder: (folder: FolderInterface | undefined) => void;

  // Search
  setSearchTerm: (term: string) => void;

  // Chat Endpoint
  setChatCompletionURL: (url: string) => void;

  // Additional config
  setAdditionalConfig: (config: Record<string, any>) => void;
  updateAdditionalConfig: (updates: Record<string, any>) => void;

  // Reset
  resetToDefaults: () => void;
}

export type UISettingsStore = UISettingsState & UISettingsActions;

// ============================================================================
// Default Values
// ============================================================================

const DEFAULT_CHAT_URL = getDefaultChatCompletionUrl();

const DEFAULT_CHAT_HISTORY =
  process?.env?.NEXT_PUBLIC_CHAT_HISTORY_DEFAULT_ON !== 'false';

const initialState: UISettingsState = {
  lightMode: 'dark',
  activeView: 'chat',
  showChatbar: false,
  chatbarWidth: 280,
  chatHistory: DEFAULT_CHAT_HISTORY,
  autoScroll: true,
  enableIntermediateSteps: true,
  expandIntermediateSteps: false,
  intermediateStepOverride: true,
  intermediateStepsView: 'timeline',
  intermediateStepsFilter: [],
  enableBackgroundProcessing: true,
  energySavingMode: false,
  folders: [],
  currentFolder: undefined,
  searchTerm: '',
  chatCompletionURL: DEFAULT_CHAT_URL,
  additionalConfig: {},
};

// ============================================================================
// Store
// ============================================================================

export const useUISettingsStore = create<UISettingsStore>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        // Initial state
        ...initialState,

        // ======================================================================
        // Theme
        // ======================================================================

        setLightMode: (mode) => set({ lightMode: mode }),

        toggleLightMode: () =>
          set((state) => ({
            lightMode: state.lightMode === 'light' ? 'dark' : 'light',
          })),

        // ======================================================================
        // View tab
        // ======================================================================

        setActiveView: (view) => set({ activeView: view }),

        // ======================================================================
        // Chat UI
        // ======================================================================

        setShowChatbar: (show) => set({ showChatbar: show }),

        toggleChatbar: () =>
          set((state) => ({ showChatbar: !state.showChatbar })),

        setChatbarWidth: (width) => set({ chatbarWidth: width }),

        setChatHistory: (enabled) => set({ chatHistory: enabled }),

        setAutoScroll: (enabled) => set({ autoScroll: enabled }),

        // ======================================================================
        // Intermediate Steps
        // ======================================================================

        setEnableIntermediateSteps: (enabled) =>
          set({ enableIntermediateSteps: enabled }),

        setExpandIntermediateSteps: (expanded) =>
          set({ expandIntermediateSteps: expanded }),

        setIntermediateStepOverride: (override) =>
          set({ intermediateStepOverride: override }),

        setIntermediateStepsView: (view) =>
          set({ intermediateStepsView: view }),

        setIntermediateStepsFilter: (filter) =>
          set({ intermediateStepsFilter: filter }),

        toggleIntermediateStepCategory: (category) =>
          set((state) => {
            const current = state.intermediateStepsFilter;
            if (current.includes(category)) {
              return {
                intermediateStepsFilter: current.filter((c) => c !== category),
              };
            }
            return {
              intermediateStepsFilter: [...current, category],
            };
          }),

        // ======================================================================
        // Background Processing
        // ======================================================================

        setEnableBackgroundProcessing: (enabled) =>
          set({ enableBackgroundProcessing: enabled }),

        // ======================================================================
        // Performance
        // ======================================================================

        setEnergySavingMode: (enabled) => set({ energySavingMode: enabled }),

        // ======================================================================
        // Folders
        // ======================================================================

        setFolders: (folders) => set({ folders }),

        addFolder: (folder) =>
          set((state) => ({ folders: [...state.folders, folder] })),

        updateFolder: (id, updates) =>
          set((state) => ({
            folders: state.folders.map((f) =>
              f.id === id ? { ...f, ...updates } : f
            ),
          })),

        deleteFolder: (id) =>
          set((state) => ({
            folders: state.folders.filter((f) => f.id !== id),
            currentFolder:
              state.currentFolder?.id === id ? undefined : state.currentFolder,
          })),

        setCurrentFolder: (folder) => set({ currentFolder: folder }),

        // ======================================================================
        // Search
        // ======================================================================

        setSearchTerm: (term) => set({ searchTerm: term }),

        // ======================================================================
        // Chat Endpoint
        // ======================================================================

        setChatCompletionURL: (url) => set({ chatCompletionURL: url }),

        // ======================================================================
        // Additional Config
        // ======================================================================

        setAdditionalConfig: (config) => set({ additionalConfig: config }),

        updateAdditionalConfig: (updates) =>
          set((state) => ({
            additionalConfig: { ...state.additionalConfig, ...updates },
          })),

        // ======================================================================
        // Reset
        // ======================================================================

        resetToDefaults: () => set(initialState),
      }),
      {
        name: 'ui-settings',
        storage: createJSONStorage(() => localStorage),
        // Only persist certain fields
        partialize: (state) => ({
          lightMode: state.lightMode,
          activeView: state.activeView,
          showChatbar: state.showChatbar,
          chatbarWidth: state.chatbarWidth,
          chatHistory: state.chatHistory,
          autoScroll: state.autoScroll,
          enableIntermediateSteps: state.enableIntermediateSteps,
          expandIntermediateSteps: state.expandIntermediateSteps,
          intermediateStepsView: state.intermediateStepsView,
          enableBackgroundProcessing: state.enableBackgroundProcessing,
          energySavingMode: state.energySavingMode,
        }),
      }
    )
  )
);

// ============================================================================
// Selectors
// ============================================================================

export const selectLightMode = (state: UISettingsStore) => state.lightMode;
export const selectShowChatbar = (state: UISettingsStore) => state.showChatbar;
export const selectEnableIntermediateSteps = (state: UISettingsStore) =>
  state.enableIntermediateSteps;

// ============================================================================
// Convenience Hooks
// ============================================================================

export const useLightMode = () => useUISettingsStore((state) => state.lightMode);
export const useShowChatbar = () => useUISettingsStore((state) => state.showChatbar);
export const useFolders = () => useUISettingsStore((state) => state.folders);
export const useSearchTerm = () => useUISettingsStore((state) => state.searchTerm);

// ============================================================================
// DevTools
// ============================================================================

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  (window as any).__uiSettingsStore = useUISettingsStore;
}
