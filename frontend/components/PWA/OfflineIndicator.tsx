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

    setIsOnline(navigator.onLine);

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
      className={`fixed top-4 left-1/2 -translate-x-1/2 z-[9999] px-4 py-2 rounded-full shadow-lg backdrop-blur-md transition-all duration-300 ${
        isOnline
          ? 'bg-green-500/90 text-white'
          : 'bg-red-500/90 text-white'
      }`}
      style={{
        animation: 'slideDown 0.3s ease-out',
      }}
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
