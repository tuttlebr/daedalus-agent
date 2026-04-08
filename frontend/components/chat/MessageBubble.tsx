'use client';

import { memo } from 'react';
import { Message } from '@/types/chat';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';

interface MessageBubbleProps {
  message: Message;
  messageIndex: number;
  isStreaming?: boolean;
  onRetry?: () => void;
}

/**
 * Dispatches to the appropriate message component based on role.
 */
export const MessageBubble = memo(({
  message,
  messageIndex,
  isStreaming = false,
  onRetry,
}: MessageBubbleProps) => {
  // Skip empty messages
  const hasContent = message.content && typeof message.content === 'string' && message.content.trim();
  const hasSteps = message.intermediateSteps && message.intermediateSteps.length > 0;
  const hasAttachments = message.attachments && message.attachments.length > 0;

  if (!hasContent && !hasSteps && !hasAttachments && !isStreaming) {
    return null;
  }

  // System messages
  if (message.role === 'system') {
    return (
      <div className="flex justify-center py-2">
        <span className="px-3 py-1 text-xs text-dark-text-muted bg-white/[0.03] rounded-full border border-white/[0.04]">
          {message.content}
        </span>
      </div>
    );
  }

  // User messages
  if (message.role === 'user') {
    return <UserMessage message={message} messageIndex={messageIndex} />;
  }

  // Assistant and agent messages
  return (
    <AssistantMessage
      message={message}
      messageIndex={messageIndex}
      isStreaming={isStreaming}
      onRetry={onRetry}
    />
  );
});

MessageBubble.displayName = 'MessageBubble';
