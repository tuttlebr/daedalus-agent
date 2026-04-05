import { useState, useEffect, useCallback, useRef } from 'react';
import { Logger } from '@/utils/logger';
import { shouldRunExpensiveOperation } from '@/utils/app/visibilityAwareTimer';
import { getWebSocketManager } from '@/services/websocket';

const logger = new Logger('AsyncChat');

// Mobile detection for adaptive polling
const isMobile = (): boolean => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const userAgent = navigator.userAgent.toLowerCase();
  return /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent)
    || window.innerWidth <= 768;
};

// Safety-net polling interval for WebSocket jobs (catches silent WS disconnects)
const WS_FALLBACK_POLL_INTERVAL = 15000;

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
  onComplete?: (response: string, intermediateSteps?: any[], finalizedAt?: number, conversationId?: string) => void;
  onError?: (error: string, context?: { partialResponse?: string; intermediateSteps?: any[]; jobId?: string; conversationId?: string }) => void;
  userId?: string; // Add userId for localStorage key scoping
  useWebSocket?: boolean; // Use WebSocket push instead of polling (default: true)
}

interface UseAsyncChatReturn {
  startAsyncJob: (messages: any[], chatCompletionURL: string, additionalProps: any, userId: string, conversationId: string, conversationName: string) => Promise<string>;
  jobStatusByConversationId: Record<string, AsyncJobStatus>;
  isPolling: boolean;
  cancelJob: (conversationId?: string) => Promise<void>;
  clearPersistedJob: (conversationId?: string) => void;
}

// Helper functions for job persistence
const getStorageKey = (userId: string) => `asyncJobs_${userId}`;

const persistJobs = (jobs: PersistedJob[], userId: string) => {
  try {
    localStorage.setItem(getStorageKey(userId), JSON.stringify(jobs));
    logger.debug('Persisted async jobs', { jobCount: jobs.length });
  } catch (error) {
    logger.error('Failed to persist jobs', error);
  }
};

const getPersistedJobs = (userId: string): PersistedJob[] => {
  try {
    const stored = localStorage.getItem(getStorageKey(userId));
    if (!stored) return [];
    const jobs = JSON.parse(stored) as PersistedJob[];
    return Array.isArray(jobs) ? jobs : [];
  } catch (error) {
    logger.error('Failed to retrieve persisted jobs', error);
    return [];
  }
};

const clearPersistedJobs = (userId: string, conversationId?: string) => {
  try {
    if (!conversationId) {
      localStorage.removeItem(getStorageKey(userId));
      logger.debug('Cleared persisted jobs for user', userId);
      return;
    }
    const existing = getPersistedJobs(userId);
    const nextJobs = existing.filter((job) => job.conversationId !== conversationId);
    persistJobs(nextJobs, userId);
    logger.debug('Cleared persisted jobs for conversation', { userId, conversationId });
  } catch (error) {
    logger.error('Failed to clear persisted jobs', error);
  }
};

