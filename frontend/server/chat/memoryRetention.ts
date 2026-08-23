import {
  buildBackendBaseUrlForMode,
  buildBackendUrlFromBase,
} from '@/utils/app/backendApi';
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
const recordKey = (jobId: string) =>
  sessionKey(['memory-retention', 'record', 'v1', jobId]);
const recordLockKey = (jobId: string) =>
  sessionKey(['memory-retention', 'lock', 'v1', jobId]);
const userIndexKey = (userId: string) =>
  sessionKey(['memory-retention', 'user', userId, 'v1']);

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

async function processRecord(jobId: string): Promise<void> {
  const redis = getRedis();
  const lockKey = recordLockKey(jobId);
  const token = uuidv4();
  if ((await redis.set(lockKey, token, 'PX', 30_000, 'NX')) !== 'OK') return;
  try {
    const record = (await jsonGet(
      recordKey(jobId),
    )) as MemoryRetentionRecord | null;
    if (!record) {
      await redis.zrem(queueKey(), jobId);
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
    if (!response.ok) {
      logger.warn(
        `Retention status returned HTTP ${response.status} for ${jobId}`,
      );
      record.updatedAt = now;
      record.pollIndex += 1;
      await persistRecord(record, now + nextDelay(record));
      return;
    }

    const body = (await response.json()) as {
      status?: MemoryRetentionStatus;
      unit_ids_count?: number;
      extraction_errors_count?: number;
      retry_count?: number;
    };
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
  const due = await getRedis().zrangebyscore(
    queueKey(),
    0,
    Date.now(),
    'LIMIT',
    0,
    Math.max(1, Math.min(limit, 50)),
  );
  await Promise.all(due.map((jobId) => processRecord(jobId)));
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
