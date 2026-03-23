/**
 * Persistent upload registry that survives navigation between conversations.
 *
 * This hook solves the problem of uploads being lost when users navigate
 * to a different conversation while an upload is in progress. It:
 * 1. Persists upload state to sessionStorage
 * 2. Tracks uploads by conversation ID
 * 3. Routes completed uploads to the correct conversation
 * 4. Handles page visibility changes (PWA backgrounding)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Logger } from '@/utils/logger';
import { createVisibilityAwareInterval, type ManagedTimer } from '@/utils/app/visibilityAwareTimer';

const logger = new Logger('UploadRegistry');

export type UploadType = 'image' | 'video' | 'document';
export type UploadStatus = 'pending' | 'uploading' | 'processing' | 'completed' | 'error' | 'cancelled';

export interface RegisteredUpload {
  id: string;
  conversationId: string;
  type: UploadType;
  filename: string;
  status: UploadStatus;
  progress: number;
  startedAt: number;
  completedAt?: number;
  error?: string;
  result?: unknown; // The upload result (e.g., imageRef, documentRef, videoRef)
}

interface UploadRegistryState {
  uploads: Record<string, RegisteredUpload>;
  lastUpdated: number;
}

const STORAGE_KEY = 'upload-registry';
const CLEANUP_INTERVAL_MS = 60000; // 1 minute
const MAX_UPLOAD_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Load registry state from sessionStorage
 */
function loadRegistryState(): UploadRegistryState {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    logger.error('Failed to load upload registry', error);
  }
  return { uploads: {}, lastUpdated: Date.now() };
}

/**
 * Save registry state to sessionStorage
 */
function saveRegistryState(state: UploadRegistryState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    logger.error('Failed to save upload registry', error);
  }
}

export interface UseUploadRegistryOptions {
  onUploadComplete?: (upload: RegisteredUpload) => void;
  onUploadError?: (upload: RegisteredUpload) => void;
}

export interface UseUploadRegistryReturn {
  // Register a new upload
  registerUpload: (
    conversationId: string,
    type: UploadType,
    filename: string
  ) => string;

  // Update upload progress
  updateProgress: (uploadId: string, progress: number) => void;

  // Mark upload as completed with result
  completeUpload: (uploadId: string, result: unknown) => void;

  // Mark upload as failed
  failUpload: (uploadId: string, error: string) => void;

  // Cancel an upload
  cancelUpload: (uploadId: string) => void;

  // Get uploads for a specific conversation
  getUploadsForConversation: (conversationId: string) => RegisteredUpload[];

  // Get pending/completed uploads that need to be routed to a conversation
  getPendingUploadsForConversation: (conversationId: string) => RegisteredUpload[];

  // Clear completed uploads for a conversation (after they've been applied)
  clearCompletedUploads: (conversationId: string) => void;

  // Check if there are any active uploads
  hasActiveUploads: boolean;

  // Get all active uploads
  activeUploads: RegisteredUpload[];
}

