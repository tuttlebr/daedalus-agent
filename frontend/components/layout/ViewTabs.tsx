'use client';

import {
  IconBrain,
  IconLayoutSidebar,
  IconMessageCircle,
  IconRobot,
  IconSparkles,
  IconPlugConnected,
} from '@tabler/icons-react';
import React, { useLayoutEffect, useRef } from 'react';

import { ChatTitle, NewChatButton } from '@/components/chat/ChatTitle';
import { IconButton } from '@/components/primitives';

import { useUISettingsStore, type AppView } from '@/state/uiSettingsStore';
import classNames from 'classnames';

const TABS: { id: AppView; label: string; icon: React.ReactNode }[] = [
  {
    id: 'chat',
    label: 'Chat',
    icon: <IconMessageCircle size={17} aria-hidden="true" />,
  },
  {
    id: 'create',
    label: 'Create',
    icon: <IconSparkles size={17} aria-hidden="true" />,
  },
  {
    id: 'autonomy',
    label: 'Autonomy',
    icon: <IconRobot size={17} aria-hidden="true" />,
  },
  {
    id: 'memory',
    label: 'Memory',
    icon: <IconBrain size={17} aria-hidden="true" />,
  },
  {
    id: 'connections',
    label: 'Connections',
    icon: <IconPlugConnected size={17} aria-hidden="true" />,
  },
];

/**
 * The single toolbar for wider windows: sidebar, destinations and the shown
 * destination's own controls (in Chat, the conversation title and New chat).
 * It floats over the content, which scrolls beneath it. Phones use the tab
 * bar instead.
 */
export function ViewTabs({
  onSlotChange,
}: {
  /** Receives the slot for destination controls while the toolbar is shown. */
  onSlotChange?: (slot: HTMLElement | null) => void;
}) {
  const activeView = useUISettingsStore((s) => s.activeView);
  const setActiveView = useUISettingsStore((s) => s.setActiveView);
  const toggleChatbar = useUISettingsStore((s) => s.toggleChatbar);
  const showChatbar = useUISettingsStore((s) => s.showChatbar);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const barRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);

  // Content starts below the toolbar and scrolls beneath it, so publish the
  // toolbar's height to the column. It is zero while the toolbar is hidden on
  // phones or above a software keyboard, which also withdraws the slot.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const column = bar?.parentElement;
    if (!bar || !column) return;
    const update = () => {
      const height = bar.getBoundingClientRect().height;
      column.style.setProperty('--app-toolbar-inset', `${height}px`);
      onSlotChange?.(height > 0 ? slotRef.current : null);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      column.style.removeProperty('--app-toolbar-inset');
      onSlotChange?.(null);
    };
  }, [onSlotChange]);

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
      ref={barRef}
      data-view={activeView}
      className="app-view-tabs hidden min-w-0 items-center md:flex"
    >
      <IconButton
        icon={<IconLayoutSidebar size={20} />}
        aria-label="Toggle sidebar"
        aria-expanded={showChatbar}
        variant="ghost"
        className="app-chrome app-toolbar-button app-sidebar-toggle shrink-0"
        onClick={toggleChatbar}
      />
      <div
        role="tablist"
        aria-label="Views"
        className="app-navigation-cluster app-chrome flex min-w-0 flex-wrap items-center gap-1"
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
              aria-label={tab.label}
              title={tab.label}
              id={`view-tab-${tab.id}`}
              aria-controls={`view-panel-${tab.id}`}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => setActiveView(tab.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={classNames(
                'app-nav-item relative inline-flex items-center justify-center gap-2 rounded-full px-3 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset',
                !active && 'text-muted hover:text-primary',
              )}
            >
              {tab.icon}
              <span className="app-nav-label">{tab.label}</span>
            </button>
          );
        })}
      </div>
      <div className="app-toolbar-context flex min-w-0 flex-1 items-center gap-2">
        {activeView === 'chat' && (
          <div className="app-toolbar-title flex min-w-[6rem] flex-1 items-center gap-2 pl-1">
            <ChatTitle className="flex-1" />
            {/* The open sidebar offers New Chat; the toolbar does not repeat it. */}
            {!showChatbar && (
              <NewChatButton className="app-chrome app-toolbar-button" />
            )}
          </div>
        )}
        <div ref={slotRef} className="contents" />
      </div>
    </div>
  );
}
