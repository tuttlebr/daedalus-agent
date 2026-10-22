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

// ============================================================================
// Types
// ============================================================================

export type AppView = 'chat' | 'autonomy' | 'create' | 'memory' | 'connections';

export interface UISettingsState {
  // Theme
  lightMode: 'system' | 'light' | 'dark';
  // Opaque materials. WebKit does not expose the system's Reduce
  // Transparency setting to pages, so the app offers the same choice.
  reduceTransparency: boolean;

  // Primary view tab
  activeView: AppView;

  // Chat UI
  showChatbar: boolean;
  chatbarWidth: number;

  // Intermediate Steps
  enableIntermediateSteps: boolean;

  // Search
  searchTerm: string;

  // Autonomy feed lane filter ('all' or a lane id); persisted so the
  // selection survives reloads.
  autonomyLaneFilter: string;
}

export interface UISettingsActions {
  // Theme
  setLightMode: (mode: 'system' | 'light' | 'dark') => void;
  setReduceTransparency: (reduce: boolean) => void;

  // View tab
  setActiveView: (view: AppView) => void;

  // Chat UI
  setShowChatbar: (show: boolean) => void;
  toggleChatbar: () => void;
  setChatbarWidth: (width: number) => void;

  // Intermediate Steps
  setEnableIntermediateSteps: (enabled: boolean) => void;

  // Search
  setSearchTerm: (term: string) => void;

  // Autonomy
  setAutonomyLaneFilter: (lane: string) => void;
}

export type UISettingsStore = UISettingsState & UISettingsActions;

// ============================================================================
// Default Values
// ============================================================================

const initialState: UISettingsState = {
  lightMode: 'system',
  reduceTransparency: false,
  activeView: 'chat',
  showChatbar: false,
  chatbarWidth: 280,
  enableIntermediateSteps: true,
  searchTerm: '',
  autonomyLaneFilter: 'all',
};

// ============================================================================
// Store
// ============================================================================

export const useUISettingsStore = create<UISettingsStore>()(
  subscribeWithSelector(
    persist(
      (set) => ({
        // Initial state
        ...initialState,

        // ======================================================================
        // Theme
        // ======================================================================

        setLightMode: (mode) => set({ lightMode: mode }),

        setReduceTransparency: (reduce) => set({ reduceTransparency: reduce }),

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

        // ======================================================================
        // Intermediate Steps
        // ======================================================================

        setEnableIntermediateSteps: (enabled) =>
          set({ enableIntermediateSteps: enabled }),

        // ======================================================================
        // Search
        // ======================================================================

        setSearchTerm: (term) => set({ searchTerm: term }),

        // ======================================================================
        // Autonomy
        // ======================================================================

        setAutonomyLaneFilter: (lane) => set({ autonomyLaneFilter: lane }),
      }),
      {
        name: 'ui-settings',
        storage: createJSONStorage(() => localStorage),
        // Only persist certain fields
        partialize: (state) => ({
          lightMode: state.lightMode,
          reduceTransparency: state.reduceTransparency,
          activeView: state.activeView,
          showChatbar: state.showChatbar,
          chatbarWidth: state.chatbarWidth,
          enableIntermediateSteps: state.enableIntermediateSteps,
          autonomyLaneFilter: state.autonomyLaneFilter,
        }),
      },
    ),
  ),
);

// ============================================================================
// DevTools
// ============================================================================

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  (window as any).__uiSettingsStore = useUISettingsStore;
}
