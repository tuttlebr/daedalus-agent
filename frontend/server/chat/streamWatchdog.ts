import { Logger } from '@/utils/logger';

import {
  FINALIZER_LOCK_TTL_MS,
  JOB_EXPIRY_SECONDS,
  STREAM_JOB_STALE_TIMEOUT_MS,
} from './constants';
import { finalizeError } from './finalization';
import {
  finalizerLockKey,
  isTerminalJobStatus,
  withRedisLock,
} from './jobState';
import type { AsyncJobRequest, AsyncJobStatus } from './types';

import { positiveIntegerFromEnv } from '@/server/config/env';
import { getRedis, jsonGet, sessionKey } from '@/server/session/redis';

const logger = new Logger('StreamWatchdog');

// Redis set indexing in-flight stream jobs so the watchdog can find orphans —
// jobs whose owning Node process died mid-stream — without scanning the
// keyspace. After a pod restart, the first new submission re-arms the sweeper,
// which then finalizes any orphans left by the previous process generation.
const STREAM_JOB_INDEX_KEY = sessionKey(['async-stream-jobs']);

const SWEEP_INTERVAL_MS =
  positiveIntegerFromEnv('STREAM_WATCHDOG_SWEEP_SECONDS', 120) * 1000;

let sweepTimer: NodeJS.Timeout | null = null;

// Register a stream job so the watchdog can finalize it if the process that
// owns its stream reader dies before finalization.
export async function registerStreamJob(jobId: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.sadd(STREAM_JOB_INDEX_KEY, jobId);
    // Bound the index lifetime to the job TTL so a missed SREM self-expires.
    await redis.expire(STREAM_JOB_INDEX_KEY, JOB_EXPIRY_SECONDS);
  } catch (err) {
    logger.warn(`Failed to register stream job ${jobId} with watchdog`, err);
  }
}

export async function deregisterStreamJob(jobId: string): Promise<void> {
  try {
    await getRedis().srem(STREAM_JOB_INDEX_KEY, jobId);
  } catch {
    // Non-fatal: the sweeper drops terminal/expired entries on its own.
  }
}

export async function sweepStreamJobs(): Promise<void> {
  const redis = getRedis();
  let jobIds: string[];
  try {
    jobIds = await redis.smembers(STREAM_JOB_INDEX_KEY);
  } catch (err) {
    logger.warn('Stream watchdog sweep failed to read index', err);
    return;
  }

  const now = Date.now();
  for (const jobId of jobIds) {
    try {
      const statusKey = sessionKey(['async-job-status', jobId]);
      const status = (await jsonGet(statusKey)) as AsyncJobStatus | null;

      // Gone (expired/cleaned) or already finalized → drop from the index.
      if (!status || status.finalizedAt || isTerminalJobStatus(status.status)) {
        await redis.srem(STREAM_JOB_INDEX_KEY, jobId);
        continue;
      }

      const lastActivityAt = status.updatedAt || status.createdAt || 0;
      if (now - lastActivityAt <= STREAM_JOB_STALE_TIMEOUT_MS) {
        continue; // still progressing
      }

      const jobRequest = (await jsonGet(
        sessionKey(['async-job-request', jobId]),
      )) as AsyncJobRequest | null;
      if (!jobRequest) {
        await redis.srem(STREAM_JOB_INDEX_KEY, jobId);
        continue;
      }

      // Serialize with the normal finalization lock and re-check finalizedAt so
      // we never race a live reader or another pod's watchdog.
      await withRedisLock(
        finalizerLockKey(jobId),
        FINALIZER_LOCK_TTL_MS,
        async () => {
          const fresh = (await jsonGet(statusKey)) as AsyncJobStatus | null;
          if (
            !fresh ||
            fresh.finalizedAt ||
            isTerminalJobStatus(fresh.status)
          ) {
            return;
          }
          logger.warn(
            `Job ${jobId}: stream produced no update for >${
              STREAM_JOB_STALE_TIMEOUT_MS / 1000
            }s; finalizing as error (orphaned reader).`,
          );
          await finalizeError(
            jobId,
            jobRequest,
            'The response stream stopped unexpectedly before completing. Please try again.',
          );
        },
      );
      await redis.srem(STREAM_JOB_INDEX_KEY, jobId);
    } catch (err) {
      logger.warn(`Stream watchdog failed to process job ${jobId}`, err);
    }
  }
}

// Lazily start a process-singleton sweeper. Safe to call on every stream-job
// submission; only the first call arms the interval.
export function ensureStreamJobWatchdog(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void sweepStreamJobs();
  }, SWEEP_INTERVAL_MS);
  // Don't keep the process alive solely for the sweeper.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}
