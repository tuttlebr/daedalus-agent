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
}

interface UseAsyncChatOptions {
  pollingInterval?: number;
  onProgress?: (status: AsyncJobStatus) => void;
  onComplete?: (response: string, intermediateSteps?: any[]) => void;
  onError?: (error: string) => void;
}

interface UseAsyncChatReturn {
  startAsyncJob: (messages: any[], chatCompletionURL: string, additionalProps: any, userId: string) => Promise<string>;
  jobStatus: AsyncJobStatus | null;
  isPolling: boolean;
  cancelJob: () => Promise<void>;
}

export const useAsyncChat = (options: UseAsyncChatOptions = {}): UseAsyncChatReturn => {
  const {
    pollingInterval = 2000, // Poll every 2 seconds
    onProgress,
    onComplete,
    onError,
  } = options;

  const [jobStatus, setJobStatus] = useState<AsyncJobStatus | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const currentJobIdRef = useRef<string | null>(null);

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

      // Check if job is complete
      if (status.status === 'completed') {
        setIsPolling(false);
        if (onComplete && status.fullResponse) {
          onComplete(status.fullResponse, status.intermediateSteps);
        }
        // Clear polling
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
      } else if (status.status === 'error') {
        setIsPolling(false);
        if (onError) {
          onError(status.error || 'Unknown error');
        }
        // Clear polling
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
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
  }, [onProgress, onComplete, onError]);

  // Start async job
  const startAsyncJob = useCallback(async (
    messages: any[],
    chatCompletionURL: string,
    additionalProps: any,
    userId: string
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
          userId,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to start async job: ${response.statusText}`);
      }

      const { jobId } = await response.json();
      currentJobIdRef.current = jobId;

      // Start polling
      setIsPolling(true);
      
      // Initial poll
      await pollJobStatus(jobId);

      // Set up interval polling
      pollingIntervalRef.current = setInterval(async () => {
        await pollJobStatus(jobId);
      }, pollingInterval);

      return jobId;
    } catch (error: any) {
      console.error('Error starting async job:', error);
      if (onError) {
        onError(error.message);
      }
      throw error;
    }
  }, [pollJobStatus, pollingInterval, onError]);

  // Cancel current job
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
    } catch (error) {
      console.error('Error canceling job:', error);
    }
  }, []);

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
  };
};
