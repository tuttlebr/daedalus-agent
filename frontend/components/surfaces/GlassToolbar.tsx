'use client';

import React, { forwardRef, memo } from 'react';
import classNames from 'classnames';

export interface GlassToolbarProps extends React.HTMLAttributes<HTMLDivElement> {
  position?: 'top' | 'bottom';
}

/**
 * Floating toolbar surface with glass effect.
 * Used for chat input bar, bottom navigation, and header toolbars.
 */
export const GlassToolbar = memo(forwardRef<HTMLDivElement, GlassToolbarProps>(({
  position = 'bottom',
  className = '',
  children,
  ...props
}, ref) => (
  <div
    ref={ref}
    className={classNames(
      'bg-surface-control backdrop-blur-xl',
      position === 'top' ? 'border-b' : 'border-t',
      'border-white/[0.06]',
      className
    )}
    {...props}
  >
    {children}
  </div>
)));

GlassToolbar.displayName = 'GlassToolbar';
