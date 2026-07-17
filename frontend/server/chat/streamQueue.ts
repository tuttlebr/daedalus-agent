import { JOB_EXPIRY_SECONDS } from './constants';
import type { StreamQueuePayload } from './types';

import {
  getRedis,
  jsonDel,
  jsonGet,
  jsonSetWithExpiry,
  sessionKey,
} from '@/server/session/redis';
import type Redis from 'ioredis';

export interface StreamQueueEntry {
  entryId: string;
  jobId: string;
  reclaimed: boolean;
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
    entries.push({ entryId, jobId: fields.jobId, reclaimed });
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

export async function enqueueStreamJob(
  jobId: string,
  payload: StreamQueuePayload,
): Promise<string> {
  await jsonSetWithExpiry(streamPayloadKey(jobId), payload, JOB_EXPIRY_SECONDS);
  try {
    const entryId = await getRedis().xadd(
      STREAM_QUEUE_KEY,
      '*',
      'jobId',
      jobId,
    );
    if (!entryId) throw new Error('Redis did not return a stream entry ID');
    return entryId;
  } catch (error) {
    await jsonDel(streamPayloadKey(jobId)).catch(() => {});
    throw error;
  }
}

export async function loadStreamQueuePayload(
  jobId: string,
): Promise<StreamQueuePayload | null> {
  return (await jsonGet(streamPayloadKey(jobId))) as StreamQueuePayload | null;
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
): Promise<StreamQueueEntry[]> {
  const result = (await (client as any).xautoclaim(
    STREAM_QUEUE_KEY,
    STREAM_QUEUE_GROUP,
    consumer,
    minIdleMs,
    '0-0',
    'COUNT',
    count,
  )) as unknown;
  if (!Array.isArray(result)) return [];
  return parseEntries(result[1], true);
}

export async function acquireStreamLease(
  jobId: string,
  ownerToken: string,
  ttlMs: number,
  client: Redis = getRedis(),
): Promise<boolean> {
  return (
    (await client.set(streamLeaseKey(jobId), ownerToken, 'PX', ttlMs, 'NX')) ===
    'OK'
  );
}

const RENEW_LEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then " +
  "return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

export async function renewStreamLease(
  jobId: string,
  ownerToken: string,
  ttlMs: number,
  client: Redis = getRedis(),
): Promise<boolean> {
  return (
    (await client.eval(
      RENEW_LEASE_LUA,
      1,
      streamLeaseKey(jobId),
      ownerToken,
      ttlMs,
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
if redis.call('get', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
`;

export async function markBackendRequestStarted(
  jobId: string,
  ownerToken: string,
  client: Redis = getRedis(),
): Promise<boolean> {
  const marker = JSON.stringify({ ownerToken, startedAt: Date.now() });
  return (
    (await client.eval(
      MARK_BACKEND_STARTED_LUA,
      2,
      streamLeaseKey(jobId),
      streamBackendStartedKey(jobId),
      ownerToken,
      marker,
      JOB_EXPIRY_SECONDS,
    )) === 1
  );
}

export async function hasBackendRequestStarted(
  jobId: string,
  client: Redis = getRedis(),
): Promise<boolean> {
  return (await client.exists(streamBackendStartedKey(jobId))) === 1;
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
