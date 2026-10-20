import { JOB_EXPIRY_SECONDS } from './constants';
import { CONVERSATION_JOB_GUARD_TTL_SECONDS } from './conversationJobGuard';
import { abortKey, finalizationJournalKey } from './jobState';
import { streamResponseKey, streamStepsKey } from './streamState';
import type {
  AsyncJobRequest,
  AsyncJobStatus,
  StreamQueuePayload,
} from './types';
import { USER_JOB_GUARD_TTL_SECONDS } from './userJobGuard';

import {
  STREAMING_STATE_TTL_SECONDS,
  getRedis,
  sessionKey,
} from '@/server/session/redis';
import { evalScript, redisScript } from '@/server/session/redisScript';
import type Redis from 'ioredis';

export interface StreamQueueEntry {
  entryId: string;
  jobId: string;
  reclaimed: boolean;
  /**
   * The submission's owner, written with the entry so a worker can release
   * the user slot and conversation guard of a job whose request and status
   * expired before any worker claimed it. Absent on entries written by
   * earlier frontends.
   */
  userId?: string;
  conversationId?: string;
}

export interface StreamJobOwner {
  userId: string;
  conversationId?: string;
}

export interface StreamQueueClaim {
  entries: StreamQueueEntry[];
  nextCursor: string;
}

export const STREAM_QUEUE_KEY =
  process.env.STREAM_WORKER_QUEUE_KEY || sessionKey(['async-stream-queue']);
export const STREAM_QUEUE_GROUP =
  process.env.STREAM_WORKER_GROUP || 'daedalus-stream-workers';

export const streamPayloadKey = (jobId: string) =>
  sessionKey(['async-stream-payload', jobId]);
export const streamLeaseKey = (jobId: string) =>
  sessionKey(['async-stream-lease', jobId]);
export const streamBackendStartedKey = (jobId: string) =>
  sessionKey(['async-stream-backend-started', jobId]);

function parseFieldList(fields: unknown): Record<string, string> {
  if (!Array.isArray(fields)) return {};
  const parsed: Record<string, string> = {};
  for (let index = 0; index + 1 < fields.length; index += 2) {
    parsed[String(fields[index])] = String(fields[index + 1]);
  }
  return parsed;
}

function parseEntries(value: unknown, reclaimed: boolean): StreamQueueEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: StreamQueueEntry[] = [];
  for (const rawEntry of value) {
    if (!Array.isArray(rawEntry) || rawEntry.length < 2) continue;
    const entryId = String(rawEntry[0]);
    const fields = parseFieldList(rawEntry[1]);
    if (!fields.jobId) continue;
    entries.push({
      entryId,
      jobId: fields.jobId,
      reclaimed,
      ...(fields.userId ? { userId: fields.userId } : {}),
      ...(fields.conversationId
        ? { conversationId: fields.conversationId }
        : {}),
    });
  }
  return entries;
}

export async function ensureStreamConsumerGroup(
  client: Redis = getRedis(),
): Promise<void> {
  try {
    await client.xgroup(
      'CREATE',
      STREAM_QUEUE_KEY,
      STREAM_QUEUE_GROUP,
      '0',
      'MKSTREAM',
    );
  } catch (error: any) {
    if (!String(error?.message || error).includes('BUSYGROUP')) throw error;
  }
}

// Reads a JSON record whether it is stored as a RedisJSON document or as a
// plain string, keeping its text opaque (cjson would corrupt empty arrays).
const READ_JSON_RECORD_LUA = `
local function read_json(key)
  local kind = redis.call('TYPE', key).ok
  if kind == 'string' then return redis.call('GET', key) end
  if string.find(string.lower(kind), 'rejson', 1, true) then
    return redis.call('JSON.GET', key, '.')
  end
  return false
end
`;

// The payload and its queue entry commit together, so neither exists without
// the other: the entry is added first (a failure there writes nothing) and
// the writes after it cannot fail. A Stop recorded against the browser's
// submission ID before this point becomes the job's stop signal in the same
// commit. The cross-session streaming notice is published only once queued.
const ENQUEUE_STREAM_JOB = redisScript(`
-- ENQUEUE_STREAM_JOB
${READ_JSON_RECORD_LUA}
local cancelled = false
if #KEYS >= 4 then
  local raw = read_json(KEYS[4])
  if raw then
    local ok, submission = pcall(cjson.decode, raw)
    cancelled = ok and type(submission) == 'table'
      and submission['cancelled'] == true
  end
end
local entry = redis.call('XADD', KEYS[2], '*', 'jobId', ARGV[3],
  'userId', ARGV[6], 'conversationId', ARGV[7])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
if cancelled then redis.call('SET', KEYS[3], 'true', 'EX', ARGV[2]) end
if ARGV[4] ~= '' then redis.call('PUBLISH', ARGV[4], ARGV[5]) end
return entry
`);

