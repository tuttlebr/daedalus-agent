'use client';

import React, { memo } from 'react';
import classNames from 'classnames';

// =============================================================================
// BASE SKELETON COMPONENT
// =============================================================================

interface SkeletonProps {
  className?: string;
  variant?: 'rectangular' | 'circular' | 'rounded' | 'text';
  width?: string | number;
  height?: string | number;
  animation?: 'pulse' | 'shimmer' | 'none';
}

export const Skeleton: React.FC<SkeletonProps> = memo(({
  className = '',
  variant = 'rectangular',
  width,
  height,
  animation = 'pulse',
}) => {
  const baseClasses = 'bg-neutral-200/60 dark:bg-neutral-800/60';

  const variantClasses = {
    rectangular: 'rounded-md',
    circular: 'rounded-full',
    rounded: 'rounded-xl',
    text: 'rounded h-4',
  };

  const animationClasses = {
    pulse: 'animate-pulse',
    shimmer: 'skeleton',
    none: '',
  };

  const style: React.CSSProperties = {};
  if (width) style.width = typeof width === 'number' ? `${width}px` : width;
  if (height) style.height = typeof height === 'number' ? `${height}px` : height;

  return (
    <div
      className={classNames(
        baseClasses,
        variantClasses[variant],
        animationClasses[animation],
        className
      )}
      style={style}
    />
  );
});

Skeleton.displayName = 'Skeleton';

// =============================================================================
// MESSAGE SKELETON - For chat message loading
// =============================================================================

interface MessageSkeletonProps {
  isUser?: boolean;
  lines?: number;
  className?: string;
}

export const MessageSkeleton: React.FC<MessageSkeletonProps> = memo(({
  isUser = false,
  lines = 3,
  className = '',
}) => {
  if (isUser) {
    return (
      <div className={classNames('flex justify-end px-3 py-2 sm:px-4', className)}>
        <div className="max-w-[280px] sm:max-w-md animate-pulse">
          <div className="h-10 sm:h-12 rounded-3xl rounded-br-lg bg-nvidia-green/15 dark:bg-nvidia-green/10 border border-nvidia-green/20" />
        </div>
      </div>
    );
  }

  return (
    <div className={classNames('flex gap-3 px-3 py-3 sm:px-4', className)}>
      {/* Avatar skeleton */}
      <div className="w-8 h-8 rounded-full bg-neutral-200/60 dark:bg-neutral-800/60 animate-pulse flex-shrink-0" />

      {/* Content skeleton */}
      <div className="flex-1 space-y-2.5 max-w-2xl">
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={classNames(
              'h-4 rounded-lg bg-neutral-200/60 dark:bg-neutral-800/60 animate-pulse',
              i === lines - 1 ? 'w-3/4' : i === 0 ? 'w-full' : 'w-5/6'
            )}
            style={{ animationDelay: `${i * 75}ms` }}
          />
        ))}
      </div>
    </div>
  );
});

MessageSkeleton.displayName = 'MessageSkeleton';

// =============================================================================
// CONVERSATION SKELETON - For sidebar conversation list loading
// =============================================================================

interface ConversationSkeletonProps {
  count?: number;
  className?: string;
}

