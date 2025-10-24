import { useState, useEffect, useCallback, useRef } from 'react';

interface AsyncJobStatus {
  jobId: string;
  status: 'pending' | 'streaming' | 'completed' | 'error';
  partialResponse?: string;
  fullResponse?: string;
  intermediateSteps?: any[];
  error?: string;
  progress?: number;
  createdAt: number;
  updatedAt: number;
  conversationId?: string;
  finalizedAt?: number;  // Timestamp when all backend operations are complete
}

interface PersistedJob {
  jobId: string;
  conversationId: string;
  userId: string;
  timestamp: number;
}

interface UseAsyncChatOptions {
  pollingInterval?: number;
  onProgress?: (status: AsyncJobStatus) => void;
  onComplete?: (response: string, intermediateSteps?: any[], finalizedAt?: number) => void;
  onError?: (error: string) => void;
  userId?: string; // Add userId for localStorage key scoping
}

interface UseAsyncChatReturn {
  startAsyncJob: (messages: any[], chatCompletionURL: string, additionalProps: any, userId: string, conversationId: string, conversationName: string) => Promise<string>;
  jobStatus: AsyncJobStatus | null;
  isPolling: boolean;
  cancelJob: () => Promise<void>;
  clearPersistedJob: () => void;
}

// Helper functions for job persistence
const getStorageKey = (userId: string) => `asyncJob_${userId}`;

const persistJob = (job: PersistedJob, userId: string) => {
  try {
    localStorage.setItem(getStorageKey(userId), JSON.stringify(job));
    console.log('📦 Persisted async job:', job.jobId, 'for conversation:', job.conversationId);
  } catch (error) {
    console.error('Failed to persist job:', error);
  }
};

const getPersistedJob = (userId: string): PersistedJob | null => {
  try {
    const stored = localStorage.getItem(getStorageKey(userId));
    if (!stored) return null;
    const job = JSON.parse(stored) as PersistedJob;
    console.log('📥 Retrieved persisted job:', job.jobId);
    return job;
  } catch (error) {
    console.error('Failed to retrieve persisted job:', error);
    return null;
  }
};

const clearPersistedJob = (userId: string) => {
  try {
    localStorage.removeItem(getStorageKey(userId));
    console.log('🗑️ Cleared persisted job for user:', userId);
  } catch (error) {
    console.error('Failed to clear persisted job:', error);
  }
};

