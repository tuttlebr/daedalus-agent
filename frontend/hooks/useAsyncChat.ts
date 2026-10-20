import { useState, useEffect, useCallback, useRef } from 'react';

import { getWebSocketManager } from '@/services/websocket';

import {
  appendIntermediateStep,
  mergeIntermediateStepSnapshot,
} from '@/utils/app/intermediateSteps';
import {
  drainOffsetDeltas,
  isStaleCumulativeSnapshot,
  type OffsetDelta,
} from '@/utils/app/streamingBuffer';
import { applyStreamingContentDelta } from '@/utils/app/streamingContent';
import { fetchWithTimeout, FetchTimeoutError } from '@/utils/fetchWithTimeout';
import { Logger } from '@/utils/logger';

import { v4 as uuidv4 } from 'uuid';

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
// The worker persists streamed text for status reads at most every 750 ms
// (STREAM_STATUS_FLUSH_INTERVAL_MS), so a repair read can briefly trail the
// live tokens that revealed the gap.
const GAP_REPAIR_RETRY_MS = 1_000;
const MAX_HELD_TOKENS_PER_JOB = 1_000;
const MISSING_JOB_MESSAGE =
  'The response status is no longer available. Reload the conversation to see any saved result.';

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
  generationDurationMs?: number;
  turnId?: string;
  assistantMessageId?: string;
}

interface ChatTokenEvent {
  conversationId: string;
  jobId: string;
  turnId?: string;
  assistantMessageId?: string;
  content: string;
  responseStart?: number;
  intermediateSteps?: any[];
}

/**
 * A live token together with the job's reconciled response text after it.
 * Consumers should render `partialResponse`: the hook alone merges live
 * deltas, status snapshots and repaired gaps for a job.
 */
export interface ChatTokenUpdate extends ChatTokenEvent {
  partialResponse: string;
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
  generationDurationMs?: number;
  intermediateSteps?: any[];
  error?: string;
}

type StatusReadResult =
  | { kind: 'status'; status: AsyncJobStatus }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

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
  generationDurationMs?: number;
  /**
   * The worker owns this outcome: it saved the turn in the conversation (or
   * deliberately suppressed the save for a deleted one). The browser need not
   * upload the conversation again.
   */
  persisted?: boolean;
}

interface UseAsyncChatOptions {
  /** HTTP status polling cadence while WebSocket delivery is unavailable. */
  pollingInterval?: number;
  onProgress?: (status: AsyncJobStatus) => void;
  onToken?: (event: ChatTokenUpdate) => void;
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
      generationDurationMs?: number;
      /** See CompletionMeta.persisted. */
      persisted?: boolean;
    },
  ) => void;
  userId?: string; // Add userId for localStorage key scoping
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
    /** Runs once the server has accepted the job, before it is tracked. */
    onAccepted?: (jobId: string) => void,
  ) => Promise<string>;
  jobStatusByConversationId: Record<string, AsyncJobStatus>;
  cancelJob: (conversationId?: string) => Promise<void>;
  steerJob: (conversationId: string, instruction: string) => Promise<void>;
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

