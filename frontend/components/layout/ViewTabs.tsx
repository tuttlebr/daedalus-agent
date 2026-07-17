'use client';

import {
  IconMessageCircle,
  IconRobot,
  IconSparkles,
} from '@tabler/icons-react';
import React, { useRef } from 'react';

import { useUISettingsStore, type AppView } from '@/state/uiSettingsStore';
import classNames from 'classnames';

const TABS: { id: AppView; label: string; icon: React.ReactNode }[] = [
  { id: 'chat', label: 'Chat', icon: <IconMessageCircle size={16} /> },
  { id: 'autonomy', label: 'Autonomy', icon: <IconRobot size={16} /> },
  { id: 'create', label: 'Create', icon: <IconSparkles size={16} /> },
];

export function ViewTabs() {
  const activeView = useUISettingsStore((s) => s.activeView);
  const setActiveView = useUISettingsStore((s) => s.setActiveView);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (e.key === 'ArrowLeft')
      next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next !== null) {
      e.preventDefault();
      setActiveView(TABS[next].id);
      tabRefs.current[next]?.focus();
    }
  };

  return (
    <div
      role="tablist"
      aria-label="Views"
      className="hidden items-center gap-1 border-b border-neutral-200 bg-white px-4 safe-top dark:border-neutral-800 dark:bg-dark-bg-primary md:flex"
    >
      {TABS.map((tab, index) => {
        const active = activeView === tab.id;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => setActiveView(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={classNames(
              'relative inline-flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40 focus-visible:ring-inset',
              active
                ? 'text-nvidia-green'
                : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100',
            )}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {active && (
              <span className="absolute inset-x-0 bottom-0 h-[2px] bg-nvidia-green" />
            )}
          </button>
        );
      })}
    </div>
  );
}
