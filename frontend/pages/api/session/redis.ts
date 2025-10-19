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

// JSON operation helpers (using regular Redis STRING commands)
export async function jsonSet(key: string, path: string, value: any, options?: { NX?: boolean; XX?: boolean }): Promise<string | null> {
  const client = getRedis();
  const serialized = JSON.stringify(value);
  
  if (options?.NX) {
    const result = await client.set(key, serialized, 'NX');
    return result;
  } else if (options?.XX) {
    const result = await client.set(key, serialized, 'XX');
    return result;
  }
  
  return await client.set(key, serialized);
}

export async function jsonGet(key: string, path: string = '.'): Promise<any> {
  const client = getRedis();
  const result = await client.get(key);
  return result ? JSON.parse(result) : null;
}

export async function jsonDel(key: string, path: string = '.'): Promise<number> {
  const client = getRedis();
  return await client.del(key);
}

export async function jsonSetWithExpiry(key: string, value: any, ttl: number): Promise<void> {
  const client = getRedis();
  const serialized = JSON.stringify(value);
  await client.setex(key, ttl, serialized);
}

export async function jsonMGet(keys: string[], path: string = '.'): Promise<any[]> {
  const client = getRedis();
  const results = await client.mget(...keys);
  return results.map(item => item ? JSON.parse(item) : null);
}
