'use client';

import { memo, useState, useEffect, useCallback } from 'react';
import { IconDownload, IconX } from '@tabler/icons-react';
import classNames from 'classnames';
import { Button, IconButton } from '@/components/primitives';
import { GlassCard } from '@/components/surfaces';

/**
 * PWA install prompt that appears 2-3 seconds after first visit.
 * Dismissible with 7-day cooldown or permanent hide.
 */
export const InstallPrompt = memo(() => {
  const [showPrompt, setShowPrompt] = useState(false);
  const [deferredEvent, setDeferredEvent] = useState<any>(null);

  useEffect(() => {
    // Check if already dismissed
    const dismissed = localStorage.getItem('pwa-install-dismissed');
    if (dismissed) {
      const dismissedAt = parseInt(dismissed, 10);
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (Date.now() - dismissedAt < sevenDays) return;
    }

    const blocked = localStorage.getItem('pwa-install-blocked');
    if (blocked) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredEvent(e);
      setTimeout(() => setShowPrompt(true), 2500);
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = useCallback(async () => {
    if (!deferredEvent) return;
    deferredEvent.prompt();
    await deferredEvent.userChoice;
    setShowPrompt(false);
    setDeferredEvent(null);
  }, [deferredEvent]);

  const handleDismiss = useCallback(() => {
    setShowPrompt(false);
    localStorage.setItem('pwa-install-dismissed', String(Date.now()));
  }, []);

  if (!showPrompt) return null;

  return (
    <div className="fixed left-1/2 -translate-x-1/2 z-[90] bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] md:bottom-safe-bottom md:mb-4 w-[calc(100%-2rem)] max-w-sm animate-slide-up">
      <GlassCard variant="elevated" padding="sm" className="flex items-center gap-3 px-4 py-3">
        <IconDownload size={20} className="text-nvidia-green flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-dark-text-primary">Install Daedalus</p>
          <p className="text-xs text-dark-text-muted">Add to your home screen for the best experience</p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Button size="xs" variant="accent" onClick={handleInstall}>Install</Button>
          <IconButton icon={<IconX />} aria-label="Dismiss" variant="ghost" size="xs" onClick={handleDismiss} />
        </div>
      </GlassCard>
    </div>
  );
});

InstallPrompt.displayName = 'InstallPrompt';
