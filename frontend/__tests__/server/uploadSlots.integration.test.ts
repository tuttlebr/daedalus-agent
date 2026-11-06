import { acquireUploadSlot, releaseUploadSlot } from '@/server/uploadSlots';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'document upload slots in real Redis',
  () => {
    const key = `test:upload-slots:${process.pid}`;
    let redis: Redis;

    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('Disposable Redis required for upload slot tests');
      redis = new Redis(process.env.REDIS_URL, { lazyConnect: true });
      await redis.connect();
    });

    beforeEach(async () => {
      await redis.del(key);
    });

    afterAll(async () => {
      await redis.del(key);
      await redis.quit();
    });

    it('admits at most the limit until an upload releases its slot', async () => {
      expect(await acquireUploadSlot(redis, key, 'a', 2, 60)).toBe(true);
      expect(await acquireUploadSlot(redis, key, 'b', 2, 60)).toBe(true);
      expect(await acquireUploadSlot(redis, key, 'c', 2, 60)).toBe(false);

      await releaseUploadSlot(redis, key, 'a');
      expect(await acquireUploadSlot(redis, key, 'c', 2, 60)).toBe(true);
      expect(await redis.zrange(key, 0, -1)).toEqual(
        expect.arrayContaining(['b', 'c']),
      );
    });

    it('frees a leaked slot at its own deadline while the user keeps uploading', async () => {
      // A process stopped before releasing "leaked". Later uploads keep the
      // set alive; with one shared counter they also kept the leak alive.
      expect(await acquireUploadSlot(redis, key, 'leaked', 2, 1)).toBe(true);
      expect(await acquireUploadSlot(redis, key, 'active', 2, 60)).toBe(true);
      expect(await acquireUploadSlot(redis, key, 'waiting', 2, 60)).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 1_100));

      expect(await acquireUploadSlot(redis, key, 'waiting', 2, 60)).toBe(true);
      expect((await redis.zrange(key, 0, -1)).sort()).toEqual([
        'active',
        'waiting',
      ]);
    });

    it('never releases another upload when a slow upload finishes late', async () => {
      expect(await acquireUploadSlot(redis, key, 'slow', 1, 1)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      // The slow upload's reservation expired; a new upload takes the slot.
      expect(await acquireUploadSlot(redis, key, 'new', 1, 60)).toBe(true);

      await releaseUploadSlot(redis, key, 'slow');

      // The limit still holds: the late release did not erase "new".
      expect(await acquireUploadSlot(redis, key, 'third', 1, 60)).toBe(false);
      expect(await redis.zrange(key, 0, -1)).toEqual(['new']);
    });

    it('keeps the set until its latest reservation ends', async () => {
      await acquireUploadSlot(redis, key, 'long', 3, 900);
      await acquireUploadSlot(redis, key, 'short', 3, 60);
      // A shorter later reservation must not expire the longer one with it.
      expect(await redis.ttl(key)).toBeGreaterThan(800);
      await acquireUploadSlot(redis, key, 'longer', 3, 1_200);
      expect(await redis.ttl(key)).toBeGreaterThan(1_100);
    });
  },
);
