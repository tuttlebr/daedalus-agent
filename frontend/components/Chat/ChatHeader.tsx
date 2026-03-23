'use client'

import React, { useContext, useCallback, memo } from 'react';
import { IconMenu2, IconX, IconBrain, IconBolt } from '@tabler/icons-react';
import HomeContext from '@/pages/api/home/home.context';

export const ChatHeader = memo(() => {
  const {
    state: { selectedConversation, showChatbar, useDeepThinker, messageIsStreaming, streamingByConversationId },
    dispatch: homeDispatch,
  } = useContext(HomeContext);

  const hasMessages = Boolean(selectedConversation?.messages?.length);
  const isStreaming = selectedConversation?.id
    ? messageIsStreaming && Boolean(streamingByConversationId[selectedConversation.id])
    : false;

  const setMode = useCallback(
    (deep: boolean) => homeDispatch({ field: 'useDeepThinker', value: deep }),
    [homeDispatch],
  );

  return (
    <header
      className={`sticky top-0 z-20 flex w-full flex-col border-b border-border-glass px-4 text-sm transition-all duration-300 sm:px-6 ${hasMessages ? 'liquid-glass-control animate-morph-in' : 'bg-transparent'}`}
      style={{
        paddingTop: 'calc(env(safe-area-inset-top))',
      }}
    >
      {/* Top row: mobile menu + streaming indicator */}
      <div className="flex h-[calc(3rem+env(safe-area-inset-top))] items-center justify-between">
        <div className="flex items-center md:hidden">
          <button
            type="button"
            className="flex h-11 w-11 items-center justify-center rounded-full text-white transition-colors duration-200 hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40"
            onClick={() =>
              homeDispatch({ field: 'showChatbar', value: !showChatbar })
            }
            aria-label="Toggle menu"
          >
            {showChatbar ? <IconX size={22} /> : <IconMenu2 size={22} />}
          </button>
        </div>

        {/* Mode toggle pills */}
        <div className="flex flex-1 items-center justify-center gap-2.5">
          <button
            type="button"
            onClick={() => setMode(false)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold tracking-wide transition-all duration-200 ${
              !useDeepThinker
                ? 'bg-nvidia-green/15 text-nvidia-green border border-nvidia-green/30'
                : 'bg-transparent text-neutral-500 dark:text-neutral-400 border border-transparent hover:text-neutral-300 hover:border-white/10'
            }`}
          >
            <IconBolt size={14} />
            Tool-Calling
          </button>
          <button
            type="button"
            onClick={() => setMode(true)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold tracking-wide transition-all duration-200 ${
              useDeepThinker
                ? 'bg-[rgba(149,47,198,0.15)] text-[#b66de0] border border-[rgba(149,47,198,0.3)]'
                : 'bg-transparent text-neutral-500 dark:text-neutral-400 border border-transparent hover:text-neutral-300 hover:border-white/10'
            }`}
          >
            <IconBrain size={14} />
            Deep Thinker
          </button>

          {isStreaming && (
            <span className="flex items-center gap-1 text-[10px] text-nvidia-green font-medium ml-2">
              <span className="w-1.5 h-1.5 rounded-full bg-nvidia-green animate-pulse" />
              Streaming
            </span>
          )}
        </div>

        <div className="w-11 md:hidden" />
      </div>
    </header>
  );
});

ChatHeader.displayName = 'ChatHeader';
