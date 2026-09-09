import { Logger } from '@/utils/logger';

import { FINALIZER_LOCK_TTL_MS, JOB_EXPIRY_SECONDS, sleep } from './constants';
import type { AsyncJobStatus } from './types';

import { getRedis, sessionKey } from '@/server/session/redis';
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
  memoryRetention?: {
    operationId: string;
    acceptedAt: number;
  };
  memoryRetentionAttemptedAt?: number;
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
  | 'memoryRetentionAttemptedAt'
  | 'streamingStateClearedAt'
  | 'eventsPublishedAt'
  | 'streamStateClearedAt'
  | 'conversationGuardReleasedAt'
  | 'completedAt'
>;

export type FinalizationJournalPhase =
  | 'conversationAppliedAt'
  | 'memoryRetentionAttemptedAt'
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

/**
 * Reflect one successful browser OAuth callback in the durable job status.
 * The state value is already bound to this job by the trusted stream worker.
 * Remove only that request so parallel service authorizations remain visible.
 */
export async function completeOAuthJobRequest(
  jobId: string,
  oauthState: string,
): Promise<boolean> {
  if (!jobId || !oauthState) return false;
  return mutateLiveJobStatus(jobId, (currentStatus) => {
    const requests = Array.isArray(currentStatus.oauthRequests)
      ? currentStatus.oauthRequests
      : [];
    const matched =
      currentStatus.oauthState === oauthState ||
      requests.some((request) => request.oauthState === oauthState);
    if (!matched) return null;

    const remaining = requests.filter(
      (request) => request.oauthState !== oauthState,
    );
    const nextRequest = remaining[0];
    return {
      ...currentStatus,
      status: nextRequest ? 'oauth_required' : 'streaming',
      authUrl: nextRequest?.authUrl,
      oauthState: nextRequest?.oauthState,
      oauthRequests: remaining.length ? remaining : undefined,
      updatedAt: Date.now(),
    };
  });
}

