'use client';

import React, { memo, useCallback, useRef } from 'react';
import classNames from 'classnames';
import { useUISettingsStore } from '@/state';
import { setUserSessionItem } from '@/utils/app/storage';

export interface SplitPaneProps {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * Desktop split layout: resizable sidebar + main content.
 * Sidebar width controlled by uiSettingsStore.chatbarWidth.
 */
export const SplitPane = memo(({
  sidebar,
  children,
  className = '',
}: SplitPaneProps) => {
  const showChatbar = useUISettingsStore((s) => s.showChatbar);
  const chatbarWidth = useUISettingsStore((s) => s.chatbarWidth);
  const setChatbarWidth = useUISettingsStore((s) => s.setChatbarWidth);

  const isResizing = useRef(false);
  const widthRef = useRef(chatbarWidth);
  widthRef.current = chatbarWidth;

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = Math.min(Math.max(e.clientX, 200), 500);
      setChatbarWidth(newWidth);
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      setUserSessionItem('chatbarWidth', String(widthRef.current));
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [setChatbarWidth]);

  return (
    <div className={classNames('flex h-full overflow-hidden', className)}>
      {/* Sidebar */}
      <div
        className="flex-shrink-0 overflow-hidden"
        style={{
          width: showChatbar ? `${chatbarWidth}px` : '0px',
          transition: isResizing.current ? 'none' : 'width 0.3s ease-out',
        }}
      >
        {sidebar}
      </div>

      {/* Resize handle */}
      {showChatbar && (
        <div
          className="w-1 flex-shrink-0 cursor-col-resize hover:bg-nvidia-green/30 active:bg-nvidia-green/50 transition-colors duration-150"
          onMouseDown={handleResizeMouseDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
        />
      )}

      {/* Main content */}
      <div className="flex flex-1 min-w-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
});

SplitPane.displayName = 'SplitPane';
