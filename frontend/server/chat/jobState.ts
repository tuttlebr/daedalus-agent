import { Logger } from '@/utils/logger';

import {
  FINALIZER_LOCK_TTL_MS,
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

// Redis key signalling that execution should stop. Cancellation and error
// finalization set it before claiming the terminal outcome.
export const abortKey = (jobId: string) =>
  sessionKey(['async-job-abort', jobId]);
export const finalizerLockKey = (jobId: string) =>
  sessionKey(['async-job-finalizer-lock', jobId]);
export const finalizationJournalKey = (jobId: string) =>
  sessionKey(['async-job-finalization', jobId]);
export const statusLockKey = (jobId: string) =>
  sessionKey(['async-job-status-lock', jobId]);

export interface JobFinalizationConversation {
  id: string;
  name: string;
  messages: any[];
  assistantMessageId: string;
  turnId?: string;
  content: string;
  intermediateSteps: any[];
  isPartial: boolean;
  error?: string;
}

export interface JobFinalizationJournal {
  version: 1;
  state: 'pending' | 'completed';
  jobId: string;
  finalizationId: string;
  outcome: 'completed' | 'error';
  userId: string;
  finalizedAt: number;
  terminalStatus?: AsyncJobStatus;
  conversation?: JobFinalizationConversation;
  conversationAppliedAt?: number;
  streamingStateClearedAt?: number;
  eventsPublishedAt?: number;
  streamStateClearedAt?: number;
  conversationGuardReleasedAt?: number;
  completedAt?: number;
}

export type NewJobFinalizationJournal = Omit<
  JobFinalizationJournal,
  | 'terminalStatus'
  | 'conversationAppliedAt'
  | 'streamingStateClearedAt'
  | 'eventsPublishedAt'
  | 'streamStateClearedAt'
  | 'conversationGuardReleasedAt'
  | 'completedAt'
>;

export type FinalizationJournalPhase =
  | 'conversationAppliedAt'
  | 'streamingStateClearedAt'
  | 'streamStateClearedAt'
  | 'conversationGuardReleasedAt'
  | 'completedAt';

export interface FinalizationEvent {
  channel: string;
  payload: string;
}

export function clearOAuthStatusFields(): Pick<
  AsyncJobStatus,
  'authUrl' | 'oauthState' | 'oauthRequests'
> {
  return {
    authUrl: undefined,
    oauthState: undefined,
    oauthRequests: undefined,
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

export function isTerminalJobStatus(status: AsyncJobStatus['status']): boolean {
  return status === 'completed' || status === 'error';
}

export function isPlausibleUnixMs(value: unknown): value is number {
  return typeof value === 'number' && value > 946684800000;
}

// Supports both RedisJSON documents and the plain-string fallback used when
// RedisJSON is unavailable. Redis runs the read, terminal guard, merge, write,
// and expiry as one indivisible operation.
const CLAIM_TERMINAL_JOB_STATUS_LUA = `
-- CLAIM_TERMINAL_FINALIZATION
local type_reply = redis.call('TYPE', KEYS[1])
local key_type = type(type_reply) == 'table' and type_reply['ok'] or type_reply
if key_type == 'none' then
  return nil
end

local is_redis_json = string.find(string.lower(key_type), 'rejson', 1, true) ~= nil
local raw
if is_redis_json then
  raw = redis.call('JSON.GET', KEYS[1], '.')
elseif key_type == 'string' then
  raw = redis.call('GET', KEYS[1])
else
  return redis.error_reply('unsupported async job status key type: ' .. key_type)
end
if not raw then
  return nil
end

local ok_current, current = pcall(cjson.decode, raw)
if not ok_current or type(current) ~= 'table' then
  return redis.error_reply('invalid async job status JSON')
end
if current['finalizedAt'] ~= nil or current['status'] == 'completed' or current['status'] == 'error' then
  return nil
end

local updates = cjson.decode(ARGV[1])
for key, value in pairs(updates) do
  current[key] = value
end
local removals = cjson.decode(ARGV[2])
for _, key in ipairs(removals) do
  current[key] = nil
end

local journal = cjson.decode(ARGV[4])
journal['terminalStatus'] = current
local encoded_journal = cjson.encode(journal)
redis.call('SET', KEYS[2], encoded_journal, 'EX', ARGV[3])

local encoded = cjson.encode(current)
if is_redis_json then
  redis.call('JSON.SET', KEYS[1], '$', encoded)
else
  redis.call('SET', KEYS[1], encoded)
end
redis.call('EXPIRE', KEYS[1], ARGV[3])
return cjson.encode({status = current, journal = journal})
`;

const MARK_FINALIZATION_PHASE_LUA = `
-- MARK_FINALIZATION_PHASE
local raw = redis.call('GET', KEYS[1])
if not raw then
  return nil
end
local journal = cjson.decode(raw)
if journal['finalizationId'] ~= ARGV[1] then
  return nil
end
local phase = ARGV[2]
if journal[phase] == nil then
  journal[phase] = tonumber(ARGV[3])
end
if phase == 'completedAt' then
  journal['state'] = 'completed'
end
local encoded = cjson.encode(journal)
redis.call('SET', KEYS[1], encoded, 'EX', ARGV[4])
return encoded
`;

const PUBLISH_FINALIZATION_EVENTS_LUA = `
-- PUBLISH_FINALIZATION_EVENTS
local raw = redis.call('GET', KEYS[1])
if not raw then
  return nil
end
local journal = cjson.decode(raw)
if journal['finalizationId'] ~= ARGV[1] then
  return nil
end
if journal['eventsPublishedAt'] ~= nil then
  return raw
end

journal['eventsPublishedAt'] = tonumber(ARGV[2])
local encoded = cjson.encode(journal)
redis.call('SET', KEYS[1], encoded, 'EX', ARGV[3])
for index = 4, #ARGV, 2 do
  redis.call('PUBLISH', ARGV[index], ARGV[index + 1])
end
return encoded
`;

export async function updateJobStatus(
  jobId: string,
  updates: Partial<AsyncJobStatus>,
  options: { publish?: boolean } = {},
): Promise<void> {
  const statusKey = sessionKey(['async-job-status', jobId]);
  const isTerminalWrite =
    updates.status === 'completed' ||
    updates.status === 'error' ||
    updates.finalizedAt !== undefined;

  if (isTerminalWrite) {
    throw new Error(
      `Job ${jobId}: terminal updates must use claimTerminalJobStatus`,
    );
  }

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
          `Job ${jobId}: Ignoring status update (status=${updates.status}); job already finalized`,
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

      if (options.publish !== false) {
        try {
          await getPublisher().publish(
            `job:${jobId}:status`,
            JSON.stringify(updatedStatus),
          );
        } catch (err) {
          logger.error(`Failed to publish job status for ${jobId}`, err);
        }
      }
      return true;
    },
    { retries: 1, retryDelayMs: 10 },
  );

  if (applied === null) {
    logger.debug(`Job ${jobId}: Status update lock was busy`);
  }
}

/**
 * Atomically claim the only terminal transition for a job.
 *
 * Every completion path must call this before writing conversations or
 * publishing completion events. One Redis script performs the read, guard,
 * merge, write, and expiry across frontend pods. Once a terminal status or
 * finalizedAt is present, all later terminal contenders lose without changing
 * the stored result.
 */
export async function claimTerminalJobStatus(
  jobId: string,
  updates: Partial<AsyncJobStatus> & {
    status: 'completed' | 'error';
    finalizedAt: number;
  },
  journal: NewJobFinalizationJournal,
): Promise<boolean> {
  if (
    journal.version !== 1 ||
    journal.jobId !== jobId ||
    journal.outcome !== updates.status ||
    journal.state !== 'pending' ||
    !journal.finalizationId ||
    journal.finalizedAt !== updates.finalizedAt
  ) {
    throw new Error(`Job ${jobId}: invalid terminal finalization journal`);
  }

  const statusKey = sessionKey(['async-job-status', jobId]);
  const serializedUpdates: Record<string, unknown> = {};
  const removals: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      removals.push(key);
    } else {
      serializedUpdates[key] = value;
    }
  }

  const locked = await withRedisLock(
    statusLockKey(jobId),
    STATUS_UPDATE_LOCK_TTL_MS,
    async () => ({
      result: await getRedis().eval(
        CLAIM_TERMINAL_JOB_STATUS_LUA,
        2,
        statusKey,
        finalizationJournalKey(jobId),
        JSON.stringify(serializedUpdates),
        JSON.stringify(removals),
        JOB_EXPIRY_SECONDS,
        JSON.stringify(journal),
      ),
    }),
    { retries: 60, retryDelayMs: 50 },
  );
  if (locked === null) {
    throw new Error(`Job ${jobId}: terminal status lock remained busy`);
  }
  const result = locked.result;
  if (typeof result !== 'string') {
    logger.debug(
      `Job ${jobId}: Ignoring terminal transition to ${updates.status}; another outcome already won`,
    );
    return false;
  }
  return true;
}

