'use client';

import React, { forwardRef, memo } from 'react';
import classNames from 'classnames';

export interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'elevated' | 'subtle';
  hover?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

const variantClasses: Record<NonNullable<GlassCardProps['variant']>, string> = {
  default: 'bg-surface-glass backdrop-blur-lg border border-border-glass',
  elevated: 'bg-surface-glass backdrop-blur-2xl border border-surface-glass-border-strong shadow-lg',
  subtle: 'bg-white/[0.03] backdrop-blur-sm border border-white/[0.04]',
};

const paddingClasses: Record<NonNullable<GlassCardProps['padding']>, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-5',
  lg: 'p-7',
};

export const GlassCard = memo(forwardRef<HTMLDivElement, GlassCardProps>(({
  variant = 'default',
  hover = false,
  padding = 'md',
  className = '',
  children,
  ...props
}, ref) => (
  <div
    ref={ref}
    className={classNames(
      'rounded-xl transition-all duration-200',
      variantClasses[variant],
      paddingClasses[padding],
      hover && 'hover:bg-surface-glass-hover hover:border-white/10 cursor-pointer',
      className
    )}
    {...props}
  >
    {children}
  </div>
)));

GlassCard.displayName = 'GlassCard';
