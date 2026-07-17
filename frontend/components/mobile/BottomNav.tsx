'use client';

import {
  IconMenu2,
  IconMessageCircle,
  IconPlus,
  IconRobot,
  IconSparkles,
} from '@tabler/icons-react';
import React, { memo } from 'react';

import { saveConversation } from '@/utils/app/conversation';

import { Conversation } from '@/types/chat';

import { useUISettingsStore, useConversationStore } from '@/state';
import classNames from 'classnames';
import { v4 as uuidv4 } from 'uuid';

/**
 * Mobile bottom navigation bar.
 * Primary mobile entry points plus a distinct New Chat action.
 * Frosted glass backdrop with safe area inset.
 */
export const BottomNav = memo(() => {
  const showChatbar = useUISettingsStore((s) => s.showChatbar);
  const setShowChatbar = useUISettingsStore((s) => s.setShowChatbar);
  const activeView = useUISettingsStore((s) => s.activeView);
  const setActiveView = useUISettingsStore((s) => s.setActiveView);

  const items = [
    {
      icon: IconMenu2,
      label: 'Menu',
      active: showChatbar,
      onClick: () => setShowChatbar(!showChatbar),
    },
    {
      icon: IconMessageCircle,
      label: 'Chat',
      active: activeView === 'chat',
      onClick: () => {
        setShowChatbar(false);
        setActiveView('chat');
      },
    },
    {
      icon: IconSparkles,
      label: 'Create',
      active: activeView === 'create',
      onClick: () => {
        setShowChatbar(false);
        setActiveView('create');
      },
    },
    {
      icon: IconRobot,
      label: 'Auto',
      active: activeView === 'autonomy',
      onClick: () => {
        setShowChatbar(false);
        setActiveView('autonomy');
      },
    },
    {
      icon: IconPlus,
      label: 'New',
      active: false,
      onClick: () => {
        setShowChatbar(false);
        setActiveView('chat');
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
              active ? 'text-nvidia-green' : 'text-dark-text-muted',
            )}
          >
            <div className="relative">
              <Icon size={22} />
              {active && (
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
