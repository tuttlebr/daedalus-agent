'use client';

import React, { memo } from 'react';
import classNames from 'classnames';
import { IconMenu2, IconPaperclip, IconBrain, IconPlus } from '@tabler/icons-react';
import { useUISettingsStore, useConversationStore } from '@/state';
import { v4 as uuidv4 } from 'uuid';
import { saveConversation } from '@/utils/app/conversation';
import { Conversation } from '@/types/chat';

/**
 * Mobile bottom navigation bar.
 * 4 buttons: Menu, Attach, Think, New Chat.
 * Frosted glass backdrop with safe area inset.
 */
export const BottomNav = memo(() => {
  const showChatbar = useUISettingsStore((s) => s.showChatbar);
  const setShowChatbar = useUISettingsStore((s) => s.setShowChatbar);
  const useDeepThinker = useUISettingsStore((s) => s.useDeepThinker);
  const toggleDeepThinker = useUISettingsStore((s) => s.toggleDeepThinker);

  const items = [
    {
      icon: IconMenu2,
      label: 'Menu',
      active: showChatbar,
      onClick: () => setShowChatbar(!showChatbar),
    },
    {
      icon: IconPaperclip,
      label: 'Attach',
      active: false,
      onClick: () => {
        document.dispatchEvent(new CustomEvent('daedalus:attach-file'));
      },
    },
    {
      icon: IconBrain,
      label: 'Think',
      active: useDeepThinker,
      onClick: toggleDeepThinker,
    },
    {
      icon: IconPlus,
      label: 'New',
      active: false,
      onClick: () => {
        const newConv: Conversation = {
          id: uuidv4(),
          name: 'New Conversation',
          messages: [],
          folderId: null,
          updatedAt: Date.now(),
        };
        useConversationStore.getState().addConversation(newConv);
        useConversationStore.getState().selectConversation(newConv.id);
        saveConversation(newConv);
      },
    },
  ];

  return (
    <nav
      className="md:hidden flex-shrink-0 bg-black/60 backdrop-blur-xl border-t border-white/[0.06] safe-bottom z-40"
      role="navigation"
      aria-label="Bottom navigation"
    >
      <div className="flex items-center justify-around px-2 h-14">
        {items.map(({ icon: Icon, label, active, onClick }) => (
          <button
            key={label}
            onClick={onClick}
            aria-label={label}
            className={classNames(
              'flex flex-col items-center justify-center gap-0.5',
              'min-w-[52px] min-h-[48px] rounded-xl',
              'transition-all duration-150 touch-manipulation',
              'active:scale-90',
              active
                ? 'text-nvidia-green'
                : 'text-dark-text-muted'
            )}
          >
            <div className="relative">
              <Icon size={22} />
              {active && label === 'Think' && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-nvidia-green animate-heartbeat-breathe" />
              )}
              {active && label !== 'Think' && (
                <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-nvidia-green" />
              )}
            </div>
            <span className="text-[9px] font-medium">{label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
});

BottomNav.displayName = 'BottomNav';
