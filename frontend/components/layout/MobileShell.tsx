'use client';

import React, { memo } from 'react';

import { useIsMobile } from '@/hooks/useMediaQuery';

import { GlassOverlay } from '@/components/surfaces';
import { GlassPanel } from '@/components/surfaces';

import { useUISettingsStore } from '@/state';
import classNames from 'classnames';

export interface MobileShellProps {
  sidebar: React.ReactNode;
  bottomNav: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * Mobile layout: main content + bottom nav + overlay sidebar.
 * Sidebar slides in from left when showChatbar is true.
 */
export const MobileShell = memo(
  ({ sidebar, bottomNav, children, className = '' }: MobileShellProps) => {
    const isMobile = useIsMobile();
    const showChatbar = useUISettingsStore((s) => s.showChatbar);
    const setShowChatbar = useUISettingsStore((s) => s.setShowChatbar);

    return (
      <div className={classNames('relative flex flex-col h-full', className)}>
        {/* Main content */}
        <div className="app-safe-x min-h-0 flex-1 overflow-hidden">
          {children}
        </div>

        {/* Bottom navigation */}
        {bottomNav}

        {/* Sidebar overlay */}
        <GlassOverlay
          open={isMobile && showChatbar}
          onClose={() => setShowChatbar(false)}
          position="left"
          aria-label="Navigation menu"
        >
          <GlassPanel
            position="left"
            className="w-[min(22rem,calc(100vw-2rem))] h-full safe-bottom"
          >
            {sidebar}
          </GlassPanel>
        </GlassOverlay>
      </div>
    );
  },
);

MobileShell.displayName = 'MobileShell';
