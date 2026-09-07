'use client';

import React, { forwardRef, memo } from 'react';

import classNames from 'classnames';

export interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'elevated' | 'subtle';
  hover?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

const variantClasses: Record<NonNullable<GlassCardProps['variant']>, string> = {
  default: 'app-card border',
  elevated: 'app-card border shadow-sm',
  subtle: 'bg-control/60 border border-separator/60',
};

const paddingClasses: Record<NonNullable<GlassCardProps['padding']>, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-5',
  lg: 'p-7',
};

export const GlassCard = memo(
  forwardRef<HTMLDivElement, GlassCardProps>(
    (
      {
        variant = 'default',
        hover = false,
        padding = 'md',
        className = '',
        children,
        ...props
      },
      ref,
    ) => (
      <div
        ref={ref}
        className={classNames(
          'rounded-xl transition-all duration-200',
          variantClasses[variant],
          paddingClasses[padding],
          hover && 'hover:bg-control cursor-pointer',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    ),
  ),
);

GlassCard.displayName = 'GlassCard';
