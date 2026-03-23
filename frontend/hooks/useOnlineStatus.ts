import { useState, useEffect, useCallback } from 'react';

export interface OnlineStatusInfo {
  isOnline: boolean;
  wasOffline: boolean; // True if we were recently offline (useful for showing "back online" message)
  lastOnlineAt: number | null;
  lastOfflineAt: number | null;
}

export const useOnlineStatus = (): OnlineStatusInfo => {
  const [isOnline, setIsOnline] = useState(() => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return true;
    return navigator.onLine;
  });
  const [wasOffline, setWasOffline] = useState(false);
  const [lastOnlineAt, setLastOnlineAt] = useState<number | null>(null);
  const [lastOfflineAt, setLastOfflineAt] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let wasOfflineTimer: ReturnType<typeof setTimeout> | null = null;

    const handleOnline = () => {
      setIsOnline(true);
      setLastOnlineAt(Date.now());
      setWasOffline(true);

      // Clear any existing timer before setting a new one
      if (wasOfflineTimer) {
        clearTimeout(wasOfflineTimer);
      }

      // Clear the "was offline" flag after 5 seconds
      wasOfflineTimer = setTimeout(() => {
        setWasOffline(false);
      }, 5000);
    };

    const handleOffline = () => {
      setIsOnline(false);
      setLastOfflineAt(Date.now());
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      if (wasOfflineTimer) {
        clearTimeout(wasOfflineTimer);
      }
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return {
    isOnline,
    wasOffline,
    lastOnlineAt,
    lastOfflineAt,
  };
};

// Utility function to send cache invalidation message to service worker
export function invalidateServiceWorkerCache(conversationId: string): void {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) {
    return;
  }

  navigator.serviceWorker.controller.postMessage({
    type: 'INVALIDATE_CONVERSATION_CACHE',
    conversationId,
  });
}
