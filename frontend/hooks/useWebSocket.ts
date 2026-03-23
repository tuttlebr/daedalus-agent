/**
 * useWebSocket Hook
 *
 * Drop-in replacement for useRealtimeSync that uses WebSocket instead of SSE.
 * Provides identical callback signatures plus job subscription support.
 *
 * Visibility-aware: disconnects when backgrounded (unless streaming),
 * reconnects when visible, notifies service worker.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { getWebSocketManager, WebSocketManager } from '@/services/websocket';
import { Conversation } from '@/types/chat';
import { Logger } from '@/utils/logger';
import { invalidateServiceWorkerCache } from './useOnlineStatus';

const logger = new Logger('useWebSocket');

export interface StreamingStateInfo {
  conversationId: string;
  sessionId: string;
  isStreaming: boolean;
}

export interface UseWebSocketCallbacks {
  onConversationUpdated?: (conversation: Conversation) => void;
  onConversationDeleted?: (conversationId: string) => void;
  onConversationListChanged?: () => void;
  onSelectedConversationChanged?: (conversationId: string) => void;
  onStreamingStateChanged?: (conversationId: string, isStreaming: boolean) => void;
  onChatToken?: (data: { conversationId: string; jobId: string; content: string; intermediateSteps?: any[] }) => void;
  onChatIntermediateStep?: (data: { conversationId: string; jobId: string; step: any }) => void;
  onChatComplete?: (data: { conversationId: string; jobId: string; fullResponse: string; intermediateSteps?: any[] }) => void;
  onConnected?: (streamingStates: Record<string, StreamingStateInfo>) => void;
  onDisconnected?: () => void;
}

export interface UseWebSocketOptions extends UseWebSocketCallbacks {
  enabled?: boolean;
}

export interface UseWebSocketReturn {
  isConnected: boolean;
  connect: () => void;
  disconnect: () => void;
  streamingStates: Record<string, boolean>;
  subscribeToJob: (jobId: string) => void;
  unsubscribeFromJob: (jobId: string) => void;
  subscribeToChat: (conversationId: string) => void;
  unsubscribeFromChat: (conversationId: string) => void;
}

export const useWebSocket = (options: UseWebSocketOptions = {}): UseWebSocketReturn => {
  const {
    enabled = true,
    onConversationUpdated,
    onConversationDeleted,
    onConversationListChanged,
    onStreamingStateChanged,
    onConnected,
    onDisconnected,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [streamingStates, setStreamingStates] = useState<Record<string, boolean>>({});
  const managerRef = useRef<WebSocketManager | null>(null);
  const cleanupRef = useRef<Array<() => void>>([]);
  const isPageVisibleRef = useRef(true);

  // Use refs for callbacks to avoid re-subscribing on every render
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  const connect = useCallback(() => {
    const manager = getWebSocketManager();
    managerRef.current = manager;
    manager.connect();
  }, []);

  const disconnect = useCallback(() => {
    const manager = managerRef.current;
    if (manager) {
      manager.disconnect();
    }
  }, []);

  const subscribeToJob = useCallback((jobId: string) => {
    const manager = managerRef.current || getWebSocketManager();
    manager.subscribeToJob(jobId);
  }, []);

  const unsubscribeFromJob = useCallback((jobId: string) => {
    const manager = managerRef.current || getWebSocketManager();
    manager.unsubscribeFromJob(jobId);
  }, []);

  const subscribeToChat = useCallback((conversationId: string) => {
    const manager = managerRef.current || getWebSocketManager();
    manager.subscribeToChat(conversationId);
  }, []);

  const unsubscribeFromChat = useCallback((conversationId: string) => {
    const manager = managerRef.current || getWebSocketManager();
    manager.unsubscribeFromChat(conversationId);
  }, []);

  // Set up WebSocket connection and handlers
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const manager = getWebSocketManager();
    managerRef.current = manager;

    // Register message handlers
    const unsubs: Array<() => void> = [];

    // Connected event
    unsubs.push(manager.on('connected', (data: any) => {
      logger.info('WebSocket connected', { userId: data?.userId });
      setIsConnected(true);

      // Initialize streaming states from server
      if (data?.streamingStates) {
        const states: Record<string, boolean> = {};
        Object.keys(data.streamingStates).forEach((convId) => {
          states[convId] = true;
        });
        setStreamingStates(states);
      }

      callbacksRef.current.onConnected?.(data?.streamingStates || {});
    }));

    // Disconnected event
    unsubs.push(manager.on('disconnected', () => {
      setIsConnected(false);
      callbacksRef.current.onDisconnected?.();
    }));

    // Conversation updated
    unsubs.push(manager.on('conversation_updated', (data: any) => {
      logger.debug('Conversation updated', { conversationId: data?.conversationId });

      if (data?.conversationId) {
        invalidateServiceWorkerCache(data.conversationId);
      }

      if (data?.conversation) {
        callbacksRef.current.onConversationUpdated?.(data.conversation);
      }
    }));

    // Conversation deleted
    unsubs.push(manager.on('conversation_deleted', (data: any) => {
      logger.debug('Conversation deleted', { conversationId: data?.conversationId });
      if (data?.conversationId) {
        callbacksRef.current.onConversationDeleted?.(data.conversationId);
      }
    }));

    // Conversation list changed
    unsubs.push(manager.on('conversation_list_changed', () => {
      logger.debug('Conversation list changed');
      callbacksRef.current.onConversationListChanged?.();
    }));

    // Selected conversation changed (cross-device sync)
    unsubs.push(manager.on('selected_conversation_changed', (data: any) => {
      logger.debug('Selected conversation changed', { conversationId: data?.conversationId });
      if (data?.conversationId) {
        callbacksRef.current.onSelectedConversationChanged?.(data.conversationId);
      }
    }));

    // Streaming started
    unsubs.push(manager.on('streaming_started', (data: any) => {
      logger.debug('Streaming started', { conversationId: data?.conversationId });
      setStreamingStates((prev) => ({
        ...prev,
        [data.conversationId]: true,
      }));
      callbacksRef.current.onStreamingStateChanged?.(data.conversationId, true);
    }));

    // Streaming ended
    unsubs.push(manager.on('streaming_ended', (data: any) => {
      logger.debug('Streaming ended', { conversationId: data?.conversationId });
      setStreamingStates((prev) => {
        const next = { ...prev };
        delete next[data.conversationId];
        return next;
      });
      callbacksRef.current.onStreamingStateChanged?.(data.conversationId, false);
    }));

    // Chat token streaming
    unsubs.push(manager.on('chat_token', (data: any) => {
      callbacksRef.current.onChatToken?.(data);
    }));

    unsubs.push(manager.on('chat_intermediate_step', (data: any) => {
      callbacksRef.current.onChatIntermediateStep?.(data);
    }));

    unsubs.push(manager.on('chat_complete', (data: any) => {
      callbacksRef.current.onChatComplete?.(data);
    }));

    // Battery critical - could surface a banner
    unsubs.push(manager.on('battery_critical', (data: any) => {
      logger.warn('Battery critical - WebSocket auto-reconnect disabled', data);
    }));

    cleanupRef.current = unsubs;

    // Connect
    manager.connect();

    return () => {
      unsubs.forEach((unsub) => unsub());
      cleanupRef.current = [];
    };
  }, [enabled]);

  // Visibility-aware connection lifecycle
  useEffect(() => {
    if (!enabled) return;

    const handleVisibilityChange = () => {
      const wasVisible = isPageVisibleRef.current;
      const visible = document.visibilityState === 'visible';
      isPageVisibleRef.current = visible;

      // Notify service worker about visibility change
      navigator.serviceWorker?.controller?.postMessage({
        type: 'SET_BACKGROUND_TASKS',
        enabled: visible,
      });

      if (!wasVisible && visible) {
        // Page became visible → reconnect if not connected
        if (!managerRef.current?.isConnected) {
          logger.info('Page visible - reconnecting WebSocket');
          connect();
        }
      } else if (wasVisible && !visible) {
        // Page hidden → disconnect if no active streaming
        const hasActiveStreaming = Object.keys(streamingStates).length > 0;
        if (!hasActiveStreaming) {
          logger.info('Page hidden (no streaming) - disconnecting WebSocket');
          disconnect();
        } else {
          logger.info('Page hidden but streaming active - keeping WebSocket');
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [enabled, connect, disconnect, streamingStates]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    isConnected,
    connect,
    disconnect,
    streamingStates,
    subscribeToJob,
    unsubscribeFromJob,
    subscribeToChat,
    unsubscribeFromChat,
  };
};