export interface StreamEnqueueOptions {
  /** The browser submission whose recorded Stop must also stop this job. */
  submissionKey?: string;
  /** Published to other sessions once the job is queued. */
  notice?: { channel: string; payload: string };
}

/**
 * Queue a job whose request and status are already written. The queue payload
 * is stored as a plain JSON string; workers read it type-agnostically.
 */
export async function enqueueStreamJob(
  jobId: string,
  payload: StreamQueuePayload,
  owner: StreamJobOwner,
  options: StreamEnqueueOptions = {},
): Promise<string> {
  const keys = [streamPayloadKey(jobId), STREAM_QUEUE_KEY, abortKey(jobId)];
  if (options.submissionKey) keys.push(options.submissionKey);
  const entryId = await evalScript(
    getRedis(),
    ENQUEUE_STREAM_JOB,
    keys.length,
    ...keys,
    JSON.stringify(payload),
    JOB_EXPIRY_SECONDS,
    jobId,
    options.notice?.channel ?? '',
    options.notice?.payload ?? '',
    owner.userId,
    owner.conversationId ?? '',
  );
  if (!entryId) throw new Error('Redis did not return a stream entry ID');
  return String(entryId);
}

export interface StreamJobPresence {
  request: boolean;
  payload: boolean;
  lease: boolean;
}

/**
 * Which execution records exist for a job. A queued or running job has its
 * request and queue payload until a worker acknowledges it after its terminal
 * status; a worker processing it also holds the lease.
 */
export async function getStreamJobPresence(
  jobId: string,
  client: Redis = getRedis(),
): Promise<StreamJobPresence> {
  const [request, payload, lease] = await Promise.all([
    client.exists(sessionKey(['async-job-request', jobId])),
    client.exists(streamPayloadKey(jobId)),
    client.exists(streamLeaseKey(jobId)),
  ]);
  return { request: request === 1, payload: payload === 1, lease: lease === 1 };
}

export async function readNewStreamJobs(
  client: Redis,
  consumer: string,
  count: number,
  blockMs: number,
): Promise<StreamQueueEntry[]> {
  const result = await client.xreadgroup(
    'GROUP',
    STREAM_QUEUE_GROUP,
    consumer,
    'COUNT',
    count,
    'BLOCK',
    blockMs,
    'STREAMS',
    STREAM_QUEUE_KEY,
    '>',
  );
  if (!Array.isArray(result) || !Array.isArray(result[0])) return [];
  return parseEntries(result[0][1], false);
}

export async function claimStaleStreamJobs(
  client: Redis,
  consumer: string,
  minIdleMs: number,
  count: number,
  cursor = '0-0',
): Promise<StreamQueueClaim> {
  const result = (await (client as any).xautoclaim(
    STREAM_QUEUE_KEY,
    STREAM_QUEUE_GROUP,
    consumer,
    minIdleMs,
    cursor,
    'COUNT',
    count,
  )) as unknown;
  if (!Array.isArray(result)) return { entries: [], nextCursor: '0-0' };
  return {
    entries: parseEntries(result[1], true),
    nextCursor: String(result[0]),
  };
}

// Lease acquisition and every record a worker needs to decide what to do with
// the entry, in one round trip. The lease commits before the reads, exactly as
// separate commands would. Terminal jobs need no request and no payload, and
// only a job that can still run reads its (history-sized) model payload.
const ACQUIRE_STREAM_LEASE_SNAPSHOT = redisScript(`
-- ACQUIRE_STREAM_LEASE_SNAPSHOT
if not redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then
  return {0}
end
${READ_JSON_RECORD_LUA}
local status = read_json(KEYS[2])
if not status then return {1, false, false, false, 0, 0} end
local ok, decoded = pcall(cjson.decode, status)
if ok and type(decoded) == 'table' and (decoded['finalizedAt'] ~= nil
  or decoded['status'] == 'completed' or decoded['status'] == 'error') then
  return {1, status, false, false, 0, 0}
end
local request = read_json(KEYS[3])
local started = redis.call('EXISTS', KEYS[5], KEYS[6], KEYS[7])
local canceled = redis.call('EXISTS', KEYS[8])
local payload = false
if request and started == 0 and canceled == 0 then
  payload = read_json(KEYS[4])
end
return {1, status, request, payload, started, canceled}
`);

