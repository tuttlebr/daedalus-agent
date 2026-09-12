import { JOB_EXPIRY_SECONDS } from './constants';

import { getRedis, jsonDel, jsonGet, sessionKey } from '@/server/session/redis';
import { isDeepStrictEqual } from 'node:util';

const APPEND_WITH_EXPIRY_LUA = `
local offset = tonumber(ARGV[3])
local length = redis.call('STRLEN', KEYS[1])
if length < offset then return redis.error_reply('stream response offset gap') end
local overlap = math.min(length - offset, string.len(ARGV[1]))
if overlap > 0 and redis.call('GETRANGE', KEYS[1], offset, offset + overlap - 1) ~= string.sub(ARGV[1], 1, overlap) then
  return redis.error_reply('stream response offset conflict')
end
if overlap < string.len(ARGV[1]) then
  redis.call('APPEND', KEYS[1], string.sub(ARGV[1], overlap + 1))
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return offset + string.len(ARGV[1])
`;

const RPUSH_WITH_EXPIRY_LUA = `
local offset = tonumber(ARGV[2])
local length = redis.call('LLEN', KEYS[1])
if length < offset then return redis.error_reply('stream steps offset gap') end
local overlap = math.min(length - offset, #ARGV - 2)
for index = 1, overlap do
  if redis.call('LINDEX', KEYS[1], offset + index - 1) ~= ARGV[index + 2] then
    return redis.error_reply('stream steps offset conflict')
  end
end
if overlap < #ARGV - 2 then
  local values = {}
  for index = overlap + 3, #ARGV do
    values[#values + 1] = ARGV[index]
  end
  redis.call('RPUSH', KEYS[1], unpack(values))
end
redis.call('EXPIRE', KEYS[1], ARGV[1])
return offset + #ARGV - 2
`;

function validateOffset(offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Stream offset must be a nonnegative safe integer');
  }
}

export const streamResponseKey = (jobId: string): string =>
  sessionKey(['async-job-response', jobId]);

export const streamStepsKey = (jobId: string): string =>
  sessionKey(['async-job-steps-v2', jobId]);

export const legacyStreamStepsKey = (jobId: string): string =>
  sessionKey(['async-job-steps', jobId]);

/**
 * Append at the acknowledged UTF-8 byte offset. Matching overlap is a retry
 * after a lost reply; only its missing suffix is written. Conflicts and gaps
 * fail without changing the stored response.
 */
export async function appendStreamResponseDelta(
  jobId: string,
  delta: string,
  byteOffset: number,
): Promise<void> {
  validateOffset(byteOffset);
  if (!delta) return;
  await getRedis().eval(
    APPEND_WITH_EXPIRY_LUA,
    1,
    streamResponseKey(jobId),
    delta,
    JOB_EXPIRY_SECONDS,
    byteOffset,
  );
}

/** Append newly observed steps without serializing the accumulated history. */
export async function appendStreamSteps(
  jobId: string,
  steps: any[],
  stepOffset: number,
): Promise<void> {
  validateOffset(stepOffset);
  if (steps.length === 0) return;
  const client = getRedis();
  const key = streamStepsKey(jobId);
  const serialized = steps.map((step) => JSON.stringify(step));
  const append = (values: string[]) =>
    client.eval(
      RPUSH_WITH_EXPIRY_LUA,
      1,
      key,
      JOB_EXPIRY_SECONDS,
      stepOffset,
      ...values,
    );
  try {
    await append(serialized);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== 'stream steps offset conflict'
    )
      throw error;
    // JSON object key order is immaterial. On a byte mismatch, compare the
    // overlapping JSON values in JS (Lua cjson cannot distinguish [] from {}).
    // Reuse the exact stored encoding only for equivalent values; the atomic
    // script checks the current offset and values again before appending.
    const existing = await client.lrange(
      key,
      stepOffset,
      stepOffset + steps.length - 1,
    );
    let equivalent: boolean;
    try {
      equivalent = existing.every((value, index) =>
        isDeepStrictEqual(JSON.parse(value), JSON.parse(serialized[index])),
      );
    } catch {
      throw error;
    }
    if (!equivalent) throw error;
    await append([...existing, ...serialized.slice(existing.length)]);
  }
}

/**
 * Read the append-only response, falling back to the legacy status snapshot
 * while jobs created by an older frontend version are still in flight.
 */
export async function getStreamResponse(
  jobId: string,
  fallback = '',
): Promise<string> {
  const response = await getRedis().get(streamResponseKey(jobId));
  return response === null ? fallback : response;
}

/**
 * Read the normalized step list. The old JSON array remains a read fallback so
 * rolling upgrades don't discard progress from already-running jobs.
 */
export async function getStreamSteps(
  jobId: string,
  fallback: any[] = [],
): Promise<any[]> {
  // A failed read is not empty history. Let callers retry instead of taking
  // an empty terminal snapshot and deleting the durable stream evidence.
  const serialized = await getRedis().lrange(streamStepsKey(jobId), 0, -1);
  if (serialized.length > 0) {
    const parsed: any[] = [];
    for (const entry of serialized) {
      try {
        parsed.push(JSON.parse(entry));
      } catch {
        // Ignore a corrupt individual event instead of hiding valid events.
      }
    }
    if (parsed.length > 0) return parsed;
  }

  const legacy = (await jsonGet(legacyStreamStepsKey(jobId))) as any[] | null;
  return Array.isArray(legacy) && legacy.length > 0 ? legacy : fallback;
}

/** Remove both normalized state and the rolling-upgrade compatibility key. */
export async function clearStreamState(jobId: string): Promise<void> {
  await Promise.all([
    getRedis().del(streamResponseKey(jobId), streamStepsKey(jobId)),
    jsonDel(legacyStreamStepsKey(jobId)),
  ]);
}
