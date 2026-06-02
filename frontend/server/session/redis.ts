import { positiveIntegerFromEnv } from '../config/env';
import { primeDns, getCachedIp } from './dns-cache';

import Redis, { RedisOptions } from 'ioredis';
import dns from 'node:dns';

// Prefer IPv4 — Node ≥17 defaults to 'verbatim' which can return AAAA
// records first and stall DNS resolution against Kubernetes CoreDNS.
dns.setDefaultResultOrder('ipv4first');

let redis: Redis | null = null;
let redisJsonSupported: boolean | null = null;

// Dedicated pub/sub clients (cannot reuse connections for pub/sub)
let publisher: Redis | null = null;
let subscriber: Redis | null = null;

const REDIS_MAX_RETRIES_PER_REQUEST = positiveIntegerFromEnv(
  'REDIS_MAX_RETRIES_PER_REQUEST',
  3,
);
const REDIS_COMMAND_TIMEOUT_MS = positiveIntegerFromEnv(
  'REDIS_COMMAND_TIMEOUT_MS',
  10_000,
);

// Bound per-command retries and timeouts so failed Redis connectivity does not
// leave API requests pending indefinitely.
const REDIS_CLIENT_OPTIONS: RedisOptions = {
  lazyConnect: true,
  maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
  enableOfflineQueue: true,
  reconnectOnError: () => true,
  connectTimeout: 10_000,
  commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
  retryStrategy: (times) => Math.min(times * 200, 2_000),
  family: 4,
};

