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
  status: 'queued' | 'running' | 'completed' | 'error';
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

export function heartbeatImageJob(
  jobId: string,
  onLost: (error: Error) => void,
): () => void {
  let stopped = false;
  let pending = false;
  const timer = setInterval(async () => {
    if (stopped || pending) return;
    pending = true;
    try {
      if (!(await updateOwnedImageJob(jobId, {})))
        throw new Error('Image execution lease was lost');
    } catch (error) {
      if (!stopped)
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
