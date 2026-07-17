import { Logger } from '@/utils/logger';

import { selectStreamBackendBaseUrl } from '@/server/chat/backendSelection';
import { JOB_EXPIRY_SECONDS, sleep } from '@/server/chat/constants';
import { releaseConversationJobGuard } from '@/server/chat/conversationJobGuard';
import { startBackgroundDocumentIngest } from '@/server/chat/documentIngest';
import {
  finalizeError,
  resumePendingFinalization,
} from '@/server/chat/finalization';
import { abortKey, isTerminalJobStatus } from '@/server/chat/jobState';
import {
  acknowledgeDuplicateStreamEntry,
  acknowledgeStreamQueueEntry,
  acquireStreamLease,
  claimStaleStreamJobs,
  ensureStreamConsumerGroup,
  hasBackendRequestStarted,
  loadStreamQueuePayload,
  markBackendRequestStarted,
  readNewStreamJobs,
  releaseStreamLease,
  renewStreamLease,
  type StreamQueueEntry,
} from '@/server/chat/streamQueue';
import { startBackgroundStreamReader } from '@/server/chat/streamReader';
import type { AsyncJobRequest, AsyncJobStatus } from '@/server/chat/types';
import { positiveIntegerFromEnv } from '@/server/config/env';
import {
  getRedis,
  jsonGet,
  jsonSetWithExpiry,
  sessionKey,
} from '@/server/session/redis';
import type Redis from 'ioredis';
import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { v4 as uuidv4 } from 'uuid';

const logger = new Logger('StreamWorker');

export const STREAM_WORKER_HEALTH_FILE =
  process.env.STREAM_WORKER_HEALTH_FILE || '/tmp/daedalus-stream-worker-health';
export const STREAM_WORKER_READY_FILE =
  process.env.STREAM_WORKER_READY_FILE || '/tmp/daedalus-stream-worker-ready';

export interface StreamWorkerOptions {
  concurrency: number;
  leaseTtlMs: number;
  heartbeatMs: number;
  cancellationPollMs: number;
  reclaimIdleMs: number;
  reclaimScanMs: number;
  readBlockMs: number;
  drainTimeoutMs: number;
  healthMaxAgeMs: number;
}

export type StreamQueueProcessOutcome =
  | 'completed'
  | 'oauth_required'
  | 'recovered_as_error'
  | 'finalization_pending'
  | 'missing'
  | 'busy'
  | 'interrupted';

export function streamWorkerOptionsFromEnv(): StreamWorkerOptions {
  const leaseTtlMs =
    positiveIntegerFromEnv('STREAM_WORKER_LEASE_TTL_SECONDS', 30) * 1000;
  return {
    concurrency: positiveIntegerFromEnv('STREAM_WORKER_CONCURRENCY', 4),
    leaseTtlMs,
    heartbeatMs: Math.min(
      positiveIntegerFromEnv(
        'STREAM_WORKER_HEARTBEAT_SECONDS',
        Math.max(1, Math.floor(leaseTtlMs / 3000)),
      ) * 1000,
      Math.max(1000, Math.floor(leaseTtlMs / 3)),
    ),
    cancellationPollMs:
      positiveIntegerFromEnv('STREAM_WORKER_CANCEL_POLL_SECONDS', 1) * 1000,
    reclaimIdleMs: Math.max(
      leaseTtlMs + 1000,
      positiveIntegerFromEnv('STREAM_WORKER_RECLAIM_IDLE_SECONDS', 45) * 1000,
    ),
    reclaimScanMs:
      positiveIntegerFromEnv('STREAM_WORKER_RECLAIM_SCAN_SECONDS', 10) * 1000,
    readBlockMs: positiveIntegerFromEnv('STREAM_WORKER_READ_BLOCK_MS', 1000),
    drainTimeoutMs:
      positiveIntegerFromEnv('STREAM_WORKER_DRAIN_TIMEOUT_SECONDS', 45) * 1000,
    healthMaxAgeMs:
      positiveIntegerFromEnv('STREAM_WORKER_HEALTH_MAX_AGE_SECONDS', 30) * 1000,
  };
}

class StreamLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Stream job ${jobId} lost its Redis ownership lease`);
    this.name = 'StreamLeaseLostError';
  }
}

export class StreamWorkerDrainError extends Error {
  constructor() {
    super('Stream worker is draining');
    this.name = 'StreamWorkerDrainError';
  }
}

function isTerminal(status: AsyncJobStatus | null): boolean {
  return Boolean(
    status &&
      (status.finalizedAt !== undefined || isTerminalJobStatus(status.status)),
  );
}

async function loadJobRequest(jobId: string): Promise<AsyncJobRequest | null> {
  return (await jsonGet(
    sessionKey(['async-job-request', jobId]),
  )) as AsyncJobRequest | null;
}

async function loadJobStatus(jobId: string): Promise<AsyncJobStatus | null> {
  return (await jsonGet(
    sessionKey(['async-job-status', jobId]),
  )) as AsyncJobStatus | null;
}

async function acknowledgeTerminalEntry(
  entry: StreamQueueEntry,
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const finalization = await resumePendingFinalization(entry.jobId);
    if (finalization !== 'pending') {
      await acknowledgeStreamQueueEntry(entry);
      return true;
    }
    if (attempt < 4) await sleep(20);
  }
  return false;
}

async function refreshBackendForReclaim(
  jobId: string,
  jobRequest: AsyncJobRequest,
): Promise<AsyncJobRequest> {
  const natBaseUrl = await selectStreamBackendBaseUrl(
    jobId,
    jobRequest.userId,
    jobRequest.natSessionId || jobRequest.userId,
    jobRequest.timezone,
  );
  const refreshed = { ...jobRequest, natBaseUrl };
  await jsonSetWithExpiry(
    sessionKey(['async-job-request', jobId]),
    refreshed,
    JOB_EXPIRY_SECONDS,
  );
  return refreshed;
}

export async function processStreamQueueEntry(
  entry: StreamQueueEntry,
  options: StreamWorkerOptions,
  controller: AbortController = new AbortController(),
  ownerToken: string = uuidv4(),
): Promise<StreamQueueProcessOutcome> {
  const acquired = await acquireStreamLease(
    entry.jobId,
    ownerToken,
    options.leaseTtlMs,
  );
  if (!acquired) return 'busy';

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let cancellationTimer: NodeJS.Timeout | null = null;
  let heartbeatInFlight = false;
  let cancellationCheckInFlight = false;

  const abortForLostLease = () => {
    if (!controller.signal.aborted) {
      controller.abort(new StreamLeaseLostError(entry.jobId));
    }
  };

  try {
    let status = await loadJobStatus(entry.jobId);
    if (!status) {
      await acknowledgeStreamQueueEntry(entry);
      return 'missing';
    }
    if (isTerminal(status)) {
      return (await acknowledgeTerminalEntry(entry))
        ? 'completed'
        : 'finalization_pending';
    }

    let jobRequest = await loadJobRequest(entry.jobId);
    if (!jobRequest) {
      await acknowledgeStreamQueueEntry(entry);
      return 'missing';
    }

    const backendStarted = await hasBackendRequestStarted(entry.jobId);
    if (entry.reclaimed && backendStarted) {
      await finalizeError(
        entry.jobId,
        jobRequest,
        'The stream worker stopped after backend execution began. The request was not replayed because backend tool execution is not resumable. Please try again.',
      );
      return (await acknowledgeTerminalEntry(entry))
        ? 'recovered_as_error'
        : 'finalization_pending';
    }

    const cancellationRequested = Boolean(await jsonGet(abortKey(entry.jobId)));
    if (cancellationRequested) {
      await finalizeError(entry.jobId, jobRequest, 'Job canceled by user');
      return (await acknowledgeTerminalEntry(entry))
        ? 'completed'
        : 'finalization_pending';
    }

    const payload = await loadStreamQueuePayload(entry.jobId);
    if (jobRequest.executionMode === 'stream' && !payload) {
      await finalizeError(
        entry.jobId,
        jobRequest,
        'The durable stream payload expired before a worker could process it.',
      );
      return (await acknowledgeTerminalEntry(entry))
        ? 'missing'
        : 'finalization_pending';
    }

    if (entry.reclaimed && !backendStarted) {
      jobRequest = await refreshBackendForReclaim(entry.jobId, jobRequest);
    }

    heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight || controller.signal.aborted) return;
      heartbeatInFlight = true;
      void renewStreamLease(entry.jobId, ownerToken, options.leaseTtlMs)
        .then((renewed) => {
          if (!renewed) abortForLostLease();
        })
        .catch(() => abortForLostLease())
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, options.heartbeatMs);
    heartbeatTimer.unref?.();

    cancellationTimer = setInterval(() => {
      if (cancellationCheckInFlight || controller.signal.aborted) return;
      cancellationCheckInFlight = true;
      void jsonGet(abortKey(entry.jobId))
        .then((canceled) => {
          if (canceled && !controller.signal.aborted) {
            controller.abort(new Error('Job canceled by user'));
          }
        })
        .catch((error) => {
          logger.warn(`Job ${entry.jobId}: cancellation check failed`, error);
        })
        .finally(() => {
          cancellationCheckInFlight = false;
        });
    }, options.cancellationPollMs);
    cancellationTimer.unref?.();

    const beforeBackendRequest = async () => {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      const marked = await markBackendRequestStarted(entry.jobId, ownerToken);
      if (!marked) {
        abortForLostLease();
        throw new StreamLeaseLostError(entry.jobId);
      }
    };

    if (jobRequest.executionMode === 'document_ingest') {
      await startBackgroundDocumentIngest(
        entry.jobId,
        jobRequest,
        jobRequest.userId,
        { signal: controller.signal, beforeBackendRequest },
      );
    } else {
      await startBackgroundStreamReader(
        entry.jobId,
        jobRequest,
        payload!.messagesForNat,
        payload!.verifiedUsername,
        { signal: controller.signal, beforeBackendRequest },
      );
    }

    status = await loadJobStatus(entry.jobId);
    if (isTerminal(status)) {
      return (await acknowledgeTerminalEntry(entry))
        ? 'completed'
        : 'finalization_pending';
    }
    if (status?.status === 'oauth_required') {
      await acknowledgeStreamQueueEntry(entry);
      if (jobRequest.conversationId) {
        await releaseConversationJobGuard(
          jobRequest.userId,
          jobRequest.conversationId,
          entry.jobId,
        ).catch((error) => {
          logger.warn(
            `Job ${entry.jobId}: failed to release conversation guard after OAuth handoff`,
            error,
          );
          return false;
        });
      }
      return 'oauth_required';
    }
    if (controller.signal.aborted) return 'interrupted';

    await finalizeError(
      entry.jobId,
      jobRequest,
      'The backend stream ended without producing a terminal result.',
    );
    return (await acknowledgeTerminalEntry(entry))
      ? 'recovered_as_error'
      : 'finalization_pending';
  } catch (error) {
    if (controller.signal.aborted) return 'interrupted';

    const status = await loadJobStatus(entry.jobId);
    if (isTerminal(status)) {
      try {
        return (await acknowledgeTerminalEntry(entry))
          ? 'recovered_as_error'
          : 'finalization_pending';
      } catch (finalizationError) {
        logger.error(
          `Job ${entry.jobId}: terminal side-effect recovery failed`,
          finalizationError,
        );
        return 'finalization_pending';
      }
    }

    const jobRequest = await loadJobRequest(entry.jobId);
    if (jobRequest) {
      await finalizeError(
        entry.jobId,
        jobRequest,
        error instanceof Error ? error.message : 'Stream worker failed',
      );
      return (await acknowledgeTerminalEntry(entry))
        ? 'recovered_as_error'
        : 'finalization_pending';
    }
    await acknowledgeStreamQueueEntry(entry);
    return 'missing';
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (cancellationTimer) clearInterval(cancellationTimer);
    await releaseStreamLease(entry.jobId, ownerToken).catch(() => false);
  }
}

interface ActiveStreamJob {
  jobId: string;
  controller: AbortController;
  promise: Promise<void>;
}

export class StreamWorkerRuntime {
  private readonly options: StreamWorkerOptions;
  private readonly consumer: string;
  private readonly active = new Map<string, ActiveStreamJob>();
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  private readClient: Redis | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private lastReclaimAt = 0;

  constructor(options: StreamWorkerOptions = streamWorkerOptionsFromEnv()) {
    this.options = options;
    this.consumer = `${hostname()}-${process.pid}-${uuidv4()}`;
  }

  private touchHealth(): void {
    writeFileSync(STREAM_WORKER_HEALTH_FILE, String(Date.now()));
  }

  private setReady(ready: boolean): void {
    if (ready) {
      writeFileSync(STREAM_WORKER_READY_FILE, String(Date.now()));
    } else if (existsSync(STREAM_WORKER_READY_FILE)) {
      unlinkSync(STREAM_WORKER_READY_FILE);
    }
  }

  private dispatch(entry: StreamQueueEntry): void {
    if (this.active.has(entry.jobId)) {
      void acknowledgeDuplicateStreamEntry(entry).catch((error) => {
        logger.warn(
          `Failed to acknowledge duplicate job ${entry.jobId}`,
          error,
        );
      });
      return;
    }

    const controller = new AbortController();
    const activeJob: ActiveStreamJob = {
      jobId: entry.jobId,
      controller,
      promise: Promise.resolve(),
    };
    activeJob.promise = processStreamQueueEntry(entry, this.options, controller)
      .then((outcome) => {
        logger.info(`Job ${entry.jobId}: queue processing ended`, { outcome });
      })
      .catch((error) => {
        logger.error(`Job ${entry.jobId}: unhandled worker failure`, error);
      })
      .finally(() => {
        this.active.delete(entry.jobId);
      });
    this.active.set(entry.jobId, activeJob);
  }

  private async drainActiveJobs(): Promise<void> {
    this.draining = true;
    this.setReady(false);

    const activePromises = () =>
      Array.from(this.active.values()).map((job) => job.promise);
    if (this.active.size > 0) {
      await Promise.race([
        Promise.allSettled(activePromises()),
        sleep(this.options.drainTimeoutMs),
      ]);
    }

    if (this.active.size > 0) {
      logger.warn(
        `Drain deadline reached with ${this.active.size} active stream job(s)`,
      );
      for (const job of this.active.values()) {
        if (!job.controller.signal.aborted) {
          job.controller.abort(new StreamWorkerDrainError());
        }
      }
      await Promise.race([Promise.allSettled(activePromises()), sleep(5000)]);
    }
  }

  beginDrain(): Promise<void> {
    if (!this.drainPromise) {
      this.drainPromise = this.drainActiveJobs();
    }
    return this.drainPromise;
  }

  async run(): Promise<void> {
    this.setReady(false);
    const baseClient = getRedis();
    this.readClient = baseClient.duplicate();
    if (this.readClient.status === 'wait') await this.readClient.connect();
    await ensureStreamConsumerGroup(baseClient);
    this.touchHealth();
    this.setReady(true);
    this.healthTimer = setInterval(() => this.touchHealth(), 5000);
    this.healthTimer.unref?.();

    logger.info('Durable stream worker started', {
      consumer: this.consumer,
      concurrency: this.options.concurrency,
      leaseTtlMs: this.options.leaseTtlMs,
      reclaimIdleMs: this.options.reclaimIdleMs,
    });

    try {
      while (!this.draining) {
        const capacity = this.options.concurrency - this.active.size;
        if (capacity <= 0) {
          await Promise.race(
            Array.from(this.active.values()).map((job) => job.promise),
          );
          continue;
        }

        let entries: StreamQueueEntry[] = [];
        try {
          const now = Date.now();
          if (now - this.lastReclaimAt >= this.options.reclaimScanMs) {
            entries = await claimStaleStreamJobs(
              this.readClient,
              this.consumer,
              this.options.reclaimIdleMs,
              capacity,
            );
            this.lastReclaimAt = now;
          }
          if (entries.length === 0) {
            entries = await readNewStreamJobs(
              this.readClient,
              this.consumer,
              capacity,
              this.options.readBlockMs,
            );
          }
          this.setReady(true);
        } catch (error) {
          this.setReady(false);
          logger.error('Stream queue read failed', error);
          await sleep(1000);
          continue;
        }

        for (const entry of entries.slice(0, capacity)) {
          this.dispatch(entry);
        }
      }
    } finally {
      await this.beginDrain();
      if (this.healthTimer) clearInterval(this.healthTimer);
      this.setReady(false);
      if (this.readClient) this.readClient.disconnect();
    }
  }
}

export function workerHealthcheck(maxAgeMs: number): boolean {
  try {
    return Date.now() - statSync(STREAM_WORKER_HEALTH_FILE).mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

export function workerReadycheck(): boolean {
  return existsSync(STREAM_WORKER_READY_FILE);
}
