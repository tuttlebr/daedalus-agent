import { useEffect, useRef } from 'react';
import { Conversation, Message } from '@/types/chat';

interface ConversationSyncOptions {
  enabled: boolean;
  conversationId?: string;
  onMessagesUpdated?: (messages: Message[]) => void;
}

/**
 * Simple hook to sync conversation state from server when app regains focus.
 * Handles the background processing use case: user locks screen, response completes,
 * user unlocks screen -> this fetches the completed response.
 */
export const useConversationSync = ({
  enabled,
  conversationId,
  onMessagesUpdated,
}: ConversationSyncOptions) => {
  const lastSyncRef = useRef<number>(0);
  const syncIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch latest conversation state from server
  const syncConversation = async () => {
    if (!enabled || !conversationId) return;

    try {
      const response = await fetch(`/api/conversations/${conversationId}`);
      if (response.ok) {
        const data = await response.json();
        if (data.messages && onMessagesUpdated) {
          onMessagesUpdated(data.messages);
        }
        lastSyncRef.current = Date.now();
      }
    } catch (error) {
      console.error('Failed to sync conversation:', error);
    }
  };

  // Sync immediately when visibility changes (user returns to app)
  useEffect(() => {
    if (!enabled) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('App visible - syncing conversation');
        syncConversation();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [enabled, conversationId]);

  // Poll every 3 seconds when visible
  useEffect(() => {
    if (!enabled) return;

    syncIntervalRef.current = setInterval(() => {
      if (document.visibilityState === 'visible') {
        syncConversation();
      }
    }, 3000);

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
      }
    };
  }, [enabled, conversationId]);

  return { syncConversation };
};
