/**
 * Redis primitives shared by the Next.js server and the WebSocket sidecar.
 *
 * The two processes keep their own clients on purpose — the sidecar needs a
 * labelled read client alongside its subscriber multiplexer, and it reads
 * session JSON with different fallback semantics. Everything below is
 * process-independent, and was previously copy-pasted between
 * `server/session/redis.ts` and `ws-server.ts`, comments included. Key
 * builders and channel names diverging between those two files would break
 * realtime delivery in a way neither side could detect locally.
 */
import { positiveIntegerFromEnv } from '../config/env';
import { getCachedIp } from './dns-cache';
import { evalScript, redisScript } from './redisScript';

import type Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';

export const DEFAULT_REDIS_URL = 'redis://redis:6379';

export const REDIS_MAX_RETRIES_PER_REQUEST = positiveIntegerFromEnv(
  'REDIS_MAX_RETRIES_PER_REQUEST',
  3,
);
export const REDIS_COMMAND_TIMEOUT_MS = positiveIntegerFromEnv(
  'REDIS_COMMAND_TIMEOUT_MS',
  10_000,
);

/**
 * Bound per-command retries and timeouts so failed Redis connectivity does not
 * leave requests pending indefinitely.
 */
export const REDIS_CLIENT_OPTIONS: RedisOptions = {
  lazyConnect: true,
  maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
  enableOfflineQueue: true,
  // Type/capability errors are expected while reading legacy string JSON on
  // RedisJSON. Reconnecting on every command error stalls each fallback read
  // and interrupts unrelated work. Only topology errors need a new connection;
  // return true (not 2) so ioredis never replays a possibly consequential write.
  reconnectOnError: (error) =>
    /^(READONLY|MASTERDOWN)(?: |$)/.test(error.message),
  connectTimeout: 10_000,
  commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
  retryStrategy: (times) => Math.min(times * 200, 2_000),
  family: 4,
};

/** Substitute the DNS-cached address so a slow resolver cannot stall connects. */
export function resolveRedisUrl(
  raw: string = process.env.REDIS_URL || DEFAULT_REDIS_URL,
): string {
  try {
    const parsed = new URL(raw);
    // TLS authenticates the configured hostname. Substituting an IP also
    // changes the certificate identity checked by Node, breaking DNS-only
    // certificates as soon as the background cache warms up.
    if (parsed.protocol === 'rediss:') return raw;
    const cachedIp = getCachedIp(parsed.hostname);
    if (cachedIp && cachedIp !== parsed.hostname) {
      parsed.hostname = cachedIp;
      return parsed.toString();
    }
  } catch {
    // Fall through to raw URL
  }
  return raw;
}

export function sessionKey(parts: Array<string | undefined | null>): string {
  return parts.filter(Boolean).join(':');
}

/** Channel names for real-time sync. Both processes must agree exactly. */
export const channels = {
  userUpdates: (userId: string) => `user:${userId}:updates`,
};

/** Job IDs accepted on every job-scoped route, socket message and channel. */
export const JOB_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Cross-session streaming marker for one conversation. */
export interface StreamingState {
  conversationId: string;
  sessionId: string;
  startedAt: number;
  userId: string;
}

export function redisErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseRedisJsonResult(result: string | null, path: string): any {
  if (!result) return null;
  const parsed = JSON.parse(result);
  return path.startsWith('$') && Array.isArray(parsed) ? parsed[0] : parsed;
}

type ThrottleState = { count: number; firstSeen: number };
const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * Collapse repeated transient errors (EAI_AGAIN, ECONNRESET, and friends) into
 * a single log line per (label, code) every 30s so logs stay scannable.
 */
