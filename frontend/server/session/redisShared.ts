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
  reconnectOnError: () => true,
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
