import { updateJsonAtomically } from '@/server/atomicJson';
import { jsonGet, sessionKey } from '@/server/session/redis';
import { randomUUID } from 'crypto';

export const IMAGE_JOB_TTL_SECONDS = 3600;
export const IMAGE_JOB_LEASE_MS = 60_000;
const LEGACY_EXECUTION_GRACE_MS = 390_000;
const processOwner = randomUUID();

export interface RecoverableImageJob {
  jobId: string;
  userId: string;
  status: 'queued' | 'running' | 'completed' | 'error' | 'cancelled';
  updatedAt: number;
  executionOwner?: string;
  leaseExpiresAt?: number;
  error?: string;
  completedAt?: number;
}

export function imageJobKey(jobId: string): string {
  return sessionKey(['image-job', jobId]);
}

function active(job: RecoverableImageJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}

function expired(job: RecoverableImageJob): boolean {
  // Legacy processes have no heartbeat: allow their provider budget plus
  // persistence grace before classifying an old record as interrupted.
  return (
    (job.leaseExpiresAt ?? job.updatedAt + LEGACY_EXECUTION_GRACE_MS) <=
    Date.now()
  );
}

export async function createRecoverableImageJob<T extends RecoverableImageJob>(
  job: T,
): Promise<T> {
  return (await updateJsonAtomically<T>(
    imageJobKey(job.jobId),
    (current) => {
      if (current) throw new Error('Image job ID already exists');
      return {
        ...job,
        executionOwner: processOwner,
        leaseExpiresAt: Date.now() + IMAGE_JOB_LEASE_MS,
      };
    },
    IMAGE_JOB_TTL_SECONDS,
  )) as T;
}

export async function updateOwnedImageJob<T extends RecoverableImageJob>(
  jobId: string,
  updates: Partial<T>,
): Promise<T | null> {
  return updateJsonAtomically<T>(
    imageJobKey(jobId),
    (current) => {
      if (
        !current ||
        !active(current) ||
        current.executionOwner !== processOwner ||
        expired(current)
      )
        return null;
      return {
        ...current,
        ...updates,
        updatedAt: Date.now(),
        leaseExpiresAt: Date.now() + IMAGE_JOB_LEASE_MS,
      };
    },
    IMAGE_JOB_TTL_SECONDS,
  );
}

export async function loadRecoverableImageJob<T extends RecoverableImageJob>(
  jobId: string,
  userId: string,
): Promise<T | null> {
  const current = (await jsonGet(imageJobKey(jobId))) as T | null;
  if (!current || current.userId !== userId) return null;
  if (!active(current) || !expired(current)) return current;
  return updateJsonAtomically<T>(
    imageJobKey(jobId),
    (latest) => {
      if (!latest || latest.userId !== userId) return null;
      if (!active(latest) || !expired(latest)) return latest;
      return {
        ...latest,
        status: 'error',
        error:
          'Image generation was interrupted and its result is unconfirmed. Check existing outputs before starting a new request; the provider may have completed it.',
        completedAt: Date.now(),
        updatedAt: Date.now(),
      };
    },
    IMAGE_JOB_TTL_SECONDS,
  );
}

export async function cancelImageJob<T extends RecoverableImageJob>(
  jobId: string,
  userId: string,
): Promise<T | null> {
  return updateJsonAtomically<T>(
    imageJobKey(jobId),
    (current) => {
      if (!current || current.userId !== userId) return null;
      if (!active(current)) return current;
      return {
        ...current,
        status: 'cancelled',
        completedAt: Date.now(),
        updatedAt: Date.now(),
      };
    },
    IMAGE_JOB_TTL_SECONDS,
  );
}

export function watchImageJobCancellation(
  jobId: string,
  onCancelled: () => void,
): () => void {
  let pending = false;
  let stopped = false;
  const timer = setInterval(async () => {
    if (pending || stopped) return;
    pending = true;
    try {
      const job = await jsonGet(imageJobKey(jobId));
      if (!stopped && job?.status === 'cancelled') onCancelled();
    } catch {
      // Lease renewal handles Redis outages; retry cancellation observation.
    } finally {
      pending = false;
    }
  }, 250);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Renew the job's lease while its provider request runs. Only proof that
 * ownership ended stops the request: a renewal that returns null (another
 * owner, a terminal status or an expired lease), or a lease validity window
 * that elapsed without a successful renewal. A renewal that merely failed to
 * reach Redis is retried on the next beat, as the stream worker does: no one
 * else can take the lease before its TTL ends.
 */
export function heartbeatImageJob(
  jobId: string,
  onLost: (error: Error) => void,
): () => void {
  let stopped = false;
  let pending = false;
  let leaseValidUntil = Date.now() + IMAGE_JOB_LEASE_MS;
  const timer = setInterval(async () => {
    if (stopped || pending) return;
    pending = true;
    const requestedAt = Date.now();
    try {
      if (!(await updateOwnedImageJob(jobId, {}))) {
        if (!stopped) onLost(new Error('Image execution lease was lost'));
        return;
      }
      leaseValidUntil = Math.max(
        leaseValidUntil,
        requestedAt + IMAGE_JOB_LEASE_MS,
      );
    } catch (error) {
      if (!stopped && Date.now() >= leaseValidUntil)
        onLost(
          error instanceof Error
            ? error
            : new Error('Image execution lease could not be renewed'),
        );
    } finally {
      pending = false;
    }
  }, IMAGE_JOB_LEASE_MS / 4);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
