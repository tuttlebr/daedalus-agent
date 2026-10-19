import { primeDns } from './dns-cache';
import {
  DEFAULT_REDIS_URL,
  REDIS_CLIENT_OPTIONS,
  channels,
  createRedisErrorThrottle,
  parseRedisJsonResult,
  redisErrorMessage,
  resolveRedisUrl,
  sessionKey,
} from './redisShared';

import Redis from 'ioredis';
import dns from 'node:dns';

export { channels, sessionKey };

// Prefer IPv4 — Node ≥17 defaults to 'verbatim' which can return AAAA
// records first and stall DNS resolution against Kubernetes CoreDNS.
dns.setDefaultResultOrder('ipv4first');

let redis: Redis | null = null;
let redisJsonSupported: boolean | null = null;

// Dedicated publisher client (cannot reuse the main connection for pub/sub)
let publisher: Redis | null = null;

// Fire-and-forget: prime cache for the configured Redis host at module load.
try {
  const seedHost = new URL(process.env.REDIS_URL || DEFAULT_REDIS_URL).hostname;
  void primeDns(seedHost);
} catch {
  // Ignore unparseable URL — connection will fail later with a clearer error.
}

const logRedisErrorThrottled = createRedisErrorThrottle();

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
    // "Existing key has wrong Redis type". Readers and the durable root writer
    // recognize both error forms for mixed-format compatibility.
    message.includes('wrong redis type')
  );
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

  return parsePlainJson(result);
}

function parsePlainJson(result: string | null): any {
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch {
    console.error('Invalid JSON in a plain Redis record');
    return null;
  }
}

// Atomically replace a root document and its TTL. Preserve plain JSON strings
// and replace other non-JSON types without exposing a missing-key interval.
const JSON_SET_WITH_EXPIRY_LUA = [
  "local kind = redis.call('TYPE', KEYS[1]).ok",
  "if kind ~= 'none' and not string.find(string.lower(kind), 'rejson', 1, true) then",
  "  return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])",
  'end',
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
  await client.eval(JSON_SET_WITH_EXPIRY_LUA, 1, key, serialized, ttl);
}

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
    // Only an absent key is null. A read outage must not look like a missing
    // job/conversation and authorize cleanup of its durable state.
    throw error;
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
    return (await client.call('JSON.DEL', key, path)) as number;
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

// JSON.MGET silently returns null for plain-string keys, including new records
// written by conversationStore. Read both formats in one round trip and keep
// JSON opaque in Lua so empty arrays and large integers survive unchanged.
const READ_JSON_BATCH_LUA = `
-- READ_JSON_BATCH
local values = {}
for _, key in ipairs(KEYS) do
  local kind = redis.call('TYPE', key).ok
  local raw = false
  if kind == 'string' then
    raw = redis.call('GET', key)
  elseif string.find(string.lower(kind), 'rejson', 1, true) then
    raw = redis.call('JSON.GET', key, ARGV[1])
  end
  table.insert(values, {kind, raw})
end
return values
`;

export async function jsonMGet(
  keys: string[],
  path: string = '$',
): Promise<any[]> {
  if (!keys.length) return [];
  const values = (await getRedis().eval(
    READ_JSON_BATCH_LUA,
    keys.length,
    ...keys,
    path,
  )) as [string, string | null][];
  // A failed read must reach the caller's error handler, never look like an
  // empty conversation list. Plain strings retain jsonGet's root semantics.
  return values.map(([kind, raw]) =>
    kind === 'string' ? parsePlainJson(raw) : parseRedisJsonResult(raw, path),
  );
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

// Streaming state storage for cross-session sync
export interface StreamingState {
  conversationId: string;
  sessionId: string;
  startedAt: number;
  userId: string;
}

// Auto-cleanup for an abandoned run; the stream worker's lease heartbeat
// renews it while the job that owns it is still running.
export const STREAMING_STATE_TTL_SECONDS = 600;

// Set streaming state for a conversation
export async function setStreamingState(
  userId: string,
  conversationId: string,
  sessionId: string,
): Promise<void> {
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

  await jsonSetWithExpiry(key, state, STREAMING_STATE_TTL_SECONDS);
}

const CLEAR_STREAMING_STATE_LUA = `
local kind = redis.call('TYPE', KEYS[1]).ok
if kind == 'none' then return 0 end
local raw
if kind == 'string' then
  raw = redis.call('GET', KEYS[1])
else
  raw = redis.call('JSON.GET', KEYS[1], '.')
end
local current = cjson.decode(raw)
if type(current) ~= 'table' or current.sessionId ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

// Cleanup may resume after the guard was released and another job started.
// Compare the owner and delete atomically, including for legacy JSON records.
export async function clearStreamingState(
  userId: string,
  conversationId: string,
  sessionId: string,
): Promise<void> {
  const key = sessionKey([
    'streaming',
    'user',
    userId,
    'conversation',
    conversationId,
  ]);
  await getRedis().eval(CLEAR_STREAMING_STATE_LUA, 1, key, sessionId);
}
