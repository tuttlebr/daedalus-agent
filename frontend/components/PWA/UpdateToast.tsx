import { FC, useState } from 'react';

interface UpdateToastProps {
  onDismiss: () => void;
}

export const UpdateToast: FC<UpdateToastProps> = ({ onDismiss }) => {
  const handleReload = () => {
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
    }
    window.location.reload();
  };

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl bg-neutral-900 dark:bg-neutral-100 px-4 py-3 shadow-2xl border border-neutral-700 dark:border-neutral-300 animate-morph-in">
      <span className="text-sm text-white dark:text-neutral-900">New version available</span>
      <button
        onClick={handleReload}
        className="rounded-lg bg-nvidia-green px-3 py-1.5 text-xs font-semibold text-white hover:bg-nvidia-green/90 transition-colors"
      >
        Reload
      </button>
      <button
        onClick={onDismiss}
        className="text-neutral-400 hover:text-white dark:hover:text-neutral-900 transition-colors text-xs"
        aria-label="Dismiss update notification"
      >
        Later
      </button>
    </div>
  );
};
