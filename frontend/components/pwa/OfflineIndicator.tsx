'use client';

import { memo, useState, useEffect } from 'react';
import { IconWifi, IconWifiOff } from '@tabler/icons-react';
import classNames from 'classnames';

/**
 * Fixed toast at top center showing offline/online status.
 * Auto-hides 3s after coming back online.
 */
export const OfflineIndicator = memo(() => {
  const [isOffline, setIsOffline] = useState(false);
  const [showReconnected, setShowReconnected] = useState(false);

  useEffect(() => {
    const goOffline = () => setIsOffline(true);
    const goOnline = () => {
      setIsOffline(false);
      setShowReconnected(true);
      setTimeout(() => setShowReconnected(false), 3000);
    };

    // Check initial state
    if (!navigator.onLine) setIsOffline(true);

    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  if (!isOffline && !showReconnected) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={classNames(
        'fixed top-safe-top left-1/2 -translate-x-1/2 z-[100] mt-3',
        'flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium',
        'backdrop-blur-xl border shadow-lg animate-slide-up',
        isOffline
          ? 'bg-nvidia-red/15 border-nvidia-red/30 text-nvidia-red'
          : 'bg-nvidia-green/15 border-nvidia-green/30 text-nvidia-green'
      )}
    >
      {isOffline ? (
        <>
          <IconWifiOff size={16} />
          <span>You are offline</span>
        </>
      ) : (
        <>
          <IconWifi size={16} />
          <span>Back online</span>
        </>
      )}
    </div>
  );
});

OfflineIndicator.displayName = 'OfflineIndicator';
