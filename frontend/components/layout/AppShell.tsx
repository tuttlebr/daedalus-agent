'use client';

import React, { memo } from 'react';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { SplitPane } from './SplitPane';
import { MobileShell } from './MobileShell';

export interface AppShellProps {
  sidebar: React.ReactNode;
  bottomNav: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Top-level app layout that switches between desktop and mobile shells.
 * - Desktop (>= md): SplitPane with resizable sidebar.
 * - Mobile (< md): MobileShell with bottom nav and overlay sidebar.
 */
export const AppShell = memo(({
  sidebar,
  bottomNav,
  children,
}: AppShellProps) => {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <MobileShell sidebar={sidebar} bottomNav={bottomNav}>
        {children}
      </MobileShell>
    );
  }

  return (
    <SplitPane sidebar={sidebar}>
      {children}
    </SplitPane>
  );
});

AppShell.displayName = 'AppShell';