export interface StreamLeaseSnapshot {
  status: AsyncJobStatus | null;
  request: AsyncJobRequest | null;
  /** Present only for a live job with no start evidence or stop signal. */
  payload: StreamQueuePayload | null;
  /**
   * The start marker or streamed output exists. The marker is an expiring key
   * Redis can evict under memory pressure; the reader writes output only after
   * the backend request was sent, so output is start evidence too.
   */
  started: boolean;
  /** A durable stop signal exists. */
  canceled: boolean;
}

function parseRecord<T>(raw: unknown): T | null {
  return typeof raw === 'string' && raw ? (JSON.parse(raw) as T) : null;
}

/**
 * Acquire the job's execution lease and read its records atomically. Returns
 * null when another owner holds the lease.
 */
export async function acquireStreamLeaseSnapshot(
  jobId: string,
  ownerToken: string,
  ttlMs: number,
  client: Redis = getRedis(),
): Promise<StreamLeaseSnapshot | null> {
  const reply = (await evalScript(
    client,
    ACQUIRE_STREAM_LEASE_SNAPSHOT,
    8,
    streamLeaseKey(jobId),
    sessionKey(['async-job-status', jobId]),
    sessionKey(['async-job-request', jobId]),
    streamPayloadKey(jobId),
    streamBackendStartedKey(jobId),
    streamResponseKey(jobId),
    streamStepsKey(jobId),
    abortKey(jobId),
    ownerToken,
    ttlMs,
  )) as [number, unknown?, unknown?, unknown?, number?, number?];
  if (Number(reply[0]) !== 1) return null;
  return {
    status: parseRecord<AsyncJobStatus>(reply[1]),
    request: parseRecord<AsyncJobRequest>(reply[2]),
    payload: parseRecord<StreamQueuePayload>(reply[3]),
    started: Number(reply[4]) > 0,
    canceled: Number(reply[5]) > 0,
  };
}

const RENEW_LEASE = redisScript(`
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('pexpire', KEYS[1], ARGV[2])
for index = 2, tonumber(ARGV[11]) do
  redis.call('expire', KEYS[index], ARGV[3])
end
-- Optional keys follow the fixed ones; ARGV[7..9] give their positions (0 when
-- absent). No placeholder key is declared: Redis ACL rejects an empty name.
local conversation_index = tonumber(ARGV[7])
local user_index = tonumber(ARGV[8])
local streaming_index = tonumber(ARGV[9])
if conversation_index > 0 then
  local guard = redis.call('get', KEYS[conversation_index])
  if guard then
    local ok, value = pcall(cjson.decode, guard)
    if ok and value.jobId == ARGV[4] then
      redis.call('expire', KEYS[conversation_index], ARGV[5])
    end
  end
end
if user_index > 0 then
  local clock = redis.call('TIME')
  local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
  -- A late heartbeat must not re-add a job released by finalization.
  redis.call('ZADD', KEYS[user_index], 'XX', now + ARGV[6] * 1000, ARGV[4])
  redis.call('EXPIRE', KEYS[user_index], ARGV[6])
end
if streaming_index > 0 then
  -- Cross-device streaming state outlives long runs only while it still
  -- names this job; a newer turn's state is left alone.
  local key = KEYS[streaming_index]
  local kind = redis.call('TYPE', key).ok
  local owner = nil
  if kind == 'string' then
    local ok, value = pcall(cjson.decode, redis.call('GET', key))
    if ok and type(value) == 'table' then owner = value.sessionId end
  elseif string.find(string.lower(kind), 'rejson', 1, true) then
    local ok, raw = pcall(redis.call, 'JSON.GET', key, '$.sessionId')
    if ok and raw then
      local decoded = cjson.decode(raw)
      if type(decoded) == 'table' then owner = decoded[1] end
    end
  end
  if owner == ARGV[4] then redis.call('EXPIRE', key, ARGV[10]) end
end
return 1
`);

