'use client';

import {
  IconBrain,
  IconLayoutSidebar,
  IconMessageCircle,
  IconRobot,
  IconSparkles,
  IconPlugConnected,
} from '@tabler/icons-react';
import React, { useRef } from 'react';

import { IconButton } from '@/components/primitives';

import { useUISettingsStore, type AppView } from '@/state/uiSettingsStore';
import classNames from 'classnames';

const TABS: { id: AppView; label: string; icon: React.ReactNode }[] = [
  { id: 'chat', label: 'Chat', icon: <IconMessageCircle size={16} /> },
  { id: 'create', label: 'Create', icon: <IconSparkles size={16} /> },
  { id: 'autonomy', label: 'Autonomy', icon: <IconRobot size={16} /> },
  { id: 'memory', label: 'Memory', icon: <IconBrain size={16} /> },
  {
    id: 'connections',
    label: 'Connections',
    icon: <IconPlugConnected size={16} />,
  },
];

export function ViewTabs() {
  const activeView = useUISettingsStore((s) => s.activeView);
  const setActiveView = useUISettingsStore((s) => s.setActiveView);
  const toggleChatbar = useUISettingsStore((s) => s.toggleChatbar);
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
    <div className="app-view-tabs app-chrome hidden min-w-0 items-center gap-2 border-b px-3 py-2 safe-top md:flex">
      <IconButton
        icon={<IconLayoutSidebar size={20} />}
        aria-label="Toggle sidebar"
        variant="ghost"
        onClick={toggleChatbar}
      />
      <div
        role="tablist"
        aria-label="Views"
        className="flex min-w-0 flex-wrap items-center gap-1"
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
              id={`view-tab-${tab.id}`}
              aria-controls={`view-panel-${tab.id}`}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => setActiveView(tab.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={classNames(
                'app-nav-item relative inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40 focus-visible:ring-inset',
                active ? 'text-nvidia-green' : 'text-muted hover:text-primary',
              )}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
