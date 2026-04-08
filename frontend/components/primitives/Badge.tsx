'use client';

import React, { memo } from 'react';
import classNames from 'classnames';

export type BadgeVariant = 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info';
export type BadgeSize = 'xs' | 'sm' | 'md' | 'lg';

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border border-neutral-200 dark:border-neutral-700',
  primary: 'bg-nvidia-green/15 text-nvidia-green border border-nvidia-green/30',
  secondary: 'bg-neutral-500/15 text-neutral-600 dark:text-neutral-400 border border-neutral-500/30',
  success: 'bg-nvidia-teal/15 text-nvidia-teal border border-nvidia-teal/30',
  warning: 'bg-nvidia-orange/15 text-nvidia-orange border border-nvidia-orange/30',
  error: 'bg-nvidia-red/15 text-nvidia-red border border-nvidia-red/30',
  info: 'bg-nvidia-blue/15 text-nvidia-blue border border-nvidia-blue/30',
};

const sizeClasses: Record<BadgeSize, string> = {
  xs: 'px-1.5 py-0.5 text-[10px] rounded-full',
  sm: 'px-2 py-1 text-xs rounded-full',
  md: 'px-2.5 py-1 text-sm rounded-full',
  lg: 'px-3 py-1.5 text-sm rounded-full',
};

export interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  size?: BadgeSize;
  icon?: React.ReactNode;
  dot?: boolean;
  dotColor?: string;
  className?: string;
}

export const Badge = memo(({
  children,
  variant = 'default',
  size = 'sm',
  icon,
  dot = false,
  dotColor,
  className = '',
}: BadgeProps) => (
  <span
    className={classNames(
      'inline-flex items-center gap-1.5 font-medium whitespace-nowrap select-none',
      variantClasses[variant],
      sizeClasses[size],
      className
    )}
  >
    {dot && (
      <span
        className={classNames('w-1.5 h-1.5 rounded-full flex-shrink-0', !dotColor && 'bg-current')}
        style={dotColor ? { backgroundColor: dotColor } : undefined}
      />
    )}
    {icon && <span className="flex-shrink-0">{icon}</span>}
    {children}
  </span>
));

Badge.displayName = 'Badge';

export interface StatusBadgeProps {
  status: 'online' | 'offline' | 'busy' | 'away' | 'idle' | 'streaming' | 'processing';
  showLabel?: boolean;
  size?: BadgeSize;
  className?: string;
}

const statusConfig: Record<StatusBadgeProps['status'], { variant: BadgeVariant; label: string; dotColor: string }> = {
  online: { variant: 'success', label: 'Online', dotColor: '#1d8ba4' },
  offline: { variant: 'default', label: 'Offline', dotColor: '#737373' },
  busy: { variant: 'error', label: 'Busy', dotColor: '#e52020' },
  away: { variant: 'warning', label: 'Away', dotColor: '#ef9100' },
  idle: { variant: 'secondary', label: 'Idle', dotColor: '#a3a3a3' },
  streaming: { variant: 'primary', label: 'Streaming', dotColor: '#76b900' },
  processing: { variant: 'info', label: 'Processing', dotColor: '#0074df' },
};

export const StatusBadge = memo(({ status, showLabel = true, size = 'sm', className = '' }: StatusBadgeProps) => {
  const config = statusConfig[status];
  return (
    <Badge variant={config.variant} size={size} dot dotColor={config.dotColor} className={className}>
      {showLabel && config.label}
    </Badge>
  );
});

StatusBadge.displayName = 'StatusBadge';