function resolveRedisUrl(): string {
  const raw = process.env.REDIS_URL || 'redis://redis:6379';
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

// Fire-and-forget: prime cache for the configured Redis host at module load.
try {
  const seedHost = new URL(process.env.REDIS_URL || 'redis://redis:6379')
    .hostname;
  void primeDns(seedHost);
} catch {
  // Ignore unparseable URL — connection will fail later with a clearer error.
}

// Collapse repeated transient errors (EAI_AGAIN, ECONNRESET, etc.) into a
// single log line per (label, code) every 30 s so logs are scannable.
type ThrottleState = { count: number; firstSeen: number };
const errorThrottle = new Map<string, ThrottleState>();
const ERROR_LOG_INTERVAL_MS = 30_000;

function logRedisErrorThrottled(label: string, error: unknown): void {
  const code = (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
  const key = `${label}:${code}`;
  const now = Date.now();
  const state = errorThrottle.get(key);
  if (!state) {
    console.error(`Redis ${label} error (${code}):`, error);
    errorThrottle.set(key, { count: 1, firstSeen: now });
    return;
  }
  if (now - state.firstSeen > ERROR_LOG_INTERVAL_MS) {
    console.error(
      `Redis ${label} error (${code}) repeated ${
        state.count
      }x in last ${Math.round((now - state.firstSeen) / 1000)}s`,
      error,
    );
    errorThrottle.set(key, { count: 1, firstSeen: now });
    return;
  }
  state.count += 1;
}

function redisErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isRedisJsonUnsupportedError(error: unknown): boolean {
  const message = redisErrorMessage(error).toLowerCase();
  return (
    message.includes('unknown command') ||
    message.includes('unknown subcommand') ||
    message.includes('wrong number of arguments for') ||
    (message.includes('module') && message.includes('not loaded'))
  );
}

function isWrongTypeError(error: unknown): boolean {
  const message = redisErrorMessage(error).toLowerCase();
  return (
    message.includes('wrongtype') ||
    message.includes('wrong kind of value') ||
    // RedisJSON surfaces a non-standard message when JSON.SET hits a key that
    // already exists as a plain (non-JSON) type, e.g.
    // "Existing key has wrong Redis type". Match it so the del+retry recovery
    // in setRedisJsonRootWithExpiry / jsonSet actually fires on the RedisJSON
    // deployment instead of rethrowing.
    message.includes('wrong redis type')
  );
}

function parseRedisJsonResult(result: string | null, path: string): any {
  if (!result) return null;
  const parsed = JSON.parse(result);
  return path.startsWith('$') && Array.isArray(parsed) ? parsed[0] : parsed;
}

async function getPlainJson(client: Redis, key: string): Promise<any> {
  let result: string | null;
  try {
    result = await client.get(key);
  } catch (error) {
    if (isWrongTypeError(error)) {
      return null;
    }
    throw error;
  }

  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch (error) {
    console.error('Error parsing JSON from Redis fallback jsonGet:', error);
    return null;
  }
}

// Atomically write a RedisJSON root document and set its TTL in a single
// round-trip. A separate JSON.SET + EXPIRE risks leaving a TTL-less key if the
// EXPIRE fails (timeout/disconnect) after the write succeeds; EVAL runs the two
// commands as one atomic unit so the key never persists without its expiry.
const JSON_SET_WITH_EXPIRY_LUA = [
  "redis.call('JSON.SET', KEYS[1], '$', ARGV[1])",
  "return redis.call('EXPIRE', KEYS[1], ARGV[2])",
].join('\n');

async function setRedisJsonRootWithExpiry(
  client: Redis,
  key: string,
  value: any,
  ttl: number,
): Promise<void> {
  const serialized = JSON.stringify(value);
  try {
    await client.eval(JSON_SET_WITH_EXPIRY_LUA, 1, key, serialized, ttl);
  } catch (error) {
    if (!isWrongTypeError(error)) {
      throw error;
    }
    // Key exists as a non-JSON type: drop it and retry the atomic write.
    await client.del(key);
    await client.eval(JSON_SET_WITH_EXPIRY_LUA, 1, key, serialized, ttl);
  }
}

// Channel name helpers for real-time sync
export const channels = {
  userUpdates: (userId: string) => `user:${userId}:updates`,
  streamingState: (userId: string) => `user:${userId}:streaming`,
};

async function ensureRedisJson(client: Redis): Promise<boolean> {
  if (redisJsonSupported !== null) {
    return redisJsonSupported;
  }

  try {
    // Use COMMAND INFO instead of a JSON.SET probe. A write probe fails when
    // Redis is in MISCONF/readonly mode and should not be mistaken for a
    // missing RedisJSON module.
    const info = (await client.call('COMMAND', 'INFO', 'JSON.GET')) as unknown;
    redisJsonSupported =
      Array.isArray(info) && info.length > 0 && info[0] !== null;
  } catch (error) {
    if (isRedisJsonUnsupportedError(error)) {
      console.warn(
        'RedisJSON not available – falling back to plain Redis commands for JSON helpers.',
        error,
      );
      redisJsonSupported = false;
    } else {
      console.error(
        'RedisJSON capability check failed because Redis is unhealthy.',
        error,
      );
      throw error;
    }
  }

  return redisJsonSupported;
}

export function getRedis(): Redis {
  if (redis && !isRedisConnectionStale(redis)) {
    return redis;
  }
  if (redis) {
    redis.disconnect();
    redis = null;
  }

  redis = new Redis(resolveRedisUrl(), REDIS_CLIENT_OPTIONS);

  redis.on('error', (error) => {
    logRedisErrorThrottled('main', error);
  });

  redis.connect().catch((error) => {
    logRedisErrorThrottled('main-connect', error);
  });

  return redis;
}

function isRedisConnectionStale(client: Redis): boolean {
  // 'reconnecting' means the client is actively recovering — keep it.
  return ['end', 'close'].includes(client.status);
}

export function sessionKey(parts: Array<string | undefined | null>): string {
  return parts.filter(Boolean).join(':');
}

// JSON operation helpers using RedisJSON commands
export async function jsonSet(
  key: string,
  path: string,
  value: any,
  options?: { NX?: boolean; XX?: boolean },
): Promise<string | null> {
  const client = getRedis();
  const supportsJson = await ensureRedisJson(client);

  // Fallback when RedisJSON is unavailable
  if (!supportsJson) {
    // Only root paths are supported in fallback mode
    if (path !== '$' && path !== '.') {
      console.warn(
        `jsonSet fallback only supports root path. Received path: ${path}`,
      );
    }

    const args: (string | number)[] = [key, JSON.stringify(value)];
    if (options?.NX) {
      args.push('NX');
    } else if (options?.XX) {
      args.push('XX');
    }

    return await client.set(...(args as [string, string, ...any]));
  }

  try {
    // Use RedisJSON JSON.SET command
    const args = [key, path, JSON.stringify(value)];

    if (options?.NX) {
      args.push('NX');
    } else if (options?.XX) {
      args.push('XX');
    }

    const result = (await client.call('JSON.SET', ...args)) as string | null;
    return result;
  } catch (error) {
    if (isWrongTypeError(error) && (path === '$' || path === '.')) {
      await client.del(key);
      return (await client.call(
        'JSON.SET',
        key,
        path,
        JSON.stringify(value),
      )) as string | null;
    }
    console.error('Error in jsonSet:', error);
    throw error;
  }
}

export async function jsonGet(key: string, path: string = '$'): Promise<any> {
  const client = getRedis();
  const supportsJson = await ensureRedisJson(client);

  // Fallback when RedisJSON is unavailable
  if (!supportsJson) {
    return await getPlainJson(client, key);
  }

  try {
    // Use RedisJSON JSON.GET command
    const result = (await client.call('JSON.GET', key, path)) as string | null;
    return parseRedisJsonResult(result, path);
  } catch (error) {
    if (isWrongTypeError(error)) {
      return await getPlainJson(client, key);
    }
    console.error('Error in jsonGet:', error);
    return null;
  }
}

export async function jsonDel(
  key: string,
  path: string = '$',
): Promise<number> {
  const client = getRedis();
  const supportsJson = await ensureRedisJson(client);

  // Fallback when RedisJSON is unavailable
  if (!supportsJson || path === '$') {
    return await client.del(key);
  }

  try {
    if (path === '$') {
      // Delete the entire key
      return await client.del(key);
    } else {
      // Delete a specific path
      const result = (await client.call('JSON.DEL', key, path)) as number;
      return result;
    }
  } catch (error) {
    console.error('Error in jsonDel:', error);
    return 0;
  }
}

export async function jsonSetWithExpiry(
  key: string,
  value: any,
  ttl: number,
): Promise<void> {
  const client = getRedis();
  const supportsJson = await ensureRedisJson(client);

  // Fallback when RedisJSON is unavailable
  if (!supportsJson) {
    try {
      await client.set(key, JSON.stringify(value), 'EX', ttl);
      return;
    } catch (error) {
      console.error('Error in jsonSetWithExpiry fallback:', error);
      throw error;
    }
  }

  try {
    await setRedisJsonRootWithExpiry(client, key, value, ttl);
  } catch (error) {
    console.error('Error in jsonSetWithExpiry:', error);
    throw error;
  }
}

export async function jsonMGet(
  keys: string[],
  path: string = '$',
): Promise<any[]> {
  const client = getRedis();
  const supportsJson = await ensureRedisJson(client);

  // Fallback when RedisJSON is unavailable
  if (!supportsJson) {
    try {
      return await Promise.all(keys.map((key) => getPlainJson(client, key)));
    } catch (error) {
      console.error('Error in jsonMGet fallback:', error);
      return keys.map(() => null);
    }
  }

  try {
    // Use RedisJSON JSON.MGET command
    const result = (await client.call('JSON.MGET', ...keys, path)) as (
      | string
      | null
    )[];

    return result.map((item) => parseRedisJsonResult(item, path));
  } catch (error) {
    if (isWrongTypeError(error)) {
      return await Promise.all(keys.map((key) => jsonGet(key, path)));
    }
    console.error('Error in jsonMGet:', error);
    return keys.map(() => null);
  }
}

// Pub/Sub client management
// Publisher client for sending messages
export function getPublisher(): Redis {
  if (publisher && !isRedisConnectionStale(publisher)) {
    return publisher;
  }
  if (publisher) {
    publisher.disconnect();
    publisher = null;
  }

  publisher = new Redis(resolveRedisUrl(), REDIS_CLIENT_OPTIONS);

  publisher.on('error', (error) => {
    logRedisErrorThrottled('publisher', error);
  });

  publisher.connect().catch((error) => {
    logRedisErrorThrottled('publisher-connect', error);
  });

  return publisher;
}

// Subscriber client for receiving messages
export function getSubscriber(): Redis {
  if (subscriber && !isRedisConnectionStale(subscriber)) {
    return subscriber;
  }
  if (subscriber) {
    subscriber.disconnect();
    subscriber = null;
  }

  subscriber = new Redis(resolveRedisUrl(), REDIS_CLIENT_OPTIONS);

  subscriber.on('error', (error) => {
    logRedisErrorThrottled('subscriber', error);
  });

  subscriber.connect().catch((error) => {
    logRedisErrorThrottled('subscriber-connect', error);
  });

  return subscriber;
}

// Streaming state storage for cross-session sync
export interface StreamingState {
  conversationId: string;
  sessionId: string;
  startedAt: number;
  userId: string;
}

const STREAMING_STATE_TTL = 600; // 10 minutes auto-cleanup

// Set streaming state for a conversation
export async function setStreamingState(
  userId: string,
  conversationId: string,
  sessionId: string,
): Promise<void> {
  const client = getRedis();
  const key = sessionKey([
    'streaming',
    'user',
    userId,
    'conversation',
    conversationId,
  ]);

  const state: StreamingState = {
    conversationId,
    sessionId,
    startedAt: Date.now(),
    userId,
  };

  await jsonSetWithExpiry(key, state, STREAMING_STATE_TTL);
}

// Clear streaming state for a conversation
export async function clearStreamingState(
  userId: string,
  conversationId: string,
): Promise<void> {
  const client = getRedis();
  const key = sessionKey([
    'streaming',
    'user',
    userId,
    'conversation',
    conversationId,
  ]);
  await jsonDel(key);
}

// Get all streaming states for a user
export async function getStreamingStates(
  userId: string,
): Promise<Record<string, StreamingState>> {
  const client = getRedis();
  const pattern = sessionKey([
    'streaming',
    'user',
    userId,
    'conversation',
    '*',
  ]);

  const states: Record<string, StreamingState> = {};

  try {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');

    if (keys.length === 0) {
      return states;
    }

    const values = await jsonMGet(keys);

    keys.forEach((key, index) => {
      const state = values[index] as StreamingState | null;
      if (state && state.conversationId) {
        states[state.conversationId] = state;
      }
    });
  } catch (error) {
    console.error('Error getting streaming states:', error);
  }

  return states;
}
