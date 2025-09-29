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

// JSON operation helpers
export async function jsonSet(key: string, path: string, value: any, options?: { NX?: boolean; XX?: boolean }): Promise<string | null> {
  const client = getRedis();
  const args: any[] = [key, path, JSON.stringify(value)];

  if (options?.NX) args.push('NX');
  if (options?.XX) args.push('XX');

  return await client.call('JSON.SET', ...args);
}

export async function jsonGet(key: string, path: string = '.'): Promise<any> {
  const client = getRedis();
  const result = await client.call('JSON.GET', key, path);
  return result ? JSON.parse(result as string) : null;
}

export async function jsonDel(key: string, path: string = '.'): Promise<number> {
  const client = getRedis();
  return await client.call('JSON.DEL', key, path) as number;
}

export async function jsonSetWithExpiry(key: string, value: any, ttl: number): Promise<void> {
  const client = getRedis();
  const pipeline = client.pipeline();
  pipeline.call('JSON.SET', key, '.', JSON.stringify(value));
  pipeline.expire(key, ttl);
  await pipeline.exec();
}

export async function jsonMGet(keys: string[], path: string = '.'): Promise<any[]> {
  const client = getRedis();
  const result = await client.call('JSON.MGET', ...keys, path);
  return (result as string[]).map(item => item ? JSON.parse(item) : null);
}
