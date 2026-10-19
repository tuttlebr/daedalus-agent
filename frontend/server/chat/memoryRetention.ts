import {
  buildBackendBaseUrlForMode,
  buildBackendUrlFromBase,
} from '@/utils/app/backendApi';
import { isMcpApprovalMarkerMessage } from '@/utils/app/mcpApproval';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout';
import { Logger } from '@/utils/logger';

import { buildNatRequestHeaders } from '@/server/chat/natMessages';
import {
  getRedis,
  jsonGet,
  jsonSetWithExpiry,
  sessionKey,
} from '@/server/session/redis';
import { v4 as uuidv4 } from 'uuid';

const logger = new Logger('MemoryRetention');
const RETENTION_RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;
const RETENTION_TIMEOUT_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const POLL_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000];
const RETAIN_MAX_PART_CHARS = 5_500;
// A submission holds turn text only until the backend accepts it or the
// retention deadline passes; this TTL bounds it if no worker polls.
const SUBMISSION_TTL_SECONDS = 24 * 60 * 60;
// Enough to ride out a backend restart (about two minutes with the poll
// backoff) without retrying a turn indefinitely.
const MAX_SUBMISSION_ATTEMPTS = 6;
// Other statuses do not change on retry: the runtime answers 503 when memory
// is not enabled, and 4xx for a request it will never accept.
const RETRYABLE_SUBMISSION_STATUSES = new Set([408, 429, 500, 502, 504]);

class RetentionRejectedError extends Error {
  constructor(readonly status?: number) {
    super(
      status === undefined
        ? 'memory retention returned no operation ID'
        : `memory retention returned HTTP ${status}`,
    );
    this.name = 'RetentionRejectedError';
  }
}

export type MemoryRetentionStatus =
  | 'accepted'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'zero_fact'
  | 'failed'
  | 'cancelled'
  | 'not_found'
  | 'timed_out';

export interface MemoryRetentionRecord {
  jobId: string;
  userId: string;
  operationId: string;
  status: MemoryRetentionStatus;
  acceptedAt: number;
  updatedAt: number;
  completedAt?: number;
  unitIdsCount?: number;
  extractionErrorsCount?: number;
  retryCount: number;
  retrySubmitted: boolean;
  notFoundCount: number;
  pollIndex: number;
}

export interface MemoryRetentionHealth {
  total: number;
  counts: Record<MemoryRetentionStatus, number>;
  recent: Array<Omit<MemoryRetentionRecord, 'userId'>>;
}

const queueKey = () => sessionKey(['memory-retention', 'queue', 'v1']);
// Submissions have their own queue: a poller from an earlier version drops
// queue entries that have no accepted record, which a submission lacks.
const submissionQueueKey = () =>
  sessionKey(['memory-retention', 'submission-queue', 'v1']);
const submissionKey = (jobId: string) =>
  sessionKey(['memory-retention', 'submission', 'v1', jobId]);
const recordKey = (jobId: string) =>
  sessionKey(['memory-retention', 'record', 'v1', jobId]);
const recordLockKey = (jobId: string) =>
  sessionKey(['memory-retention', 'lock', 'v1', jobId]);
const userIndexKey = (userId: string) =>
  sessionKey(['memory-retention', 'user', userId, 'v1']);

/**
 * A completed turn waiting to be sent to the backend's memory service. The
 * finalization journal write that records the attempt creates it, so chat
 * completion never waits for the memory service; the worker's retention poll
 * sends it. The backend derives the stored document and its operation from the
 * request ID and content, so a repeated send after a lost reply is idempotent.
 */
export interface MemoryRetentionSubmission {
  version: 1;
  jobId: string;
  userId: string;
  conversationId: string;
  assistantMessageId: string;
  userContent: string;
  assistantContent: string;
  createdAt: number;
  attempts: number;
}

export interface MemoryRetentionSubmissionWrite {
  key: string;
  queueKey: string;
  value: string;
  ttlSeconds: number;
  dueAt: number;
}

function latestUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user' || typeof message?.content !== 'string') {
      continue;
    }
    return message.content.trim();
  }
  return '';
}

function sanitizeRetentionText(value: string): string {
  return value
    .replace(
      /\[(?:IDENTITY|MEMORY_CONTEXT|SOURCE_POLICY)\][\s\S]*?(?=\n\[[A-Z_]+\]|$)/gi,
      '',
    )
    .replace(/data:[^\s)\]]+/gi, '[embedded data omitted]')
    .replace(/redis(?:s)?:\/\/[^\s)\]]+/gi, '[internal reference omitted]')
    .trim()
    .slice(0, RETAIN_MAX_PART_CHARS);
}

