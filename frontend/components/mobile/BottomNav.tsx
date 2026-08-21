'use client';

import {
  IconMessageCircle,
  IconPlugConnected,
  IconRobot,
  IconSparkles,
} from '@tabler/icons-react';
import React, { memo } from 'react';

import { useUISettingsStore } from '@/state';
import classNames from 'classnames';

/**
 * Mobile bottom navigation bar.
 * Peer top-level mobile destinations. Commands such as Menu and New Chat live
 * in the Chat toolbar instead of competing with navigation.
 * Frosted glass backdrop with safe area inset.
 */
export const BottomNav = memo(
  ({ keyboardOpen = false }: { keyboardOpen?: boolean }) => {
    const setShowChatbar = useUISettingsStore((s) => s.setShowChatbar);
    const activeView = useUISettingsStore((s) => s.activeView);
    const setActiveView = useUISettingsStore((s) => s.setActiveView);

    const items = [
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
        label: 'Autonomy',
        active: activeView === 'autonomy',
        onClick: () => {
          setShowChatbar(false);
          setActiveView('autonomy');
        },
      },
      {
        icon: IconPlugConnected,
        label: 'Connections',
        active: activeView === 'connections',
        onClick: () => {
          setShowChatbar(false);
          setActiveView('connections');
        },
      },
    ];

    if (keyboardOpen) return null;

    return (
      <nav
        className="md:hidden flex-shrink-0 bg-black/60 backdrop-blur-xl border-t border-white/[0.06] safe-bottom z-40"
        role="navigation"
        aria-label="Primary navigation"
      >
        <div className="flex items-center justify-around px-2 h-14">
          {items.map(({ icon: Icon, label, active, onClick }) => (
            <button
              key={label}
              onClick={onClick}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              className={classNames(
                'flex flex-col items-center justify-center gap-0.5',
                'min-w-[52px] min-h-[48px] rounded-xl',
                'transition-all duration-150 touch-manipulation motion-reduce:transition-none',
                'active:scale-90 motion-reduce:active:scale-100',
                active ? 'text-nvidia-green' : 'text-dark-text-muted',
              )}
            >
              <div className="relative">
                <Icon size={22} />
                {active && (
                  <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-nvidia-green" />
                )}
              </div>
              <span className="text-[11px] font-medium leading-none">
                {label}
              </span>
            </button>
          ))}
        </div>
      </nav>
    );
  },
);

BottomNav.displayName = 'BottomNav';