const clearPersistedJob = (userId: string, jobId: string) => {
  const existing = getPersistedJobs(userId);
  const nextJobs = existing.filter((job) => job.jobId !== jobId);
  if (nextJobs.length !== existing.length) persistJobs(nextJobs, userId);
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

export const useAsyncChat = (
  options: UseAsyncChatOptions = {},
): UseAsyncChatReturn => {
  const {
    // Polling while WebSocket delivery is unavailable: 3s on desktop, 5s on
    // mobile (battery-conscious).
    pollingInterval = isMobile() ? 5000 : 3000,
    onProgress,
    onToken,
    onIntermediateStep,
    onComplete,
    onError,
    userId = 'anon',
  } = options;

  const [jobStatusByConversationId, setJobStatusByConversationId] = useState<
    Record<string, AsyncJobStatus>
  >({});
  const pendingSubmissionsRef = useRef<
    Record<
      string,
      {
        submissionId: string;
        controller: AbortController;
        conversationId: string;
        cancelled: boolean;
        jobId?: string;
      }
    >
  >({});
  const activeJobsRef = useRef<Record<string, PersistedJob>>({});
  const steeringRetryRef = useRef<
    Record<string, { jobId: string; instruction: string; commandId: string }>
  >({});
  const steerJob = useCallback(
    async (conversationId: string, instruction: string) => {
      const job = Object.values(activeJobsRef.current).find(
        (candidate) => candidate.conversationId === conversationId,
      );
      if (!job) throw new Error('No active response to steer');
      const previous = steeringRetryRef.current[conversationId];
      const command =
        previous?.jobId === job.jobId && previous.instruction === instruction
          ? previous
          : { jobId: job.jobId, instruction, commandId: uuidv4() };
      steeringRetryRef.current[conversationId] = command;
      await getWebSocketManager().steerJob(
        command.jobId,
        instruction,
        command.commandId,
      );
      delete steeringRetryRef.current[conversationId];
    },
    [],
  );
  const jobStatusByJobIdRef = useRef<Record<string, AsyncJobStatus>>({});
  const hasResumedRef = useRef(false); // Prevent double-resume
  const isComponentMountedRef = useRef(true);
  const completedJobsRef = useRef<Set<string>>(new Set());
  const wsJobUnsubsRef = useRef<Record<string, () => void>>({}); // WebSocket handler cleanup by jobId
  const wsActiveJobsRef = useRef<Set<string>>(new Set()); // Jobs using WebSocket (not polling)
  const wsFallbackTimersRef = useRef<
    Record<string, ReturnType<typeof setInterval> | null>
  >({}); // WS safety-net polling
  const lastWsEventByJobRef = useRef<Record<string, number>>({}); // Last WS message timestamp per job
  const fallbackRequestsRef = useRef(new Set<string>());
  // Lets the fallback poller restart itself at a faster cadence without a
  // forward reference to a callback declared later in this hook.
  const startWsFallbackPollingRef = useRef<
    ((jobId: string, intervalMs?: number) => void) | null
  >(null);
  const refreshJobStatusRef = useRef<((jobId: string) => Promise<void>) | null>(
    null,
  );
  const subscribeJobToWsRef = useRef<
    ((jobId: string, conversationId?: string) => void) | null
  >(null);
  // Live tokens whose offset lies beyond the received text: earlier tokens
  // were lost, so these wait for a status snapshot to fill the hole.
  const heldTokensByJobRef = useRef<Record<string, OffsetDelta[]>>({});
  const gapRepairTimersRef = useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({});
  const gapRepairAttemptsRef = useRef<Record<string, number>>({});
  const repairGapRef = useRef<((jobId: string) => Promise<void>) | null>(null);
  const missingJobChecksRef = useRef(new Set<string>());

  const removeActiveJob = useCallback(
    (jobId: string, conversationId?: string, clearStatus: boolean = true) => {
      const trackedConversationId =
        conversationId || activeJobsRef.current[jobId]?.conversationId;

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

      const gapRepairTimer = gapRepairTimersRef.current[jobId];
      if (gapRepairTimer) {
        clearTimeout(gapRepairTimer);
        delete gapRepairTimersRef.current[jobId];
      }
      delete heldTokensByJobRef.current[jobId];
      delete gapRepairAttemptsRef.current[jobId];

      delete activeJobsRef.current[jobId];
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
        // Tokens and steps from parallel work cannot resolve an OAuth wait.
        // Authoritative job_status updates bypass this live-event merge.
        status:
          updates.status === 'streaming' &&
          baseStatus.status === 'oauth_required'
            ? 'oauth_required'
            : updates.status ?? baseStatus.status,
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

  const scheduleGapRepair = useCallback((jobId: string, delayMs: number) => {
    if (gapRepairTimersRef.current[jobId]) return;
    gapRepairTimersRef.current[jobId] = setTimeout(() => {
      delete gapRepairTimersRef.current[jobId];
      void repairGapRef.current?.(jobId);
    }, delayMs);
  }, []);

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
      const currentText = current?.partialResponse || '';
      const content = event.content || '';
      const responseStart = event.responseStart;
      let partialResponse = currentText;
      if (
        content &&
        typeof responseStart === 'number' &&
        Number.isSafeInteger(responseStart) &&
        responseStart > currentText.length
      ) {
        // One worker publishes a job's tokens in order, so this offset means
        // earlier tokens were never delivered (for example while the socket
        // was resubscribing). Later tokens alone can never fill that hole and
        // a recent live event must not suppress the status read that can.
        const held = heldTokensByJobRef.current[event.jobId] ?? [];
        held.push({ content, responseStart });
        if (held.length > MAX_HELD_TOKENS_PER_JOB) {
          held.splice(0, held.length - MAX_HELD_TOKENS_PER_JOB);
        }
        heldTokensByJobRef.current[event.jobId] = held;
        scheduleGapRepair(event.jobId, 0);
      } else {
        partialResponse = applyStreamingContentDelta(
          currentText,
          content,
          responseStart,
        );
      }
      updateLiveStatus(
        event.jobId,
        conversationId,
        {
          status: 'streaming',
          partialResponse,
          ...(event.intermediateSteps
            ? {
                intermediateSteps: mergeIntermediateStepSnapshot(
                  current?.intermediateSteps,
                  event.intermediateSteps,
                ),
              }
            : {}),
          turnId: event.turnId || current?.turnId,
          assistantMessageId:
            event.assistantMessageId || current?.assistantMessageId,
        },
        false,
      );

      onToken?.({ ...event, partialResponse });
    },
    [getActiveConversationId, onToken, scheduleGapRepair, updateLiveStatus],
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
      const nextSteps = appendIntermediateStep(
        current?.intermediateSteps || [],
        event.step,
      );
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
        // Finalization publishes chat_complete only after saving the turn.
        onError?.(event.error, {
          partialResponse: event.fullResponse,
          intermediateSteps: event.intermediateSteps,
          jobId: event.jobId,
          conversationId,
          turnId: event.turnId,
          assistantMessageId: event.assistantMessageId,
          generationDurationMs: event.generationDurationMs,
          persisted: true,
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
            generationDurationMs: event.generationDurationMs,
            persisted: true,
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
      if (!activeJobsRef.current[jobId]) return;
      const conversationId =
        status.conversationId || activeJobsRef.current[jobId]?.conversationId;

      // Skip if already completed
      if (completedJobsRef.current.has(jobId)) return;

      // A snapshot travels on a different channel than the per-token stream and
      // can land behind it. Keep the accumulated text when the snapshot is only
      // a stale prefix of it, otherwise the next token's responseStart lands
      // past the end and is dropped until the following snapshot arrives.
      // Pushed status records (for example an OAuth prompt) carry no response
      // text at all; that says nothing about the text already received.
      const accumulated = jobStatusByJobIdRef.current[jobId]?.partialResponse;
      let text =
        typeof status.partialResponse !== 'string'
          ? accumulated
          : accumulated &&
            isStaleCumulativeSnapshot(accumulated, status.partialResponse)
          ? accumulated
          : status.partialResponse;
      const held = heldTokensByJobRef.current[jobId];
      if (held?.length) {
        const drained = drainOffsetDeltas(text ?? '', held);
        text = drained.text;
        if (drained.pending.length) {
          heldTokensByJobRef.current[jobId] = drained.pending;
        } else {
          delete heldTokensByJobRef.current[jobId];
        }
      }
      // Tool steps follow the same rule. A record without a step list (an
      // OAuth prompt, the stored status of a streaming job) keeps the steps
      // already received, and a snapshot never drops or repeats a live step.
      const steps = mergeIntermediateStepSnapshot(
        jobStatusByJobIdRef.current[jobId]?.intermediateSteps,
        status.intermediateSteps,
      );
      const merged: AsyncJobStatus = {
        ...status,
        ...(text !== undefined ? { partialResponse: text } : {}),
        ...(steps !== undefined ? { intermediateSteps: steps } : {}),
      };

      // Update state
      jobStatusByJobIdRef.current[jobId] = merged;
      if (conversationId) {
        setJobStatusByConversationId((prev) => ({
          ...prev,
          [conversationId]: merged,
        }));
      }

      // Every terminal record is written with finalizedAt together with its
      // durable finalization journal (finalizeSuccess/finalizeError).
      const isUiTerminalStatus =
        status.status === 'error' ||
        (status.status === 'completed' && Boolean(status.finalizedAt));

      // Progress callback, including UI-terminal states so cleanup safety nets
      // run even when completion/error handlers do not render content.
      if (
        onProgress &&
        (status.status === 'pending' ||
          status.status === 'streaming' ||
          status.status === 'oauth_required' ||
          isUiTerminalStatus)
      ) {
        onProgress(merged);
      }

      if (status.status === 'completed' && status.finalizedAt) {
        completedJobsRef.current.add(jobId);
        if (onComplete) {
          onComplete(
            status.fullResponse ?? status.partialResponse ?? '',
            merged.intermediateSteps,
            status.finalizedAt,
            conversationId,
            {
              turnId: status.turnId,
              assistantMessageId: status.assistantMessageId,
              jobId,
              generationDurationMs: status.generationDurationMs,
              persisted: true,
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
            partialResponse: merged.partialResponse,
            intermediateSteps: merged.intermediateSteps,
            jobId,
            conversationId,
            turnId: status.turnId,
            assistantMessageId: status.assistantMessageId,
            generationDurationMs: status.generationDurationMs,
            persisted: Boolean(status.finalizedAt),
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
    (jobId: string, conversationId?: string): void => {
      if (!isComponentMountedRef.current) return;
      const wsManager = getWebSocketManager();

      // Queue subscriptions even while disconnected. The manager sends them
      // on reconnect so a turn does not remain on HTTP polling indefinitely.
      wsManager.subscribeToJob(jobId);
      if (conversationId) {
        wsManager.subscribeToChat(conversationId);
      }
      wsActiveJobsRef.current.add(jobId);

      const unsubs: Array<() => void> = [];

      unsubs.push(
        wsManager.on('job_status', (data: AsyncJobStatus) => {
          if (data.jobId === jobId) {
            lastWsEventByJobRef.current[jobId] = Date.now();
            handleWsJobStatus(data);
          }
        }),
      );

      unsubs.push(
        wsManager.on('disconnected', () => {
          if (activeJobsRef.current[jobId]) {
            startWsFallbackPollingRef.current?.(jobId, pollingInterval);
          }
        }),
      );

      // The server does not replay what was published while the socket was
      // down, and a recent disconnection keeps the fallback poller quiet.
      // Read the status once the subscriptions are re-established, as when
      // tracking starts, so a missed completion does not wait for that poll.
      // Live delivery is back, so the poller returns to its safety-net pace.
      unsubs.push(
        wsManager.on('connected', () => {
          if (
            activeJobsRef.current[jobId] &&
            !completedJobsRef.current.has(jobId)
          ) {
            void refreshJobStatusRef.current?.(jobId);
            if (wsFallbackTimersRef.current[jobId]) {
              startWsFallbackPollingRef.current?.(
                jobId,
                WS_FALLBACK_POLL_INTERVAL,
              );
            }
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
    },
    [
      pollingInterval,
      handleWsJobStatus,
      handleWsChatToken,
      handleWsChatIntermediateStep,
      handleWsChatComplete,
    ],
  );
  subscribeJobToWsRef.current = subscribeJobToWs;

  const fetchJobStatus = useCallback(
    async (jobId: string): Promise<StatusReadResult> => {
      try {
        const response = await fetchWithTimeout(
          `/api/chat/async?jobId=${jobId}`,
          { credentials: 'include' },
          STATUS_FETCH_TIMEOUT_MS,
        );
        if (response.ok) {
          return { kind: 'status', status: await response.json() };
        }
        await response.body?.cancel();
        return response.status === 404
          ? { kind: 'missing' }
          : { kind: 'unavailable' };
      } catch {
        // Network/timeout error: the caller retries on its own schedule.
        return { kind: 'unavailable' };
      }
    },
    [],
  );

  const findSavedResponse = useCallback(
    async (job: PersistedJob): Promise<any | null> => {
      try {
        const response = await fetchWithTimeout(
          `/api/conversations/${job.conversationId}`,
          { credentials: 'include' },
          STATUS_FETCH_TIMEOUT_MS,
        );
        if (!response.ok) {
          await response.body?.cancel();
          return null;
        }
        const conversation = await response.json();
        return findCorrelatedAssistantMessage(conversation?.messages, job);
      } catch (error) {
        logger.error(
          `Failed to check conversation for job ${job.jobId}`,
          error,
        );
        return null;
      }
    },
    [],
  );

  const completeFromSavedResponse = useCallback(
    (job: PersistedJob, saved: any) => {
      completedJobsRef.current.add(job.jobId);
      onComplete?.(
        saved.content,
        saved.intermediateSteps,
        Date.now(),
        job.conversationId,
        {
          turnId: saved.metadata?.turnId || job.turnId,
          assistantMessageId: saved.id || job.assistantMessageId,
          jobId: job.jobId,
          generationDurationMs: saved.generationDurationMs,
          persisted: true,
        },
      );
    },
    [onComplete],
  );

  // The status record no longer exists (it expires an hour after its last
  // update, or the job was removed). The worker writes the conversation before
  // publishing completion, so recover the owned answer from it; otherwise end
  // the turn visibly instead of leaving it streaming with nothing to poll.
  const handleMissingJob = useCallback(
    async (jobId: string) => {
      const job = activeJobsRef.current[jobId];
      if (
        !job ||
        completedJobsRef.current.has(jobId) ||
        missingJobChecksRef.current.has(jobId)
      ) {
        return;
      }
      missingJobChecksRef.current.add(jobId);
      try {
        const saved = await findSavedResponse(job);
        if (
          !isComponentMountedRef.current ||
          !activeJobsRef.current[jobId] ||
          completedJobsRef.current.has(jobId)
        )
          return;
        if (saved) {
          completeFromSavedResponse(job, saved);
        } else {
          completedJobsRef.current.add(jobId);
          const live = jobStatusByJobIdRef.current[jobId];
          onError?.(MISSING_JOB_MESSAGE, {
            partialResponse: live?.partialResponse,
            intermediateSteps: live?.intermediateSteps,
            jobId,
            conversationId: job.conversationId,
            turnId: live?.turnId || job.turnId,
            assistantMessageId:
              live?.assistantMessageId || job.assistantMessageId,
            persisted: false,
          });
        }
        clearPersistedJob(userId, jobId);
        removeActiveJob(jobId, job.conversationId);
        logger.info(`Job ${jobId}: status unavailable, tracking ended`);
      } finally {
        missingJobChecksRef.current.delete(jobId);
      }
    },
    [
      completeFromSavedResponse,
      findSavedResponse,
      onError,
      removeActiveJob,
      userId,
    ],
  );

  // Fill text that live delivery lost from a snapshot read while newer live
  // events arrived. Their status and tool state stay authoritative.
  const repairLiveText = useCallback(
    (jobId: string, snapshotText?: string) => {
      const live = jobStatusByJobIdRef.current[jobId];
      if (!live || typeof snapshotText !== 'string') return;
      const currentText = live.partialResponse || '';
      const base = isStaleCumulativeSnapshot(currentText, snapshotText)
        ? currentText
        : snapshotText;
      const drained = drainOffsetDeltas(
        base,
        heldTokensByJobRef.current[jobId] ?? [],
      );
      if (drained.pending.length) {
        heldTokensByJobRef.current[jobId] = drained.pending;
      } else {
        delete heldTokensByJobRef.current[jobId];
      }
      if (drained.text === currentText) return;
      const status = updateLiveStatus(jobId, live.conversationId, {
        partialResponse: drained.text,
      });
      onProgress?.(status);
    },
    [onProgress, updateLiveStatus],
  );

  // One status read shared by the safety-net poller and gap repair. Requests
  // never overlap: a slow response could otherwise land after a newer one and
  // rewind the visible state.
  const refreshJobStatus = useCallback(
    async (jobId: string) => {
      if (!isComponentMountedRef.current) return;
      if (fallbackRequestsRef.current.has(jobId)) return;
      fallbackRequestsRef.current.add(jobId);
      const statusAtRequestStart = jobStatusByJobIdRef.current[jobId];
      try {
        const result = await fetchJobStatus(jobId);
        if (
          !isComponentMountedRef.current ||
          !activeJobsRef.current[jobId] ||
          completedJobsRef.current.has(jobId)
        ) {
          return;
        }
        if (result.kind === 'missing') {
          await handleMissingJob(jobId);
          return;
        }
        if (result.kind !== 'status') return;
        const status = result.status;
        // Live events can resume while the HTTP response is in flight.
        // Preserve their newer tool state as well as their response text.
        if (
          status.status !== 'completed' &&
          status.status !== 'error' &&
          jobStatusByJobIdRef.current[jobId] !== statusAtRequestStart
        ) {
          repairLiveText(jobId, status.partialResponse);
          return;
        }
        handleWsJobStatus(status);
      } finally {
        fallbackRequestsRef.current.delete(jobId);
      }
    },
    [fetchJobStatus, handleMissingJob, handleWsJobStatus, repairLiveText],
  );
  refreshJobStatusRef.current = refreshJobStatus;

  const repairGap = useCallback(
    async (jobId: string) => {
      const gapOpen = () =>
        isComponentMountedRef.current &&
        Boolean(activeJobsRef.current[jobId]) &&
        !completedJobsRef.current.has(jobId) &&
        Boolean(heldTokensByJobRef.current[jobId]?.length);
      if (!gapOpen()) {
        delete gapRepairAttemptsRef.current[jobId];
        return;
      }
      await refreshJobStatus(jobId);
      if (!gapOpen()) {
        delete gapRepairAttemptsRef.current[jobId];
        return;
      }
      const attempt = (gapRepairAttemptsRef.current[jobId] ?? 0) + 1;
      gapRepairAttemptsRef.current[jobId] = attempt;
      scheduleGapRepair(
        jobId,
        Math.min(
          GAP_REPAIR_RETRY_MS * attempt,
          Math.max(GAP_REPAIR_RETRY_MS, pollingInterval),
        ),
      );
    },
    [pollingInterval, refreshJobStatus, scheduleGapRepair],
  );
  repairGapRef.current = repairGap;

  // Start a safety-net HTTP poll alongside WebSocket to catch silent disconnects.
  // Skips the poll when WS has recently delivered an event for the job.
  const startWsFallbackPolling = useCallback(
    (
      jobId: string,
      intervalMs: number = getWebSocketManager().isConnected
        ? WS_FALLBACK_POLL_INTERVAL
        : pollingInterval,
    ) => {
      if (!isComponentMountedRef.current) return;
      if (wsFallbackTimersRef.current[jobId]) {
        clearInterval(wsFallbackTimersRef.current[jobId]!);
      }
      lastWsEventByJobRef.current[jobId] = Date.now();
      const timer = setInterval(() => {
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
        // Use the ordinary polling cadence during disconnection, retaining
        // subscriptions so live delivery can recover when the socket returns.
        if (!wsManager.isConnected && intervalMs > pollingInterval) {
          logger.info(
            `Job ${jobId}: WebSocket delivery lost, falling back to ${pollingInterval}ms polling`,
          );
          clearInterval(timer);
          delete wsFallbackTimersRef.current[jobId];
          startWsFallbackPollingRef.current?.(jobId, pollingInterval);
          return;
        }
        void refreshJobStatus(jobId);
      }, intervalMs);
      wsFallbackTimersRef.current[jobId] = timer;
    },
    [refreshJobStatus, pollingInterval],
  );
  startWsFallbackPollingRef.current = startWsFallbackPolling;

  // Read the current status once after subscribing, then keep the safety-net
  // poller running until a terminal event arrives. Live events can arrive
  // while this first read is in flight, so it takes the same guarded path as
  // every later read.
  const trackJobStatus = useCallback(
    async (jobId: string) => {
      await refreshJobStatus(jobId);
      if (
        activeJobsRef.current[jobId] &&
        !completedJobsRef.current.has(jobId)
      ) {
        startWsFallbackPolling(jobId);
      }
    },
    [refreshJobStatus, startWsFallbackPolling],
  );

  const cancelJob = useCallback(
    async (conversationId?: string, exceptSubmissionId?: string) => {
      const jobsToCancel = conversationId
        ? Object.values(activeJobsRef.current).filter(
            (job) => job.conversationId === conversationId,
          )
        : Object.values(activeJobsRef.current);

      const submissions = Object.values(pendingSubmissionsRef.current).filter(
        (submission) =>
          submission.submissionId !== exceptSubmissionId &&
          (!conversationId || submission.conversationId === conversationId),
      );
      try {
        await Promise.all([
          ...submissions.map(async (submission) => {
            const response = await fetch(
              `/api/chat/async?submissionId=${encodeURIComponent(
                submission.submissionId,
              )}`,
              {
                method: 'DELETE',
                credentials: 'include',
                signal: AbortSignal.timeout(10000),
              },
            );
            const outcome = response.ok ? await response.json() : null;
            if (
              !outcome ||
              (outcome.canceled !== true &&
                !['completed', 'error'].includes(outcome.status))
            ) {
              throw new Error('Could not stop the response. Please try again.');
            }
            submission.cancelled = true;
            submission.controller.abort();
            if (submission.jobId)
              removeActiveJob(submission.jobId, submission.conversationId);
            clearPersistedJobs(userId, submission.conversationId);
          }),
          ...jobsToCancel.map(async (job) => {
            // Delete job on server
            const response = await fetch(`/api/chat/async?jobId=${job.jobId}`, {
              method: 'DELETE',
              credentials: 'include',
              signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) {
              throw new Error(
                `Could not stop the response (HTTP ${response.status}). Please try again.`,
              );
            }
            const outcome = await response.json();
            if (outcome.canceled !== true) {
              // A terminal job can legitimately win the cancellation race.
              // Confirm that state before discarding our recovery markers.
              const statusResponse = await fetchWithTimeout(
                `/api/chat/async?jobId=${job.jobId}`,
                { credentials: 'include' },
                STATUS_FETCH_TIMEOUT_MS,
              );
              const status = statusResponse.ok
                ? await statusResponse.json()
                : null;
              if (!status || !['completed', 'error'].includes(status.status)) {
                throw new Error(
                  'Cancellation was not confirmed. The response may still be running; please try again.',
                );
              }
            }
            clearPersistedJobs(userId, job.conversationId);
            removeActiveJob(job.jobId, job.conversationId);
          }),
        ]);
      } catch (error) {
        logger.error('Error canceling job', error);
        throw error;
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
      onAccepted?: (jobId: string) => void,
    ): Promise<string> => {
      const submission = {
        submissionId: uuidv4(),
        controller: new AbortController(),
        conversationId,
        cancelled: false,
        jobId: undefined as string | undefined,
      };
      pendingSubmissionsRef.current[submission.submissionId] = submission;
      try {
        // Cancel any existing job for this conversation
        const existingJobs = Object.values(activeJobsRef.current).filter(
          (job) => job.conversationId === conversationId,
        );
        if (existingJobs.length > 0) {
          await cancelJob(conversationId, submission.submissionId);
        }

        let response: Response;
        try {
          response = await fetchWithTimeout(
            '/api/chat/async',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              signal: submission.controller.signal,
              body: JSON.stringify({
                submissionId: submission.submissionId,
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

        const { jobId, status } = await response.json();
        submission.jobId = jobId;
        if (submission.cancelled || status === 'cancelled') return jobId;
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
        // The remote job remains resumable, but a late admission response
        // must not recreate subscriptions or call the unmounted view.
        if (!isComponentMountedRef.current) return jobId;

        try {
          onAccepted?.(jobId);
        } catch (error) {
          logger.error('Accepted-job callback failed', error);
        }

        // WebSocket push is primary; HTTP status reads cover subscription
        // latency and lost delivery.
        subscribeJobToWs(jobId, conversationId);
        await trackJobStatus(jobId);

        return jobId;
      } catch (error: any) {
        if (submission.cancelled) return submission.jobId ?? '';
        logger.error('Error starting async job', error);
        if (isComponentMountedRef.current && onError) {
          onError(error.message, {
            conversationId,
            turnId,
            assistantMessageId,
            persisted: false,
          });
        }
        throw error;
      } finally {
        delete pendingSubmissionsRef.current[submission.submissionId];
      }
    },
    [onError, userId, cancelJob, subscribeJobToWs, trackJobStatus],
  );

  // Clean up on unmount. Strict Mode and Fast Refresh run this cleanup and
  // then the effect again on the same instance, with jobs still tracked: the
  // mounted flag, their live subscriptions and their safety-net polls are
  // restored here. The resume effect does not run again for them.
  useEffect(() => {
    isComponentMountedRef.current = true;
    for (const job of Object.values(activeJobsRef.current)) {
      if (
        completedJobsRef.current.has(job.jobId) ||
        wsJobUnsubsRef.current[job.jobId]
      ) {
        continue;
      }
      subscribeJobToWsRef.current?.(job.jobId, job.conversationId);
      startWsFallbackPollingRef.current?.(job.jobId);
    }
    const wsActiveJobs = wsActiveJobsRef.current;
    const activeJobs = activeJobsRef.current;

    return () => {
      isComponentMountedRef.current = false;
      Object.values(gapRepairTimersRef.current).forEach(clearTimeout);
      gapRepairTimersRef.current = {};
      Object.values(wsFallbackTimersRef.current).forEach((timer) => {
        if (timer) {
          clearInterval(timer);
        }
      });
      wsFallbackTimersRef.current = {};

      // Clean up WebSocket job subscriptions
      const wsManager = getWebSocketManager();
      for (const jobId of Array.from(wsActiveJobs)) {
        wsManager.unsubscribeFromJob(jobId);
        const conversationId = activeJobs[jobId]?.conversationId;
        if (conversationId) {
          wsManager.unsubscribeFromChat(conversationId);
        }
      }
      wsActiveJobs.clear();
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

    for (const job of jobsToResume) {
      if (!isComponentMountedRef.current) return;
      logger.info('Resuming job tracking', job.jobId);
      activeJobsRef.current[job.jobId] = job;
      subscribeJobToWs(job.jobId, job.conversationId);
      await trackJobStatus(job.jobId);
    }
  }, [userId, subscribeJobToWs, trackJobStatus]);

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

    // Every completion path clears the persisted record, so a record that has
    // disappeared during an await was resolved by live delivery meanwhile.
    const unresolved = (jobId: string) =>
      isComponentMountedRef.current &&
      getPersistedJobs(userId).some((persisted) => persisted.jobId === jobId);

    for (const job of persistedJobs) {
      if (!isComponentMountedRef.current) return;
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
            if (!unresolved(job.jobId)) continue;
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
                    generationDurationMs: status.generationDurationMs,
                    persisted: Boolean(status.finalizedAt),
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
                generationDurationMs: status.generationDurationMs,
                persisted: Boolean(status.finalizedAt),
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

        // Fallback: the worker saves the owned answer in the conversation.
        if (!isComponentMountedRef.current) return;
        const saved = await findSavedResponse(job);
        if (saved && unresolved(job.jobId)) {
          completeFromSavedResponse(job, saved);
          logger.info(
            `Recovered orphaned job ${job.jobId} via conversation data`,
          );
          clearPersistedJobs(userId, job.conversationId);
          removeActiveJob(job.jobId, job.conversationId);
        }
      }
    }
  }, [
    userId,
    onComplete,
    onError,
    removeActiveJob,
    findSavedResponse,
    completeFromSavedResponse,
  ]);

  // Immediately refetch when app becomes visible (user returns from background)
  useEffect(() => {
    const handleVisibilityResume = async () => {
      if (document.visibilityState === 'visible') {
        logger.info('App became visible - resuming polling if needed');
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
    cancelJob,
    steerJob,
  };
};
