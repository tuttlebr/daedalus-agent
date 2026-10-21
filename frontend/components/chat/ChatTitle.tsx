'use client';

import { IconPlus, IconRobot } from '@tabler/icons-react';
import React, { memo } from 'react';

import { startNewConversation } from '@/utils/app/conversation';

import { IconButton } from '@/components/primitives';

import { useConversationStore, useUISettingsStore } from '@/state';
import classNames from 'classnames';

const AUTONOMOUS_CONVERSATION_ID = 'autonomous-agent-thoughts';

/**
 * The selected conversation's name with its ownership and streaming state.
 * Phones show it in the Chat header; wider windows show it in the toolbar.
 */
export const ChatTitle = memo(
  ({
    as: Heading = 'span',
    className,
  }: {
    as?: 'h1' | 'span';
    className?: string;
  }) => {
    const title = useConversationStore((s) => {
      const id = s.selectedConversationId;
      return (id && s.conversations.find((c) => c.id === id)?.name) || '';
    });
    const isAutonomous = useConversationStore(
      (s) => s.selectedConversationId === AUTONOMOUS_CONVERSATION_ID,
    );
    const isStreaming = useConversationStore(
      (s) =>
        !!s.selectedConversationId &&
        s.streamingConversationIds.has(s.selectedConversationId),
    );

    return (
      <div className={classNames('flex min-w-0 items-center gap-3', className)}>
        {isAutonomous && (
          <span className="flex flex-shrink-0 items-center gap-1 rounded-full border border-nvidia-purple/30 bg-nvidia-purple/15 px-2 py-0.5 text-[0.75rem] font-medium text-nvidia-purple">
            <IconRobot size={12} aria-hidden="true" />
            Autonomous
          </span>
        )}
        <Heading className="truncate text-sm font-medium text-dark-text-primary">
          {title || 'New Chat'}
        </Heading>
        {isStreaming && (
          <span className="flex flex-shrink-0 items-center gap-1.5 text-xs text-nvidia-green">
            <span className="h-1.5 w-1.5 rounded-full bg-nvidia-green animate-heartbeat-breathe" />
            Streaming
          </span>
        )}
      </div>
    );
  },
);

ChatTitle.displayName = 'ChatTitle';

/** Opens an empty conversation and closes the history drawer. */
export const NewChatButton = memo(({ className }: { className?: string }) => {
  const setShowChatbar = useUISettingsStore((s) => s.setShowChatbar);
  return (
    <IconButton
      icon={<IconPlus />}
      aria-label="New chat"
      variant="ghost"
      size="md"
      onClick={() => {
        startNewConversation();
        setShowChatbar(false);
      }}
      className={classNames('flex-shrink-0', className)}
    />
  );
});

NewChatButton.displayName = 'NewChatButton';
