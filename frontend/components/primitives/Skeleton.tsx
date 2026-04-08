'use client';

import React, { memo } from 'react';
import classNames from 'classnames';

export interface SkeletonProps {
  className?: string;
  variant?: 'text' | 'circular' | 'rectangular';
  width?: string | number;
  height?: string | number;
}

export const Skeleton = memo(({
  className = '',
  variant = 'text',
  width,
  height,
}: SkeletonProps) => (
  <div
    className={classNames(
      'animate-pulse bg-white/5',
      variant === 'circular' && 'rounded-full',
      variant === 'rectangular' && 'rounded-lg',
      variant === 'text' && 'rounded h-4',
      className
    )}
    style={{ width, height }}
    aria-hidden="true"
  />
));

Skeleton.displayName = 'Skeleton';

/** Pre-composed skeleton for a chat message */
export const MessageSkeleton = memo(({ className = '' }: { className?: string }) => (
  <div className={classNames('flex gap-3 p-4', className)}>
    <Skeleton variant="circular" width={36} height={36} />
    <div className="flex-1 space-y-2">
      <Skeleton width="40%" height={14} />
      <Skeleton width="90%" height={14} />
      <Skeleton width="65%" height={14} />
    </div>
  </div>
));

MessageSkeleton.displayName = 'MessageSkeleton';
