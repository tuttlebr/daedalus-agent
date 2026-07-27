'use client';

import React, { memo } from 'react';

import classNames from 'classnames';

export interface SkeletonProps {
  className?: string;
  variant?: 'text' | 'circular' | 'rectangular';
  width?: string | number;
  height?: string | number;
}

export const Skeleton = memo(
  ({ className = '', variant = 'text', width, height }: SkeletonProps) => (
    <div
      className={classNames(
        'animate-pulse bg-white/5',
        variant === 'circular' && 'rounded-full',
        variant === 'rectangular' && 'rounded-lg',
        variant === 'text' && 'rounded h-4',
        className,
      )}
      style={{ width, height }}
      aria-hidden="true"
    />
  ),
);

Skeleton.displayName = 'Skeleton';
