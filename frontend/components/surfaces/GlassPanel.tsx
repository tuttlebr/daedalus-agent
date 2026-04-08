'use client';

import React, { forwardRef, memo } from 'react';
import classNames from 'classnames';

export interface GlassPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  position?: 'left' | 'right';
}

/**
 * Full-height glass panel for sidebars and navigation.
 * Uses heavier blur than GlassCard for panel surfaces.
 */
export const GlassPanel = memo(forwardRef<HTMLDivElement, GlassPanelProps>(({
  position = 'left',
  className = '',
  children,
  ...props
}, ref) => (
  <div
    ref={ref}
    className={classNames(
      'h-full flex flex-col',
      'bg-dark-bg-secondary',
      position === 'left' ? 'border-r' : 'border-l',
      'border-white/[0.06]',
      className
    )}
    {...props}
  >
    {children}
  </div>
)));

GlassPanel.displayName = 'GlassPanel';
