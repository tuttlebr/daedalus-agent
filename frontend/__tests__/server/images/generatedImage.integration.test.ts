// @vitest-environment node
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ username: '' }));
vi.mock('@/server/session/_utils', () => ({
  requireAuthenticatedUser: async () => identity,
  getStorageSessionId: () => 'generated-review-session',
}));

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'generated image views with real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let client: ReturnType<typeof redis.getRedis>;
    let route: typeof import('@/pages/api/generated-image/[id]');
    let helper: typeof import('@/server/images/generatedImage');
    const keys: string[] = [];

    const get = async (query: Record<string, string>) => {
      const res = {
        status: vi.fn().mockReturnThis(),
        setHeader: vi.fn(),
        send: vi.fn(),
        json: vi.fn(),
      };
      await route.default(
        { method: 'GET', query, headers: {} } as any,
        res as any,
      );
      return res;
    };

    const storeJson = async (record: Record<string, unknown>) => {
      const id = randomUUID();
      const key = `generated:image:${id}`;
      keys.push(key);
      await client.call('JSON.SET', key, '$', JSON.stringify(record));
      await client.expire(key, 600);
      return { id, key };
    };

    beforeAll(async () => {
      if (!process.env.REDIS_URL) throw new Error('Disposable Redis required');
      redis = await import('@/server/session/redis');
      client = redis.getRedis();
      identity.username = `generated-review-${randomUUID()}`;
      route = await import('@/pages/api/generated-image/[id]');
      helper = await import('@/server/images/generatedImage');
    });
    afterAll(async () => {
      if (client) {
        if (keys.length) await client.del(...keys);
        client.disconnect();
      }
    });

    it('persists the first thumbnail and later serves it without reading the original', async () => {
      const original = await sharp({
        create: { width: 1536, height: 1024, channels: 3, background: '#2a6' },
      })
        .png()
        .toBuffer();
      const { id, key } = await storeJson({
        data: original.toString('base64'),
        mimeType: 'image/png',
        userId: identity.username,
        source: 'visual_media.generate',
      });
      const ttl = await client.ttl(key);

      const first = await get({ id, thumbnail: 'true' });
      expect(first.status).toHaveBeenCalledWith(200);
      const thumbnail = first.send.mock.calls[0][0] as Buffer;
      const metadata = await sharp(thumbnail).metadata();
      expect([metadata.format, metadata.width, metadata.height]).toEqual([
        'jpeg',
        400,
        267,
      ]);
      const [persisted] = JSON.parse(
        (await client.call('JSON.GET', key, '$.thumbnail')) as string,
      );
      expect(Buffer.from(persisted, 'base64')).toEqual(thumbnail);
      // A path write keeps the backend's record expiry.
      expect(await client.ttl(key)).toBeLessThanOrEqual(ttl);
      expect(await client.ttl(key)).toBeGreaterThan(0);

      const call = vi.spyOn(client, 'call');
      const evaluate = vi.spyOn(client, 'eval');
      try {
        const later = await get({ id, thumbnail: '1' });
        expect(later.send.mock.calls[0][0]).toEqual(thumbnail);
        const requested = [...call.mock.calls, ...evaluate.mock.calls].flat();
        expect(requested).not.toContain('$.data');
        expect(requested).not.toContain('.data');
      } finally {
        call.mockRestore();
        evaluate.mockRestore();
      }

      const full = await get({ id });
      expect(full.send.mock.calls[0][0]).toEqual(original);
    });

    it('keeps the first persisted thumbnail and never recreates a deleted record', async () => {
      const { id, key } = await storeJson({
        data: 'AA==',
        userId: identity.username,
      });

      await helper.persistGeneratedImageThumbnail(id, 'Zmlyc3Q=');
      await helper.persistGeneratedImageThumbnail(id, 'c2Vjb25k');
      expect(
        JSON.parse(
          (await client.call('JSON.GET', key, '$.thumbnail')) as string,
        ),
      ).toEqual(['Zmlyc3Q=']);

      await client.del(key);
      await helper.persistGeneratedImageThumbnail(id, 'Zmlyc3Q=');
      expect(await client.exists(key)).toBe(0);
    });

    it('reads owner fields from RedisJSON and legacy string records', async () => {
      const { id } = await storeJson({
        data: 'AAAA',
        user: 'legacy-owner',
        sessionId: 'generated-review-session',
        mimeType: 'image/webp',
      });
      await expect(
        helper.readGeneratedImageRecord(id, ['mimeType']),
      ).resolves.toMatchObject({
        storage: 'json',
        hasData: true,
        user: 'legacy-owner',
        sessionId: 'generated-review-session',
        mimeType: 'image/webp',
      });

      const legacyId = randomUUID();
      const legacyKey = `generated:image:${legacyId}`;
      keys.push(legacyKey);
      await client.set(
        legacyKey,
        JSON.stringify({ data: 'AAAA', userId: identity.username }),
        'EX',
        600,
      );
      await expect(
        helper.readGeneratedImageRecord(legacyId, ['thumbnail']),
      ).resolves.toMatchObject({
        storage: 'string',
        hasData: true,
        userId: identity.username,
        data: 'AAAA',
      });
      await helper.persistGeneratedImageThumbnail(legacyId, 'AAAA');
      expect(await client.type(legacyKey)).toBe('string');
      await expect(
        helper.readGeneratedImageRecord(randomUUID()),
      ).resolves.toBeNull();
    });
  },
);
