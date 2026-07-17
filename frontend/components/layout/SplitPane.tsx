'use client';

import React, { memo, useCallback, useRef, useState } from 'react';

import { setUserSessionItem } from '@/utils/app/storage';

import { useUISettingsStore } from '@/state';
import classNames from 'classnames';

export interface SplitPaneProps {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 500;
const DEFAULT_SIDEBAR_WIDTH = 280;
const KEYBOARD_RESIZE_STEP = 16;

/**
 * Desktop split layout: resizable sidebar + main content.
 * Sidebar width controlled by uiSettingsStore.chatbarWidth.
 * The divider supports pointer drag (mouse/touch/pen), arrow-key resizing,
 * and double-click to reset to the default width.
 */
export const SplitPane = memo(
  ({ sidebar, children, className = '' }: SplitPaneProps) => {
    const showChatbar = useUISettingsStore((s) => s.showChatbar);
    const chatbarWidth = useUISettingsStore((s) => s.chatbarWidth);
    const setChatbarWidth = useUISettingsStore((s) => s.setChatbarWidth);

    const [isResizing, setIsResizing] = useState(false);
    const widthRef = useRef(chatbarWidth);
    widthRef.current = chatbarWidth;

    const applyWidth = useCallback(
      (width: number) => {
        const clamped = Math.min(
          Math.max(width, MIN_SIDEBAR_WIDTH),
          MAX_SIDEBAR_WIDTH,
        );
        setChatbarWidth(clamped);
        return clamped;
      },
      [setChatbarWidth],
    );

    const persistWidth = useCallback(() => {
      setUserSessionItem('chatbarWidth', String(widthRef.current));
    }, []);

    const handlePointerDown = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setIsResizing(true);
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      },
      [],
    );

    const handlePointerMove = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        applyWidth(e.clientX);
      },
      [applyWidth],
    );

    const handlePointerUp = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setIsResizing(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        persistWidth();
      },
      [persistWidth],
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        let next: number | null = null;
        if (e.key === 'ArrowLeft') {
          next = widthRef.current - KEYBOARD_RESIZE_STEP;
        } else if (e.key === 'ArrowRight') {
          next = widthRef.current + KEYBOARD_RESIZE_STEP;
        } else if (e.key === 'Home') {
          next = MIN_SIDEBAR_WIDTH;
        } else if (e.key === 'End') {
          next = MAX_SIDEBAR_WIDTH;
        } else if (e.key === 'Enter') {
          next = DEFAULT_SIDEBAR_WIDTH;
        }
        if (next !== null) {
          e.preventDefault();
          widthRef.current = applyWidth(next);
          persistWidth();
        }
      },
      [applyWidth, persistWidth],
    );

    const handleDoubleClick = useCallback(() => {
      widthRef.current = applyWidth(DEFAULT_SIDEBAR_WIDTH);
      persistWidth();
    }, [applyWidth, persistWidth]);

    return (
      <div className={classNames('flex h-full overflow-hidden', className)}>
        {/* Sidebar */}
        <div
          className="flex-shrink-0 overflow-hidden"
          style={{
            width: showChatbar ? `${chatbarWidth}px` : '0px',
            transition: isResizing ? 'none' : 'width 0.3s ease-out',
          }}
        >
          {sidebar}
        </div>

        {/* Resize handle: 1px visual line with an invisible ~12px hit area */}
        {showChatbar && (
          <div
            className={classNames(
              'relative w-1 flex-shrink-0 cursor-col-resize touch-none',
              'after:absolute after:inset-y-0 after:-left-1.5 after:-right-1.5 after:content-[""]',
              'hover:bg-nvidia-green/30 focus-visible:bg-nvidia-green/40',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40',
              'transition-colors duration-150',
              isResizing && 'bg-nvidia-green/50',
            )}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onKeyDown={handleKeyDown}
            onDoubleClick={handleDoubleClick}
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={MAX_SIDEBAR_WIDTH}
            aria-valuenow={chatbarWidth}
            title="Drag to resize. Double-click to reset."
          />
        )}

        {/* Main content */}
        <div className="flex flex-1 min-w-0 overflow-hidden">{children}</div>
      </div>
    );
  },
);

SplitPane.displayName = 'SplitPane';
