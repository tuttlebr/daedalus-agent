'use client';

import React, { memo } from 'react';

import { MobileShell } from './MobileShell';
import { SplitPane } from './SplitPane';

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
export const AppShell = memo(
  ({ sidebar, bottomNav, children }: AppShellProps) => {
    // Keep the content tree mounted when a window crosses the breakpoint.
    return (
      <MobileShell sidebar={sidebar} bottomNav={bottomNav}>
        <SplitPane sidebar={sidebar}>{children}</SplitPane>
      </MobileShell>
    );
  },
);

AppShell.displayName = 'AppShell';
