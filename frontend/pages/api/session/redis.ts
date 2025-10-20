import Redis from 'ioredis';

let redis: Redis | null = null;

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
