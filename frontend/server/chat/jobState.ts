import { Logger } from '@/utils/logger';

import {
  JOB_EXPIRY_SECONDS,
  STATUS_UPDATE_LOCK_TTL_MS,
  sleep,
} from './constants';
import type { AsyncJobStatus } from './types';

import {
  getPublisher,
  getRedis,
  jsonGet,
  jsonSetWithExpiry,
  sessionKey,
} from '@/server/session/redis';
import { v4 as uuidv4 } from 'uuid';

const logger = new Logger('AsyncJob');

// Redis key signalling that a job has been finalized (or is finalizing).
// Set by handleGet before calling finalizeSuccess/finalizeError so the
// background stream reader stops publishing events and status updates.
export const abortKey = (jobId: string) =>
  sessionKey(['async-job-abort', jobId]);
export const finalizerLockKey = (jobId: string) =>
  sessionKey(['async-job-finalizer-lock', jobId]);
export const statusLockKey = (jobId: string) =>
  sessionKey(['async-job-status-lock', jobId]);

export function clearOAuthStatusFields(): Pick<
  AsyncJobStatus,
  'authUrl' | 'oauthState'
> {
  return {
    authUrl: undefined,
    oauthState: undefined,
  };
}

export async function withRedisLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  options?: { retries?: number; retryDelayMs?: number },
): Promise<T | null> {
  const client = getRedis();
  const token = uuidv4();
  const retries = options?.retries ?? 0;
  const retryDelayMs = options?.retryDelayMs ?? 50;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const acquired = await client.set(key, token, 'PX', ttlMs, 'NX');
    if (acquired === 'OK') {
      try {
        return await fn();
      } finally {
        try {
          await client.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            key,
            token,
          );
        } catch {
          // best effort unlock; TTL still prevents deadlock
        }
      }
    }

    if (attempt < retries) {
      await sleep(retryDelayMs);
    }
  }

  return null;
}

export function mapNatStatus(natStatus: string): AsyncJobStatus['status'] {
  switch (natStatus) {
    case 'submitted':
      return 'pending';
    case 'running':
      return 'streaming';
    case 'success':
      return 'completed';
    case 'failure':
    case 'interrupted':
      return 'error';
    default:
      logger.warn(`Unknown NAT job status: ${natStatus}`);
      return 'pending';
  }
}

export function extractNatOutput(
  output: { value: string } | string | null,
): string {
  if (!output) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && 'value' in output)
    return String(output.value);
  return JSON.stringify(output);
}

export function isTerminalJobStatus(status: AsyncJobStatus['status']): boolean {
  return status === 'completed' || status === 'error';
}

export function isPlausibleUnixMs(value: unknown): value is number {
  return typeof value === 'number' && value > 946684800000;
}

export async function updateJobStatus(
  jobId: string,
  updates: Partial<AsyncJobStatus>,
): Promise<void> {
  const statusKey = sessionKey(['async-job-status', jobId]);
  const isTerminalWrite =
    updates.status === 'completed' ||
    updates.status === 'error' ||
    updates.finalizedAt !== undefined;

  const applied = await withRedisLock(
    statusLockKey(jobId),
    STATUS_UPDATE_LOCK_TTL_MS,
    async () => {
      const currentStatus = (await jsonGet(statusKey)) as AsyncJobStatus | null;

      if (!currentStatus) {
        logger.error('Job status not found for update', jobId);
        return false;
      }

      // Finalization guard: prevent the background stream reader from flipping a
      // completed/errored job back to 'streaming' after finalizeSuccess has run.
      // Only terminal status writes (completed / error) are allowed through.
      if (
        currentStatus.finalizedAt &&
        updates.status !== undefined &&
        updates.status !== 'completed' &&
        updates.status !== 'error'
      ) {
        logger.debug(
          `Job ${jobId}: Ignoring status update (status=${updates.status}) — job already finalized`,
        );
        return false;
      }

      const updatedStatus: AsyncJobStatus = {
        ...currentStatus,
        ...updates,
      };

      if (JSON.stringify(updatedStatus) === JSON.stringify(currentStatus)) {
        return false;
      }

      await jsonSetWithExpiry(statusKey, updatedStatus, JOB_EXPIRY_SECONDS);

      // Publish status update via Redis Pub/Sub for WebSocket sidecar
      try {
        const publisher = getPublisher();
        await publisher.publish(
          `job:${jobId}:status`,
          JSON.stringify(updatedStatus),
        );
      } catch (err) {
        logger.error(`Failed to publish job status for ${jobId}`, err);
      }
      return true;
    },
    {
      retries: isTerminalWrite ? 20 : 1,
      retryDelayMs: isTerminalWrite ? 25 : 10,
    },
  );

  if (applied === null && isTerminalWrite) {
    logger.warn(
      `Job ${jobId}: Failed to acquire status lock for terminal update`,
    );
  }
}