async function withRedisLock<T>(
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

// Supports both RedisJSON documents and the plain-string fallback used when
// RedisJSON is unavailable. The read guard and compare-and-set write
// each execute atomically; a changed snapshot is re-read before retrying.
const READ_LIVE_JOB_STATUS_LUA = `
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

`;

const CLAIM_TERMINAL_JOB_STATUS_LUA = `
-- CLAIM_TERMINAL_FINALIZATION
${READ_LIVE_JOB_STATUS_LUA}
if raw ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[3])
if is_redis_json then
  redis.call('JSON.SET', KEYS[1], '$', ARGV[2])
else
  redis.call('SET', KEYS[1], ARGV[2])
end
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`;

// Keep journal JSON opaque in Lua: cjson loses empty-array types and rounds
// large exact integers. The snapshot comparison also fences competing phases.
const UPDATE_FINALIZATION_JOURNAL_LUA = `
-- UPDATE_FINALIZATION_JOURNAL
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
if raw ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
for index = 4, #ARGV, 2 do
  redis.call('PUBLISH', ARGV[index], ARGV[index + 1])
end
return 1
`;

// Compare the exact stored snapshot and write the JS-serialized replacement.
// Lua decoding/re-encoding the entire document would turn empty JSON arrays
// into objects on plain Redis, corrupting nested status payloads.
const READ_JOB_STATUS_SNAPSHOT_LUA = `
-- READ_JOB_STATUS_SNAPSHOT
${READ_LIVE_JOB_STATUS_LUA}
return raw
`;

const UPDATE_LIVE_JOB_STATUS_LUA = `
-- UPDATE_LIVE_JOB_STATUS
${READ_LIVE_JOB_STATUS_LUA}
if raw ~= ARGV[1] then return 0 end
if is_redis_json then
  redis.call('JSON.SET', KEYS[1], '$', ARGV[2])
else
  redis.call('SET', KEYS[1], ARGV[2])
end
redis.call('EXPIRE', KEYS[1], ARGV[3])
if ARGV[4] ~= '' then
  redis.pcall('PUBLISH', ARGV[4], ARGV[2])
end
return 1
`;

async function mutateLiveJobStatus(
  jobId: string,
  mutate: (current: AsyncJobStatus) => AsyncJobStatus | null,
  publish = true,
): Promise<boolean> {
  const client = getRedis();
  const statusKey = sessionKey(['async-job-status', jobId]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const snapshot = await client.eval(
      READ_JOB_STATUS_SNAPSHOT_LUA,
      1,
      statusKey,
    );
    if (typeof snapshot !== 'string') return false;
    const current = JSON.parse(snapshot) as AsyncJobStatus;
    const updated = mutate(current);
    if (!updated || JSON.stringify(updated) === JSON.stringify(current))
      return false;
    const applied = await client.eval(
      UPDATE_LIVE_JOB_STATUS_LUA,
      1,
      statusKey,
      snapshot,
      JSON.stringify(updated),
      JOB_EXPIRY_SECONDS,
      publish ? `job:${jobId}:status` : '',
    );
    // Missing/terminal records return nil. Only a changed live snapshot retries.
    if (applied === null) return false;
    if (Number(applied) === 1) return true;
  }
  throw new Error(`Job ${jobId}: status changed during every update attempt`);
}

export async function updateJobStatus(
  jobId: string,
  updates: Partial<AsyncJobStatus>,
  options: { publish?: boolean } = {},
): Promise<void> {
  const isTerminalWrite =
    updates.status === 'completed' ||
    updates.status === 'error' ||
    updates.finalizedAt !== undefined;

  if (isTerminalWrite) {
    throw new Error(
      `Job ${jobId}: terminal updates must use claimTerminalJobStatus`,
    );
  }

  await mutateLiveJobStatus(
    jobId,
    (current) => ({ ...current, ...updates }),
    options.publish !== false,
  );
}

/**
 * Atomically claim the only terminal transition for a job.
 *
 * Every completion path must call this before writing conversations or
 * publishing completion events. One Redis script compares the snapshot and
 * writes the terminal status and journal atomically across frontend pods. Once a terminal status or
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

  const client = getRedis();
  const statusKey = sessionKey(['async-job-status', jobId]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const snapshot = await client.eval(
      READ_JOB_STATUS_SNAPSHOT_LUA,
      1,
      statusKey,
    );
    if (typeof snapshot !== 'string') return false;
    const terminalStatus = { ...JSON.parse(snapshot), ...updates };
    const result = await client.eval(
      CLAIM_TERMINAL_JOB_STATUS_LUA,
      2,
      statusKey,
      finalizationJournalKey(jobId),
      snapshot,
      JSON.stringify(terminalStatus),
      JOB_EXPIRY_SECONDS,
      JSON.stringify({ ...journal, terminalStatus }),
    );
    if (result === null) return false;
    if (Number(result) === 1) return true;
  }
  throw new Error(
    `Job ${jobId}: status changed during every finalization attempt`,
  );
}

export async function getFinalizationJournal(
  jobId: string,
): Promise<JobFinalizationJournal | null> {
  const raw = await getRedis().get(finalizationJournalKey(jobId));
  if (!raw) return null;

  return parseFinalizationJournal(jobId, raw);
}

function parseFinalizationJournal(
  jobId: string,
  raw: string,
): JobFinalizationJournal {
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

async function mutateFinalizationJournal(
  jobId: string,
  finalizationId: string,
  mutate: (journal: JobFinalizationJournal) => void,
  events: FinalizationEvent[] = [],
): Promise<JobFinalizationJournal | null> {
  const client = getRedis();
  const key = finalizationJournalKey(jobId);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const snapshot = await client.get(key);
    if (!snapshot) return null;
    const journal = parseFinalizationJournal(jobId, snapshot);
    if (journal.finalizationId !== finalizationId) return null;
    const original = JSON.stringify(journal);
    mutate(journal);
    const updated = JSON.stringify(journal);
    if (updated === original) return journal;
    const result = await client.eval(
      UPDATE_FINALIZATION_JOURNAL_LUA,
      1,
      key,
      snapshot,
      updated,
      JOB_EXPIRY_SECONDS,
      ...events.flatMap((event) => [event.channel, event.payload]),
    );
    if (result === null) return null;
    if (Number(result) === 1) return journal;
  }
  throw new Error(`Job ${jobId}: journal changed during every update attempt`);
}

export async function markFinalizationPhase(
  jobId: string,
  finalizationId: string,
  phase: FinalizationJournalPhase,
  at: number = Date.now(),
): Promise<JobFinalizationJournal | null> {
  return mutateFinalizationJournal(jobId, finalizationId, (journal) => {
    if (journal[phase] === undefined) journal[phase] = at;
    if (phase === 'completedAt') journal.state = 'completed';
  });
}

export async function setMemoryRetentionReceipt(
  jobId: string,
  finalizationId: string,
  receipt: { operationId: string; acceptedAt: number },
): Promise<JobFinalizationJournal | null> {
  return mutateFinalizationJournal(jobId, finalizationId, (journal) => {
    if (journal.memoryRetention === undefined)
      journal.memoryRetention = receipt;
  });
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
  return mutateFinalizationJournal(
    jobId,
    finalizationId,
    (journal) => {
      if (journal.eventsPublishedAt === undefined)
        journal.eventsPublishedAt = at;
    },
    events,
  );
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
