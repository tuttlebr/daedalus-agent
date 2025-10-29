import { useEffect, useRef, useState } from 'react';

interface BackgroundProcessingState {
  isStreaming: boolean;
  conversationId: string | null;
  partialResponse: string;
  timestamp: number;
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

export const useBackgroundProcessing = (): UseBackgroundProcessingReturn => {
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const dbRef = useRef<IDBDatabase | null>(null);
  const requestCountRef = useRef(0); // Track wake lock requests

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
      console.error('Failed to open IndexedDB:', err);
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

      if (!visible) {
        console.log('App went to background - streaming may be interrupted');
      } else {
        console.log('App returned to foreground');
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

  // Smart wake lock request with battery level detection
  const requestWakeLock = async () => {
    if (!('wakeLock' in navigator)) {
      console.warn('Wake Lock API not supported');
      return;
    }

    // Check battery level before requesting wake lock
    if ('getBattery' in navigator) {
      try {
        const battery = await (navigator as any).getBattery();
        const batteryLevel = battery.level * 100;

        // Don't request wake lock if battery is low
        if (batteryLevel < 20) {
          console.log('Battery low, skipping wake lock request');
          return;
        }

        // If charging, we can be more aggressive with wake lock
        if (!battery.charging && batteryLevel < 50) {
          console.log('Battery not charging and below 50%, limiting wake lock');
          // Only request if no existing lock
          if (wakeLockRef.current) return;
        }
      } catch (err) {
        console.log('Battery API not available');
      }
    }

    // Increment request count
    requestCountRef.current += 1;

    // Only request if we don't already have a lock
    if (!wakeLockRef.current) {
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        setWakeLockActive(true);
        console.log('Wake lock acquired - screen will stay on during streaming');

        wakeLockRef.current.addEventListener('release', () => {
          console.log('Wake lock released');
          setWakeLockActive(false);
          wakeLockRef.current = null;
          requestCountRef.current = 0;
        });
      } catch (err) {
        console.error('Failed to acquire wake lock:', err);
      }
    }
  };

  // Release wake lock when streaming completes (with reference counting)
  const releaseWakeLock = async () => {
    // Decrement request count
    requestCountRef.current = Math.max(0, requestCountRef.current - 1);

    // Only release if no more requests
    if (requestCountRef.current === 0 && wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
        setWakeLockActive(false);
        console.log('Wake lock released - no more active requests');
      } catch (err) {
        console.error('Failed to release wake lock:', err);
      }
    } else if (requestCountRef.current > 0) {
      console.log(`Wake lock retained - ${requestCountRef.current} active requests`);
    }
  };

  // Save streaming state to IndexedDB for recovery
  const saveStreamingState = async (state: BackgroundProcessingState) => {
    if (!dbRef.current) {
      console.warn('IndexedDB not initialized');
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
      console.warn('IndexedDB not initialized');
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
      console.warn('IndexedDB not initialized');
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

  // Auto-release wake lock on unmount
  useEffect(() => {
    return () => {
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
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