/** The submission for a successfully completed, still-owned turn, if any. */
export function buildMemoryRetentionSubmission(input: {
  jobId: string;
  userId: string;
  conversationId: string;
  assistantMessageId: string;
  messages: unknown;
  content: string;
  createdAt: number;
}): MemoryRetentionSubmissionWrite | null {
  if (isMcpApprovalMarkerMessage(input.content)) return null;
  const userContent = sanitizeRetentionText(latestUserText(input.messages));
  if (!userContent) return null;
  const submission: MemoryRetentionSubmission = {
    version: 1,
    jobId: input.jobId,
    userId: input.userId,
    conversationId: input.conversationId,
    assistantMessageId: input.assistantMessageId,
    userContent,
    assistantContent: sanitizeRetentionText(input.content),
    createdAt: input.createdAt,
    attempts: 0,
  };
  return {
    key: submissionKey(input.jobId),
    queueKey: submissionQueueKey(),
    value: JSON.stringify(submission),
    ttlSeconds: SUBMISSION_TTL_SECONDS,
    dueAt: input.createdAt,
  };
}

async function readSubmission(
  jobId: string,
): Promise<MemoryRetentionSubmission | null> {
  const raw = await getRedis().get(submissionKey(jobId));
  if (!raw) return null;
  try {
    const submission = JSON.parse(raw) as MemoryRetentionSubmission;
    if (submission?.version === 1 && submission.jobId === jobId) {
      return submission;
    }
  } catch {
    // Fall through: an unreadable submission cannot be sent.
  }
  logger.warn(`Discarding an invalid retention submission for ${jobId}`);
  await getRedis().del(submissionKey(jobId));
  await getRedis().zrem(submissionQueueKey(), jobId);
  return null;
}

async function submitRetention(
  submission: MemoryRetentionSubmission,
): Promise<string> {
  const response = await fetchWithTimeout(
    buildBackendUrlFromBase(
      buildBackendBaseUrlForMode(),
      '/v1/memory/retain-turn',
    ),
    {
      method: 'POST',
      headers: buildNatRequestHeaders(
        submission.userId,
        { 'Content-Type': 'application/json' },
        undefined,
        undefined,
        submission.conversationId,
        submission.jobId,
      ),
      body: JSON.stringify({
        request_id: submission.jobId,
        conversation_id: submission.conversationId,
        assistant_message_id: submission.assistantMessageId,
        user_content: submission.userContent,
        assistant_content: submission.assistantContent,
      }),
    },
    REQUEST_TIMEOUT_MS,
  );
  if (!response.ok) {
    // Release the connection and deadline timer instead of leaving an unread
    // diagnostic body open until fetchWithTimeout aborts it.
    await response.body?.cancel().catch(() => undefined);
    throw new RetentionRejectedError(response.status);
  }
  const body = (await response.json()) as { operation_id?: string };
  if (!body.operation_id) throw new RetentionRejectedError();
  return body.operation_id;
}

/** Send a queued turn; retry with backoff until the retention deadline. */
async function processSubmission(
  submission: MemoryRetentionSubmission,
): Promise<void> {
  const redis = getRedis();
  const { jobId } = submission;
  const now = Date.now();
  const accepted = (await jsonGet(
    recordKey(jobId),
  )) as MemoryRetentionRecord | null;
  if (accepted?.operationId) {
    // Accepted before its submission could be removed; polling owns it now.
    await redis.zadd(queueKey(), now + POLL_DELAYS_MS[0], jobId);
    await redis.del(submissionKey(jobId));
    await redis.zrem(submissionQueueKey(), jobId);
    return;
  }
  if (now - submission.createdAt >= RETENTION_TIMEOUT_MS) {
    logger.warn(`Retention submission for ${jobId} expired unsent`);
    await redis.del(submissionKey(jobId));
    await redis.zrem(submissionQueueKey(), jobId);
    return;
  }
  let operationId: string;
  try {
    operationId = await submitRetention(submission);
  } catch (error) {
    // The optional memory service may be unavailable; chat completion has
    // already been published. A transient failure is retried with backoff.
    logger.warn(`Automatic memory retention failed for ${jobId}`, error);
    const permanent =
      error instanceof RetentionRejectedError &&
      (error.status === undefined ||
        !RETRYABLE_SUBMISSION_STATUSES.has(error.status));
    if (permanent || submission.attempts + 1 >= MAX_SUBMISSION_ATTEMPTS) {
      await redis.del(submissionKey(jobId));
      await redis.zrem(submissionQueueKey(), jobId);
      return;
    }
    const retry: MemoryRetentionSubmission = {
      ...submission,
      attempts: submission.attempts + 1,
    };
    await redis.set(
      submissionKey(jobId),
      JSON.stringify(retry),
      'EX',
      SUBMISSION_TTL_SECONDS,
    );
    await redis.zadd(
      submissionQueueKey(),
      now +
        POLL_DELAYS_MS[
          Math.min(submission.attempts, POLL_DELAYS_MS.length - 1)
        ],
      jobId,
    );
    return;
  }
  // Record the accepted operation before dropping the submission: a crash in
  // between re-sends the same idempotent request instead of losing it.
  await enqueueMemoryRetention({
    jobId,
    userId: submission.userId,
    operationId,
    acceptedAt: now,
  });
  await redis.del(submissionKey(jobId));
  await redis.zrem(submissionQueueKey(), jobId);
}

