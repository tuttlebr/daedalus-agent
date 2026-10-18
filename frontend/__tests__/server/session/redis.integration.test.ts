// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ username: '' }));
vi.mock('@/utils/auth/session', () => ({ getSession: async () => session }));

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'mixed-format bulk conversation reads',
  () => {
    let redis: typeof import('@/server/session/redis');
    let client: ReturnType<typeof redis.getRedis>;
    const prefix = `bulk-review-${randomUUID()}`;
    const keys = new Set<string>();
    const key = (...parts: string[]) => {
      const value = redis.sessionKey(parts);
      keys.add(value);
      return value;
    };

    beforeAll(async () => {
      if (!process.env.REDIS_URL) throw new Error('Disposable Redis required');
      redis = await import('@/server/session/redis');
      client = redis.getRedis();
      await client.ping();
      session.username = prefix;
    });

    afterAll(async () => {
      if (client) {
        if (keys.size) await client.del(...keys);
        client.disconnect();
      }
    });

    it('retains values, order, duplicate keys and missing keys across storage formats', async () => {
      const plain = key(prefix, 'plain');
      const json = key(prefix, 'json');
      const absent = key(prefix, 'absent');
      const value = { nested: [[], {}, 9007199254740991] };
      await client.set(plain, JSON.stringify(value));
      await client.call('JSON.SET', json, '$', JSON.stringify([value]));
      expect(await redis.jsonMGet([plain, json, absent, plain])).toEqual([
        value,
        [value],
        null,
        value,
      ]);
      expect(await redis.jsonMGet([json], '.')).toEqual([[value]]);
      expect(await redis.jsonMGet([])).toEqual([]);
    });

    it('matches individual reads for malformed plain-string records', async () => {
      const invalid = key(prefix, 'invalid');
      const empty = key(prefix, 'empty');
      const valid = key(prefix, 'valid');
      await client.set(invalid, '{invalid json');
      await client.set(empty, '');
      await client.set(valid, '[1,2]');
      const requested = [invalid, empty, valid];
      expect(await redis.jsonMGet(requested)).toEqual(
        await Promise.all(requested.map((entry) => redis.jsonGet(entry))),
      );
      expect(await redis.jsonMGet(requested)).toEqual([null, null, [1, 2]]);
    });

    it('lists newly saved plain-string conversations alongside legacy RedisJSON records', async () => {
      const { reserveConversationForUser } = await import(
        '@/server/session/conversationStore'
      );
      const handler = (await import('@/pages/api/conversations/index')).default;
      const plainId = `${prefix}-new`;
      const legacyId = `${prefix}-legacy`;
      key('conversation', plainId);
      const membership = key('user', prefix, 'conversations');
      const plain = await reserveConversationForUser(prefix, plainId, 'New');
      const legacy = {
        id: legacyId,
        ownerId: prefix,
        name: 'Legacy',
        messages: [],
      };
      await client.call(
        'JSON.SET',
        key('conversation', legacyId),
        '$',
        JSON.stringify(legacy),
      );
      await client.sadd(membership, legacyId);
      // Stale membership must not expose a different owner.
      await client.set(
        key('conversation', `${prefix}-foreign`),
        JSON.stringify({ ownerId: 'another-user', messages: ['private'] }),
      );
      await client.sadd(membership, `${prefix}-foreign`);
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handler({ method: 'GET' } as any, res as any);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json.mock.calls[0][0]).toEqual(
        expect.arrayContaining([plain, legacy]),
      );
      expect(res.json.mock.calls[0][0]).toHaveLength(2);
    });

    it('propagates unavailable data as a server error instead of an empty list', async () => {
      const handler = (await import('@/pages/api/conversations/index')).default;
      await client.sadd(
        key('user', prefix, 'conversations'),
        `${prefix}-outage`,
      );
      const outage = new Error('MASTERDOWN synthetic read outage');
      const call = vi.spyOn(client, 'call').mockRejectedValue(outage);
      const evalCommand = vi.spyOn(client, 'eval').mockRejectedValue(outage);
      const get = vi.spyOn(client, 'get').mockRejectedValue(outage);
      try {
        await expect(
          redis.jsonMGet([key(prefix, 'unavailable')]),
        ).rejects.toThrow('synthetic read outage');
        const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
        await handler({ method: 'GET' } as any, res as any);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
          error: 'Failed to fetch conversations',
        });
      } finally {
        call.mockRestore();
        evalCommand.mockRestore();
        get.mockRestore();
      }
    });
  },
);
