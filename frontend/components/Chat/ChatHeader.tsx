'use client'

import React, { useContext, memo, useEffect, useState } from 'react';
import { IconMenu2 } from '@tabler/icons-react';
import HomeContext from '@/pages/api/home/home.context';
import { getWorkflowName } from '@/utils/app/helper';

export const ChatHeader = memo(() => {
  const workflow = getWorkflowName();
  const {
    state: { selectedConversation, showChatbar },
    dispatch,
  } = useContext(HomeContext);

  const [scrollY, setScrollY] = useState(0);
  const [glassIntensity, setGlassIntensity] = useState<'subtle' | 'medium' | 'strong'>('strong');

  useEffect(() => {
    const handleScroll = () => {
      // Listen to scroll on chat container
      const chatContainer = document.getElementById('chat-scroll-region');
      if (chatContainer) {
        const scrollPosition = chatContainer.scrollTop;
        setScrollY(scrollPosition);
        
        // Adjust glass intensity based on scroll position
        if (scrollPosition < 50) {
          setGlassIntensity('strong');
        } else if (scrollPosition < 200) {
          setGlassIntensity('medium');
        } else {
          setGlassIntensity('subtle');
        }
      }
    };

    // Listen to scroll on chat container
    const chatContainer = document.getElementById('chat-scroll-region');
    if (chatContainer) {
      chatContainer.addEventListener('scroll', handleScroll);
      // Initial check
      handleScroll();
      return () => chatContainer.removeEventListener('scroll', handleScroll);
    }
  }, []);

  const handleToggleMenu = () => {
    dispatch({ field: 'showChatbar', value: !showChatbar });
  };

  const hasMessages = Boolean(selectedConversation?.messages?.length);

  const glassIntensityClass = 
    glassIntensity === 'strong' ? 'liquid-glass-strong' :
    glassIntensity === 'medium' ? 'liquid-glass-medium' :
    'liquid-glass-subtle';

  return (
    <header
      className={`sticky top-0 z-30 w-full border-b border-white/5 liquid-glass ${glassIntensityClass} px-4 py-3 text-sm text-white transition-all duration-300 dark:text-white sm:px-6`}
      style={{
        paddingTop: 'calc(env(safe-area-inset-top))',
        background: 'linear-gradient(to bottom, rgba(0, 0, 0, 0.6), rgba(0, 0, 0, 0.2), transparent)',
      }}
      data-scroll-glass={glassIntensity}
      role="banner"
    >
      <div className="mx-auto flex w-full max-w-5xl items-center gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={handleToggleMenu}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full liquid-glass liquid-glass-subtle text-white transition-all duration-300 focus-ring-glass focus-visible:outline-none md:hidden"
            aria-label={showChatbar ? 'Hide conversations' : 'Show conversations'}
            aria-pressed={showChatbar}
          >
            <IconMenu2 size={18} />
          </button>
        </div>

        <div className="flex flex-1 flex-col items-center gap-0.5 text-center md:items-start md:text-left">
          <span className="text-[11px] uppercase tracking-[0.2em] text-white/60 dark:text-white/50">
            {workflow}
          </span>
          {hasMessages && (
            <p className="truncate text-base font-medium text-white">
              {selectedConversation?.name || 'New Conversation'}
            </p>
          )}
        </div>

        <div className="hidden min-h-[44px] min-w-[44px] items-center justify-end md:flex" aria-hidden="true">
          {/* Reserved for future actions */}
        </div>
      </div>
    </header>
  );
});

ChatHeader.displayName = 'ChatHeader';
