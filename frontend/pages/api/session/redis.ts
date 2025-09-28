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
