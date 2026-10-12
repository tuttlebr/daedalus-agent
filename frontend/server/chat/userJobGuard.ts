import { CONVERSATION_JOB_GUARD_TTL_SECONDS } from './conversationJobGuard';

import { getRedis, sessionKey } from '@/server/session/redis';
import type Redis from 'ioredis';

export const MAX_ACTIVE_CHATS_PER_USER = 5;
export const USER_JOB_GUARD_TTL_SECONDS = CONVERSATION_JOB_GUARD_TTL_SECONDS;

export const userJobGuardKey = (userId: string): string =>
  sessionKey(['async-user-jobs', encodeURIComponent(userId)]);

const ACQUIRE_USER_JOB_GUARD_LUA = `
-- ACQUIRE_USER_JOB_GUARD
local clock = redis.call('TIME')
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 1 end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], now + ARGV[3] * 1000, ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`;

// Count pending submissions too, so simultaneous requests and multiple tabs
// cannot queue more than five chats before a worker starts them.
export async function acquireUserJobGuard(
  userId: string,
  jobId: string,
  client: Redis = getRedis(),
): Promise<boolean> {
  return (
    Number(
      await client.eval(
        ACQUIRE_USER_JOB_GUARD_LUA,
        1,
        userJobGuardKey(userId),
        jobId,
        MAX_ACTIVE_CHATS_PER_USER,
        USER_JOB_GUARD_TTL_SECONDS,
      ),
    ) === 1
  );
}

export async function releaseUserJobGuard(
  userId: string,
  jobId: string,
  client: Redis = getRedis(),
): Promise<void> {
  await client.eval(
    "return redis.call('ZREM', KEYS[1], ARGV[1])",
    1,
    userJobGuardKey(userId),
    jobId,
  );
}
