import { useEffect, useState, useCallback } from 'react';
import { IconDownload, IconX, IconShare, IconPlus } from '@tabler/icons-react';
import { showInstallPrompt, isPWAInstalled } from '@/utils/app/pwa';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const InstallPrompt = () => {
  const [showPrompt, setShowPrompt] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showIOSInstructions, setShowIOSInstructions] = useState(false);
  const [canInstall, setCanInstall] = useState(false);

  useEffect(() => {
    // Check if already installed
    if (isPWAInstalled()) {
      return;
    }

    // Check if user has dismissed the prompt before
    const dismissed = localStorage.getItem('pwa-install-dismissed');
    if (dismissed) {
      const dismissedTime = parseInt(dismissed, 10);
      // Show again after 7 days
      if (Date.now() - dismissedTime < 7 * 24 * 60 * 60 * 1000) {
        return;
      }
    }

    // Detect iOS
    const isIOSDevice = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
    setIsIOS(isIOSDevice);

    // For iOS, show prompt after a delay
    if (isIOSDevice) {
      const timer = setTimeout(() => {
        setShowPrompt(true);
      }, 3000);
      return () => clearTimeout(timer);
    }

    // For Android/Desktop, listen for beforeinstallprompt
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setCanInstall(true);
      // Show prompt after a short delay for better UX
      setTimeout(() => {
        setShowPrompt(true);
      }, 2000);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    // Check if app was installed
    window.addEventListener('appinstalled', () => {
      setShowPrompt(false);
      setCanInstall(false);
    });

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  const handleInstall = useCallback(async () => {
    const installed = await showInstallPrompt();
    if (installed) {
      setShowPrompt(false);
    }
  }, []);

  const handleDismiss = useCallback(() => {
    setShowPrompt(false);
    localStorage.setItem('pwa-install-dismissed', Date.now().toString());
  }, []);

  const handleNeverShow = useCallback(() => {
    setShowPrompt(false);
    localStorage.setItem('pwa-install-dismissed', (Date.now() + 365 * 24 * 60 * 60 * 1000).toString());
  }, []);

  if (!showPrompt) return null;

  // iOS-specific instructions modal
  if (isIOS && showIOSInstructions) {
    return (
      <div className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in">
        <div className="w-full max-w-sm liquid-glass-overlay rounded-2xl p-6 animate-morph-in">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-white">Install Daedalus</h3>
            <button
              onClick={() => setShowIOSInstructions(false)}
              className="p-2 rounded-full hover:bg-white/10 transition-colors"
              aria-label="Close"
            >
              <IconX size={20} className="text-white/60" />
            </button>
          </div>

          <div className="space-y-4 text-white/80 text-sm">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-nvidia-green/20 flex items-center justify-center text-nvidia-green font-bold">
                1
              </div>
              <div className="flex-1 pt-1">
                <p>Tap the <IconShare size={18} className="inline text-blue-400" /> Share button in Safari</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-nvidia-green/20 flex items-center justify-center text-nvidia-green font-bold">
                2
              </div>
              <div className="flex-1 pt-1">
                <p>Scroll down and tap <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-white/10 rounded"><IconPlus size={14} /> Add to Home Screen</span></p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-nvidia-green/20 flex items-center justify-center text-nvidia-green font-bold">
                3
              </div>
              <div className="flex-1 pt-1">
                <p>Tap <span className="font-medium text-nvidia-green">Add</span> to install the app</p>
              </div>
            </div>
          </div>

          <div className="mt-6 flex gap-2">
            <button
              onClick={handleDismiss}
              className="flex-1 py-3 px-4 rounded-xl bg-white/10 text-white/80 hover:bg-white/20 transition-all text-sm font-medium"
            >
              Maybe Later
            </button>
            <button
              onClick={() => setShowIOSInstructions(false)}
              className="flex-1 py-3 px-4 rounded-xl bg-nvidia-green text-white hover:bg-nvidia-green-dark transition-all text-sm font-medium"
            >
              Got it!
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-20 md:bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-80 z-[9999] animate-slide-up">
      <div className="liquid-glass-overlay rounded-2xl p-4 shadow-lg">
        <div className="flex items-start gap-3">
          {/* App Icon */}
          <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-nvidia-green to-emerald flex items-center justify-center shadow-glow-green">
            <IconDownload size={24} className="text-white" />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-white mb-1">Install Daedalus</h3>
            <p className="text-xs text-white/60 leading-relaxed">
              {isIOS
                ? 'Add to your home screen for the best experience with background processing.'
                : 'Install for faster access and background processing while your screen is off.'
              }
            </p>
          </div>

          {/* Close button */}
          <button
            onClick={handleDismiss}
            className="flex-shrink-0 p-1 rounded-full hover:bg-white/10 transition-colors"
            aria-label="Dismiss"
          >
            <IconX size={16} className="text-white/40" />
          </button>
        </div>

        {/* Actions */}
        <div className="mt-4 flex gap-2">
          <button
            onClick={handleNeverShow}
            className="flex-1 py-2.5 px-3 rounded-xl text-xs text-white/60 hover:text-white/80 hover:bg-white/5 transition-all font-medium"
          >
            Don&apos;t show again
          </button>
          {isIOS ? (
            <button
              onClick={() => setShowIOSInstructions(true)}
              className="flex-1 py-2.5 px-4 rounded-xl bg-nvidia-green text-white hover:bg-nvidia-green-dark transition-all text-sm font-medium flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(118,185,0,0.3)]"
            >
              <IconShare size={16} />
              How to Install
            </button>
          ) : canInstall ? (
            <button
              onClick={handleInstall}
              className="flex-1 py-2.5 px-4 rounded-xl bg-nvidia-green text-white hover:bg-nvidia-green-dark transition-all text-sm font-medium flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(118,185,0,0.3)]"
            >
              <IconDownload size={16} />
              Install
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
};
