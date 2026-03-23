import { useContext, useMemo } from 'react';
import HomeContext from '@/pages/api/home/home.context';

/**
 * Centralized hook for determining streaming state of a conversation.
 * Eliminates the duplicated streaming-state derivation logic that was
 * scattered across ChatInput, VirtualMessageList, ChatMessage, and
 * IntermediateSteps.
 */
export function useIsStreaming(conversationId?: string | null) {
  const {
    state: { messageIsStreaming, streamingByConversationId },
  } = useContext(HomeContext);

  return useMemo(() => {
    const isConversationStreaming = conversationId
      ? Boolean(streamingByConversationId[conversationId])
      : false;
    return {
      /** True if any conversation is currently streaming */
      isAnyStreaming: messageIsStreaming,
      /** True if the specified conversation is streaming */
      isStreaming: messageIsStreaming && isConversationStreaming,
      /** Raw per-conversation streaming map */
      streamingByConversationId,
    };
  }, [messageIsStreaming, streamingByConversationId, conversationId]);
}