export async function getFinalizationJournal(
  jobId: string,
): Promise<JobFinalizationJournal | null> {
  const raw = await getRedis().get(finalizationJournalKey(jobId));
  if (!raw) return null;

  let journal: JobFinalizationJournal;
  try {
    journal = JSON.parse(raw) as JobFinalizationJournal;
  } catch (error) {
    logger.error(`Job ${jobId}: failed to parse finalization journal`, error);
    throw error;
  }
  if (
    journal.version !== 1 ||
    journal.jobId !== jobId ||
    typeof journal.finalizationId !== 'string' ||
    !journal.finalizationId
  ) {
    throw new Error(`Job ${jobId}: invalid finalization journal`);
  }
  return journal;
}

export async function markFinalizationPhase(
  jobId: string,
  finalizationId: string,
  phase: FinalizationJournalPhase,
  at: number = Date.now(),
): Promise<JobFinalizationJournal | null> {
  const result = await getRedis().eval(
    MARK_FINALIZATION_PHASE_LUA,
    1,
    finalizationJournalKey(jobId),
    finalizationId,
    phase,
    at,
    JOB_EXPIRY_SECONDS,
  );
  return typeof result === 'string'
    ? (JSON.parse(result) as JobFinalizationJournal)
    : null;
}

/**
 * Publish completion events and persist their idempotency marker in one Redis
 * script. A retry after a lost client response observes eventsPublishedAt and
 * cannot publish the same finalization a second time.
 */
export async function publishFinalizationEvents(
  jobId: string,
  finalizationId: string,
  events: FinalizationEvent[],
  at: number = Date.now(),
): Promise<JobFinalizationJournal | null> {
  const result = await getRedis().eval(
    PUBLISH_FINALIZATION_EVENTS_LUA,
    1,
    finalizationJournalKey(jobId),
    finalizationId,
    at,
    JOB_EXPIRY_SECONDS,
    ...events.flatMap((event) => [event.channel, event.payload]),
  );
  return typeof result === 'string'
    ? (JSON.parse(result) as JobFinalizationJournal)
    : null;
}

export async function withFinalizationLock<T>(
  jobId: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  return withRedisLock(finalizerLockKey(jobId), FINALIZER_LOCK_TTL_MS, fn, {
    retries: 1,
    retryDelayMs: 10,
  });
}
