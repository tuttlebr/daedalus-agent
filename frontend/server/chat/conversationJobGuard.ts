import { JOB_EXPIRY_SECONDS } from './constants';

import { getRedis, sessionKey } from '@/server/session/redis';
import type Redis from 'ioredis';

export const CONVERSATION_JOB_GUARD_TTL_SECONDS = JOB_EXPIRY_SECONDS * 2;
export const CONVERSATION_JOB_INITIALIZATION_GRACE_MS = 60_000;

export interface ConversationJobGuard {
  version: 1;
  userId: string;
  conversationId: string;
  jobId: string;
  acquiredAt: number;
}

export type ConversationJobGuardAcquisition =
  | {
      acquired: true;
      guard: ConversationJobGuard;
    }
  | {
      acquired: false;
      current: ConversationJobGuard | null;
      currentSerialized: string | null;
    };

export const conversationJobGuardKey = (
  userId: string,
  conversationId: string,
): string =>
  sessionKey([
    'async-conversation-job',
    encodeURIComponent(userId),
    encodeURIComponent(conversationId),
  ]);

function serializeConversationJobGuard(guard: ConversationJobGuard): string {
  return JSON.stringify(guard);
}

export function parseConversationJobGuard(
  serialized: string | null,
): ConversationJobGuard | null {
  if (!serialized) return null;
  try {
    const parsed = JSON.parse(serialized) as Partial<ConversationJobGuard>;
    if (
      parsed.version !== 1 ||
      typeof parsed.userId !== 'string' ||
      !parsed.userId ||
      typeof parsed.conversationId !== 'string' ||
      !parsed.conversationId ||
      typeof parsed.jobId !== 'string' ||
      !parsed.jobId ||
      typeof parsed.acquiredAt !== 'number' ||
      !Number.isFinite(parsed.acquiredAt)
    ) {
      return null;
    }
    return parsed as ConversationJobGuard;
  } catch {
    return null;
  }
}

export function isConversationJobInitializationStale(
  guard: ConversationJobGuard,
  now = Date.now(),
): boolean {
  return now - guard.acquiredAt >= CONVERSATION_JOB_INITIALIZATION_GRACE_MS;
}

export async function acquireConversationJobGuard(
  userId: string,
  conversationId: string,
  jobId: string,
  client: Redis = getRedis(),
  acquiredAt = Date.now(),
): Promise<ConversationJobGuardAcquisition> {
  const key = conversationJobGuardKey(userId, conversationId);
  const guard: ConversationJobGuard = {
    version: 1,
    userId,
    conversationId,
    jobId,
    acquiredAt,
  };
  const serialized = serializeConversationJobGuard(guard);

  // A release may race the first failed SET NX. Retry once when the subsequent
  // read observes no owner so callers don't reject a request on a stale view.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const acquired = await client.set(
      key,
      serialized,
      'EX',
      CONVERSATION_JOB_GUARD_TTL_SECONDS,
      'NX',
    );
    if (acquired === 'OK') {
      return { acquired: true, guard };
    }

    const currentSerialized = await client.get(key);
    if (currentSerialized !== null) {
      return {
        acquired: false,
        current: parseConversationJobGuard(currentSerialized),
        currentSerialized,
      };
    }
  }

  return { acquired: false, current: null, currentSerialized: null };
}

const REPLACE_CONVERSATION_JOB_GUARD_LUA = `
-- REPLACE_CONVERSATION_JOB_GUARD
local current = redis.call('GET', KEYS[1])
if not current or current ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

export async function replaceStaleConversationJobGuard(
  userId: string,
  conversationId: string,
  expectedSerialized: string,
  jobId: string,
  client: Redis = getRedis(),
  acquiredAt = Date.now(),
): Promise<ConversationJobGuard | null> {
  const replacement: ConversationJobGuard = {
    version: 1,
    userId,
    conversationId,
    jobId,
    acquiredAt,
  };
  const replaced = await client.eval(
    REPLACE_CONVERSATION_JOB_GUARD_LUA,
    1,
    conversationJobGuardKey(userId, conversationId),
    expectedSerialized,
    serializeConversationJobGuard(replacement),
    CONVERSATION_JOB_GUARD_TTL_SECONDS,
  );
  return Number(replaced) === 1 ? replacement : null;
}

const RELEASE_CONVERSATION_JOB_GUARD_LUA = `
-- RELEASE_CONVERSATION_JOB_GUARD
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local ok, current = pcall(cjson.decode, raw)
if not ok or type(current) ~= 'table' then
  return 0
end
if current['version'] ~= 1 or current['userId'] ~= ARGV[1] or current['conversationId'] ~= ARGV[2] or current['jobId'] ~= ARGV[3] then
  return 0
end
return redis.call('DEL', KEYS[1])
`;

export async function releaseConversationJobGuard(
  userId: string,
  conversationId: string,
  jobId: string,
  client: Redis = getRedis(),
): Promise<boolean> {
  const released = await client.eval(
    RELEASE_CONVERSATION_JOB_GUARD_LUA,
    1,
    conversationJobGuardKey(userId, conversationId),
    userId,
    conversationId,
    jobId,
  );
  return Number(released) === 1;
}
