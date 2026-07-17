import { useState, useEffect, useCallback, useRef } from 'react';

import { getWebSocketManager } from '@/services/websocket';

import { shouldRunExpensiveOperation } from '@/utils/app/visibilityAwareTimer';
import { fetchWithTimeout, FetchTimeoutError } from '@/utils/fetchWithTimeout';
import { Logger } from '@/utils/logger';

const logger = new Logger('AsyncChat');

const isMobile = (): boolean => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined')
    return false;
  const userAgent = navigator.userAgent.toLowerCase();
  return (
    /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
      userAgent,
    ) || window.innerWidth <= 768
  );
};

const WS_FALLBACK_POLL_INTERVAL = Math.max(
  1000,
  Number(process.env.NEXT_PUBLIC_WS_FALLBACK_POLL_INTERVAL_MS) || 15000,
);
const SUBMIT_JOB_TIMEOUT_MS = 60_000;
const STATUS_FETCH_TIMEOUT_MS = 15_000;

interface DocumentIngestProgress {
  completed: number;
  total: number;
  currentDoc?: string;
  currentIndex?: number;
  percent: number;
  phase?: string;
  message?: string;
  chunks?: number;
  pages?: number;
  failures?: number;
  attempt?: number;
}

interface OAuthRequest {
  id: string;
  authUrl: string;
  oauthState?: string;
  service?: string;
}

interface AsyncJobStatus {
  jobId: string;
  status: 'pending' | 'streaming' | 'oauth_required' | 'completed' | 'error';
  partialResponse?: string;
  fullResponse?: string;
  intermediateSteps?: any[];
  error?: string;
  authUrl?: string;
  oauthState?: string;
  oauthRequests?: OAuthRequest[];
  progress?: number;
  ingestProgress?: DocumentIngestProgress;
  createdAt: number;
  updatedAt: number;
  conversationId?: string;
  finalizedAt?: number; // Timestamp when all backend operations are complete
  turnId?: string;
  assistantMessageId?: string;
}

interface ChatTokenEvent {
  conversationId: string;
  jobId: string;
  turnId?: string;
  assistantMessageId?: string;
  content: string;
  intermediateSteps?: any[];
}

interface ChatIntermediateStepEvent {
  conversationId: string;
  jobId: string;
  turnId?: string;
  assistantMessageId?: string;
  step: any;
}

interface ChatCompleteEvent {
  conversationId: string;
  jobId: string;
  turnId?: string;
  assistantMessageId?: string;
  fullResponse: string;
  intermediateSteps?: any[];
  error?: string;
}

interface PersistedJob {
  jobId: string;
  conversationId: string;
  userId: string;
  timestamp: number;
  turnId?: string;
  assistantMessageId?: string;
}

/**
 * Find only the assistant response owned by a persisted job.
 *
 * New conversation messages always carry metadata.jobId. The turn-only branch
 * is limited to legacy messages that have no job ID, so an answer from another
 * concurrent or later job can never be attached to this recovery.
 */
export function findCorrelatedAssistantMessage(
  messages: unknown,
  job: Pick<PersistedJob, 'jobId' | 'turnId'>,
): any | null {
  if (!Array.isArray(messages)) return null;
  const assistants = [...messages]
    .reverse()
    .filter((message: any) => message?.role === 'assistant');

  const exact = assistants.find(
    (message: any) => message?.metadata?.jobId === job.jobId,
  );
  if (exact) return exact;

  if (!job.turnId) return null;
  return (
    assistants.find(
      (message: any) =>
        !message?.metadata?.jobId && message?.metadata?.turnId === job.turnId,
    ) || null
  );
}

interface CompletionMeta {
  turnId?: string;
  assistantMessageId?: string;
  jobId?: string;
}

interface UseAsyncChatOptions {
  pollingInterval?: number;
  onProgress?: (status: AsyncJobStatus) => void;
  onToken?: (event: ChatTokenEvent) => void;
  onIntermediateStep?: (event: ChatIntermediateStepEvent) => void;
  onComplete?: (
    response: string,
    intermediateSteps?: any[],
    finalizedAt?: number,
    conversationId?: string,
    meta?: CompletionMeta,
  ) => void;
  onError?: (
    error: string,
    context?: {
      partialResponse?: string;
      intermediateSteps?: any[];
      jobId?: string;
      conversationId?: string;
      turnId?: string;
      assistantMessageId?: string;
    },
  ) => void;
  userId?: string; // Add userId for localStorage key scoping
  useWebSocket?: boolean; // Use WebSocket push instead of polling (default: true)
}