export const ConversationSkeleton: React.FC<ConversationSkeletonProps> = memo(({
  count = 5,
  className = '',
}) => {
  return (
    <div className={classNames('space-y-1 p-2', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 p-3 rounded-xl animate-pulse"
          style={{ animationDelay: `${i * 50}ms` }}
        >
          {/* Icon placeholder */}
          <div className="w-5 h-5 rounded bg-neutral-300/50 dark:bg-neutral-700/50 flex-shrink-0" />

          {/* Text placeholder */}
          <div className="flex-1 space-y-1.5">
            <div
              className="h-3.5 rounded bg-neutral-300/50 dark:bg-neutral-700/50"
              style={{ width: `${60 + Math.random() * 30}%` }}
            />
            <div
              className="h-2.5 rounded bg-neutral-200/40 dark:bg-neutral-800/40"
              style={{ width: `${40 + Math.random() * 20}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
});

ConversationSkeleton.displayName = 'ConversationSkeleton';

// =============================================================================
// CHAT SKELETON - Full chat loading state
// =============================================================================

export const ChatLoadingSkeleton: React.FC<{ className?: string }> = memo(({ className = '' }) => {
  return (
    <div className={classNames('flex flex-col gap-4 p-4 animate-morph-in', className)}>
      {/* User message */}
      <MessageSkeleton isUser lines={1} />

      {/* Assistant response */}
      <MessageSkeleton lines={4} />

      {/* Another user message */}
      <MessageSkeleton isUser lines={1} />

      {/* Another assistant response */}
      <MessageSkeleton lines={3} />
    </div>
  );
});

ChatLoadingSkeleton.displayName = 'ChatLoadingSkeleton';

// =============================================================================
// INTERMEDIATE STEPS SKELETON - For agent thinking/processing
// =============================================================================

export const IntermediateStepsSkeleton: React.FC<{ className?: string }> = memo(({ className = '' }) => {
  return (
    <div className={classNames('px-3 py-2 sm:px-4', className)}>
      <div className="flex items-center gap-2 p-3 rounded-xl bg-neutral-100/50 dark:bg-neutral-800/30 border border-neutral-200/50 dark:border-neutral-700/30 animate-pulse">
        {/* Thinking icon */}
        <div className="w-5 h-5 rounded-full bg-nvidia-green/20 animate-pulse" />

        {/* Text */}
        <div className="flex-1">
          <div className="h-3.5 w-24 rounded bg-neutral-300/50 dark:bg-neutral-700/50" />
        </div>

        {/* Expand icon */}
        <div className="w-4 h-4 rounded bg-neutral-300/40 dark:bg-neutral-700/40" />
      </div>
    </div>
  );
});

IntermediateStepsSkeleton.displayName = 'IntermediateStepsSkeleton';

// =============================================================================
// CARD SKELETON - For settings panels, modals
// =============================================================================

interface CardSkeletonProps {
  hasHeader?: boolean;
  lines?: number;
  hasAction?: boolean;
  className?: string;
}

export const CardSkeleton: React.FC<CardSkeletonProps> = memo(({
  hasHeader = true,
  lines = 3,
  hasAction = false,
  className = '',
}) => {
  return (
    <div className={classNames(
      'rounded-2xl p-4 bg-neutral-100/50 dark:bg-neutral-800/30 border border-neutral-200/50 dark:border-neutral-700/30 animate-pulse',
      className
    )}>
      {hasHeader && (
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-neutral-300/50 dark:bg-neutral-700/50" />
          <div className="flex-1">
            <div className="h-4 w-32 rounded bg-neutral-300/50 dark:bg-neutral-700/50 mb-1.5" />
            <div className="h-3 w-24 rounded bg-neutral-200/50 dark:bg-neutral-800/50" />
          </div>
        </div>
      )}

      <div className="space-y-2.5">
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={classNames(
              'h-3.5 rounded bg-neutral-200/50 dark:bg-neutral-700/40',
              i === lines - 1 ? 'w-2/3' : 'w-full'
            )}
            style={{ animationDelay: `${i * 50}ms` }}
          />
        ))}
      </div>

      {hasAction && (
        <div className="mt-4 pt-4 border-t border-neutral-200/50 dark:border-neutral-700/30">
          <div className="h-9 w-24 rounded-lg bg-neutral-300/50 dark:bg-neutral-700/50" />
        </div>
      )}
    </div>
  );
});

CardSkeleton.displayName = 'CardSkeleton';

// =============================================================================
// IMAGE SKELETON - For image loading placeholders
// =============================================================================

interface ImageSkeletonProps {
  aspectRatio?: 'square' | 'video' | 'portrait' | 'landscape';
  className?: string;
}

export const ImageSkeleton: React.FC<ImageSkeletonProps> = memo(({
  aspectRatio = 'landscape',
  className = '',
}) => {
  const aspectClasses = {
    square: 'aspect-square',
    video: 'aspect-video',
    portrait: 'aspect-[3/4]',
    landscape: 'aspect-[4/3]',
  };

  return (
    <div className={classNames(
      'relative rounded-xl bg-neutral-200/60 dark:bg-neutral-800/60 overflow-hidden animate-pulse',
      aspectClasses[aspectRatio],
      className
    )}>
      {/* Image icon placeholder */}
      <div className="absolute inset-0 flex items-center justify-center">
        <svg
          className="w-12 h-12 text-neutral-400/50 dark:text-neutral-600/50"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
      </div>
    </div>
  );
});

ImageSkeleton.displayName = 'ImageSkeleton';

// =============================================================================
// SKELETON GROUP - For multiple skeleton items with stagger animation
// =============================================================================

interface SkeletonGroupProps {
  children: React.ReactNode;
  staggerDelay?: number;
  className?: string;
}

export const SkeletonGroup: React.FC<SkeletonGroupProps> = memo(({
  children,
  staggerDelay = 50,
  className = '',
}) => {
  return (
    <div className={classNames('animate-morph-in', className)}>
      {React.Children.map(children, (child, index) => {
        if (React.isValidElement(child)) {
          return React.cloneElement(child as React.ReactElement<{ style?: React.CSSProperties }>, {
            style: {
              ...(child.props as { style?: React.CSSProperties }).style,
              animationDelay: `${index * staggerDelay}ms`,
            },
          });
        }
        return child;
      })}
    </div>
  );
});

SkeletonGroup.displayName = 'SkeletonGroup';

// =============================================================================
// EXPORTS
// =============================================================================

export default Skeleton;
