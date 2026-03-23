'use client';

import { useCallback, useRef, useState } from 'react';
import toast from 'react-hot-toast';

// =============================================================================
// TYPES
// =============================================================================

interface UploadState {
  id: string;
  controller: AbortController;
  type: 'image' | 'video' | 'document';
  filename: string;
  progress: number;
  startedAt: number;
}

interface UseFileUploadOptions {
  /** Callback when upload completes successfully */
  onUploadComplete?: (type: 'image' | 'video' | 'document', result: unknown) => void;
  /** Callback when upload fails */
  onUploadError?: (type: 'image' | 'video' | 'document', error: Error) => void;
}

interface UseFileUploadReturn {
  /** Start a new tracked upload */
  startTrackedUpload: (type: 'image' | 'video' | 'document', filename: string) => { id: string; controller: AbortController };
  /** Update upload progress */
  updateUploadProgress: (id: string, progress: number) => void;
  /** Complete and remove a tracked upload */
  completeTrackedUpload: (id: string) => void;
  /** Cancel a specific upload */
  cancelUpload: (id: string) => void;
  /** Cancel all uploads of a specific type */
  cancelAllUploads: (type?: 'image' | 'video' | 'document') => void;
  /** Current upload progress by ID */
  uploadProgress: Record<string, number>;
  /** Number of active uploads */
  activeUploadsCount: number;
  /** Whether there are any active uploads */
  hasActiveUploads: boolean;
  /** Get upload state by ID */
  getUploadState: (id: string) => UploadState | undefined;
  /** Check if a specific upload is still active */
  isUploadActive: (id: string) => boolean;
}

/**
 * Custom hook for managing file uploads with progress tracking and cancellation
 *
 * Handles:
 * - Upload progress tracking
 * - Upload cancellation via AbortController
 * - Multiple concurrent uploads
 * - Type-based filtering
 */
export function useFileUpload({
  onUploadComplete,
  onUploadError,
}: UseFileUploadOptions = {}): UseFileUploadReturn {
  const activeUploadsRef = useRef<Map<string, UploadState>>(new Map());
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});

  // Generate unique upload ID
  const generateUploadId = useCallback(() => {
    return `upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }, []);

  // Start a new tracked upload
  const startTrackedUpload = useCallback((
    type: 'image' | 'video' | 'document',
    filename: string
  ): { id: string; controller: AbortController } => {
    const id = generateUploadId();
    const controller = new AbortController();

    const uploadState: UploadState = {
      id,
      controller,
      type,
      filename,
      progress: 0,
      startedAt: Date.now(),
    };

    activeUploadsRef.current.set(id, uploadState);
    setUploadProgress(prev => ({ ...prev, [id]: 0 }));

    return { id, controller };
  }, [generateUploadId]);

  // Update upload progress
  const updateUploadProgress = useCallback((id: string, progress: number) => {
    const upload = activeUploadsRef.current.get(id);
    if (upload) {
      upload.progress = progress;
      setUploadProgress(prev => ({ ...prev, [id]: progress }));
    }
  }, []);

  // Complete and remove a tracked upload
  const completeTrackedUpload = useCallback((id: string) => {
    const upload = activeUploadsRef.current.get(id);
    activeUploadsRef.current.delete(id);
    setUploadProgress(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

    if (upload && onUploadComplete) {
      onUploadComplete(upload.type, { id, filename: upload.filename });
    }
  }, [onUploadComplete]);

  // Cancel a specific upload
  const cancelUpload = useCallback((id: string) => {
    const upload = activeUploadsRef.current.get(id);
    if (upload) {
      upload.controller.abort();
      activeUploadsRef.current.delete(id);
      setUploadProgress(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast(`Upload cancelled: ${upload.filename}`, { icon: 'ℹ️' });

      if (onUploadError) {
        onUploadError(upload.type, new Error('Upload cancelled'));
      }
    }
  }, [onUploadError]);

  // Cancel all uploads of a specific type
  const cancelAllUploads = useCallback((type?: 'image' | 'video' | 'document') => {
    const uploadsToCancel = Array.from(activeUploadsRef.current.values())
      .filter(upload => !type || upload.type === type);

    uploadsToCancel.forEach(upload => {
      upload.controller.abort();
      activeUploadsRef.current.delete(upload.id);

      if (onUploadError) {
        onUploadError(upload.type, new Error('Upload cancelled'));
      }
    });

    if (uploadsToCancel.length > 0) {
      setUploadProgress(prev => {
        const next = { ...prev };
        uploadsToCancel.forEach(upload => delete next[upload.id]);
        return next;
      });
      toast(`Cancelled ${uploadsToCancel.length} upload(s)`, { icon: 'ℹ️' });
    }
  }, [onUploadError]);

  // Get upload state by ID
  const getUploadState = useCallback((id: string): UploadState | undefined => {
    return activeUploadsRef.current.get(id);
  }, []);

  // Check if a specific upload is still active
  const isUploadActive = useCallback((id: string): boolean => {
    return activeUploadsRef.current.has(id);
  }, []);

  // Computed values
  const activeUploadsCount = Object.keys(uploadProgress).length;
  const hasActiveUploads = activeUploadsCount > 0;

  return {
    startTrackedUpload,
    updateUploadProgress,
    completeTrackedUpload,
    cancelUpload,
    cancelAllUploads,
    uploadProgress,
    activeUploadsCount,
    hasActiveUploads,
    getUploadState,
    isUploadActive,
  };
}

export default useFileUpload;