export function useUploadRegistry(
  options: UseUploadRegistryOptions = {}
): UseUploadRegistryReturn {
  const { onUploadComplete, onUploadError } = options;

  const [state, setState] = useState<UploadRegistryState>(loadRegistryState);
  const isInitializedRef = useRef(false);

  // Save to sessionStorage whenever state changes
  useEffect(() => {
    if (isInitializedRef.current) {
      saveRegistryState(state);
    } else {
      isInitializedRef.current = true;
    }
  }, [state]);

  // Cleanup old uploads periodically using visibility-aware timer
  // This pauses when app is backgrounded, saving battery on mobile
  useEffect(() => {
    const cleanup = () => {
      const now = Date.now();
      setState((prev) => {
        const uploads = { ...prev.uploads };
        let hasChanges = false;

        for (const [id, upload] of Object.entries(uploads)) {
          // Remove uploads older than MAX_UPLOAD_AGE_MS
          if (now - upload.startedAt > MAX_UPLOAD_AGE_MS) {
            delete uploads[id];
            hasChanges = true;
            logger.debug('Cleaned up old upload', { id, filename: upload.filename });
          }
        }

        if (hasChanges) {
          return { uploads, lastUpdated: now };
        }
        return prev;
      });
    };

    // Initial cleanup
    cleanup();

    // Periodic cleanup using visibility-aware timer
    const timer: ManagedTimer = createVisibilityAwareInterval(cleanup, {
      interval: CLEANUP_INTERVAL_MS,
      pauseWhenHidden: true,
      mobileMultiplier: 2, // Double interval on mobile
    });

    return () => timer.stop();
  }, []);

  // Handle page visibility changes (PWA backgrounding)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Reload state from storage when page becomes visible
        // (another tab might have updated it)
        const freshState = loadRegistryState();
        setState(freshState);
        logger.debug('Reloaded upload registry on visibility change');
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const registerUpload = useCallback(
    (conversationId: string, type: UploadType, filename: string): string => {
      const id = `upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const upload: RegisteredUpload = {
        id,
        conversationId,
        type,
        filename,
        status: 'uploading',
        progress: 0,
        startedAt: Date.now(),
      };

      setState((prev) => ({
        uploads: { ...prev.uploads, [id]: upload },
        lastUpdated: Date.now(),
      }));

      logger.info('Registered upload', { id, conversationId, type, filename });
      return id;
    },
    []
  );

  const updateProgress = useCallback((uploadId: string, progress: number) => {
    setState((prev) => {
      const upload = prev.uploads[uploadId];
      if (!upload || upload.status !== 'uploading') {
        return prev;
      }

      return {
        uploads: {
          ...prev.uploads,
          [uploadId]: { ...upload, progress },
        },
        lastUpdated: Date.now(),
      };
    });
  }, []);

  const completeUpload = useCallback(
    (uploadId: string, result: unknown) => {
      setState((prev) => {
        const upload = prev.uploads[uploadId];
        if (!upload) {
          return prev;
        }

        const completedUpload: RegisteredUpload = {
          ...upload,
          status: 'completed',
          progress: 100,
          completedAt: Date.now(),
          result,
        };

        logger.info('Upload completed', { id: uploadId, filename: upload.filename });

        // Call completion callback
        if (onUploadComplete) {
          setTimeout(() => onUploadComplete(completedUpload), 0);
        }

        return {
          uploads: { ...prev.uploads, [uploadId]: completedUpload },
          lastUpdated: Date.now(),
        };
      });
    },
    [onUploadComplete]
  );

  const failUpload = useCallback(
    (uploadId: string, error: string) => {
      setState((prev) => {
        const upload = prev.uploads[uploadId];
        if (!upload) {
          return prev;
        }

        const failedUpload: RegisteredUpload = {
          ...upload,
          status: 'error',
          error,
          completedAt: Date.now(),
        };

        logger.error('Upload failed', { id: uploadId, filename: upload.filename, error });

        // Call error callback
        if (onUploadError) {
          setTimeout(() => onUploadError(failedUpload), 0);
        }

        return {
          uploads: { ...prev.uploads, [uploadId]: failedUpload },
          lastUpdated: Date.now(),
        };
      });
    },
    [onUploadError]
  );

  const cancelUpload = useCallback((uploadId: string) => {
    setState((prev) => {
      const upload = prev.uploads[uploadId];
      if (!upload) {
        return prev;
      }

      logger.info('Upload cancelled', { id: uploadId, filename: upload.filename });

      return {
        uploads: {
          ...prev.uploads,
          [uploadId]: {
            ...upload,
            status: 'cancelled',
            completedAt: Date.now(),
          },
        },
        lastUpdated: Date.now(),
      };
    });
  }, []);

  const getUploadsForConversation = useCallback(
    (conversationId: string): RegisteredUpload[] => {
      return Object.values(state.uploads).filter(
        (upload) => upload.conversationId === conversationId
      );
    },
    [state.uploads]
  );

  const getPendingUploadsForConversation = useCallback(
    (conversationId: string): RegisteredUpload[] => {
      return Object.values(state.uploads).filter(
        (upload) =>
          upload.conversationId === conversationId &&
          upload.status === 'completed' &&
          upload.result !== undefined
      );
    },
    [state.uploads]
  );

  const clearCompletedUploads = useCallback((conversationId: string) => {
    setState((prev) => {
      const uploads = { ...prev.uploads };
      let hasChanges = false;

      for (const [id, upload] of Object.entries(uploads)) {
        if (
          upload.conversationId === conversationId &&
          (upload.status === 'completed' || upload.status === 'error' || upload.status === 'cancelled')
        ) {
          delete uploads[id];
          hasChanges = true;
        }
      }

      if (hasChanges) {
        return { uploads, lastUpdated: Date.now() };
      }
      return prev;
    });
  }, []);

  const activeUploads = Object.values(state.uploads).filter(
    (upload) => upload.status === 'uploading' || upload.status === 'processing'
  );

  const hasActiveUploads = activeUploads.length > 0;

  return {
    registerUpload,
    updateProgress,
    completeUpload,
    failUpload,
    cancelUpload,
    getUploadsForConversation,
    getPendingUploadsForConversation,
    clearCompletedUploads,
    hasActiveUploads,
    activeUploads,
  };
}
