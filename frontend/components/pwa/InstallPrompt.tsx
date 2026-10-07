'use client';

import { IconDownload, IconX } from '@tabler/icons-react';
import { memo, useState, useEffect } from 'react';

import { isIOS, isStandaloneWebApp } from '@/utils/app/platform';

import { Button, IconButton } from '@/components/primitives';
import { GlassCard } from '@/components/surfaces';

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Safari installs through its Share menu; Chromium supplies an install event. */
export const InstallPrompt = memo(() => {
  const [showPrompt, setShowPrompt] = useState(false);
  const [iosInstructions, setIOSInstructions] = useState(false);
  const [deferredEvent, setDeferredEvent] = useState<InstallEvent | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (isStandaloneWebApp()) return;
    try {
      const dismissedAt = Number(localStorage.getItem('pwa-install-dismissed'));
      if (Date.now() - dismissedAt < 7 * 24 * 60 * 60 * 1000) return;
      if (localStorage.getItem('pwa-install-blocked')) return;
    } catch {
      // Storage may be restricted; installation remains available.
    }

    let timer: ReturnType<typeof setTimeout>;
    let interacted = false;
    const schedulePrompt = () => {
      if (interacted) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!isStandaloneWebApp()) setShowPrompt(true);
      }, 2500);
    };
    const handler = (event: Event) => {
      event.preventDefault();
      setDeferredEvent(event as InstallEvent);
      setIOSInstructions(false);
      schedulePrompt();
    };
    const hideInstalled = () => {
      clearTimeout(timer);
      setShowPrompt(false);
      setDeferredEvent(null);
    };
    const displayMode = window.matchMedia('(display-mode: standalone)');
    const handleDisplayMode = () => {
      if (isStandaloneWebApp()) hideInstalled();
    };
    const handleInteraction = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('.app-install-prompt')
      )
        return;
      // Do not interrupt an ongoing task with installation guidance, including
      // when beforeinstallprompt arrives after the first interaction.
      interacted = true;
      hideInstalled();
    };
    if (isIOS()) {
      setIOSInstructions(true);
      schedulePrompt();
    }
    window.addEventListener('beforeinstallprompt', handler);
    window.addEventListener('appinstalled', hideInstalled);
    document.addEventListener('pointerdown', handleInteraction);
    document.addEventListener('keydown', handleInteraction);
    displayMode.addEventListener('change', handleDisplayMode);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', hideInstalled);
      document.removeEventListener('pointerdown', handleInteraction);
      document.removeEventListener('keydown', handleInteraction);
      displayMode.removeEventListener('change', handleDisplayMode);
    };
  }, []);

  const dismiss = () => {
    setShowPrompt(false);
    try {
      localStorage.setItem('pwa-install-dismissed', String(Date.now()));
    } catch {
      // Dismiss for this visit even if persistence is unavailable.
    }
  };

  async function install() {
    if (!deferredEvent || installing) return;
    setInstalling(true);
    try {
      await deferredEvent.prompt();
      await deferredEvent.userChoice;
      dismiss();
    } catch {
      // A consumed or dismissed browser event needs a new install opportunity.
    } finally {
      setDeferredEvent(null);
      setInstalling(false);
      setShowPrompt(false);
    }
  }

  if (!showPrompt) return null;

  return (
    <aside
      aria-label="Install Daedalus"
      className="app-install-prompt fixed z-[90] mx-auto w-auto max-w-sm animate-slide-up"
    >
      <GlassCard
        variant="elevated"
        padding="sm"
        className="flex items-start gap-3 px-4 py-3"
      >
        <IconDownload size={20} className="mt-3 shrink-0 text-nvidia-green" />
        <div className="min-w-0 flex-1 py-2">
          <p className="text-sm font-medium text-primary">Install Daedalus</p>
          <p className="mt-1 text-sm text-muted">
            {iosInstructions
              ? 'In Safari, open Share and choose Add to Home Screen. Leave Open as Web App on if shown, then tap Add.'
              : 'Add to your Home Screen for quick access.'}
          </p>
          {!iosInstructions && (
            <Button
              className="mt-2"
              size="sm"
              variant="accent"
              onClick={install}
              disabled={installing}
            >
              Install
            </Button>
          )}
        </div>
        <IconButton
          icon={<IconX />}
          aria-label="Dismiss install instructions"
          variant="ghost"
          size="sm"
          onClick={dismiss}
        />
      </GlassCard>
    </aside>
  );
});

InstallPrompt.displayName = 'InstallPrompt';
