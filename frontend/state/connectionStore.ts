/**
 * Connection Store - Zustand-based state for WebSocket/SSE connection status
 *
 * Provides a reactive interface to the ConnectionManager singleton,
 * so components can subscribe to connection state changes.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

// ============================================================================
// Types
// ============================================================================

export type ConnectionMode = 'websocket' | 'sse' | 'polling' | 'none';

export interface ConnectionState {
  mode: ConnectionMode;
  isConnected: boolean;
  lastDisconnect: number | null;
  reconnectAttempts: number;
}

export interface ConnectionActions {
  setConnected: (mode: ConnectionMode) => void;
  setDisconnected: () => void;
  setReconnecting: (attempts: number) => void;
  reset: () => void;
}

export type ConnectionStore = ConnectionState & ConnectionActions;

// ============================================================================
// Initial State
// ============================================================================

const initialState: ConnectionState = {
  mode: 'none',
  isConnected: false,
  lastDisconnect: null,
  reconnectAttempts: 0,
};

// ============================================================================
// Store
// ============================================================================

export const useConnectionStore = create<ConnectionStore>()(
  subscribeWithSelector((set) => ({
    ...initialState,

    setConnected: (mode) =>
      set({
        mode,
        isConnected: true,
        reconnectAttempts: 0,
      }),

    setDisconnected: () =>
      set((state) => ({
        isConnected: false,
        lastDisconnect: Date.now(),
        reconnectAttempts: state.reconnectAttempts,
      })),

    setReconnecting: (attempts) =>
      set({
        isConnected: false,
        reconnectAttempts: attempts,
      }),

    reset: () => set(initialState),
  }))
);

// ============================================================================
// Selectors
// ============================================================================

export const selectIsConnected = (state: ConnectionStore) => state.isConnected;
export const selectConnectionMode = (state: ConnectionStore) => state.mode;
export const selectReconnectAttempts = (state: ConnectionStore) => state.reconnectAttempts;

// ============================================================================
// Convenience Hooks
// ============================================================================

export function useIsConnected() {
  return useConnectionStore(selectIsConnected);
}

export function useConnectionMode() {
  return useConnectionStore(selectConnectionMode);
}
