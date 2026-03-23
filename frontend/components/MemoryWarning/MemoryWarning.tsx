import React, { useCallback } from 'react';
import { IconAlertTriangle, IconX, IconRefresh } from '@tabler/icons-react';
import { useMemoryMonitor, memoryMonitor } from '@/utils/app/memoryMonitor';
import { clearAllImageBlobs } from '@/utils/app/imageHandler';
import { cleanupOldIntermediateSteps } from '@/utils/app/intermediateStepsDB';
import toast from 'react-hot-toast';

interface MemoryWarningProps {
  className?: string;
}

export const MemoryWarning: React.FC<MemoryWarningProps> = ({ className = '' }) => {
  const [isVisible, setIsVisible] = React.useState(true);
  const [isClearing, setIsClearing] = React.useState(false);

  const { memoryInfo, isHighMemory } = useMemoryMonitor({
    warningThreshold: 70, // Lowered from 80%
    criticalThreshold: 80, // Lowered from 90%
    checkInterval: 5000, // Check every 5 seconds (more frequent)
    onWarning: () => {
      setIsVisible(true);
      // Auto-clear caches at warning level
      clearAllImageBlobs();
      if ('caches' in window) {
        caches.keys().then(cacheNames => {
          cacheNames.forEach(name => {
            if (name.includes('runtime')) {
              caches.delete(name);
            }
          });
        });
      }
    },
    onCritical: () => {
      setIsVisible(true);
      // Auto-clear more aggressively on critical
      handleClearMemory();
    }
  });

  const handleClearMemory = useCallback(async () => {
    setIsClearing(true);

    try {
      let totalCleaned = 0;

      // Level 1: Clear image blob cache
      clearAllImageBlobs();
      console.log('Cleared image blob cache');

      // Level 2: Clean up intermediate steps (more aggressive - 6 hours)
      const deletedSteps = await cleanupOldIntermediateSteps();
      totalCleaned += deletedSteps;

      // Level 3: Clear service worker caches
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        let cachesCleared = 0;
        for (const name of cacheNames) {
          await caches.delete(name);
          cachesCleared++;
        }
        console.log(`Cleared ${cachesCleared} caches`);
      }

      // Level 4: Clear sessionStorage for non-essential items
      if (memoryInfo && memoryInfo.percentUsed > 85) {
        const keysToRemove = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key && !key.includes('auth') && !key.includes('selectedConversation')) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(key => sessionStorage.removeItem(key));
        console.log(`Cleared ${keysToRemove.length} sessionStorage items`);
      }

      // Try to trigger garbage collection
      memoryMonitor.forceGarbageCollection();

      toast.success(`Memory cleaned up! Removed ${totalCleaned} items.`);

      // Check memory again after cleanup
      setTimeout(() => {
        const stats = memoryMonitor.getStats();
        if (stats.current && stats.current.percentUsed < 70) {
          setIsVisible(false);
        }
      }, 1000);

    } catch (error) {
      console.error('Failed to clear memory:', error);
      toast.error('Failed to clear memory');
    } finally {
      setIsClearing(false);
    }
  }, [memoryInfo]);

  const formatMemoryInfo = () => {
    if (!memoryInfo) return '';

    const used = (memoryInfo.usedJSHeapSize / (1024 * 1024)).toFixed(0);
    const limit = (memoryInfo.jsHeapSizeLimit / (1024 * 1024)).toFixed(0);

    return `${used}MB / ${limit}MB (${memoryInfo.percentUsed.toFixed(0)}%)`;
  };

  if (!isHighMemory || !isVisible || !memoryInfo) {
    return null;
  }

  const isCritical = memoryInfo.percentUsed >= 80; // Lowered threshold
  const isWarning = memoryInfo.percentUsed >= 70 && memoryInfo.percentUsed < 80;

  return (
    <div
      className={`
        fixed bottom-20 right-4 z-50 max-w-sm
        animate-slide-up
        ${className}
      `}
    >
      <div
        className={`
          rounded-2xl border p-4 shadow-lg backdrop-blur-xl
          ${isCritical
            ? 'border-red-500/50 bg-red-500/10 dark:bg-red-500/20'
            : 'border-yellow-500/50 bg-yellow-500/10 dark:bg-yellow-500/20'
          }
        `}
      >
        <div className="flex items-start gap-3">
          <div className={`
            flex-shrink-0 p-2 rounded-full
            ${isCritical
              ? 'bg-red-500/20 text-red-500'
              : 'bg-yellow-500/20 text-yellow-500'
            }
          `}>
            <IconAlertTriangle size={20} />
          </div>

          <div className="flex-1">
            <h3 className={`
              font-semibold text-sm mb-1
              ${isCritical ? 'text-red-700 dark:text-red-300' : 'text-yellow-700 dark:text-yellow-300'}
            `}>
              {isCritical ? 'Critical Memory Usage' : 'High Memory Usage'}
            </h3>

            <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
              Memory usage: {formatMemoryInfo()}
            </p>

            <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
              {isCritical
                ? 'Your browser is running out of memory. Clear some data to prevent crashes.'
                : 'Memory usage is high. Consider clearing some data to improve performance.'
              }
            </p>

            <div className="flex gap-2">
              <button
                onClick={handleClearMemory}
                disabled={isClearing}
                className={`
                  flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium
                  transition-colors disabled:opacity-50
                  ${isCritical
                    ? 'bg-red-500 text-white hover:bg-red-600'
                    : 'bg-yellow-500 text-white hover:bg-yellow-600'
                  }
                `}
              >
                <IconRefresh size={14} className={isClearing ? 'animate-spin' : ''} />
                {isClearing ? 'Clearing...' : 'Clear Memory'}
              </button>

              <button
                onClick={() => setIsVisible(false)}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium
                  bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300
                  hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
              >
                <IconX size={14} />
                Dismiss
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
