'use client';

import {
  IconBrain,
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
        icon: IconBrain,
        label: 'Memory',
        active: activeView === 'memory',
        onClick: () => {
          setShowChatbar(false);
          setActiveView('memory');
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
        className="app-chrome md:hidden flex-shrink-0 border-t z-40"
        role="navigation"
        aria-label="Primary navigation"
      >
        <div className="app-bottom-nav">
          {items.map(({ icon: Icon, label, active, onClick }) => (
            <button
              key={label}
              onClick={onClick}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              className={classNames(
                'app-nav-item flex flex-col items-center justify-center gap-1',

                'transition-all duration-150 touch-manipulation motion-reduce:transition-none',

                active ? 'text-nvidia-green' : 'text-dark-text-muted',
              )}
            >
              <div className="relative">
                <Icon size={22} aria-hidden="true" />
              </div>
              <span className="app-nav-label font-medium">{label}</span>
            </button>
          ))}
        </div>
      </nav>
    );
  },
);

BottomNav.displayName = 'BottomNav';
