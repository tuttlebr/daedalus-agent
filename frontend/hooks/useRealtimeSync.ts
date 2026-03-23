import { useEffect, useRef, useCallback, useState } from 'react';
import { SSEClient, createSSEUrl } from '@/services/sse';
import { Conversation } from '@/types/chat';
import { Logger } from '@/utils/logger';
import { invalidateServiceWorkerCache } from './useOnlineStatus';

const logger = new Logger('RealtimeSync');

export interface StreamingStateInfo {
  conversationId: string;
  sessionId: string;
  isStreaming: boolean;
}

export interface RealtimeSyncCallbacks {
  onConversationUpdated?: (conversation: Conversation) => void;
  onConversationDeleted?: (conversationId: string) => void;
  onConversationListChanged?: () => void;
  onStreamingStateChanged?: (conversationId: string, isStreaming: boolean) => void;
  onConnected?: (streamingStates: Record<string, StreamingStateInfo>) => void;
  onDisconnected?: () => void;
}

export interface UseRealtimeSyncOptions extends RealtimeSyncCallbacks {
  enabled?: boolean;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
}

export interface UseRealtimeSyncReturn {
  isConnected: boolean;
  connect: () => void;
  disconnect: () => void;
  streamingStates: Record<string, boolean>;
}

export const useRealtimeSync = (options: UseRealtimeSyncOptions = {}): UseRealtimeSyncReturn => {
  const {
    enabled = true,
    reconnectDelay = 2000,
    maxReconnectAttempts = 10,
    onConversationUpdated,
    onConversationDeleted,
    onConversationListChanged,
    onStreamingStateChanged,
    onConnected,
    onDisconnected,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [streamingStates, setStreamingStates] = useState<Record<string, boolean>>({});
  const sseClientRef = useRef<SSEClient | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isIntentionalDisconnectRef = useRef(false);
  const isPageVisibleRef = useRef(true);

  // Create a custom event source that handles our sync-specific events
  const setupEventSource = useCallback(() => {
    if (typeof window === 'undefined' || !enabled) return;

    // Clear any existing connection
    if (sseClientRef.current) {
      sseClientRef.current.close();
      sseClientRef.current = null;
    }

    const eventSource = new EventSource('/api/sync/stream');

    // Handle connected event
    eventSource.addEventListener('connected', (event) => {
      try {
        const data = JSON.parse(event.data);
        logger.info('Real-time sync connected', { userId: data.userId });
        setIsConnected(true);
        reconnectAttemptsRef.current = 0;

        // Initialize streaming states from server
        if (data.streamingStates) {
          const states: Record<string, boolean> = {};
          Object.keys(data.streamingStates).forEach((convId) => {
            states[convId] = true;
          });
          setStreamingStates(states);
        }

        if (onConnected) {
          onConnected(data.streamingStates || {});
        }
      } catch (error) {
        logger.error('Error parsing connected event:', error);
      }
    });

    // Handle conversation updates
    eventSource.addEventListener('conversation_updated', (event) => {
      try {
        const data = JSON.parse(event.data);
        logger.debug('Received conversation update', { conversationId: data.conversationId });

        // Invalidate service worker cache for this conversation
        if (data.conversationId) {
          invalidateServiceWorkerCache(data.conversationId);
        }

        if (onConversationUpdated && data.conversation) {
          onConversationUpdated(data.conversation);
        }
      } catch (error) {
        logger.error('Error parsing conversation update:', error);
      }
    });

    // Handle conversation deleted
    eventSource.addEventListener('conversation_deleted', (event) => {
      try {
        const data = JSON.parse(event.data);
        logger.debug('Received conversation deleted', { conversationId: data.conversationId });
        if (onConversationDeleted && data.conversationId) {
          onConversationDeleted(data.conversationId);
        }
      } catch (error) {
        logger.error('Error parsing conversation deleted event:', error);
      }
    });

    // Handle conversation list changed (new conversation created, list reordered, etc.)
    eventSource.addEventListener('conversation_list_changed', (event) => {
      logger.debug('Received conversation list changed event');
      if (onConversationListChanged) {
        onConversationListChanged();
      }
    });

    // Handle streaming started
    eventSource.addEventListener('streaming_started', (event) => {
      try {
        const data = JSON.parse(event.data);
        logger.debug('Streaming started', { conversationId: data.conversationId });
        setStreamingStates((prev) => ({
          ...prev,
          [data.conversationId]: true,
        }));
        if (onStreamingStateChanged) {
          onStreamingStateChanged(data.conversationId, true);
        }
      } catch (error) {
        logger.error('Error parsing streaming_started event:', error);
      }
    });

    // Handle streaming ended
    eventSource.addEventListener('streaming_ended', (event) => {
      try {
        const data = JSON.parse(event.data);
        logger.debug('Streaming ended', { conversationId: data.conversationId });
        setStreamingStates((prev) => {
          const next = { ...prev };
          delete next[data.conversationId];
          return next;
        });
        if (onStreamingStateChanged) {
          onStreamingStateChanged(data.conversationId, false);
        }
      } catch (error) {
        logger.error('Error parsing streaming_ended event:', error);
      }
    });

    // Handle heartbeat
    eventSource.addEventListener('heartbeat', () => {
      logger.debug('Received heartbeat');
    });

    // Handle errors
    eventSource.onerror = () => {
      logger.warn('SSE connection error');
      setIsConnected(false);

      if (onDisconnected) {
        onDisconnected();
      }

      if (!isIntentionalDisconnectRef.current && isPageVisibleRef.current) {
        attemptReconnect();
      }
    };

    // Store reference for cleanup
    const client: SSEClient = {
      connect: () => {},
      close: () => {
        eventSource.close();
      },
      isConnected: () => eventSource.readyState === EventSource.OPEN,
    } as SSEClient;

    sseClientRef.current = client;

    // Also store the actual event source for cleanup
    (client as any)._eventSource = eventSource;

  }, [enabled, onConversationUpdated, onConversationDeleted, onConversationListChanged, onStreamingStateChanged, onConnected, onDisconnected]);

  const attemptReconnect = useCallback(() => {
    if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached');
      return;
    }

    reconnectAttemptsRef.current++;
    const delay = reconnectDelay * Math.pow(2, reconnectAttemptsRef.current - 1);

    logger.info(`Attempting to reconnect in ${delay}ms (attempt ${reconnectAttemptsRef.current})`);

    reconnectTimerRef.current = setTimeout(() => {
      if (!isIntentionalDisconnectRef.current && isPageVisibleRef.current) {
        setupEventSource();
      }
    }, delay);
  }, [reconnectDelay, maxReconnectAttempts, setupEventSource]);

  const connect = useCallback(() => {
    isIntentionalDisconnectRef.current = false;
    reconnectAttemptsRef.current = 0;
    setupEventSource();
  }, [setupEventSource]);

  const disconnect = useCallback(() => {
    isIntentionalDisconnectRef.current = true;

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (sseClientRef.current) {
      const client = sseClientRef.current as any;
      if (client._eventSource) {
        client._eventSource.close();
      }
      sseClientRef.current.close();
      sseClientRef.current = null;
    }

    setIsConnected(false);
  }, []);

  // Track visibility for reconnection logic
  useEffect(() => {
    const handleVisibilityChange = () => {
      const wasVisible = isPageVisibleRef.current;
      isPageVisibleRef.current = document.visibilityState === 'visible';

      // Reconnect when page becomes visible if not connected
      if (!wasVisible && isPageVisibleRef.current && enabled && !isConnected) {
        logger.info('Page became visible - reconnecting');
        connect();
      }

      // Disconnect when page becomes hidden to save resources
      if (wasVisible && !isPageVisibleRef.current && isConnected) {
        logger.info('Page hidden - disconnecting to save resources');
        disconnect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [enabled, isConnected, connect, disconnect]);

  // Setup on mount
  useEffect(() => {
    if (enabled) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    isConnected,
    connect,
    disconnect,
    streamingStates,
  };
};