export const useAsyncChat = (options: UseAsyncChatOptions = {}): UseAsyncChatReturn => {
  const {
    // Adaptive polling: 3s on desktop, 5s on mobile (battery-conscious)
    pollingInterval = isMobile() ? 5000 : 3000,
    onProgress,
    onComplete,
    onError,
    userId = 'anon',
    useWebSocket: useWS = true,
  } = options;

  const [jobStatusByConversationId, setJobStatusByConversationId] = useState<Record<string, AsyncJobStatus>>({});
  const [isPolling, setIsPolling] = useState(false);
  const pollingTimersRef = useRef<Record<string, ReturnType<typeof setTimeout> | null>>({});
  const activeJobsRef = useRef<Record<string, PersistedJob>>({});
  const pollCountByJobRef = useRef<Record<string, number>>({});
  const pollErrorCountRef = useRef<Record<string, number>>({});
  const lastStatusHashByJobRef = useRef<Record<string, string>>({});
  const jobStatusByJobIdRef = useRef<Record<string, AsyncJobStatus>>({});
  const hasResumedRef = useRef(false); // Prevent double-resume
  const isComponentMountedRef = useRef(true);
  const isPageVisibleRef = useRef(true);
  const completedJobsRef = useRef<Set<string>>(new Set());
  const wsJobUnsubsRef = useRef<Record<string, () => void>>({}); // WebSocket handler cleanup by jobId
  const wsActiveJobsRef = useRef<Set<string>>(new Set()); // Jobs using WebSocket (not polling)
  const wsFallbackTimersRef = useRef<Record<string, ReturnType<typeof setInterval> | null>>({}); // WS safety-net polling

  const removeActiveJob = useCallback((jobId: string, conversationId?: string, clearStatus: boolean = true) => {
    const timer = pollingTimersRef.current[jobId];
    if (timer) {
      clearTimeout(timer);
      delete pollingTimersRef.current[jobId];
    }
    const fallbackTimer = wsFallbackTimersRef.current[jobId];
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      delete wsFallbackTimersRef.current[jobId];
    }
    delete activeJobsRef.current[jobId];
    delete pollCountByJobRef.current[jobId];
    delete pollErrorCountRef.current[jobId];
    delete lastStatusHashByJobRef.current[jobId];
    delete jobStatusByJobIdRef.current[jobId];
    completedJobsRef.current.delete(jobId);

    if (clearStatus && conversationId) {
      setJobStatusByConversationId((prev) => {
        if (!prev[conversationId]) {
          return prev;
        }
        const next = { ...prev };
        delete next[conversationId];
        return next;
      });
    }

    setIsPolling(Object.keys(activeJobsRef.current).length > 0);
  }, []);

  // Handle incoming job status from WebSocket push
  const handleWsJobStatus = useCallback((status: AsyncJobStatus) => {
    if (!isComponentMountedRef.current) return;

    const jobId = status.jobId;
    const conversationId = status.conversationId || activeJobsRef.current[jobId]?.conversationId;

    // Skip if already completed
    if (completedJobsRef.current.has(jobId)) return;

    // Update state
    jobStatusByJobIdRef.current[jobId] = status;
    if (conversationId) {
      setJobStatusByConversationId((prev) => ({
        ...prev,
        [conversationId]: status,
      }));
    }

    // Progress callback
    if (onProgress) {
      onProgress(status);
    }

    const completionGraceMs = 8000;
    const updatedAt = status.updatedAt || status.createdAt || Date.now();
    const shouldFinalizeFallback = status.status === 'completed'
      && !status.finalizedAt
      && Boolean(status.fullResponse)
      && Date.now() - updatedAt > completionGraceMs;

    if ((status.status === 'completed' && status.finalizedAt) || shouldFinalizeFallback) {
      completedJobsRef.current.add(jobId);
      if (onComplete && status.fullResponse) {
        onComplete(status.fullResponse, status.intermediateSteps, status.finalizedAt, conversationId);
      }
      // Clean up
      if (conversationId) {
        clearPersistedJobs(userId, conversationId);
      }
      // Unsubscribe from WebSocket job updates
      const wsManager = getWebSocketManager();
      wsManager.unsubscribeFromJob(jobId);
      wsActiveJobsRef.current.delete(jobId);
      if (wsJobUnsubsRef.current[jobId]) {
        wsJobUnsubsRef.current[jobId]();
        delete wsJobUnsubsRef.current[jobId];
      }
      removeActiveJob(jobId, conversationId);
      logger.info('Job completed via WebSocket push');
    } else if (status.status === 'error') {
      if (onError) {
        onError(status.error || 'Unknown error', {
          partialResponse: status.partialResponse,
          intermediateSteps: status.intermediateSteps,
          jobId,
          conversationId,
        });
      }
      if (conversationId) {
        clearPersistedJobs(userId, conversationId);
      }
      const wsManager = getWebSocketManager();
      wsManager.unsubscribeFromJob(jobId);
      wsActiveJobsRef.current.delete(jobId);
      if (wsJobUnsubsRef.current[jobId]) {
        wsJobUnsubsRef.current[jobId]();
        delete wsJobUnsubsRef.current[jobId];
      }
      removeActiveJob(jobId, conversationId);
      logger.info('Job errored via WebSocket push');
    }
    // For 'pending' and 'streaming', just let updates flow through
  }, [onProgress, onComplete, onError, userId, removeActiveJob]);

  // Subscribe a job to WebSocket push updates
  const subscribeJobToWs = useCallback((jobId: string): boolean => {
    if (!useWS) return false;

    const wsManager = getWebSocketManager();
    if (!wsManager.isConnected) {
      logger.debug('WebSocket not connected, falling back to polling');
      return false;
    }

    // Subscribe to job status via WebSocket
    wsManager.subscribeToJob(jobId);
    wsActiveJobsRef.current.add(jobId);

    // Register handler for job_status messages
    const unsub = wsManager.on('job_status', (data: AsyncJobStatus) => {
      if (data.jobId === jobId) {
        handleWsJobStatus(data);
      }
    });
    wsJobUnsubsRef.current[jobId] = unsub;

    logger.info(`Job ${jobId} subscribed to WebSocket push`);
    return true;
  }, [useWS, handleWsJobStatus]);

  // Start a safety-net HTTP poll alongside WebSocket to catch silent disconnects.
  // If WS delivers completion first, completedJobsRef prevents double-processing.
  const startWsFallbackPolling = useCallback((jobId: string) => {
    if (wsFallbackTimersRef.current[jobId]) {
      clearInterval(wsFallbackTimersRef.current[jobId]!);
    }
    const timer = setInterval(async () => {
      if (!activeJobsRef.current[jobId] || !isComponentMountedRef.current || completedJobsRef.current.has(jobId)) {
        clearInterval(timer);
        delete wsFallbackTimersRef.current[jobId];
        return;
      }
      try {
        const response = await fetch(`/api/chat/async?jobId=${jobId}`);
        if (response.ok) {
          const status: AsyncJobStatus = await response.json();
          handleWsJobStatus(status);
        } else if (response.status === 404) {
          const conversationId = activeJobsRef.current[jobId]?.conversationId;
          clearInterval(timer);
          delete wsFallbackTimersRef.current[jobId];
          removeActiveJob(jobId, conversationId);
        }
      } catch {
        // Network error — will retry on next interval
      }
    }, WS_FALLBACK_POLL_INTERVAL);
    wsFallbackTimersRef.current[jobId] = timer;
  }, [handleWsJobStatus, removeActiveJob]);

  // Calculate adaptive polling interval with exponential backoff
  // Starts fast, slows down over time to save battery
  const getAdaptiveInterval = useCallback((jobId: string, status?: AsyncJobStatus | null) => {
    const baseInterval = pollingInterval;
    const pollCount = pollCountByJobRef.current[jobId] ?? 0;

    // Exponential backoff: double interval every 10 polls, max 4x base
    const backoffMultiplier = Math.min(4, Math.pow(1.1, Math.floor(pollCount / 10)));

    // If on mobile and job is in 'pending' state, poll less frequently
    const mobileSlowdown = isMobile() && status?.status === 'pending' ? 2 : 1;
    const visibilitySlowdown = !isPageVisibleRef.current ? 4 : 1;

    return Math.floor(baseInterval * backoffMultiplier * mobileSlowdown * visibilitySlowdown);
  }, [pollingInterval]);

  // Schedule next poll with adaptive timing
  const scheduleNextPoll = useCallback((jobId: string, pollFn: (jobId: string) => Promise<AsyncJobStatus | null>) => {
    const existingTimer = pollingTimersRef.current[jobId];
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const interval = getAdaptiveInterval(jobId, jobStatusByJobIdRef.current[jobId]);
    pollingTimersRef.current[jobId] = setTimeout(async () => {
      // Skip poll if page is hidden (battery saving)
      if (!isPageVisibleRef.current) {
        // Reschedule for when visible
        scheduleNextPoll(jobId, pollFn);
        return;
      }

      // Check if we should skip expensive operations (low battery)
      const shouldPoll = await shouldRunExpensiveOperation();
      if (!shouldPoll) {
        // Still reschedule but with longer interval
        pollCountByJobRef.current[jobId] = (pollCountByJobRef.current[jobId] ?? 0) + 5;
        scheduleNextPoll(jobId, pollFn);
        return;
      }

      if (activeJobsRef.current[jobId] && isComponentMountedRef.current) {
        pollCountByJobRef.current[jobId] = (pollCountByJobRef.current[jobId] ?? 0) + 1;
        await pollFn(jobId);
      }
    }, interval);
  }, [getAdaptiveInterval]);

  // Poll for job status
  const pollJobStatus = useCallback(async (jobId: string) => {
    try {
      const response = await fetch(`/api/chat/async?jobId=${jobId}`);

      if (!response.ok) {
        if (response.status === 404) {
          logger.info('Job not found, stopping polling');
          const conversationId = activeJobsRef.current[jobId]?.conversationId;
          removeActiveJob(jobId, conversationId);
          return null;
        }
        throw new Error(`Failed to fetch job status: ${response.statusText}`);
      }

      const status: AsyncJobStatus = await response.json();
      const conversationId = status.conversationId || activeJobsRef.current[jobId]?.conversationId;

      // Capture previous status BEFORE updating refs (for backoff reset logic)
      const previousStatus = jobStatusByJobIdRef.current[jobId];

      const statusHash = [
        status.status,
        status.partialResponse?.length || 0,
        status.fullResponse?.length || 0,
        status.progress || 0,
        status.finalizedAt || 0,
      ].join('|');
      const lastHash = lastStatusHashByJobRef.current[jobId] || '';
      const isStatusChanged = statusHash !== lastHash;
      if (isStatusChanged) {
        jobStatusByJobIdRef.current[jobId] = status;
        lastStatusHashByJobRef.current[jobId] = statusHash;
        if (conversationId) {
          setJobStatusByConversationId((prev) => ({
            ...prev,
            [conversationId]: status,
          }));
        }
      }

      // Call progress callback
      if (onProgress && isStatusChanged) {
        onProgress(status);
      }

      // Reset backoff when actively receiving data:
      // 1. Status changes to streaming (active work)
      // 2. Partial response is growing (receiving chunks)
      // This prevents progressively slower polling during active streaming
      const isReceivingData = status.status === 'streaming' ||
        (status.partialResponse &&
         previousStatus?.partialResponse &&
         status.partialResponse.length > previousStatus.partialResponse.length);

      if (isReceivingData) {
        pollCountByJobRef.current[jobId] = 0;
      }
      // Reset consecutive poll error counter on any successful poll
      pollErrorCountRef.current[jobId] = 0;

      const completionGraceMs = 8000;
      const updatedAt = status.updatedAt || status.createdAt || Date.now();
      const shouldFinalizeFallback = status.status === 'completed'
        && !status.finalizedAt
        && Boolean(status.fullResponse)
        && Date.now() - updatedAt > completionGraceMs;

      // Check if job is complete AND finalized
      if ((status.status === 'completed' && status.finalizedAt) || shouldFinalizeFallback) {
        if (completedJobsRef.current.has(jobId)) {
          return status;
        }
        completedJobsRef.current.add(jobId);
        // Only consider job truly complete when finalizedAt is set
        pollCountByJobRef.current[jobId] = 0;
        if (onComplete && status.fullResponse) {
          onComplete(status.fullResponse, status.intermediateSteps, status.finalizedAt, conversationId);
        }
        // Clear polling and persisted job
        if (conversationId) {
          clearPersistedJobs(userId, conversationId);
        }
        removeActiveJob(jobId, conversationId);
        logger.info('Job completed and finalized - cleared persisted state');
      } else if (status.status === 'completed' && !status.finalizedAt) {
        // Job marked complete but still finalizing - keep polling
        logger.debug('Job completed but not finalized yet, continuing to poll');
        scheduleNextPoll(jobId, pollJobStatus);
      } else if (status.status === 'error') {
        pollCountByJobRef.current[jobId] = 0;
        if (onError) {
          onError(status.error || 'Unknown error', {
            partialResponse: status.partialResponse,
            intermediateSteps: status.intermediateSteps,
            jobId,
            conversationId,
          });
        }
        // Clear polling and persisted job
        if (conversationId) {
          clearPersistedJobs(userId, conversationId);
        }
        removeActiveJob(jobId, conversationId);
        logger.info('Job errored - cleared persisted state');
      } else {
        // Job still in progress, schedule next poll
        scheduleNextPoll(jobId, pollJobStatus);
      }

      return status;
    } catch (error: unknown) {
      logger.error('Error polling job status', error);
      const conversationId = activeJobsRef.current[jobId]?.conversationId;

      // Track consecutive poll failures - only fire onError after multiple failures
      if (!pollErrorCountRef.current[jobId]) {
        pollErrorCountRef.current[jobId] = 0;
      }
      pollErrorCountRef.current[jobId]++;

      if (pollErrorCountRef.current[jobId] < 4) {
        // Transient failure: log and retry with backoff
        logger.warn(`Poll failure ${pollErrorCountRef.current[jobId]}/4 for job ${jobId}, retrying with backoff`);
        scheduleNextPoll(jobId, pollJobStatus);
        return null;
      }

      // 4+ consecutive failures: give up with whatever partial data we have
      logger.error(`Poll failure ${pollErrorCountRef.current[jobId]} for job ${jobId}, giving up`);
      pollErrorCountRef.current[jobId] = 0;
      pollCountByJobRef.current[jobId] = 0;
      const lastKnownStatus = jobStatusByConversationId[conversationId || ''];
      if (onError) {
        onError(error instanceof Error ? error.message : 'Unknown error', {
          partialResponse: lastKnownStatus?.partialResponse,
          intermediateSteps: lastKnownStatus?.intermediateSteps,
          jobId,
          conversationId,
        });
      }
      removeActiveJob(jobId, conversationId, false);
      return null;
    }
  }, [onProgress, onComplete, onError, userId, scheduleNextPoll, removeActiveJob]);

  const cancelJob = useCallback(async (conversationId?: string) => {
    const jobsToCancel = conversationId
      ? Object.values(activeJobsRef.current).filter((job) => job.conversationId === conversationId)
      : Object.values(activeJobsRef.current);

    if (jobsToCancel.length === 0) {
      return;
    }

    try {
      await Promise.all(jobsToCancel.map(async (job) => {
        // Delete job on server
        await fetch(`/api/chat/async?jobId=${job.jobId}`, {
          method: 'DELETE',
        });
        // Clean up WebSocket subscription if active
        if (wsActiveJobsRef.current.has(job.jobId)) {
          const wsManager = getWebSocketManager();
          wsManager.unsubscribeFromJob(job.jobId);
          wsActiveJobsRef.current.delete(job.jobId);
          if (wsJobUnsubsRef.current[job.jobId]) {
            wsJobUnsubsRef.current[job.jobId]();
            delete wsJobUnsubsRef.current[job.jobId];
          }
        }
        clearPersistedJobs(userId, job.conversationId);
        removeActiveJob(job.jobId, job.conversationId);
      }));
    } catch (error) {
      logger.error('Error canceling job', error);
    }
  }, [userId, removeActiveJob]);

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
      // Cancel any existing job for this conversation
      const existingJobs = Object.values(activeJobsRef.current)
        .filter((job) => job.conversationId === conversationId);
      if (existingJobs.length > 0) {
        await cancelJob(conversationId);
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
        const body = await response.json().catch(() => ({}));
        const reason = body?.reason ?? '';
        throw new Error(`Failed to start async job: ${response.statusText}${reason ? ` (${reason})` : ''}`);
      }

      const { jobId } = await response.json();
      const job: PersistedJob = {
        jobId,
        conversationId,
        userId: jobUserId,
        timestamp: Date.now(),
      };
      activeJobsRef.current[jobId] = job;

      // Persist job metadata for resume after backgrounding
      const persistedJobs = getPersistedJobs(userId);
      const nextPersistedJobs = [
        ...persistedJobs.filter((existing) => existing.conversationId !== conversationId),
        job,
      ];
      persistJobs(nextPersistedJobs, userId);

      // Try WebSocket push first, fall back to polling
      const usingWs = subscribeJobToWs(jobId);

      if (!usingWs) {
        // Fallback: use HTTP polling
        setIsPolling(true);
        pollCountByJobRef.current[jobId] = 0;
        await pollJobStatus(jobId);
      } else {
        // With WebSocket, do one initial poll to get immediate status
        setIsPolling(true);
        try {
          const initialResponse = await fetch(`/api/chat/async?jobId=${jobId}`);
          if (initialResponse.ok) {
            const initialStatus: AsyncJobStatus = await initialResponse.json();
            handleWsJobStatus(initialStatus);
          }
        } catch {
          // Initial status fetch failed, WebSocket will deliver updates
        }
        // Start safety-net polling alongside WebSocket
        if (!completedJobsRef.current.has(jobId)) {
          startWsFallbackPolling(jobId);
        }
      }

      return jobId;
    } catch (error: any) {
      logger.error('Error starting async job', error);
      if (onError) {
        onError(error.message);
      }
      throw error;
    }
  }, [pollJobStatus, onError, userId, cancelJob, subscribeJobToWs, handleWsJobStatus, startWsFallbackPolling]);

  // Track page visibility for battery-efficient polling
  useEffect(() => {
    const handleVisibilityChange = () => {
      isPageVisibleRef.current = document.visibilityState === 'visible';
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      isComponentMountedRef.current = false;
      Object.values(pollingTimersRef.current).forEach((timer) => {
        if (timer) {
          clearTimeout(timer);
        }
      });
      pollingTimersRef.current = {};
      Object.values(wsFallbackTimersRef.current).forEach((timer) => {
        if (timer) {
          clearInterval(timer);
        }
      });
      wsFallbackTimersRef.current = {};

      // Clean up WebSocket job subscriptions
      const wsManager = getWebSocketManager();
      for (const jobId of wsActiveJobsRef.current) {
        wsManager.unsubscribeFromJob(jobId);
      }
      wsActiveJobsRef.current.clear();
      Object.values(wsJobUnsubsRef.current).forEach((unsub) => unsub());
      wsJobUnsubsRef.current = {};
    };
  }, []);

  // Resume polling (or WebSocket subscription) for persisted job
  const resumePollingIfNeeded = useCallback(async () => {
    const persistedJobs = getPersistedJobs(userId);

    if (persistedJobs.length === 0) {
      return; // No persisted jobs to resume
    }

    const jobsToResume = persistedJobs.filter((job) => !activeJobsRef.current[job.jobId]);
    if (jobsToResume.length === 0) {
      return;
    }

    setIsPolling(true);

    for (const job of jobsToResume) {
      logger.info('Resuming job tracking', job.jobId);
      activeJobsRef.current[job.jobId] = job;

      // Try WebSocket first, fall back to polling
      const usingWs = subscribeJobToWs(job.jobId);
      if (!usingWs) {
        pollCountByJobRef.current[job.jobId] = 0; // Reset backoff on resume
        await pollJobStatus(job.jobId);
      } else {
        // Do one poll to get current status immediately
        try {
          const response = await fetch(`/api/chat/async?jobId=${job.jobId}`);
          if (response.ok) {
            const status: AsyncJobStatus = await response.json();
            handleWsJobStatus(status);
          }
        } catch {
          // WebSocket will deliver updates
        }
        // Start safety-net polling alongside WebSocket
        if (!completedJobsRef.current.has(job.jobId)) {
          startWsFallbackPolling(job.jobId);
        }
      }
    }
  }, [userId, pollJobStatus, subscribeJobToWs, handleWsJobStatus, startWsFallbackPolling]);

  // On mount: resume any persisted job
  useEffect(() => {
    if (!hasResumedRef.current) {
      hasResumedRef.current = true;
      resumePollingIfNeeded();
    }
  }, [resumePollingIfNeeded]);

  // Verify job completion with retry logic
  const verifyJobCompletion = useCallback(async (jobId: string, conversationId: string, retries = 3): Promise<boolean> => {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(`/api/chat/async?jobId=${jobId}`);
        if (response.ok) {
          const status: AsyncJobStatus = await response.json();
          if (status.status === 'completed' && status.finalizedAt) {
            logger.info(`Job ${jobId} verified as complete on attempt ${i + 1}`);
            return true;
          }
        } else if (response.status === 404) {
          // Job no longer exists, sync conversation directly
          logger.warn(`Job ${jobId} not found, syncing conversation directly`);
          try {
            const convResponse = await fetch(`/api/conversations/${conversationId}`);
            if (convResponse.ok) {
              const convData = await convResponse.json();
              if (convData.messages?.length > 0) {
                logger.info(`Retrieved conversation ${conversationId} directly`);
                return true;
              }
            }
          } catch (e) {
            logger.error('Failed to sync conversation directly', e);
          }
          return false;
        }
        // Wait before retry with exponential backoff
        if (i < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
        }
      } catch (error) {
        logger.error(`Verification attempt ${i + 1} failed`, error);
        if (i < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
        }
      }
    }
    return false;
  }, []);

  // Check for orphaned jobs (jobs older than 10 minutes that may have been missed)
  const checkOrphanedJobs = useCallback(async () => {
    const persistedJobs = getPersistedJobs(userId);
    const now = Date.now();
    const orphanThreshold = 10 * 60 * 1000; // 10 minutes

    for (const job of persistedJobs) {
      if (now - job.timestamp > orphanThreshold) {
        logger.warn(`Found potential orphaned job: ${job.jobId}`);

        // Try to get the full job status so we can fire onComplete with the response
        try {
          const statusResponse = await fetch(`/api/chat/async?jobId=${job.jobId}`);
          if (statusResponse.ok) {
            const status: AsyncJobStatus = await statusResponse.json();
            if (status.status === 'completed' && status.fullResponse) {
              completedJobsRef.current.add(job.jobId);
              if (onComplete) {
                onComplete(status.fullResponse, status.intermediateSteps, status.finalizedAt, job.conversationId);
              }
              clearPersistedJobs(userId, job.conversationId);
              removeActiveJob(job.jobId, job.conversationId);
              logger.info(`Recovered orphaned job ${job.jobId} - fired onComplete with response`);
              continue;
            }
          }
        } catch (e) {
          logger.error(`Failed to fetch status for orphaned job ${job.jobId}`, e);
        }

        // Fallback: fetch conversation directly from Redis and fire onComplete
        try {
          const response = await fetch(`/api/conversations/${job.conversationId}`);
          if (response.ok) {
            const convData = await response.json();
            if (convData.messages?.length > 0) {
              const lastAssistantMsg = [...convData.messages].reverse().find((m: any) => m.role === 'assistant');
              if (lastAssistantMsg && onComplete) {
                completedJobsRef.current.add(job.jobId);
                onComplete(lastAssistantMsg.content, lastAssistantMsg.intermediateSteps, Date.now(), job.conversationId);
                logger.info(`Recovered orphaned job ${job.jobId} via conversation data`);
              }
              clearPersistedJobs(userId, job.conversationId);
              removeActiveJob(job.jobId, job.conversationId);
            }
          }
        } catch (e) {
          logger.error(`Failed to check conversation for orphaned job ${job.jobId}`, e);
        }
      }
    }
  }, [userId, onComplete, removeActiveJob]);

  // Immediately refetch when app becomes visible (user returns from background)
  useEffect(() => {
    const handleVisibilityResume = async () => {
      if (document.visibilityState === 'visible') {
        logger.info('App became visible - resuming polling if needed');
        // Reset backoff when returning to foreground
        Object.keys(pollCountByJobRef.current).forEach((jobId) => {
          pollCountByJobRef.current[jobId] = 0;
        });
        await resumePollingIfNeeded();

        // Check for orphaned jobs that may have completed while away
        await checkOrphanedJobs();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityResume);
    return () => document.removeEventListener('visibilitychange', handleVisibilityResume);
  }, [resumePollingIfNeeded, checkOrphanedJobs]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      Object.values(pollingTimersRef.current).forEach((timer) => {
        if (timer) {
          clearTimeout(timer);
        }
      });
      pollingTimersRef.current = {};
      Object.values(wsFallbackTimersRef.current).forEach((timer) => {
        if (timer) {
          clearInterval(timer);
        }
      });
      wsFallbackTimersRef.current = {};
    };
  }, []);

  return {
    startAsyncJob,
    jobStatusByConversationId,
    isPolling,
    cancelJob,
    clearPersistedJob: (conversationId?: string) => clearPersistedJobs(userId, conversationId),
  };
};
