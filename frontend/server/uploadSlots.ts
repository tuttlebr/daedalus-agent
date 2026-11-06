import type Redis from 'ioredis';

/**
 * Per-user concurrency slots for long uploads. Each upload holds its own
 * sorted-set member whose score is its expiry, as chat slots do
 * (server/chat/userJobGuard.ts). A slot leaked by a process that stopped
 * before releasing it expires on its own deadline, even while the user keeps
 * uploading; and a release after that deadline removes only its own member,
 * never a newer upload's slot. A single shared counter could do neither.
 */
const ACQUIRE_UPLOAD_SLOT_LUA = `
-- ACQUIRE_UPLOAD_SLOT
local clock = redis.call('TIME')
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]) * 1000, ARGV[1])
-- The set lives until its latest reservation ends; a shorter new one never
-- cuts an earlier, longer one short.
local latest = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
redis.call('PEXPIREAT', KEYS[1], latest[2])
return 1
`;

const RELEASE_UPLOAD_SLOT_LUA = `
-- RELEASE_UPLOAD_SLOT
return redis.call('ZREM', KEYS[1], ARGV[1])
`;

/** Reserve one of `limit` slots for `slotId` for at most `ttlSeconds`. */
export async function acquireUploadSlot(
  client: Redis,
  key: string,
  slotId: string,
  limit: number,
  ttlSeconds: number,
): Promise<boolean> {
  return (
    Number(
      await client.eval(
        ACQUIRE_UPLOAD_SLOT_LUA,
        1,
        key,
        slotId,
        limit,
        ttlSeconds,
      ),
    ) === 1
  );
}

/** Release this upload's slot; other uploads' slots are untouched. */
export async function releaseUploadSlot(
  client: Redis,
  key: string,
  slotId: string,
): Promise<void> {
  await client.eval(RELEASE_UPLOAD_SLOT_LUA, 1, key, slotId);
}
