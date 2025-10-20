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

  // Request screen wake lock to prevent sleep during streaming
  const requestWakeLock = async () => {
    if (!('wakeLock' in navigator)) {
      console.warn('Wake Lock API not supported');
      return;
    }

    try {
      wakeLockRef.current = await navigator.wakeLock.request('screen');
      setWakeLockActive(true);
      console.log('Wake lock acquired - screen will stay on during streaming');

      wakeLockRef.current.addEventListener('release', () => {
        console.log('Wake lock released');
        setWakeLockActive(false);
      });
    } catch (err) {
      console.error('Failed to acquire wake lock:', err);
    }
  };

  // Release wake lock when streaming completes
  const releaseWakeLock = async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
        setWakeLockActive(false);
      } catch (err) {
        console.error('Failed to release wake lock:', err);
      }
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
