import { IconBolt, IconBoltOff } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

interface BackgroundProcessingIndicatorProps {
  wakeLockActive: boolean;
  isStreaming: boolean;
}

export const BackgroundProcessingIndicator: React.FC<BackgroundProcessingIndicatorProps> = ({
  wakeLockActive,
  isStreaming,
}) => {
  const [showIndicator, setShowIndicator] = useState(false);

  useEffect(() => {
    // Only show indicator when streaming and wake lock is active
    setShowIndicator(isStreaming && wakeLockActive);
  }, [isStreaming, wakeLockActive]);

  if (!showIndicator) return null;

  return (
    <div className="fixed top-20 right-4 z-50 animate-fade-in">
      <div className="flex items-center gap-2 px-3 py-2 rounded-full apple-glass backdrop-blur-xl border border-nvidia-green/30 shadow-[0_8px_32px_rgba(118,185,0,0.2)] text-xs text-nvidia-green">
        <IconBolt size={14} className="animate-pulse" />
        <span className="font-medium">Screen lock active</span>
      </div>
    </div>
  );
};