export function createRedisErrorThrottle(
  prefix = '',
): (label: string, error: unknown) => void {
  const seen = new Map<string, ThrottleState>();

  return (label: string, error: unknown): void => {
    const code = (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
    const key = `${label}:${code}`;
    const now = Date.now();
    const state = seen.get(key);
    if (!state) {
      console.error(`${prefix}Redis ${label} error (${code}):`, error);
      seen.set(key, { count: 1, firstSeen: now });
      return;
    }
    if (now - state.firstSeen > ERROR_LOG_INTERVAL_MS) {
      console.error(
        `${prefix}Redis ${label} error (${code}) repeated ${
          state.count
        }x in last ${Math.round((now - state.firstSeen) / 1000)}s`,
        error,
      );
      seen.set(key, { count: 1, firstSeen: now });
      return;
    }
    state.count += 1;
  };
}

// Ownership checks need a few top-level fields of records that also carry a
// whole conversation history. A RedisJSON document is read by path. A plain
// string cannot be, so it is returned whole for the caller to parse, which
// still saves the failed JSON.GET round trip of a try-then-fall-back read.
const READ_JSON_FIELDS = redisScript(`
-- READ_JSON_FIELDS
local kind = redis.call('TYPE', KEYS[1]).ok
if string.find(string.lower(kind), 'rejson', 1, true) then
  local paths = {}
  for index = 1, #ARGV do paths[index] = '$.' .. ARGV[index] end
  return {1, redis.call('JSON.GET', KEYS[1], unpack(paths))}
end
if kind == 'string' then return {2, redis.call('GET', KEYS[1])} end
return {0}
`);

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Top-level fields of a JSON record, or null when the record is absent. */
export async function readJsonFields<T extends object>(
  client: Redis,
  key: string,
  fields: Array<keyof T & string>,
): Promise<Partial<T> | null> {
  if (!fields.length || !fields.every((field) => FIELD_NAME.test(field))) {
    throw new Error('JSON field names must be plain identifiers');
  }
  const [kind, raw] = (await evalScript(
    client,
    READ_JSON_FIELDS,
    1,
    key,
    ...fields,
  )) as [number, string?];
  if (Number(kind) === 0 || !raw) return null;
  const parsed = JSON.parse(raw);
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value =
      Number(kind) === 2
        ? parsed?.[field]
        : fields.length === 1
        ? parsed?.[0]
        : parsed?.[`$.${field}`]?.[0];
    if (value !== undefined) result[field] = value;
  }
  return result as Partial<T>;
}

// Conversation records are written with `id` and `ownerId` as their leading
// keys (server/session/conversationStore.ts), so the owner is read from the
// first bytes instead of the whole history. Records written in another key
// order are returned whole and parsed by the caller.
const READ_CONVERSATION_OWNER = redisScript(`
-- READ_CONVERSATION_OWNER
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) ~= 1 then return {0} end
local kind = redis.call('TYPE', KEYS[2]).ok
if string.find(string.lower(kind), 'rejson', 1, true) then
  return {2, redis.call('JSON.GET', KEYS[2], '$.ownerId')}
end
if kind == 'string' then
  local head = redis.call('GETRANGE', KEYS[2], 0, 1023)
  local owner = string.match(head, '^{"id":"[^"\\\\]*","ownerId":"([^"\\\\]*)"')
  if owner then return {3, owner} end
  return {4, redis.call('GET', KEYS[2])}
end
return {1}
`);

export interface ConversationOwnership {
  /** The conversation is in the user's set. */
  member: boolean;
  /** The record's bound owner; null for a legacy or missing record. */
  ownerId: string | null;
}

export async function readConversationOwner(
  client: Redis,
  userId: string,
  conversationId: string,
): Promise<ConversationOwnership> {
  const [kind, value] = (await evalScript(
    client,
    READ_CONVERSATION_OWNER,
    2,
    sessionKey(['user', userId, 'conversations']),
    sessionKey(['conversation', conversationId]),
    conversationId,
  )) as [number, string?];
  switch (Number(kind)) {
    case 0:
      return { member: false, ownerId: null };
    case 2: {
      const owner = value ? JSON.parse(value)?.[0] : undefined;
      return {
        member: true,
        ownerId: typeof owner === 'string' ? owner : null,
      };
    }
    case 3:
      return { member: true, ownerId: value || null };
    case 4: {
      const owner = value ? JSON.parse(value)?.ownerId : undefined;
      return {
        member: true,
        ownerId: typeof owner === 'string' ? owner : null,
      };
    }
    default:
      return { member: true, ownerId: null };
  }
}
