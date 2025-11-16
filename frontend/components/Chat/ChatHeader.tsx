'use client'

import React, { useContext, memo, useMemo } from 'react';
import { IconActivity, IconClock, IconMenu2 } from '@tabler/icons-react';
import HomeContext from '@/pages/api/home/home.context';
import { getWorkflowName } from '@/utils/app/helper';
import { FloatingControl } from '@/components/UI/FloatingControl';

export const ChatHeader = memo(() => {
  const workflow = getWorkflowName();
  const {
    state: { selectedConversation, showChatbar, messageIsStreaming, useDeepThinker },
    dispatch,
  } = useContext(HomeContext);

  const handleToggleMenu = () => {
    dispatch({ field: 'showChatbar', value: !showChatbar });
  };

  const messageCount = selectedConversation?.messages?.length ?? 0;
  const statusLabel = messageIsStreaming ? 'Streaming response' : 'Awaiting prompt';
  const StatusIcon = messageIsStreaming ? IconActivity : IconClock;

  const conversationName = selectedConversation?.name?.trim() || 'New Conversation';

  const descriptor = useMemo(() => {
    if (!messageCount) {
      return 'Begin a new exchange';
    }
    return `${messageCount} ${messageCount === 1 ? 'message' : 'messages'}`;
  }, [messageCount]);

  return (
    <header
      className="sticky top-0 z-30 w-full px-4 pt-4 text-sm text-white sm:px-6"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top))',
      }}
      role="banner"
    >
      <div className="mx-auto flex w-full max-w-5xl items-center gap-3 rounded-[28px] border border-white/10 bg-white/5 px-4 py-3 text-sm text-white shadow-[0_20px_60px_-35px_rgba(4,9,27,0.95)] backdrop-blur-2xl">
        <div className="flex items-center gap-2">
          <div className="md:hidden">
            <FloatingControl
              icon={<IconMenu2 size={16} />}
              label="Menu"
              hint={showChatbar ? 'Hide' : 'Show'}
              tone={showChatbar ? 'accent' : 'default'}
              active={showChatbar}
              onClick={handleToggleMenu}
              aria-pressed={showChatbar}
              aria-label={showChatbar ? 'Hide conversations' : 'Show conversations'}
            />
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-1 text-left">
          <span className="text-[0.65rem] uppercase tracking-[0.4em] text-white/60">
            {workflow}
          </span>
          <div className="flex flex-wrap items-baseline gap-2 text-white">
            <p className="truncate text-lg font-semibold">{conversationName}</p>
            <span className="text-[0.7rem] uppercase tracking-[0.35em] text-white/50">
              {descriptor}
            </span>
          </div>
        </div>

        <div className="hidden min-h-[44px] min-w-[44px] items-center gap-3 md:flex">
          <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-1.5 text-[0.7rem] uppercase tracking-[0.3em] text-white/75">
            <StatusIcon size={14} className="text-white/80" />
            <span>{statusLabel}</span>
          </div>
          {useDeepThinker && (
            <span className="rounded-2xl border border-white/15 bg-gradient-to-r from-cyan-300/30 to-emerald-300/30 px-3 py-1 text-[0.65rem] uppercase tracking-[0.35em] text-white">
              Deep Thinker
            </span>
          )}
        </div>
      </div>
    </header>
  );
});

ChatHeader.displayName = 'ChatHeader';
