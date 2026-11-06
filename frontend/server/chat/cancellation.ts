import { Logger } from '@/utils/logger';

import { JOB_EXPIRY_SECONDS } from './constants';
import { finalizeError } from './finalization';
import { abortKey, isTerminalJobStatus } from './jobState';
import { forwardCancellation } from './steering';
import { getStreamJobPresence, streamPayloadKey } from './streamQueue';
import {
  type AsyncJobRequest,
  type AsyncJobStatus,
  USER_CANCELLATION_MESSAGE,
} from './types';

import {
  getRedis,
  jsonDel,
  jsonGet,
  jsonSetWithExpiry,
  sessionKey,
} from '@/server/session/redis';
import { readJsonFields } from '@/server/session/redisShared';

const logger = new Logger('AsyncJob');

export interface ChatJobCancellation {
  /** `missing`: no request record; `forbidden`: another user's job. */
  outcome: 'cancelled' | 'missing' | 'forbidden';
  /** Whether this call stopped a live job (or delegated its stop). */
  canceled: boolean;
  /** The job's status before the stop, when it had one. */
  previousStatus?: AsyncJobStatus['status'];
}

/**
 * Stop a user's chat job through the same path as the browser's Stop.
 *
 * A queued or running job keeps its queue payload (and, when running, its
 * lease); the durable abort signal is recorded first and its worker finalizes
 * the stop after flushing accepted output. A job no worker owns is finalized
 * here. Completed external actions are never undone.
 */
export async function cancelChatJob(
  userId: string,
  jobId: string,
): Promise<ChatJobCancellation> {
  const requestKey = sessionKey(['async-job-request', jobId]);
  const statusKey = sessionKey(['async-job-status', jobId]);
  // Ownership and backend cancellation need only the request's routing
  // fields, not the conversation history it carries.
  const [jobMeta, currentStatus] = await Promise.all([
    readJsonFields<AsyncJobRequest>(getRedis(), requestKey, [
      'jobId',
      'userId',
      'executionMode',
      'natBaseUrl',
      'natSessionId',
      'timezone',
      'conversationId',
    ]),
    jsonGet(statusKey) as Promise<AsyncJobStatus | null>,
  ]);
  if (!jobMeta) return { outcome: 'missing', canceled: false };
  if (jobMeta.userId !== userId)
    return { outcome: 'forbidden', canceled: false };

  let canceled = false;
  let workerOwnsFinalization = false;
  if (currentStatus && !isTerminalJobStatus(currentStatus.status)) {
    // Signal before checking ownership so a worker still holding the payload
    // observes the stop. A live status without a payload or lease has no
    // worker owner; finish it here.
    await jsonSetWithExpiry(abortKey(jobId), true, JOB_EXPIRY_SECONDS);
    const [afterAbort, presence] = await Promise.all([
      jsonGet(statusKey) as Promise<AsyncJobStatus | null>,
      getStreamJobPresence(jobId),
    ]);
    // A queued or running job keeps its queue payload until a worker
    // acknowledges its terminal status, and a running one also holds the
    // lease. Without either, including a pending job whose submitting
    // process stopped before queueing it, no worker will observe the stop.
    workerOwnsFinalization =
      ['stream', 'document_ingest'].includes(jobMeta.executionMode ?? '') &&
      Boolean(afterAbort) &&
      !isTerminalJobStatus(afterAbort!.status) &&
      (presence.payload || presence.lease);
    if (workerOwnsFinalization) {
      // Let the stream owner flush accepted output before claiming the
      // terminal snapshot. The durable queue also handles queued jobs and
      // worker replacement; keep its request/payload available until then.
      canceled = true;
      // The durable abort remains authoritative if the run is queued or the
      // backend is unreachable. Only a leased job can have a backend run to
      // signal; a queued one would just wait on a control call that no run
      // can answer. Active runs get an immediate signal.
      if (jobMeta.executionMode === 'stream' && presence.lease)
        await forwardCancellation(jobMeta as AsyncJobRequest).catch(() => {
          logger.warn(
            'Backend cancellation unavailable; worker abort remains active',
            { jobId },
          );
        });
    } else {
      // Finalizing here saves the turn, which needs the whole request.
      const jobRequest = (await jsonGet(requestKey)) as AsyncJobRequest | null;
      canceled = jobRequest
        ? await finalizeError(jobId, jobRequest, USER_CANCELLATION_MESSAGE)
        : false;
    }
  }

  if (canceled && !workerOwnsFinalization) {
    await Promise.all([jsonDel(requestKey), jsonDel(streamPayloadKey(jobId))]);
  }

  return {
    outcome: 'cancelled',
    canceled,
    ...(currentStatus ? { previousStatus: currentStatus.status } : {}),
  };
}