export async function renewStreamLease(
  jobId: string,
  ownerToken: string,
  ttlMs: number,
  client: Redis = getRedis(),
  conversationGuardKey?: string,
  userGuardKey?: string,
  streamingStateKey?: string,
): Promise<boolean> {
  // Every key needed to recover a running job must outlive that job, even
  // while a long tool call produces no new response/step writes.
  const keys = [
    streamLeaseKey(jobId),
    sessionKey(['async-job-request', jobId]),
    sessionKey(['async-job-status', jobId]),
    streamPayloadKey(jobId),
    streamBackendStartedKey(jobId),
    streamResponseKey(jobId),
    streamStepsKey(jobId),
    abortKey(jobId),
    finalizationJournalKey(jobId),
  ];
  const renewedKeyCount = keys.length;
  const position = (key?: string): number => {
    if (!key) return 0;
    keys.push(key);
    return keys.length;
  };
  const conversationIndex = position(conversationGuardKey);
  const userIndex = position(userGuardKey);
  const streamingIndex = position(streamingStateKey);
  return (
    (await evalScript(
      client,
      RENEW_LEASE,
      keys.length,
      ...keys,
      ownerToken,
      ttlMs,
      JOB_EXPIRY_SECONDS,
      jobId,
      CONVERSATION_JOB_GUARD_TTL_SECONDS,
      USER_JOB_GUARD_TTL_SECONDS,
      conversationIndex,
      userIndex,
      streamingIndex,
      STREAMING_STATE_TTL_SECONDS,
      renewedKeyCount,
    )) === 1
  );
}

const RELEASE_LEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then " +
  "return redis.call('del', KEYS[1]) else return 0 end";

export async function releaseStreamLease(
  jobId: string,
  ownerToken: string,
  client: Redis = getRedis(),
): Promise<boolean> {
  return (
    (await client.eval(
      RELEASE_LEASE_LUA,
      1,
      streamLeaseKey(jobId),
      ownerToken,
    )) === 1
  );
}

const MARK_BACKEND_STARTED_LUA = `
-- MARK_BACKEND_STARTED
if redis.call('get', KEYS[1]) ~= ARGV[1] then
  return 0
end
-- A Stop or conversation deletion committed before this point wins. Checking
-- it in the same script as the marker leaves no window in which a recorded
-- stop can be followed by a backend request.
if redis.call('exists', KEYS[3]) == 1 then
  return 2
end
redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
`;

export type BackendStartResult = 'started' | 'lease_lost' | 'canceled';

/**
 * Record that this lease owner is about to send the backend request. Only
 * 'started' permits the request: 'lease_lost' means another owner may run the
 * job, and 'canceled' means a durable stop was recorded first.
 */
export async function markBackendRequestStarted(
  jobId: string,
  ownerToken: string,
  client: Redis = getRedis(),
): Promise<BackendStartResult> {
  const marker = JSON.stringify({ ownerToken, startedAt: Date.now() });
  const result = Number(
    await client.eval(
      MARK_BACKEND_STARTED_LUA,
      3,
      streamLeaseKey(jobId),
      streamBackendStartedKey(jobId),
      abortKey(jobId),
      ownerToken,
      marker,
      JOB_EXPIRY_SECONDS,
    ),
  );
  if (result === 1) return 'started';
  if (result === 2) return 'canceled';
  return 'lease_lost';
}

export async function acknowledgeStreamQueueEntry(
  entry: StreamQueueEntry,
  client: Redis = getRedis(),
): Promise<void> {
  await client
    .multi()
    .xack(STREAM_QUEUE_KEY, STREAM_QUEUE_GROUP, entry.entryId)
    .xdel(STREAM_QUEUE_KEY, entry.entryId)
    .del(streamPayloadKey(entry.jobId), streamBackendStartedKey(entry.jobId))
    .exec();
}

export async function acknowledgeDuplicateStreamEntry(
  entry: StreamQueueEntry,
  client: Redis = getRedis(),
): Promise<void> {
  await client
    .multi()
    .xack(STREAM_QUEUE_KEY, STREAM_QUEUE_GROUP, entry.entryId)
    .xdel(STREAM_QUEUE_KEY, entry.entryId)
    .exec();
}
