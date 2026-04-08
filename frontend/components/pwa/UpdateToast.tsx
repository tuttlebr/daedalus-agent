'use client';

import { memo } from 'react';
import { IconRefresh, IconX } from '@tabler/icons-react';
import { Button, IconButton } from '@/components/primitives';
import { GlassCard } from '@/components/surfaces';

interface UpdateToastProps {
  onDismiss: () => void;
}

export const UpdateToast = memo(({ onDismiss }: UpdateToastProps) => (
  <div className="fixed bottom-safe-bottom left-1/2 -translate-x-1/2 z-[90] mb-4 w-[calc(100%-2rem)] max-w-sm animate-slide-up">
    <GlassCard variant="elevated" padding="sm" className="flex items-center gap-3 px-4 py-3">
      <IconRefresh size={20} className="text-nvidia-green flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-dark-text-primary">Update Available</p>
        <p className="text-xs text-dark-text-muted">A new version is ready</p>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <Button size="xs" variant="accent" onClick={() => window.location.reload()}>Update</Button>
        <IconButton icon={<IconX />} aria-label="Dismiss" variant="ghost" size="xs" onClick={onDismiss} />
      </div>
    </GlassCard>
  </div>
));

UpdateToast.displayName = 'UpdateToast';
