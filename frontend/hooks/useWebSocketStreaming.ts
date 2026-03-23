/**
 * useWebSocketStreaming Hook
 *
 * Provides token-by-token chat streaming over WebSocket.
 * Subscribes to a conversation's token channel, accumulates tokens,
 * and provides a StreamState interface compatible with the SSE path.
 * Falls back to SSE if WS is unavailable.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { getWebSocketManager } from '@/services/websocket';
import { Logger } from '@/utils/logger';

const logger = new Logger('WebSocketStreaming');

export interface StreamState {
  isStreaming: boolean;
  content: string;
  intermediateSteps: any[];
  error?: string;
}

interface UseWebSocketStreamingOptions {
  conversationId: string | null;
  enabled: boolean;
  onToken?: (content: string) => void;
  onIntermediateStep?: (step: any) => void;
  onComplete?: (fullResponse: string, intermediateSteps: any[]) => void;
  onError?: (error: string) => void;
}

export const useWebSocketStreaming = ({
  conversationId,
  enabled,
  onToken,
  onIntermediateStep,
  onComplete,
  onError,
}: UseWebSocketStreamingOptions) => {
  const [streamState, setStreamState] = useState<StreamState>({
    isStreaming: false,
    content: '',
    intermediateSteps: [],
  });

  const callbacksRef = useRef({ onToken, onIntermediateStep, onComplete, onError });
  callbacksRef.current = { onToken, onIntermediateStep, onComplete, onError };

  const contentRef = useRef('');
  const stepsRef = useRef<any[]>([]);
  const unsubsRef = useRef<Array<() => void>>([]);

  const subscribe = useCallback((convId: string) => {
    const manager = getWebSocketManager();
    if (!manager.isConnected) return false;

    // Reset state
    contentRef.current = '';
    stepsRef.current = [];
    setStreamState({ isStreaming: true, content: '', intermediateSteps: [] });

    // Subscribe to the conversation's token channel
    manager.subscribeToChat(convId);

    const unsubs: Array<() => void> = [];

    unsubs.push(manager.on('chat_token', (data: any) => {
      if (data.conversationId !== convId) return;
      contentRef.current += data.content;
      setStreamState({
        isStreaming: true,
        content: contentRef.current,
        intermediateSteps: stepsRef.current,
      });
      callbacksRef.current.onToken?.(data.content);
    }));

    unsubs.push(manager.on('chat_intermediate_step', (data: any) => {
      if (data.conversationId !== convId) return;
      // Deduplicate by UUID before appending
      const uuid = data.step?.payload?.UUID;
      if (uuid && stepsRef.current.some((s: any) => s.payload?.UUID === uuid)) return;
      stepsRef.current = [...stepsRef.current, data.step];
      setStreamState(prev => ({
        ...prev,
        intermediateSteps: stepsRef.current,
      }));
      callbacksRef.current.onIntermediateStep?.(data.step);
    }));

    unsubs.push(manager.on('chat_complete', (data: any) => {
      if (data.conversationId !== convId) return;
      const finalContent = data.fullResponse || contentRef.current;
      const finalSteps = data.intermediateSteps || stepsRef.current;
      setStreamState({
        isStreaming: false,
        content: finalContent,
        intermediateSteps: finalSteps,
      });
      callbacksRef.current.onComplete?.(finalContent, finalSteps);
      // Unsubscribe after completion
      manager.unsubscribeFromChat(convId);
    }));

    unsubsRef.current = unsubs;
    return true;
  }, []);

  const unsubscribe = useCallback(() => {
    unsubsRef.current.forEach(unsub => unsub());
    unsubsRef.current = [];
    if (conversationId) {
      const manager = getWebSocketManager();
      manager.unsubscribeFromChat(conversationId);
    }
    setStreamState(prev => ({ ...prev, isStreaming: false }));
  }, [conversationId]);

  // Auto-subscribe when conversationId changes and streaming is enabled
  useEffect(() => {
    if (!enabled || !conversationId) return;
    const subscribed = subscribe(conversationId);
    if (!subscribed) {
      logger.debug('WS not connected, falling back to SSE/polling');
    }
    return () => unsubscribe();
  }, [enabled, conversationId, subscribe, unsubscribe]);

  return {
    streamState,
    subscribe,
    unsubscribe,
    isWsAvailable: getWebSocketManager().isConnected,
  };
};
