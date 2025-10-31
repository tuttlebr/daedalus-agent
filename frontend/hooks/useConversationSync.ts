import { useEffect, useRef, useCallback } from 'react';
import { Conversation, Message } from '@/types/chat';

interface ConversationSyncOptions {
  enabled: boolean;
  conversationId?: string;
  onConversationUpdated?: (conversation: Conversation) => void;
  minSyncInterval?: number; // Minimum time between syncs in milliseconds
}

/**
 * Hook to sync conversation state from server in specific scenarios:
 * - When app regains focus after being in background
 * - Manually triggered after sending a message
 * - With debouncing to prevent excessive syncs
 */
export const useConversationSync = ({
  enabled,
  conversationId,
  onConversationUpdated,
  minSyncInterval = 5000, // Default 5 seconds between syncs
}: ConversationSyncOptions) => {
  const lastSyncRef = useRef<number>(0);
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastConversationHashRef = useRef<string>('');

  // Generate a simple hash of conversation state for comparison
  const generateConversationHash = (conversation: Conversation): string => {
    // Use message count and last message ID for change detection
    const lastMessageId = conversation.messages?.length > 0
      ? conversation.messages[conversation.messages.length - 1].id
      : '';
    return `${conversation.id}-${conversation.messages?.length || 0}-${lastMessageId}`;
  };

  // Fetch latest conversation state from server with debouncing
  const syncConversation = useCallback(async (force = false) => {
    if (!enabled || !conversationId) {
      return;
    }

    // Check if enough time has passed since last sync
    const now = Date.now();
    const timeSinceLastSync = now - lastSyncRef.current;

    if (!force && timeSinceLastSync < minSyncInterval) {
      console.log(`⏳ Skipping sync - only ${timeSinceLastSync}ms since last sync (min: ${minSyncInterval}ms)`);
      return;
    }

    console.log(`🔄 Syncing conversation ${conversationId} from server...`);

    try {
      const response = await fetch(`/api/conversations/${conversationId}`);
      if (response.ok) {
        const data = await response.json();
        const newHash = generateConversationHash(data);

        console.log(`📥 Received conversation data:`, {
          conversationId: data.conversationId || data.id,
          messageCount: data.messages?.length || 0,
          hasChanged: newHash !== lastConversationHashRef.current,
        });

        // Only update if conversation has actually changed
        if (data.messages && onConversationUpdated && newHash !== lastConversationHashRef.current) {
          console.log(`✅ Updating UI with ${data.messages.length} messages`);
          onConversationUpdated(data);
          lastConversationHashRef.current = newHash;
        } else if (newHash === lastConversationHashRef.current) {
          console.log(`⏭️ Skipping UI update - conversation hasn't changed`);
        }

        lastSyncRef.current = now;
      } else {
        console.error(`Failed to sync conversation - status: ${response.status}`);
      }
    } catch (error) {
      console.error('Failed to sync conversation:', error);
    }
  }, [enabled, conversationId, onConversationUpdated, minSyncInterval]);

  // Debounced sync function to prevent rapid-fire calls
  const debouncedSync = useCallback(() => {
    // Clear any existing timeout
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
    }

    // Set a new timeout for the sync
    syncTimeoutRef.current = setTimeout(() => {
      syncConversation();
    }, 300); // 300ms debounce delay
  }, [syncConversation]);

  // Sync when visibility changes (user returns to app) with debouncing
  useEffect(() => {
    if (!enabled) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('🔄 App visible - scheduling sync...');
        debouncedSync();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      // Clear timeout on cleanup
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
    };
  }, [enabled, debouncedSync]);

  // Trigger sync after sending a message
  const syncAfterSend = useCallback(() => {
    if (!enabled) return;

    console.log('📤 Message sent - scheduling sync...');
    // Use a longer delay after sending to allow server processing
    setTimeout(() => {
      syncConversation(true); // Force sync after sending
    }, 2000); // 2 second delay to allow server to process
  }, [enabled, syncConversation]);

  // Reset conversation hash when conversation changes
  useEffect(() => {
    lastConversationHashRef.current = '';
  }, [conversationId]);

  return {
    syncConversation,
    syncAfterSend,
    debouncedSync
  };
};