interface UseAsyncChatReturn {
  startAsyncJob: (
    messages: any[],
    additionalProps: any,
    userId: string,
    conversationId: string,
    conversationName: string,
    turnId?: string,
    assistantMessageId?: string,
  ) => Promise<string>;
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
    const nextJobs = existing.filter(
      (job) => job.conversationId !== conversationId,
    );
    persistJobs(nextJobs, userId);
    logger.debug('Cleared persisted jobs for conversation', {
      userId,
      conversationId,
    });
  } catch (error) {
    logger.error('Failed to clear persisted jobs', error);
  }
};

function appendStreamDelta(currentText: string, delta: string): string {
  if (!delta) return currentText;
  if (!currentText) return delta;

  const maxOverlap = Math.min(currentText.length, delta.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (currentText.endsWith(delta.slice(0, overlap))) {
      return `${currentText}${delta.slice(overlap)}`;
    }
  }

  return `${currentText}${delta}`;
}

export const useAsyncChat = (
  options: UseAsyncChatOptions = {},
): UseAsyncChatReturn => {
  const {
    // Adaptive polling: 3s on desktop, 5s on mobile (battery-conscious)
    pollingInterval = isMobile() ? 5000 : 3000,
    onProgress,
    onToken,
    onIntermediateStep,
    onComplete,
    onError,
    userId = 'anon',
    useWebSocket: useWS = true,
  } = options;

  const [jobStatusByConversationId, setJobStatusByConversationId] = useState<
    Record<string, AsyncJobStatus>
  >({});
  const [isPolling, setIsPolling] = useState(false);
  const pollingTimersRef = useRef<
    Record<string, ReturnType<typeof setTimeout> | null>
  >({});
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
  const wsFallbackTimersRef = useRef<
    Record<string, ReturnType<typeof setInterval> | null>
  >({}); // WS safety-net polling
  const lastWsEventByJobRef = useRef<Record<string, number>>({}); // Last WS message timestamp per job

  const removeActiveJob = useCallback(
    (jobId: string, conversationId?: string, clearStatus: boolean = true) => {
      const trackedConversationId =
        conversationId || activeJobsRef.current[jobId]?.conversationId;

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

      if (wsActiveJobsRef.current.has(jobId)) {
        const wsManager = getWebSocketManager();
        wsManager.unsubscribeFromJob(jobId);
        if (trackedConversationId) {
          wsManager.unsubscribeFromChat(trackedConversationId);
        }
        wsActiveJobsRef.current.delete(jobId);
      }

      if (wsJobUnsubsRef.current[jobId]) {
        wsJobUnsubsRef.current[jobId]();
        delete wsJobUnsubsRef.current[jobId];
      }

      delete activeJobsRef.current[jobId];
      delete pollCountByJobRef.current[jobId];
      delete pollErrorCountRef.current[jobId];
      delete lastStatusHashByJobRef.current[jobId];
      delete jobStatusByJobIdRef.current[jobId];
      delete lastWsEventByJobRef.current[jobId];
      completedJobsRef.current.delete(jobId);

      if (clearStatus && trackedConversationId) {
        setJobStatusByConversationId((prev) => {
          if (!prev[trackedConversationId]) {
            return prev;
          }
          const next = { ...prev };
          delete next[trackedConversationId];
          return next;
        });
      }

      setIsPolling(Object.keys(activeJobsRef.current).length > 0);
    },
    [],
  );

  const getActiveConversationId = useCallback(
    (jobId: string, conversationId?: string): string | undefined => {
      return conversationId || activeJobsRef.current[jobId]?.conversationId;
    },
    [],
  );

  const updateLiveStatus = useCallback(
    (
      jobId: string,
      conversationId: string | undefined,
      updates: Partial<AsyncJobStatus>,
      publishState: boolean = true,
    ): AsyncJobStatus => {
      const now = Date.now();
      const existing = jobStatusByJobIdRef.current[jobId];
      const baseStatus: AsyncJobStatus =
        existing ||
        ({
          jobId,
          status: 'streaming',
          createdAt: now,
          updatedAt: now,
          ...(conversationId ? { conversationId } : {}),
        } as AsyncJobStatus);
      const nextStatus: AsyncJobStatus = {
        ...baseStatus,
        ...updates,
        jobId,
        status: updates.status ?? baseStatus.status,
        createdAt: updates.createdAt ?? baseStatus.createdAt,
        conversationId:
          conversationId || updates.conversationId || baseStatus.conversationId,
        updatedAt: now,
      };

      jobStatusByJobIdRef.current[jobId] = nextStatus;
      if (publishState && nextStatus.conversationId) {
        setJobStatusByConversationId((prev) => ({
          ...prev,
          [nextStatus.conversationId!]: nextStatus,
        }));
      }

      return nextStatus;
    },
    [],
  );

  const handleWsChatToken = useCallback(
    (event: ChatTokenEvent) => {
      if (!isComponentMountedRef.current) return;
      if (!event?.jobId || completedJobsRef.current.has(event.jobId)) return;
      if (!activeJobsRef.current[event.jobId]) return;

      const conversationId = getActiveConversationId(
        event.jobId,
        event.conversationId,
      );
      lastWsEventByJobRef.current[event.jobId] = Date.now();

      const current = jobStatusByJobIdRef.current[event.jobId];
      const partialResponse = appendStreamDelta(
        current?.partialResponse || '',
        event.content || '',
      );
      updateLiveStatus(
        event.jobId,
        conversationId,
        {
          status: 'streaming',
          partialResponse,
          ...(event.intermediateSteps
            ? { intermediateSteps: event.intermediateSteps }
            : {}),
          turnId: event.turnId || current?.turnId,
          assistantMessageId:
            event.assistantMessageId || current?.assistantMessageId,
        },
        false,
      );

      onToken?.(event);
    },
    [getActiveConversationId, onToken, updateLiveStatus],
  );

  const handleWsChatIntermediateStep = useCallback(
    (event: ChatIntermediateStepEvent) => {
      if (!isComponentMountedRef.current) return;
      if (!event?.jobId || completedJobsRef.current.has(event.jobId)) return;
      if (!activeJobsRef.current[event.jobId]) return;

      const conversationId = getActiveConversationId(
        event.jobId,
        event.conversationId,
      );
      lastWsEventByJobRef.current[event.jobId] = Date.now();

      const current = jobStatusByJobIdRef.current[event.jobId];
      const nextSteps = event.step
        ? [...(current?.intermediateSteps || []), event.step]
        : current?.intermediateSteps || [];
      const status = updateLiveStatus(event.jobId, conversationId, {
        status: 'streaming',
        intermediateSteps: nextSteps,
        turnId: event.turnId || current?.turnId,
        assistantMessageId:
          event.assistantMessageId || current?.assistantMessageId,
      });

      onIntermediateStep?.(event);
      onProgress?.(status);
    },
    [getActiveConversationId, onIntermediateStep, onProgress, updateLiveStatus],
  );

  const handleWsChatComplete = useCallback(
    (event: ChatCompleteEvent) => {
      if (!isComponentMountedRef.current) return;
      if (!event?.jobId || completedJobsRef.current.has(event.jobId)) return;
      if (!activeJobsRef.current[event.jobId]) return;

      const conversationId = getActiveConversationId(
        event.jobId,
        event.conversationId,
      );
      lastWsEventByJobRef.current[event.jobId] = Date.now();
      completedJobsRef.current.add(event.jobId);

      if (event.error) {
        onError?.(event.error, {
          partialResponse: event.fullResponse,
          intermediateSteps: event.intermediateSteps,
          jobId: event.jobId,
          conversationId,
          turnId: event.turnId,
          assistantMessageId: event.assistantMessageId,
        });
      } else {
        onComplete?.(
          event.fullResponse,
          event.intermediateSteps,
          Date.now(),
          conversationId,
          {
            turnId: event.turnId,
            assistantMessageId: event.assistantMessageId,
            jobId: event.jobId,
          },
        );
      }

      if (conversationId) {
        clearPersistedJobs(userId, conversationId);
      }
      removeActiveJob(event.jobId, conversationId);
      logger.info('Job completed via chat token stream');
    },
    [getActiveConversationId, onComplete, onError, removeActiveJob, userId],
  );

  // Handle incoming job status from WebSocket push
  const handleWsJobStatus = useCallback(
    (status: AsyncJobStatus) => {
      if (!isComponentMountedRef.current) return;

      const jobId = status.jobId;
      const conversationId =
        status.conversationId || activeJobsRef.current[jobId]?.conversationId;

      lastWsEventByJobRef.current[jobId] = Date.now();

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

      const completionGraceMs = 8000;
      const updatedAt = status.updatedAt || status.createdAt || Date.now();
      const shouldFinalizeFallback =
        status.status === 'completed' &&
        !status.finalizedAt &&
        Boolean(status.fullResponse) &&
        Date.now() - updatedAt > completionGraceMs;
      const isUiTerminalStatus =
        status.status === 'error' ||
        (status.status === 'completed' &&
          (Boolean(status.finalizedAt) || shouldFinalizeFallback));

      // Progress callback, including UI-terminal states so cleanup safety nets
      // run even when completion/error handlers do not render content.
      if (
        onProgress &&
        (status.status === 'pending' ||
          status.status === 'streaming' ||
          status.status === 'oauth_required' ||
          isUiTerminalStatus)
      ) {
        onProgress(status);
      }

      if (
        (status.status === 'completed' && status.finalizedAt) ||
        shouldFinalizeFallback
      ) {
        completedJobsRef.current.add(jobId);
        if (onComplete && status.fullResponse) {
          onComplete(
            status.fullResponse,
            status.intermediateSteps,
            status.finalizedAt,
            conversationId,
            {
              turnId: status.turnId,
              assistantMessageId: status.assistantMessageId,
              jobId,
            },
          );
        }
        // Clean up
        if (conversationId) {
          clearPersistedJobs(userId, conversationId);
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
            turnId: status.turnId,
            assistantMessageId: status.assistantMessageId,
          });
        }
        if (conversationId) {
          clearPersistedJobs(userId, conversationId);
        }
        removeActiveJob(jobId, conversationId);
        logger.info('Job errored via WebSocket push');
      }
      // For 'pending' and 'streaming', just let updates flow through
    },
    [onProgress, onComplete, onError, userId, removeActiveJob],
  );

  // Subscribe a job to WebSocket push updates
  const subscribeJobToWs = useCallback(
    (jobId: string, conversationId?: string): boolean => {
      if (!useWS) return false;

      const wsManager = getWebSocketManager();
      if (!wsManager.isConnected) {
        logger.debug('WebSocket not connected, falling back to polling');
        return false;
      }

      // Subscribe to job status via WebSocket
      wsManager.subscribeToJob(jobId);
      if (conversationId) {
        wsManager.subscribeToChat(conversationId);
      }
      wsActiveJobsRef.current.add(jobId);

      const unsubs: Array<() => void> = [];

      unsubs.push(
        wsManager.on('job_status', (data: AsyncJobStatus) => {
          if (data.jobId === jobId) {
            handleWsJobStatus(data);
          }
        }),
      );

      unsubs.push(
        wsManager.on('chat_token', (data: ChatTokenEvent) => {
          if (data.jobId === jobId) {
            handleWsChatToken(data);
          }
        }),
      );

      unsubs.push(
        wsManager.on(
          'chat_intermediate_step',
          (data: ChatIntermediateStepEvent) => {
            if (data.jobId === jobId) {
              handleWsChatIntermediateStep(data);
            }
          },
        ),
      );

      unsubs.push(
        wsManager.on('chat_complete', (data: ChatCompleteEvent) => {
          if (data.jobId === jobId) {
            handleWsChatComplete(data);
          }
        }),
      );

      wsJobUnsubsRef.current[jobId] = () => {
        unsubs.forEach((unsub) => unsub());
      };

      logger.info(`Job ${jobId} subscribed to WebSocket push`);
      return true;
    },
    [
      useWS,
      handleWsJobStatus,
      handleWsChatToken,
      handleWsChatIntermediateStep,
      handleWsChatComplete,
    ],
  );

  // Start a safety-net HTTP poll alongside WebSocket to catch silent disconnects.
  // Skips the poll when WS has recently delivered an event for the job.
  const startWsFallbackPolling = useCallback(
    (jobId: string) => {
      if (wsFallbackTimersRef.current[jobId]) {
        clearInterval(wsFallbackTimersRef.current[jobId]!);
      }
      lastWsEventByJobRef.current[jobId] = Date.now();
      const timer = setInterval(async () => {
        if (
          !activeJobsRef.current[jobId] ||
          !isComponentMountedRef.current ||
          completedJobsRef.current.has(jobId)
        ) {
          clearInterval(timer);
          delete wsFallbackTimersRef.current[jobId];
          delete lastWsEventByJobRef.current[jobId];
          return;
        }
        const wsManager = getWebSocketManager();
        const lastEvent = lastWsEventByJobRef.current[jobId] ?? 0;
        const wsIsHealthy =
          wsManager.isConnected &&
          wsActiveJobsRef.current.has(jobId) &&
          Date.now() - lastEvent < WS_FALLBACK_POLL_INTERVAL * 2;
        if (wsIsHealthy) {
          return;
        }
        try {
          const response = await fetchWithTimeout(
            `/api/chat/async?jobId=${jobId}`,
            { credentials: 'include' },
            STATUS_FETCH_TIMEOUT_MS,
          );
          if (response.ok) {
            const status: AsyncJobStatus = await response.json();
            handleWsJobStatus(status);
          } else if (response.status === 404) {
            const conversationId = activeJobsRef.current[jobId]?.conversationId;
            clearInterval(timer);
            delete wsFallbackTimersRef.current[jobId];
            delete lastWsEventByJobRef.current[jobId];
            removeActiveJob(jobId, conversationId);
          }
        } catch {
          // Network/timeout error — will retry on next interval
        }
      }, WS_FALLBACK_POLL_INTERVAL);
      wsFallbackTimersRef.current[jobId] = timer;
    },
    [handleWsJobStatus, removeActiveJob],
  );

  // Calculate adaptive polling interval with exponential backoff
  // Starts fast, slows down over time to save battery
  const getAdaptiveInterval = useCallback(
    (jobId: string, status?: AsyncJobStatus | null) => {
      const baseInterval = pollingInterval;
      const pollCount = pollCountByJobRef.current[jobId] ?? 0;

      // Exponential backoff: double interval every 10 polls, max 4x base
      const backoffMultiplier = Math.min(
        4,
        Math.pow(1.1, Math.floor(pollCount / 10)),
      );

      // If on mobile and job is in 'pending' state, poll less frequently
      const mobileSlowdown = isMobile() && status?.status === 'pending' ? 2 : 1;
      const visibilitySlowdown = !isPageVisibleRef.current ? 4 : 1;

      return Math.floor(
        baseInterval * backoffMultiplier * mobileSlowdown * visibilitySlowdown,
      );
    },
    [pollingInterval],
  );

  // Schedule next poll with adaptive timing
  const scheduleNextPoll = useCallback(
    (
      jobId: string,
      pollFn: (jobId: string) => Promise<AsyncJobStatus | null>,
    ) => {
      const existingTimer = pollingTimersRef.current[jobId];
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const interval = getAdaptiveInterval(
        jobId,
        jobStatusByJobIdRef.current[jobId],
      );
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
          pollCountByJobRef.current[jobId] =
            (pollCountByJobRef.current[jobId] ?? 0) + 5;
          scheduleNextPoll(jobId, pollFn);
          return;
        }

        if (activeJobsRef.current[jobId] && isComponentMountedRef.current) {
          pollCountByJobRef.current[jobId] =
            (pollCountByJobRef.current[jobId] ?? 0) + 1;
          await pollFn(jobId);
        }
      }, interval);
    },
    [getAdaptiveInterval],
  );

  // Poll for job status
  const pollJobStatus = useCallback(
    async (jobId: string) => {
      try {
        const response = await fetchWithTimeout(
          `/api/chat/async?jobId=${jobId}`,
          { credentials: 'include' },
          STATUS_FETCH_TIMEOUT_MS,
        );

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
        const conversationId =
          status.conversationId || activeJobsRef.current[jobId]?.conversationId;

        // Capture previous status BEFORE updating refs (for backoff reset logic)
        const previousStatus = jobStatusByJobIdRef.current[jobId];

        const statusHash = [
          status.status,
          status.partialResponse?.length || 0,
          status.fullResponse?.length || 0,
          status.progress || 0,
          status.ingestProgress
            ? [
                status.ingestProgress.completed,
                status.ingestProgress.total,
                status.ingestProgress.currentDoc || '',
                status.ingestProgress.currentIndex || '',
                status.ingestProgress.phase || '',
                status.ingestProgress.message || '',
                status.ingestProgress.chunks || '',
                status.ingestProgress.pages || '',
                status.ingestProgress.failures || '',
                status.ingestProgress.attempt || '',
              ].join('/')
            : '',
          status.finalizedAt || 0,
          status.authUrl || '',
          status.oauthState || '',
          JSON.stringify(status.oauthRequests || []),
          status.turnId || '',
          status.assistantMessageId || '',
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

        // Reset backoff when actively receiving data:
        // 1. Status changes to streaming (active work)
        // 2. Partial response is growing (receiving chunks)
        // This prevents progressively slower polling during active streaming
        const isReceivingData =
          status.status === 'streaming' ||
          status.status === 'oauth_required' ||
          (status.partialResponse &&
            previousStatus?.partialResponse &&
            status.partialResponse.length >
              previousStatus.partialResponse.length);

        if (isReceivingData) {
          pollCountByJobRef.current[jobId] = 0;
        }
        // Reset consecutive poll error counter on any successful poll
        pollErrorCountRef.current[jobId] = 0;

        const completionGraceMs = 8000;
        const updatedAt = status.updatedAt || status.createdAt || Date.now();
        const shouldFinalizeFallback =
          status.status === 'completed' &&
          !status.finalizedAt &&
          Boolean(status.fullResponse) &&
          Date.now() - updatedAt > completionGraceMs;
        const isUiTerminalStatus =
          status.status === 'error' ||
          (status.status === 'completed' &&
            (Boolean(status.finalizedAt) || shouldFinalizeFallback));

        // Call progress callback, including UI-terminal states so cleanup
        // safety nets run even when completion/error handlers do not render
        // content.
        if (
          onProgress &&
          isStatusChanged &&
          (status.status === 'pending' ||
            status.status === 'streaming' ||
            status.status === 'oauth_required' ||
            isUiTerminalStatus)
        ) {
          onProgress(status);
        }

        // Check if job is complete AND finalized
        if (
          (status.status === 'completed' && status.finalizedAt) ||
          shouldFinalizeFallback
        ) {
          if (completedJobsRef.current.has(jobId)) {
            return status;
          }
          completedJobsRef.current.add(jobId);
          // Only consider job truly complete when finalizedAt is set
          pollCountByJobRef.current[jobId] = 0;
          if (onComplete && status.fullResponse) {
            onComplete(
              status.fullResponse,
              status.intermediateSteps,
              status.finalizedAt,
              conversationId,
              {
                turnId: status.turnId,
                assistantMessageId: status.assistantMessageId,
                jobId,
              },
            );
          }
          // Clear polling and persisted job
          if (conversationId) {
            clearPersistedJobs(userId, conversationId);
          }
          removeActiveJob(jobId, conversationId);
          logger.info('Job completed and finalized - cleared persisted state');
        } else if (status.status === 'completed' && !status.finalizedAt) {
          // Job marked complete but still finalizing - keep polling
          logger.debug(
            'Job completed but not finalized yet, continuing to poll',
          );
          scheduleNextPoll(jobId, pollJobStatus);
        } else if (status.status === 'error') {
          pollCountByJobRef.current[jobId] = 0;
          if (onError) {
            onError(status.error || 'Unknown error', {
              partialResponse: status.partialResponse,
              intermediateSteps: status.intermediateSteps,
              jobId,
              conversationId,
              turnId: status.turnId,
              assistantMessageId: status.assistantMessageId,
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
          logger.warn(
            `Poll failure ${pollErrorCountRef.current[jobId]}/4 for job ${jobId}, retrying with backoff`,
          );
          scheduleNextPoll(jobId, pollJobStatus);
          return null;
        }

        // 4+ consecutive failures: give up with whatever partial data we have
        logger.error(
          `Poll failure ${pollErrorCountRef.current[jobId]} for job ${jobId}, giving up`,
        );
        pollErrorCountRef.current[jobId] = 0;
        pollCountByJobRef.current[jobId] = 0;
        const lastKnownStatus = jobStatusByConversationId[conversationId || ''];
        if (onError) {
          onError(error instanceof Error ? error.message : 'Unknown error', {
            partialResponse: lastKnownStatus?.partialResponse,
            intermediateSteps: lastKnownStatus?.intermediateSteps,
            jobId,
            conversationId,
            turnId: lastKnownStatus?.turnId,
            assistantMessageId: lastKnownStatus?.assistantMessageId,
          });
        }
        removeActiveJob(jobId, conversationId, false);
        return null;
      }
    },
    [
      onProgress,
      onComplete,
      onError,
      userId,
      scheduleNextPoll,
      removeActiveJob,
    ],
  );

  const cancelJob = useCallback(
    async (conversationId?: string) => {
      const jobsToCancel = conversationId
        ? Object.values(activeJobsRef.current).filter(
            (job) => job.conversationId === conversationId,
          )
        : Object.values(activeJobsRef.current);

      if (jobsToCancel.length === 0) {
        return;
      }

      try {
        await Promise.all(
          jobsToCancel.map(async (job) => {
            // Delete job on server
            await fetch(`/api/chat/async?jobId=${job.jobId}`, {
              method: 'DELETE',
              credentials: 'include',
            });
            clearPersistedJobs(userId, job.conversationId);
            removeActiveJob(job.jobId, job.conversationId);
          }),
        );
      } catch (error) {
        logger.error('Error canceling job', error);
      }
    },
    [userId, removeActiveJob],
  );

  // Start async job
  const startAsyncJob = useCallback(
    async (
      messages: any[],
      additionalProps: any,
      jobUserId: string,
      conversationId: string,
      conversationName: string,
      turnId?: string,
      assistantMessageId?: string,
    ): Promise<string> => {
      try {
        // Cancel any existing job for this conversation
        const existingJobs = Object.values(activeJobsRef.current).filter(
          (job) => job.conversationId === conversationId,
        );
        if (existingJobs.length > 0) {
          await cancelJob(conversationId);
        }

        let response: Response;
        try {
          response = await fetchWithTimeout(
            '/api/chat/async',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                messages,
                additionalProps,
                userId: jobUserId,
                conversationId,
                conversationName,
                turnId,
                assistantMessageId,
              }),
            },
            SUBMIT_JOB_TIMEOUT_MS,
          );
        } catch (err) {
          if (err instanceof FetchTimeoutError) {
            throw new Error(
              'The server did not respond in time. Please try again.',
            );
          }
          throw err;
        }

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          const detail =
            body?.error || body?.message || body?.reason || response.statusText;
          throw new Error(
            detail || `Failed to start async job (HTTP ${response.status})`,
          );
        }

        const { jobId } = await response.json();
        const job: PersistedJob = {
          jobId,
          conversationId,
          userId: jobUserId,
          timestamp: Date.now(),
          turnId,
          assistantMessageId,
        };
        activeJobsRef.current[jobId] = job;

        // Persist job metadata for resume after backgrounding
        const persistedJobs = getPersistedJobs(userId);
        const nextPersistedJobs = [
          ...persistedJobs.filter(
            (existing) => existing.conversationId !== conversationId,
          ),
          job,
        ];
        persistJobs(nextPersistedJobs, userId);

        // Try WebSocket push first, fall back to polling
        const usingWs = subscribeJobToWs(jobId, conversationId);

        if (!usingWs) {
          // Fallback: use HTTP polling
          setIsPolling(true);
          pollCountByJobRef.current[jobId] = 0;
          await pollJobStatus(jobId);
        } else {
          // With WebSocket, do one initial poll to get immediate status
          setIsPolling(true);
          try {
            const initialResponse = await fetchWithTimeout(
              `/api/chat/async?jobId=${jobId}`,
              { credentials: 'include' },
              STATUS_FETCH_TIMEOUT_MS,
            );
            if (initialResponse.ok) {
              const initialStatus: AsyncJobStatus =
                await initialResponse.json();
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
          onError(error.message, {
            conversationId,
            turnId,
            assistantMessageId,
          });
        }
        throw error;
      }
    },
    [
      pollJobStatus,
      onError,
      userId,
      cancelJob,
      subscribeJobToWs,
      handleWsJobStatus,
      startWsFallbackPolling,
    ],
  );

  // Track page visibility for battery-efficient polling
  useEffect(() => {
    const handleVisibilityChange = () => {
      isPageVisibleRef.current = document.visibilityState === 'visible';
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () =>
      document.removeEventListener('visibilitychange', handleVisibilityChange);
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
      for (const jobId of Array.from(wsActiveJobsRef.current)) {
        wsManager.unsubscribeFromJob(jobId);
        const conversationId = activeJobsRef.current[jobId]?.conversationId;
        if (conversationId) {
          wsManager.unsubscribeFromChat(conversationId);
        }
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

    const jobsToResume = persistedJobs.filter(
      (job) => !activeJobsRef.current[job.jobId],
    );
    if (jobsToResume.length === 0) {
      return;
    }

    setIsPolling(true);

    for (const job of jobsToResume) {
      logger.info('Resuming job tracking', job.jobId);
      activeJobsRef.current[job.jobId] = job;

      // Try WebSocket first, fall back to polling
      const usingWs = subscribeJobToWs(job.jobId, job.conversationId);
      if (!usingWs) {
        pollCountByJobRef.current[job.jobId] = 0; // Reset backoff on resume
        await pollJobStatus(job.jobId);
      } else {
        // Do one poll to get current status immediately
        try {
          const response = await fetchWithTimeout(
            `/api/chat/async?jobId=${job.jobId}`,
            { credentials: 'include' },
            STATUS_FETCH_TIMEOUT_MS,
          );
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
  }, [
    userId,
    pollJobStatus,
    subscribeJobToWs,
    handleWsJobStatus,
    startWsFallbackPolling,
  ]);

  // On mount: resume any persisted job
  useEffect(() => {
    if (!hasResumedRef.current) {
      hasResumedRef.current = true;
      resumePollingIfNeeded();
    }
  }, [resumePollingIfNeeded]);

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
          const statusResponse = await fetchWithTimeout(
            `/api/chat/async?jobId=${job.jobId}`,
            { credentials: 'include' },
            STATUS_FETCH_TIMEOUT_MS,
          );
          if (statusResponse.ok) {
            const status: AsyncJobStatus = await statusResponse.json();
            if (status.status === 'completed' && status.fullResponse) {
              completedJobsRef.current.add(job.jobId);
              if (onComplete) {
                onComplete(
                  status.fullResponse,
                  status.intermediateSteps,
                  status.finalizedAt,
                  job.conversationId,
                  {
                    turnId: status.turnId || job.turnId,
                    assistantMessageId:
                      status.assistantMessageId || job.assistantMessageId,
                    jobId: job.jobId,
                  },
                );
              }
              clearPersistedJobs(userId, job.conversationId);
              removeActiveJob(job.jobId, job.conversationId);
              logger.info(
                `Recovered orphaned job ${job.jobId} - fired onComplete with response`,
              );
              continue;
            }
            if (status.status === 'error') {
              completedJobsRef.current.add(job.jobId);
              onError?.(status.error || 'The job failed before completion.', {
                partialResponse: status.partialResponse,
                intermediateSteps: status.intermediateSteps,
                jobId: job.jobId,
                conversationId: job.conversationId,
                turnId: status.turnId || job.turnId,
                assistantMessageId:
                  status.assistantMessageId || job.assistantMessageId,
              });
              clearPersistedJobs(userId, job.conversationId);
              removeActiveJob(job.jobId, job.conversationId);
              continue;
            }

            // The server still owns a pending or streaming job. Conversation
            // fallback would only find an older turn, so leave it tracked.
            continue;
          }
        } catch (e) {
          logger.error(
            `Failed to fetch status for orphaned job ${job.jobId}`,
            e,
          );
        }

        // Fallback: fetch conversation directly from Redis and fire onComplete
        try {
          const response = await fetchWithTimeout(
            `/api/conversations/${job.conversationId}`,
            { credentials: 'include' },
            STATUS_FETCH_TIMEOUT_MS,
          );
          if (response.ok) {
            const convData = await response.json();
            const correlatedAssistant = findCorrelatedAssistantMessage(
              convData.messages,
              job,
            );
            if (correlatedAssistant) {
              if (onComplete) {
                completedJobsRef.current.add(job.jobId);
                onComplete(
                  correlatedAssistant.content,
                  correlatedAssistant.intermediateSteps,
                  Date.now(),
                  job.conversationId,
                  {
                    turnId: correlatedAssistant.metadata?.turnId || job.turnId,
                    assistantMessageId:
                      correlatedAssistant.id || job.assistantMessageId,
                    jobId: job.jobId,
                  },
                );
                logger.info(
                  `Recovered orphaned job ${job.jobId} via conversation data`,
                );
              }
              clearPersistedJobs(userId, job.conversationId);
              removeActiveJob(job.jobId, job.conversationId);
            }
          }
        } catch (e) {
          logger.error(
            `Failed to check conversation for orphaned job ${job.jobId}`,
            e,
          );
        }
      }
    }
  }, [userId, onComplete, onError, removeActiveJob]);

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
    return () =>
      document.removeEventListener('visibilitychange', handleVisibilityResume);
  }, [resumePollingIfNeeded, checkOrphanedJobs]);

  return {
    startAsyncJob,
    jobStatusByConversationId,
    isPolling,
    cancelJob,
    clearPersistedJob: (conversationId?: string) =>
      clearPersistedJobs(userId, conversationId),
  };
};
