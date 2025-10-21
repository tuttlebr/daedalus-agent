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
    if (!enabled || !conversationId) {
      console.log('Sync skipped - enabled:', enabled, 'conversationId:', conversationId);
      return;
    }

    console.log(`🔄 Syncing conversation ${conversationId} from server...`);

    try {
      const response = await fetch(`/api/conversations/${conversationId}`);
      if (response.ok) {
        const data = await response.json();
        console.log(`📥 Received conversation data:`, {
          conversationId: data.conversationId,
          messageCount: data.messages?.length || 0,
          status: data.status,
          updatedAt: data.updatedAt,
          isPartial: data.isPartial,
        });

        if (data.messages && onMessagesUpdated) {
          console.log(`✅ Updating UI with ${data.messages.length} messages`);
          onMessagesUpdated(data.messages);
        }
        lastSyncRef.current = Date.now();
      } else {
        console.error(`Failed to sync conversation - status: ${response.status}`);
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

  // Only poll when actively needed (disabled for now to prevent unnecessary syncs)
  // Syncing on visibility change should be sufficient
  useEffect(() => {
    if (!enabled) return;

    // Disabled automatic polling - rely on visibility change events
    // If polling is needed in the future, increase interval to reduce load
    // syncIntervalRef.current = setInterval(() => {
    //   if (document.visibilityState === 'visible') {
    //     syncConversation();
    //   }
    // }, 10000); // 10 seconds instead of 3

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
      }
    };
  }, [enabled, conversationId]);

  return { syncConversation };
};
