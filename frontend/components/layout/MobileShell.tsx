'use client';

import React, { memo } from 'react';

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
    const showChatbar = useUISettingsStore((s) => s.showChatbar);
    const setShowChatbar = useUISettingsStore((s) => s.setShowChatbar);

    return (
      <div className={classNames('relative flex flex-col h-full', className)}>
        {/* Main content */}
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>

        {/* Bottom navigation */}
        {bottomNav}

        {/* Sidebar overlay */}
        <GlassOverlay
          open={showChatbar}
          onClose={() => setShowChatbar(false)}
          position="left"
          aria-label="Navigation menu"
        >
          <GlassPanel
            position="left"
            className="w-[80vw] max-w-sm h-full safe-top safe-bottom"
          >
            {sidebar}
          </GlassPanel>
        </GlassOverlay>
      </div>
    );
  },
);

MobileShell.displayName = 'MobileShell';
