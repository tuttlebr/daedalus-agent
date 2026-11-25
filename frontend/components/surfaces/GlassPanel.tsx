'use client';

import React, { forwardRef, memo } from 'react';

import { MaterialDither } from './MaterialDither';

import classNames from 'classnames';

export interface GlassPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  position?: 'left' | 'right';
}

/**
 * Inset glass panel for sidebars and navigation.
 * The shared material keeps content behind the navigation softly diffused.
 */
export const GlassPanel = memo(
  forwardRef<HTMLDivElement, GlassPanelProps>(
    ({ position = 'left', className = '', children, ...props }, ref) => (
      <div
        ref={ref}
        data-position={position}
        className={classNames(
          'app-glass-panel app-panel-material app-chrome flex h-full flex-col overflow-hidden',
          className,
        )}
        {...props}
      >
        <MaterialDither kind="reflection" />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          {children}
        </div>
      </div>
    ),
  ),
);

GlassPanel.displayName = 'GlassPanel';
