'use client';

import React, { memo } from 'react';
import classNames from 'classnames';

export interface ProgressBarProps {
  value: number; // 0-100
  max?: number;
  variant?: 'default' | 'accent' | 'success' | 'error';
  size?: 'sm' | 'md';
  showLabel?: boolean;
  indeterminate?: boolean;
  className?: string;
}

const barColors: Record<NonNullable<ProgressBarProps['variant']>, string> = {
  default: 'bg-neutral-400 dark:bg-neutral-500',
  accent: 'bg-nvidia-green',
  success: 'bg-nvidia-teal',
  error: 'bg-nvidia-red',
};

export const ProgressBar = memo(({
  value,
  max = 100,
  variant = 'accent',
  size = 'sm',
  showLabel = false,
  indeterminate = false,
  className = '',
}: ProgressBarProps) => {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div className={classNames('w-full', className)}>
      <div
        className={classNames(
          'w-full rounded-full overflow-hidden',
          'bg-white/5',
          size === 'sm' ? 'h-1' : 'h-2'
        )}
        role="progressbar"
        aria-valuenow={indeterminate ? undefined : value}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        {indeterminate ? (
          <div className={classNames('h-full w-1/3 rounded-full animate-loading-bar', barColors[variant])} />
        ) : (
          <div
            className={classNames('h-full rounded-full transition-all duration-300 ease-out', barColors[variant])}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      {showLabel && !indeterminate && (
        <span className="mt-1 text-xs text-dark-text-muted">{Math.round(pct)}%</span>
      )}
    </div>
  );
});

ProgressBar.displayName = 'ProgressBar';
