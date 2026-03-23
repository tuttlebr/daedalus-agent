import { IconBolt, IconLoader2, IconCheck } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

interface BackgroundProcessingIndicatorProps {
  wakeLockActive: boolean;
  isStreaming: boolean;
  isPolling?: boolean;
}

export const BackgroundProcessingIndicator: React.FC<BackgroundProcessingIndicatorProps> = ({
  wakeLockActive,
  isStreaming,
  isPolling = false,
}) => {
  const [showIndicator, setShowIndicator] = useState(false);
  const [recentlyCompleted, setRecentlyCompleted] = useState(false);
  const [wasStreaming, setWasStreaming] = useState(false);

  useEffect(() => {
    const isActive = isStreaming || isPolling;

    // Track when streaming/polling ends to show completion state
    if (wasStreaming && !isActive) {
      setRecentlyCompleted(true);
      const timer = setTimeout(() => {
        setRecentlyCompleted(false);
        setShowIndicator(false);
      }, 2000);
      return () => clearTimeout(timer);
    }

    setWasStreaming(isActive);

    // Show indicator when actively processing with wake lock
    if (isActive && wakeLockActive) {
      setShowIndicator(true);
    } else if (!isActive && !recentlyCompleted) {
      setShowIndicator(false);
    }
  }, [isStreaming, isPolling, wakeLockActive, wasStreaming, recentlyCompleted]);

  if (!showIndicator) return null;

  const isActive = isStreaming || isPolling;

  return (
    <div
      className="fixed top-4 right-4 z-50 animate-morph-in"
      style={{
        top: 'max(1rem, calc(env(safe-area-inset-top) + 8px))',
        right: 'max(1rem, env(safe-area-inset-right))',
      }}
    >
      <div className={`
        flex items-center gap-2 px-4 py-2.5 rounded-full
        liquid-glass-overlay backdrop-blur-xl
        border transition-all duration-300
        ${recentlyCompleted
          ? 'border-emerald/50 shadow-[0_8px_32px_rgba(16,185,129,0.25)]'
          : 'border-nvidia-green/40 shadow-[0_8px_32px_rgba(118,185,0,0.25)]'
        }
      `}>
        {recentlyCompleted ? (
          <>
            <IconCheck size={16} className="text-emerald animate-scale-in" />
            <span className="text-xs font-medium text-emerald">Complete</span>
          </>
        ) : (
          <>
            {isPolling ? (
              <IconLoader2 size={16} className="text-nvidia-green animate-spin" />
            ) : (
              <IconBolt size={16} className="text-nvidia-green animate-pulse" />
            )}
            <div className="flex flex-col">
              <span className="text-xs font-medium text-nvidia-green">
                {isPolling ? 'Processing' : 'Active'}
              </span>
              {wakeLockActive && (
                <span className="text-[10px] text-white/50">Screen lock on</span>
              )}
            </div>
            {/* Animated progress dots */}
            <div className="flex gap-0.5 ml-1">
              <span className="w-1 h-1 rounded-full bg-nvidia-green animate-pulse" style={{ animationDelay: '0ms' }} />
              <span className="w-1 h-1 rounded-full bg-nvidia-green animate-pulse" style={{ animationDelay: '200ms' }} />
              <span className="w-1 h-1 rounded-full bg-nvidia-green animate-pulse" style={{ animationDelay: '400ms' }} />
            </div>
          </>
        )}
      </div>
    </div>
  );
};
