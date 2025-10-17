import React from 'react';
import classNames from 'classnames';

interface LoadingSkeletonProps {
  className?: string;
  lines?: number;
  showAvatar?: boolean;
}

export const LoadingSkeleton: React.FC<LoadingSkeletonProps> = ({
  className = '',
  lines = 3,
  showAvatar = true,
}) => {
  return (
    <div className={classNames('animate-fade-in', className)}>
      <div className="flex gap-3">
        {showAvatar && (
          <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 skeleton" />
        )}
        <div className="flex-1 space-y-2">
          {Array.from({ length: lines }).map((_, i) => (
            <div
              key={i}
              className={classNames(
                'h-4 rounded bg-gray-200 dark:bg-gray-700 skeleton',
                i === lines - 1 ? 'w-3/4' : 'w-full'
              )}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

export const ChatSkeleton: React.FC = () => {
  return (
    <div className="flex flex-col gap-4 p-4">
      {/* User message skeleton */}
      <div className="flex justify-end">
        <div className="max-w-xs">
          <div className="h-12 rounded-2xl rounded-br-md bg-nvidia-green/20 skeleton" />
        </div>
      </div>

      {/* Assistant message skeleton */}
      <LoadingSkeleton lines={4} />

      {/* User message skeleton */}
      <div className="flex justify-end">
        <div className="max-w-xs">
          <div className="h-8 rounded-2xl rounded-br-md bg-nvidia-green/20 skeleton" />
        </div>
      </div>

      {/* Assistant message skeleton */}
      <LoadingSkeleton lines={3} />
    </div>
  );
};