async function persistRecord(
  record: MemoryRetentionRecord,
  nextPollAt?: number,
): Promise<void> {
  const redis = getRedis();
  await jsonSetWithExpiry(
    recordKey(record.jobId),
    record,
    RETENTION_RECORD_TTL_SECONDS,
  );
  await redis.zadd(
    userIndexKey(record.userId),
    record.acceptedAt,
    record.jobId,
  );
  await redis.expire(userIndexKey(record.userId), RETENTION_RECORD_TTL_SECONDS);
  await redis.zremrangebyrank(userIndexKey(record.userId), 0, -101);
  if (nextPollAt !== undefined) {
    await redis.zadd(queueKey(), nextPollAt, record.jobId);
  } else {
    await redis.zrem(queueKey(), record.jobId);
  }
}

export async function enqueueMemoryRetention(input: {
  jobId: string;
  userId: string;
  operationId: string;
  acceptedAt?: number;
}): Promise<MemoryRetentionRecord> {
  const acceptedAt = input.acceptedAt ?? Date.now();
  const existing = (await jsonGet(
    recordKey(input.jobId),
  )) as MemoryRetentionRecord | null;
  if (existing?.operationId === input.operationId) {
    await getRedis().zadd(
      queueKey(),
      Date.now() + POLL_DELAYS_MS[0],
      input.jobId,
    );
    return existing;
  }
  const record: MemoryRetentionRecord = {
    jobId: input.jobId,
    userId: input.userId,
    operationId: input.operationId,
    status: 'accepted',
    acceptedAt,
    updatedAt: acceptedAt,
    retryCount: 0,
    retrySubmitted: false,
    notFoundCount: 0,
    pollIndex: 0,
  };
  await persistRecord(record, acceptedAt + POLL_DELAYS_MS[0]);
  return record;
}

function nextDelay(record: MemoryRetentionRecord): number {
  return POLL_DELAYS_MS[Math.min(record.pollIndex, POLL_DELAYS_MS.length - 1)];
}

async function backendRequest(
  record: MemoryRetentionRecord,
  method: 'GET' | 'POST',
  suffix = '',
): Promise<Response> {
  const encodedId = encodeURIComponent(record.operationId);
  return fetchWithTimeout(
    buildBackendUrlFromBase(
      buildBackendBaseUrlForMode(),
      `/v1/memory/operations/${encodedId}${suffix}`,
    ),
    {
      method,
      headers: buildNatRequestHeaders(record.userId, {
        Accept: 'application/json',
      }),
    },
    REQUEST_TIMEOUT_MS,
  );
}

async function releaseLock(key: string, token: string): Promise<void> {
  await getRedis().eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    1,
    key,
    token,
  );
}

