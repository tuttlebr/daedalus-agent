// @vitest-environment node
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ username: '' }));
vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: async () => identity,
  getStorageSessionId: () => 'image-review-session',
}));

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'image storage views with real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let client: ReturnType<typeof redis.getRedis>;
    let storage: typeof import('@/pages/api/session/imageStorage');
    const keys: string[] = [];

    const get = async (query: Record<string, string>) => {
      const res = {
        status: vi.fn().mockReturnThis(),
        setHeader: vi.fn(),
        send: vi.fn(),
        json: vi.fn(),
      };
      await storage.default({ method: 'GET', query } as any, res as any);
      return res;
    };

    beforeAll(async () => {
      if (!process.env.REDIS_URL) throw new Error('Disposable Redis required');
      redis = await import('@/server/session/redis');
      client = redis.getRedis();
      identity.username = `image-review-${randomUUID()}`;
      storage = await import('@/pages/api/session/imageStorage');
    });
    afterAll(async () => {
      if (client) {
        if (keys.length) await client.del(...keys);
        await client.del(
          redis.sessionKey(['user', identity.username, 'images']),
        );
        client.disconnect();
      }
    });

    it('serves each stored view from its RedisJSON paths', async () => {
      const photo = await sharp({
        create: { width: 900, height: 600, channels: 3, background: '#2a6' },
      })
        .jpeg()
        .toBuffer();
      const { imageId } = await storage.storeImage(
        'image-review-session',
        identity.username,
        photo.toString('base64'),
        'image/jpeg',
      );
      const key = redis.sessionKey([
        'user',
        identity.username,
        'image',
        imageId,
      ]);
      keys.push(key);
      const stored = JSON.parse(
        (await client.call('JSON.GET', key, '$')) as string,
      )[0];
      expect(stored.thumbnail).toEqual(expect.any(String));

      const full = await get({ imageId });
      expect(full.status).toHaveBeenCalledWith(200);
      expect(full.send.mock.calls[0][0]).toEqual(photo);
      expect(full.setHeader).toHaveBeenCalledWith('X-Has-Thumbnail', 'true');

      const thumbnail = await get({ imageId, thumbnail: 'true' });
      expect(thumbnail.status).toHaveBeenCalledWith(200);
      expect(thumbnail.send.mock.calls[0][0]).toEqual(
        Buffer.from(stored.thumbnail, 'base64'),
      );
    });

    it('falls back to the original for a small image and keeps legacy strings readable', async () => {
      const icon = await sharp({
        create: { width: 8, height: 8, channels: 3, background: '#a26' },
      })
        .png()
        .toBuffer();
      const { imageId } = await storage.storeImage(
        'image-review-session',
        identity.username,
        icon.toString('base64'),
        'image/png',
      );
      keys.push(
        redis.sessionKey(['user', identity.username, 'image', imageId]),
      );
      const small = await get({ imageId, thumbnail: 'true' });
      expect(small.status).toHaveBeenCalledWith(200);
      expect(small.send.mock.calls[0][0]).toEqual(icon);

      const legacyId = `legacy-${randomUUID()}`;
      const legacyKey = redis.sessionKey([
        'user',
        identity.username,
        'image',
        legacyId,
      ]);
      keys.push(legacyKey);
      await client.set(
        legacyKey,
        JSON.stringify({
          id: legacyId,
          userId: identity.username,
          sessionId: 'image-review-session',
          mimeType: 'image/png',
          data: icon.toString('base64'),
        }),
      );
      const legacy = await get({ imageId: legacyId, thumbnail: 'true' });
      expect(legacy.status).toHaveBeenCalledWith(200);
      expect(legacy.send.mock.calls[0][0]).toEqual(icon);

      const missing = await get({ imageId: `absent-${randomUUID()}` });
      expect(missing.status).toHaveBeenCalledWith(404);
    });
  },
);
