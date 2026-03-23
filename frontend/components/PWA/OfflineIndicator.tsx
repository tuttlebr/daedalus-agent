import { useEffect, useState } from 'react';
import { IconWifi, IconWifiOff } from '@tabler/icons-react';

export const OfflineIndicator = () => {
  const [isOnline, setIsOnline] = useState(true);
  const [showIndicator, setShowIndicator] = useState(false);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      setShowIndicator(true);
      setTimeout(() => setShowIndicator(false), 3000);
    };

    const handleOffline = () => {
      setIsOnline(false);
      setShowIndicator(true);
    };

    setIsOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (!showIndicator) return null;

  return (
    <div
      className={`fixed left-1/2 -translate-x-1/2 z-[9999] px-5 py-2.5 rounded-2xl shadow-lg backdrop-blur-xl transition-all duration-300 animate-morph-in ${
        isOnline
          ? 'bg-nvidia-green/90 text-white'
          : 'bg-error/90 text-white'
      }`}
      style={{
        top: 'calc(env(safe-area-inset-top, 0px) + 1rem)',
      }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        {isOnline ? (
          <>
            <IconWifi size={18} />
            <span className="text-sm font-medium">Back Online</span>
          </>
        ) : (
          <>
            <IconWifiOff size={18} />
            <span className="text-sm font-medium">No Internet Connection</span>
          </>
        )}
      </div>
    </div>
  );
};