/** Send or poll one job's retention, if it is not being processed elsewhere. */
export async function processMemoryRetention(jobId: string): Promise<void> {
  const redis = getRedis();
  const lockKey = recordLockKey(jobId);
  const token = uuidv4();
  if ((await redis.set(lockKey, token, 'PX', 30_000, 'NX')) !== 'OK') return;
  try {
    const submission = await readSubmission(jobId);
    if (submission) {
      await processSubmission(submission);
      return;
    }
    const record = (await jsonGet(
      recordKey(jobId),
    )) as MemoryRetentionRecord | null;
    if (!record) {
      await redis.zrem(queueKey(), jobId);
      await redis.zrem(submissionQueueKey(), jobId);
      return;
    }
    const now = Date.now();
    if (now - record.acceptedAt >= RETENTION_TIMEOUT_MS) {
      record.status = 'timed_out';
      record.updatedAt = now;
      record.completedAt = now;
      await persistRecord(record);
      return;
    }

    let response: Response;
    try {
      response = await backendRequest(record, 'GET');
    } catch (error) {
      logger.warn(`Retention status request failed for ${jobId}`, error);
      record.updatedAt = now;
      record.pollIndex += 1;
      await persistRecord(record, now + nextDelay(record));
      return;
    }
    let body: {
      status?: MemoryRetentionStatus;
      unit_ids_count?: number;
      extraction_errors_count?: number;
      retry_count?: number;
    } | null = null;
    if (response.ok) {
      body = await response.json().catch(() => null);
    } else {
      // fetchWithTimeout holds its deadline and connection until the body is
      // consumed or cancelled; the status code is the whole result here.
      await response.body?.cancel().catch(() => undefined);
    }
    if (!body || typeof body !== 'object') {
      logger.warn(
        `Retention status returned an unusable HTTP ${response.status} response for ${jobId}`,
      );
      record.updatedAt = now;
      record.pollIndex += 1;
      await persistRecord(record, now + nextDelay(record));
      return;
    }
    const status = body.status || 'not_found';
    record.status = status;
    record.updatedAt = now;
    record.unitIdsCount = Number(body.unit_ids_count || 0);
    record.extractionErrorsCount = Number(body.extraction_errors_count || 0);
    record.retryCount = Number(body.retry_count || record.retryCount || 0);

    if (
      status === 'completed' ||
      status === 'zero_fact' ||
      status === 'cancelled'
    ) {
      record.completedAt = now;
      await persistRecord(record);
      return;
    }
    if (status === 'failed') {
      if (!record.retrySubmitted) {
        const retry = await backendRequest(record, 'POST', '/retry').catch(
          () => null,
        );
        await retry?.body?.cancel().catch(() => undefined);
        if (retry?.ok) {
          record.status = 'pending';
          record.retrySubmitted = true;
          record.retryCount = Math.max(1, record.retryCount);
          record.pollIndex = 0;
          await persistRecord(record, now + POLL_DELAYS_MS[0]);
          return;
        }
      }
      record.completedAt = now;
      await persistRecord(record);
      return;
    }
    if (status === 'not_found') {
      record.notFoundCount += 1;
      if (record.notFoundCount >= 3) {
        record.completedAt = now;
        await persistRecord(record);
        return;
      }
    } else {
      record.notFoundCount = 0;
    }
    record.pollIndex += 1;
    await persistRecord(record, now + nextDelay(record));
  } finally {
    await releaseLock(lockKey, token).catch(() => undefined);
  }
}

export async function processDueMemoryRetentions(limit = 10): Promise<number> {
  const count = Math.max(1, Math.min(limit, 50));
  const now = Date.now();
  const redis = getRedis();
  const [submissions, polls] = await Promise.all(
    [submissionQueueKey(), queueKey()].map((key) =>
      redis.zrangebyscore(key, 0, now, 'LIMIT', 0, count),
    ),
  );
  const due = [...new Set([...submissions, ...polls])].slice(0, count);
  await Promise.all(due.map((jobId) => processMemoryRetention(jobId)));
  return due.length;
}

export async function getMemoryRetentionHealth(
  userId: string,
): Promise<MemoryRetentionHealth> {
  const redis = getRedis();
  const jobIds = await redis.zrevrange(userIndexKey(userId), 0, 99);
  const records = (
    await Promise.all(
      jobIds.map(
        (jobId) =>
          jsonGet(recordKey(jobId)) as Promise<MemoryRetentionRecord | null>,
      ),
    )
  ).filter((record): record is MemoryRetentionRecord =>
    Boolean(record && record.userId === userId),
  );
  const statuses: MemoryRetentionStatus[] = [
    'accepted',
    'pending',
    'processing',
    'completed',
    'zero_fact',
    'failed',
    'cancelled',
    'not_found',
    'timed_out',
  ];
  const counts = Object.fromEntries(
    statuses.map((status) => [status, 0]),
  ) as Record<MemoryRetentionStatus, number>;
  for (const record of records) counts[record.status] += 1;
  return {
    total: records.length,
    counts,
    recent: records
      .slice(0, 20)
      .map(({ userId: _userId, ...record }) => record),
  };
}
