'use client';

import React, { forwardRef, memo } from 'react';

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
          'app-glass-panel app-chrome flex h-full flex-col',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    ),
  ),
);

GlassPanel.displayName = 'GlassPanel';
