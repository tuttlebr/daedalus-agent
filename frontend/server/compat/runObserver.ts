import { parseMcpApprovalMarker } from '@/utils/app/mcpApproval';

import {
  type AsyncJobStatus,
  type RunUsage,
  USER_CANCELLATION_MESSAGE,
} from '@/server/chat/types';
import { jsonGet, sessionKey } from '@/server/session/redis';

/**
 * Normalized run events for protocol encoders. They are derived from the same
 * Redis job record the web application reads; tool progress, intermediate
 * steps and reasoning never appear here.
 */
export type RunOutcome =
  | { kind: 'completed'; text: string; usage?: RunUsage }
  | { kind: 'approval_required'; conversationId?: string; summary?: string }
  | { kind: 'oauth_required'; service?: string }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' };

/**
 * Longest wait for one run: the backend's 30-minute run deadline plus queue
 * time, below the job record's one-hour lifetime.
 */
export const COMPAT_RUN_WAIT_MS = 40 * 60 * 1000;
const FAST_POLL_MS = 250;
const SLOW_POLL_MS = 750;
const FAST_POLL_WINDOW_MS = 5000;

export class RunWaitTimeoutError extends Error {
  constructor() {
    super('The run did not finish within the API wait limit.');
    this.name = 'RunWaitTimeoutError';
  }
}

export async function readJobStatus(
  jobId: string,
): Promise<AsyncJobStatus | null> {
  return (await jsonGet(
    sessionKey(['async-job-status', jobId]),
  )) as AsyncJobStatus | null;
}

/** The outcome a status represents, or null while the run is still live. */
export function outcomeFromStatus(
  status: AsyncJobStatus | null,
): RunOutcome | null {
  if (!status) return { kind: 'unavailable' };
  if (status.status === 'oauth_required') {
    return {
      kind: 'oauth_required',
      ...(status.oauthRequests?.[0]?.service
        ? { service: status.oauthRequests[0].service }
        : {}),
    };
  }
  if (status.status === 'completed') {
    const text = status.fullResponse ?? '';
    const marker = parseMcpApprovalMarker(text);
    if (marker) {
      return {
        kind: 'approval_required',
        ...(status.conversationId
          ? { conversationId: status.conversationId }
          : {}),
        ...(marker.summary ? { summary: marker.summary } : {}),
      };
    }
    return {
      kind: 'completed',
      text,
      ...(status.usage ? { usage: status.usage } : {}),
    };
  }
  if (status.status === 'error') {
    return status.error === USER_CANCELLATION_MESSAGE
      ? { kind: 'cancelled' }
      : {
          kind: 'failed',
          message: status.error || 'The run failed.',
        };
  }
  return null;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wait for a job's outcome by polling its status record. Terminal statuses
 * are written once by finalization with the final answer, so the answer is
 * read whole rather than reassembled from live deltas. Rejects with the
 * signal's reason when aborted and with RunWaitTimeoutError at the deadline.
 */
export async function waitForRunOutcome(
  jobId: string,
  options: {
    signal: AbortSignal;
    deadlineMs?: number;
    onStatus?: (status: AsyncJobStatus['status']) => void;
  },
): Promise<RunOutcome> {
  const started = Date.now();
  const deadline = started + (options.deadlineMs ?? COMPAT_RUN_WAIT_MS);
  let lastStatus: AsyncJobStatus['status'] | null = null;
  for (;;) {
    const status = await readJobStatus(jobId);
    if (status && status.status !== lastStatus) {
      lastStatus = status.status;
      options.onStatus?.(status.status);
    }
    const outcome = outcomeFromStatus(status);
    if (outcome) return outcome;
    if (Date.now() >= deadline) throw new RunWaitTimeoutError();
    await delay(
      Date.now() - started < FAST_POLL_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS,
      options.signal,
    );
  }
}