export const useAsyncChat = (options: UseAsyncChatOptions = {}): UseAsyncChatReturn => {
  const {
    pollingInterval = 2000, // Poll every 2 seconds
    onProgress,
    onComplete,
    onError,
    userId = 'anon',
  } = options;

  const [jobStatus, setJobStatus] = useState<AsyncJobStatus | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const currentJobIdRef = useRef<string | null>(null);
  const hasResumedRef = useRef(false); // Prevent double-resume
  const isComponentMountedRef = useRef(true);

  // Poll for job status
  const pollJobStatus = useCallback(async (jobId: string) => {
    try {
      const response = await fetch(`/api/chat/async?jobId=${jobId}`);

      if (!response.ok) {
        if (response.status === 404) {
          console.log('Job not found, stopping polling');
          setIsPolling(false);
          return null;
        }
        throw new Error(`Failed to fetch job status: ${response.statusText}`);
      }

      const status: AsyncJobStatus = await response.json();
      setJobStatus(status);

      // Call progress callback
      if (onProgress) {
        onProgress(status);
      }

      // Check if job is complete AND finalized
      if (status.status === 'completed' && status.finalizedAt) {
        // Only consider job truly complete when finalizedAt is set
        setIsPolling(false);
        if (onComplete && status.fullResponse) {
          onComplete(status.fullResponse, status.intermediateSteps, status.finalizedAt);
        }
        // Clear polling and persisted job
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
        clearPersistedJob(userId);
        currentJobIdRef.current = null;
        console.log('✅ Job completed and finalized - cleared persisted state');
      } else if (status.status === 'completed' && !status.finalizedAt) {
        // Job marked complete but still finalizing - keep polling
        console.log('⏳ Job completed but not finalized yet, continuing to poll...');
      } else if (status.status === 'error') {
        setIsPolling(false);
        if (onError) {
          onError(status.error || 'Unknown error');
        }
        // Clear polling and persisted job
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
        clearPersistedJob(userId);
        currentJobIdRef.current = null;
        console.log('❌ Job errored - cleared persisted state');
      }

      return status;
    } catch (error: any) {
      console.error('Error polling job status:', error);
      setIsPolling(false);
      if (onError) {
        onError(error.message);
      }
      return null;
    }
  }, [onProgress, onComplete, onError, userId]);

  // Start async job
  const startAsyncJob = useCallback(async (
    messages: any[],
    chatCompletionURL: string,
    additionalProps: any,
    jobUserId: string,
    conversationId: string,
    conversationName: string
  ): Promise<string> => {
    try {
      // Cancel any existing job
      if (currentJobIdRef.current) {
        await cancelJob();
      }

      const response = await fetch('/api/chat/async', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages,
          chatCompletionURL,
          additionalProps,
          userId: jobUserId,
          conversationId,
          conversationName,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to start async job: ${response.statusText}`);
      }

      const { jobId } = await response.json();
      currentJobIdRef.current = jobId;

      // Persist job metadata for resume after backgrounding
      persistJob({
        jobId,
        conversationId,
        userId: jobUserId,
        timestamp: Date.now(),
      }, userId);

      // Start polling
      setIsPolling(true);

      // Initial poll
      await pollJobStatus(jobId);

      // Set up interval polling
      pollingIntervalRef.current = setInterval(async () => {
        if (currentJobIdRef.current === jobId && isComponentMountedRef.current) {
          await pollJobStatus(jobId);
        }
      }, pollingInterval);

      return jobId;
    } catch (error: any) {
      console.error('Error starting async job:', error);
      if (onError) {
        onError(error.message);
      }
      throw error;
    }
  }, [pollJobStatus, pollingInterval, onError, userId]);

  // Cancel current job
  // Clean up on unmount
  useEffect(() => {
    return () => {
      isComponentMountedRef.current = false;
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, []);

  const cancelJob = useCallback(async () => {
    if (!currentJobIdRef.current) return;

    const jobId = currentJobIdRef.current;

    try {
      // Stop polling
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }

      setIsPolling(false);

      // Delete job on server
      await fetch(`/api/chat/async?jobId=${jobId}`, {
        method: 'DELETE',
      });

      currentJobIdRef.current = null;
      setJobStatus(null);
      clearPersistedJob(userId);
    } catch (error) {
      console.error('Error canceling job:', error);
    }
  }, [userId]);

  // Resume polling for persisted job (called on mount and visibility change)
  const resumePollingIfNeeded = useCallback(async () => {
    const persistedJob = getPersistedJob(userId);

    if (!persistedJob) {
      return; // No persisted job to resume
    }

    // If we already have this job polling, skip
    if (currentJobIdRef.current === persistedJob.jobId) {
      return;
    }

    console.log('🔄 Resuming polling for persisted job:', persistedJob.jobId);
    currentJobIdRef.current = persistedJob.jobId;
    setIsPolling(true);

    // Immediately fetch status
    const status = await pollJobStatus(persistedJob.jobId);

    // If job is still running, set up polling
    if (status && status.status !== 'completed' && status.status !== 'error') {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
      // Set up interval polling
      pollingIntervalRef.current = setInterval(async () => {
        if (currentJobIdRef.current === persistedJob.jobId && isComponentMountedRef.current) {
          await pollJobStatus(persistedJob.jobId);
        }
      }, pollingInterval);
    }
  }, [userId, pollJobStatus, pollingInterval]);

  // On mount: resume any persisted job
  useEffect(() => {
    if (!hasResumedRef.current) {
      hasResumedRef.current = true;
      resumePollingIfNeeded();
    }
  }, [resumePollingIfNeeded]);

  // Immediately refetch when app becomes visible (user returns from background)
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        console.log('👁️ App became visible - resuming polling if needed');
        await resumePollingIfNeeded();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [resumePollingIfNeeded]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, []);

  return {
    startAsyncJob,
    jobStatus,
    isPolling,
    cancelJob,
    clearPersistedJob: () => clearPersistedJob(userId),
  };
};
