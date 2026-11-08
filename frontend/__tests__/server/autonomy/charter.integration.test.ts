// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'charter concurrency against real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let store: typeof import('@/server/autonomy/store');
    const users: string[] = [];
    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('Disposable REDIS_URL required');
      redis = await import('@/server/session/redis');
      store = await import('@/server/autonomy/store');
      await redis.getRedis().ping();
    });
    afterAll(async () => {
      if (redis) {
        for (const user of users) {
          const keys = await redis
            .getRedis()
            .keys(`autonomy:${user}:charter:*`);
          if (keys.length) await redis.getRedis().del(...keys);
        }
        redis.getRedis().disconnect();
      }
    });
    it('concurrent settings patches preserve independent responsibility changes', async () => {
      const user = `charter-${process.pid}-${Date.now()}`;
      users.push(user);
      await Promise.all([
        store.saveConfig(user, {
          responsibilities: { calendar: { calendarId: 'selected' } },
        }),
        store.saveConfig(user, {
          responsibilities: { lighting: { enabled: false } },
        }),
      ]);
      const config = await store.getConfig(user);
      expect(config.responsibilities.calendar.calendarId).toBe('selected');
      expect(config.responsibilities.lighting.enabled).toBe(false);
    });
    it('concurrent check-now requests schedule only one action', async () => {
      const user = `charter-queue-${process.pid}-${Date.now()}`;
      users.push(user);
      const ids = await Promise.all(
        Array.from({ length: 10 }, () =>
          store.requestResponsibility(user, 'cluster'),
        ),
      );
      expect(new Set(ids).size).toBe(1);
      expect(Object.keys((await store.getState(user)).actions)).toHaveLength(1);
    });
  },
);
