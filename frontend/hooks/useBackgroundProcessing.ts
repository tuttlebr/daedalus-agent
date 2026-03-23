import { useEffect, useRef, useState } from 'react';
import { Logger } from '@/utils/logger';

const logger = new Logger('BackgroundProcessing');

export interface BackgroundProcessingState {
  isStreaming: boolean;
  conversationId: string | null;
  partialResponse: string;
  timestamp: number;
  intermediateSteps?: any[];
  jobId?: string;
}

interface UseBackgroundProcessingReturn {
  wakeLockActive: boolean;
  isVisible: boolean;
  requestWakeLock: () => Promise<void>;
  releaseWakeLock: () => Promise<void>;
  saveStreamingState: (state: BackgroundProcessingState) => Promise<void>;
  getStreamingState: () => Promise<BackgroundProcessingState | null>;
  clearStreamingState: () => Promise<void>;
}

// Maximum time to hold wake lock (5 minutes) - safety timeout
const WAKE_LOCK_MAX_DURATION_MS = 5 * 60 * 1000;

export const useBackgroundProcessing = (): UseBackgroundProcessingReturn => {
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const dbRef = useRef<IDBDatabase | null>(null);
  const requestCountRef = useRef(0); // Track wake lock requests
  const wakeLockTimeoutRef = useRef<NodeJS.Timeout | null>(null); // Safety timeout

  // Initialize IndexedDB for persistent state
  useEffect(() => {
    const openDB = async () => {
      return new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('DaedalusBackgroundDB', 1);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);

        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains('streamingState')) {
            db.createObjectStore('streamingState');
          }
        };
      });
    };

    openDB().then(db => {
      dbRef.current = db;
    }).catch(err => {
      logger.error('Failed to open IndexedDB', err);
    });

    return () => {
      if (dbRef.current) {
        dbRef.current.close();
      }
    };
  }, []);

  // Monitor page visibility
  useEffect(() => {
    const handleVisibilityChange = () => {
      const visible = document.visibilityState === 'visible';
      setIsVisible(visible);

      // Notify service worker to enable/disable background tasks
      navigator.serviceWorker?.controller?.postMessage({
        type: 'SET_BACKGROUND_TASKS',
        enabled: visible,
      });

      if (!visible) {
        logger.info('App went to background - streaming may be interrupted');
      } else {
        logger.info('App returned to foreground');
        // Re-acquire wake lock if it was active
        if (wakeLockActive) {
          requestWakeLock();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [wakeLockActive]);

  // Smart wake lock request with battery level detection and safety timeout
  const requestWakeLock = async () => {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
      logger.warn('Wake Lock API not supported');
      return;
    }

    // Check battery level before requesting wake lock
    if ('getBattery' in navigator) {
      try {
        const battery = await (navigator as any).getBattery();
        const batteryLevel = battery.level * 100;

        // Don't request wake lock if battery is low
        if (batteryLevel < 20) {
          logger.info('Battery low, skipping wake lock request');
          return;
        }

        // If charging, we can be more aggressive with wake lock
        if (!battery.charging && batteryLevel < 50) {
          logger.info('Battery not charging and below 50%, limiting wake lock');
          // Only request if no existing lock
          if (wakeLockRef.current) return;
        }
      } catch (err) {
        logger.debug('Battery API not available');
      }
    }

    // Increment request count
    requestCountRef.current += 1;

    // Only request if we don't already have a lock
    if (!wakeLockRef.current) {
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        setWakeLockActive(true);
        logger.info('Wake lock acquired - screen will stay on during streaming');

        // Set up safety timeout to auto-release wake lock after max duration
        // This prevents indefinite battery drain if release is never called
        if (wakeLockTimeoutRef.current) {
          clearTimeout(wakeLockTimeoutRef.current);
        }
        wakeLockTimeoutRef.current = setTimeout(async () => {
          logger.warn('Wake lock safety timeout reached - auto-releasing');
          if (wakeLockRef.current) {
            try {
              await wakeLockRef.current.release();
              wakeLockRef.current = null;
              requestCountRef.current = 0;
              setWakeLockActive(false);
            } catch (err) {
              logger.error('Failed to auto-release wake lock', err);
            }
          }
        }, WAKE_LOCK_MAX_DURATION_MS);

        wakeLockRef.current.addEventListener('release', () => {
          logger.info('Wake lock released');
          setWakeLockActive(false);
          wakeLockRef.current = null;
          requestCountRef.current = 0;
          // Clear safety timeout when released normally
          if (wakeLockTimeoutRef.current) {
            clearTimeout(wakeLockTimeoutRef.current);
            wakeLockTimeoutRef.current = null;
          }
        });
      } catch (err) {
        logger.error('Failed to acquire wake lock', err);
      }
    } else {
      // Wake lock already exists — do NOT reset the safety timeout.
      // The timeout is set once when the lock is first acquired and acts as
      // an absolute maximum duration to prevent indefinite battery drain.
      logger.debug('Wake lock already active, skipping timeout refresh', {
        activeRequests: requestCountRef.current,
      });
    }
  };

  // Release wake lock when streaming completes (with reference counting)
  const releaseWakeLock = async () => {
    // Decrement request count
    requestCountRef.current = Math.max(0, requestCountRef.current - 1);

    // Only release if no more requests
    if (requestCountRef.current === 0 && wakeLockRef.current) {
      // Clear safety timeout
      if (wakeLockTimeoutRef.current) {
        clearTimeout(wakeLockTimeoutRef.current);
        wakeLockTimeoutRef.current = null;
      }

      try {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
        setWakeLockActive(false);
        logger.info('Wake lock released - no more active requests');
      } catch (err) {
        logger.error('Failed to release wake lock', err);
      }
    } else if (requestCountRef.current > 0) {
      logger.debug('Wake lock retained', { activeRequests: requestCountRef.current });
    }
  };

  // Save streaming state to IndexedDB for recovery
  const saveStreamingState = async (state: BackgroundProcessingState) => {
    if (!dbRef.current) {
      logger.warn('IndexedDB not initialized');
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const transaction = dbRef.current!.transaction(['streamingState'], 'readwrite');
      const store = transaction.objectStore('streamingState');
      const request = store.put(state, 'current');

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  };

  // Retrieve streaming state from IndexedDB
  const getStreamingState = async (): Promise<BackgroundProcessingState | null> => {
    if (!dbRef.current) {
      logger.warn('IndexedDB not initialized');
      return null;
    }

    return new Promise<BackgroundProcessingState | null>((resolve, reject) => {
      const transaction = dbRef.current!.transaction(['streamingState'], 'readonly');
      const store = transaction.objectStore('streamingState');
      const request = store.get('current');

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  };

  // Clear streaming state from IndexedDB
  const clearStreamingState = async () => {
    if (!dbRef.current) {
      logger.warn('IndexedDB not initialized');
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const transaction = dbRef.current!.transaction(['streamingState'], 'readwrite');
      const store = transaction.objectStore('streamingState');
      const request = store.delete('current');

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  };

  // Auto-release wake lock and clear timeout on unmount
  useEffect(() => {
    return () => {
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
      }
      if (wakeLockTimeoutRef.current) {
        clearTimeout(wakeLockTimeoutRef.current);
      }
    };
  }, []);

  return {
    wakeLockActive,
    isVisible,
    requestWakeLock,
    releaseWakeLock,
    saveStreamingState,
    getStreamingState,
    clearStreamingState,
  };
};
