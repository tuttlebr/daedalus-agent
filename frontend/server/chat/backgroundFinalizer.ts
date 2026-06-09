import { Logger } from '@/utils/logger';

import { fetchNatJobStatus } from './backendSelection';
import {
  FINALIZER_MAX_RUNTIME_MS,
  FINALIZER_POLL_INTERVAL_MS,
  sleep,
} from './constants';
import { finalizeFromNatStatus } from './finalization';
import {
  abortKey,
  clearOAuthStatusFields,
  isTerminalJobStatus,
  mapNatStatus,
  updateJobStatus,
} from './jobState';
import type {
  AsyncJobRequest,
  AsyncJobStatus,
  NatAsyncJobResponse,
} from './types';

import { jsonGet, sessionKey } from '@/server/session/redis';

const logger = new Logger('AsyncJob');

// Process-singleton set of jobs with an active finalizer (one instance per
// Node process via the module cache — same semantics as before extraction).
const backgroundFinalizers = new Set<string>();

export function launchBackgroundFinalizer(
  jobId: string,
  jobRequest: AsyncJobRequest,
): void {
  if (backgroundFinalizers.has(jobId)) return;
  backgroundFinalizers.add(jobId);
  startBackgroundFinalizer(jobId, jobRequest)
    .catch((err) => {
      logger.error(`Job ${jobId}: Background finalizer failed`, err);
    })
    .finally(() => {
      backgroundFinalizers.delete(jobId);
    });
}

async function startBackgroundFinalizer(
  jobId: string,
  jobRequest: AsyncJobRequest,
): Promise<void> {
  const startedAt = Date.now();
  const statusKey = sessionKey(['async-job-status', jobId]);
  const stepsKey = sessionKey(['async-job-steps', jobId]);

  while (Date.now() - startedAt < FINALIZER_MAX_RUNTIME_MS) {
    const status = (await jsonGet(statusKey)) as AsyncJobStatus | null;
    if (!status) return;
    if (status.finalizedAt || isTerminalJobStatus(status.status)) return;

    const shouldAbort = await jsonGet(abortKey(jobId));
    if (shouldAbort && status.finalizedAt) return;

    try {
      const natStatus = await fetchNatJobStatus(jobId, jobRequest);
      if (!natStatus) {
        await sleep(FINALIZER_POLL_INTERVAL_MS);
        continue;
      }

      const mapped = mapNatStatus(natStatus.status);
      if (mapped === 'pending' || mapped === 'streaming') {
        const liveSteps = (await jsonGet(stepsKey)) as any[] | null;
        const keepOAuthPrompt =
          status.status === 'oauth_required' &&
          (Boolean(status.authUrl) || Boolean(status.oauthRequests?.length));
        await updateJobStatus(jobId, {
          status: keepOAuthPrompt ? 'oauth_required' : mapped,
          progress: keepOAuthPrompt ? 0 : mapped === 'streaming' ? 50 : 0,
          ...(keepOAuthPrompt ? {} : clearOAuthStatusFields()),
          ...(liveSteps?.length ? { intermediateSteps: liveSteps } : {}),
          updatedAt: Date.now(),
        });
      } else {
        await finalizeFromNatStatus(jobId, jobRequest, natStatus);
        return;
      }
    } catch (err) {
      logger.warn(`Job ${jobId}: Background finalizer poll failed`, err);
    }

    await sleep(FINALIZER_POLL_INTERVAL_MS);
  }

  const timeoutStatus: NatAsyncJobResponse = {
    job_id: jobId,
    status: 'failure',
    error: `Async job did not finalize within ${
      FINALIZER_MAX_RUNTIME_MS / 1000
    }s`,
    output: null,
    created_at: '',
    updated_at: '',
    expires_at: '',
  };
  await finalizeFromNatStatus(jobId, jobRequest, timeoutStatus).catch((err) => {
    logger.error(`Job ${jobId}: Failed timeout finalization`, err);
  });
}
