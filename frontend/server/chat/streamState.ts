import { JOB_EXPIRY_SECONDS } from './constants';

import { getRedis, jsonDel, jsonGet, sessionKey } from '@/server/session/redis';

const APPEND_WITH_EXPIRY_LUA = `
local length = redis.call('APPEND', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return length
`;

const RPUSH_WITH_EXPIRY_LUA = `
local values = {}
for index = 2, #ARGV do
  values[#values + 1] = ARGV[index]
end
local length = redis.call('RPUSH', KEYS[1], unpack(values))
redis.call('EXPIRE', KEYS[1], ARGV[1])
return length
`;

export const streamResponseKey = (jobId: string): string =>
  sessionKey(['async-job-response', jobId]);

export const streamStepsKey = (jobId: string): string =>
  sessionKey(['async-job-steps-v2', jobId]);

export const legacyStreamStepsKey = (jobId: string): string =>
  sessionKey(['async-job-steps', jobId]);

/**
 * Append only the response bytes produced since the previous flush. The Lua
 * script keeps the write and TTL refresh in one Redis round trip.
 */
export async function appendStreamResponseDelta(
  jobId: string,
  delta: string,
): Promise<void> {
  if (!delta) return;
  await getRedis().eval(
    APPEND_WITH_EXPIRY_LUA,
    1,
    streamResponseKey(jobId),
    delta,
    JOB_EXPIRY_SECONDS,
  );
}

/** Append newly observed steps without serializing the accumulated history. */
export async function appendStreamSteps(
  jobId: string,
  steps: any[],
): Promise<void> {
  if (steps.length === 0) return;
  await getRedis().eval(
    RPUSH_WITH_EXPIRY_LUA,
    1,
    streamStepsKey(jobId),
    JOB_EXPIRY_SECONDS,
    ...steps.map((step) => JSON.stringify(step)),
  );
}

/**
 * Read the append-only response, falling back to the legacy status snapshot
 * while jobs created by an older frontend version are still in flight.
 */
export async function getStreamResponse(
  jobId: string,
  fallback = '',
): Promise<string> {
  try {
    const response = await getRedis().get(streamResponseKey(jobId));
    return response === null ? fallback : response;
  } catch {
    return fallback;
  }
}

/**
 * Read the normalized step list. The old JSON array remains a read fallback so
 * rolling upgrades don't discard progress from already-running jobs.
 */
export async function getStreamSteps(
  jobId: string,
  fallback: any[] = [],
): Promise<any[]> {
  try {
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
  } catch {
    // Fall through to the legacy representation.
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
