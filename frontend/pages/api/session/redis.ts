import Redis from 'ioredis';

let redis: Redis | null = null;
let redisJsonSupported: boolean | null = null;

// Dedicated pub/sub clients (cannot reuse connections for pub/sub)
let publisher: Redis | null = null;
let subscriber: Redis | null = null;

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
    // Probe for RedisJSON support once and cache the result
    await client.call('JSON.SET', '__redisjson_probe__', '$', 'null');
    await client.call('JSON.DEL', '__redisjson_probe__', '$');
    redisJsonSupported = true;
  } catch (error) {
    console.warn('RedisJSON not available – falling back to plain Redis commands for JSON helpers.', error);
    redisJsonSupported = false;
  }

  return redisJsonSupported;
}

export function getRedis(): Redis {
  if (redis && !isRedisConnectionStale(redis)) {
    return redis;
  }

  const url = process.env.REDIS_URL || 'redis://redis:6379';

  redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 5,
    enableOfflineQueue: true,
    reconnectOnError: () => true,
  });

  redis.on('error', (error) => {
    console.error('Redis connection error', error);
  });

  redis.connect().catch((error) => {
    console.error('Failed to connect to Redis', error);
  });

  return redis;
}

function isRedisConnectionStale(client: Redis): boolean {
  return ['end', 'close', 'reconnecting'].includes(client.status);
}

export function sessionKey(parts: Array<string | undefined | null>): string {
  return parts.filter(Boolean).join(':');
}

// JSON operation helpers using RedisJSON commands
export async function jsonSet(key: string, path: string, value: any, options?: { NX?: boolean; XX?: boolean }): Promise<string | null> {
  const client = getRedis();
  const supportsJson = await ensureRedisJson(client);

  // Fallback when RedisJSON is unavailable
  if (!supportsJson) {
    // Only root paths are supported in fallback mode
    if (path !== '$' && path !== '.') {
      console.warn(`jsonSet fallback only supports root path. Received path: ${path}`);
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

    const result = await client.call('JSON.SET', ...args) as string | null;
    return result;
  } catch (error) {
    console.error('Error in jsonSet:', error);
    throw error;
  }
}

export async function jsonGet(key: string, path: string = '$'): Promise<any> {
  const client = getRedis();
  const supportsJson = await ensureRedisJson(client);

  // Fallback when RedisJSON is unavailable
  if (!supportsJson) {
    const result = await client.get(key);
    if (!result) return null;
    try {
      return JSON.parse(result);
    } catch (error) {
      console.error('Error parsing JSON from Redis fallback jsonGet:', error);
      return null;
    }
  }

  try {
    // Use RedisJSON JSON.GET command
    const result = await client.call('JSON.GET', key, path) as string | null;

    if (!result) return null;

    // RedisJSON returns an array when using $ path
    const parsed = JSON.parse(result);
    return path.startsWith('$') && Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (error) {
    console.error('Error in jsonGet:', error);
    return null;
  }
}

export async function jsonDel(key: string, path: string = '$'): Promise<number> {
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
      const result = await client.call('JSON.DEL', key, path) as number;
      return result;
    }
  } catch (error) {
    console.error('Error in jsonDel:', error);
    return 0;
  }
}

export async function jsonSetWithExpiry(key: string, value: any, ttl: number): Promise<void> {
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
    // Set the JSON value
    await client.call('JSON.SET', key, '$', JSON.stringify(value));
    // Set expiry
    await client.expire(key, ttl);
  } catch (error) {
    console.error('Error in jsonSetWithExpiry:', error);
    throw error;
  }
}

export async function jsonMGet(keys: string[], path: string = '$'): Promise<any[]> {
  const client = getRedis();
  const supportsJson = await ensureRedisJson(client);

  // Fallback when RedisJSON is unavailable
  if (!supportsJson) {
    try {
      const results = await client.mget(...keys);
      return results.map(item => {
        if (!item) return null;
        try {
          return JSON.parse(item);
        } catch (error) {
          console.error('Error parsing JSON from Redis fallback jsonMGet:', error);
          return null;
        }
      });
    } catch (error) {
      console.error('Error in jsonMGet fallback:', error);
      return keys.map(() => null);
    }
  }

  try {
    // Use RedisJSON JSON.MGET command
    const result = await client.call('JSON.MGET', ...keys, path) as (string | null)[];

    return result.map(item => {
      if (!item) return null;
      const parsed = JSON.parse(item);
      return path.startsWith('$') && Array.isArray(parsed) ? parsed[0] : parsed;
    });
  } catch (error) {
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

  const url = process.env.REDIS_URL || 'redis://redis:6379';

  publisher = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    reconnectOnError: () => true,
  });

  publisher.on('error', (error) => {
    console.error('Redis publisher connection error', error);
  });

  publisher.connect().catch((error) => {
    console.error('Failed to connect Redis publisher', error);
  });

  return publisher;
}

// Subscriber client for receiving messages
export function getSubscriber(): Redis {
  if (subscriber && !isRedisConnectionStale(subscriber)) {
    return subscriber;
  }

  const url = process.env.REDIS_URL || 'redis://redis:6379';

  subscriber = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    reconnectOnError: () => true,
  });

  subscriber.on('error', (error) => {
    console.error('Redis subscriber connection error', error);
  });

  subscriber.connect().catch((error) => {
    console.error('Failed to connect Redis subscriber', error);
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
  sessionId: string
): Promise<void> {
  const client = getRedis();
  const key = sessionKey(['streaming', 'user', userId, 'conversation', conversationId]);

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
  conversationId: string
): Promise<void> {
  const client = getRedis();
  const key = sessionKey(['streaming', 'user', userId, 'conversation', conversationId]);
  await jsonDel(key);
}

// Get all streaming states for a user
export async function getStreamingStates(
  userId: string
): Promise<Record<string, StreamingState>> {
  const client = getRedis();
  const pattern = sessionKey(['streaming', 'user', userId, 'conversation', '*']);

  const states: Record<string, StreamingState> = {};

  try {
    const keys = await client.keys(pattern);
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
