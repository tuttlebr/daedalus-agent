'use client';

import React from 'react';
import classNames from 'classnames';
import { IconMessageCircle, IconSparkles } from '@tabler/icons-react';
import { useUISettingsStore, type AppView } from '@/state/uiSettingsStore';

const TABS: { id: AppView; label: string; icon: React.ReactNode }[] = [
  { id: 'chat', label: 'Chat', icon: <IconMessageCircle size={16} /> },
  { id: 'create', label: 'Create New', icon: <IconSparkles size={16} /> },
];

export function ViewTabs() {
  const activeView = useUISettingsStore((s) => s.activeView);
  const setActiveView = useUISettingsStore((s) => s.setActiveView);

  return (
    <div
      role="tablist"
      className="flex items-center gap-1 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-dark-bg-primary px-4"
    >
      {TABS.map((tab) => {
        const active = activeView === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setActiveView(tab.id)}
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
