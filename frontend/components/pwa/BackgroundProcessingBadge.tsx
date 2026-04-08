'use client';

import { memo } from 'react';
import classNames from 'classnames';
import { IconLoader } from '@tabler/icons-react';

interface BackgroundProcessingBadgeProps {
  visible: boolean;
  label?: string;
}

/**
 * Shown when a long-running job continues in the background.
 * Appears as a floating badge at the bottom of the chat.
 */
export const BackgroundProcessingBadge = memo(({ visible, label = 'Processing in background...' }: BackgroundProcessingBadgeProps) => {
  if (!visible) return null;

  return (
    <div className="fixed bottom-safe-bottom left-1/2 -translate-x-1/2 z-[80] mb-20 animate-slide-up">
      <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-dark-bg-secondary/90 backdrop-blur-xl border border-white/[0.06] shadow-lg">
        <IconLoader size={14} className="text-nvidia-green animate-spin" />
        <span className="text-xs text-dark-text-muted">{label}</span>
      </div>
    </div>
  );
});

BackgroundProcessingBadge.displayName = 'BackgroundProcessingBadge';
