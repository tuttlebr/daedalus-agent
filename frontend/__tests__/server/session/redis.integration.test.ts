// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ username: '' }));
vi.mock('@/utils/auth/session', () => ({ getSession: async () => session }));
vi.mock('@/server/session/_utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/session/_utils')>()),
  getOrSetSessionId: () => 'integration-session',
}));

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

    it.each(['absent', 'string', 'json', 'list', 'set'])(
      'replaces a %s record with exact JSON and an expiry in one commit',
      async (format) => {
        const target = key(prefix, 'replace', format);
        if (format === 'string') await client.set(target, '{"old":true}');
        if (format === 'json')
          await client.call('JSON.SET', target, '$', '{"old":true}');
        if (format === 'list') await client.rpush(target, 'old');
        if (format === 'set') await client.sadd(target, 'old');
        const value = { rows: [[], {}, 9007199254740991], text: '雪' };
        const evaluate = vi.spyOn(client, 'eval');
        const remove = vi.spyOn(client, 'del');
        try {
          await redis.jsonSetWithExpiry(target, value, 120);
          expect(await redis.jsonGet(target)).toEqual(value);
          expect(await client.ttl(target)).toBeGreaterThan(0);
          expect(await client.ttl(target)).toBeLessThanOrEqual(120);
          expect(evaluate).toHaveBeenCalledTimes(1);
          expect(remove).not.toHaveBeenCalled();
        } finally {
          evaluate.mockRestore();
          remove.mockRestore();
        }
      },
    );

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

    it.each(['string', 'json'])(
      'only clears streaming state belonging to the finishing job (%s)',
      async (format) => {
        const conversationId = `${prefix}-stream-${format}`;
        const streamingKey = key(
          'streaming',
          'user',
          prefix,
          'conversation',
          conversationId,
        );
        const state = {
          userId: prefix,
          conversationId,
          sessionId: 'new-job',
          startedAt: 1,
        };
        if (format === 'string')
          await client.set(streamingKey, JSON.stringify(state));
        else
          await client.call(
            'JSON.SET',
            streamingKey,
            '$',
            JSON.stringify(state),
          );
        await redis.clearStreamingState(prefix, conversationId, 'old-job');
        expect(await redis.jsonGet(streamingKey)).toEqual(state);
        await redis.clearStreamingState(prefix, conversationId, 'new-job');
        expect(await redis.jsonGet(streamingKey)).toBeNull();
        await redis.clearStreamingState(prefix, conversationId, 'new-job');
      },
    );

    it('lists newly saved plain-string conversations alongside legacy RedisJSON records', async () => {
      const { reserveConversationForUser } = await import(
        '@/server/session/conversationStore'
      );
      const handler = (await import('@/pages/api/session/conversationHistory'))
        .default;
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
      // Neither record stores a revision; both are identified by updatedAt.
      expect(res.json.mock.calls[0][0]).toEqual(
        expect.arrayContaining([
          { ...plain, revision: 't0' },
          { ...legacy, revision: 't0' },
        ]),
      );
      expect(res.json.mock.calls[0][0]).toHaveLength(2);
    });

    it('propagates unavailable data as a server error instead of an empty list', async () => {
      const handler = (await import('@/pages/api/session/conversationHistory'))
        .default;
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
          error: 'Failed to load conversationHistory',
        });
      } finally {
        call.mockRestore();
        evalCommand.mockRestore();
        get.mockRestore();
      }
    });

    describe('field-limited ownership reads', () => {
      const history = Array.from({ length: 200 }, (_, index) => ({
        id: `m${index}`,
        role: index % 2 ? 'assistant' : 'user',
        content: 'x'.repeat(2_000),
        // Nested owner-like keys must never be mistaken for the record's.
        metadata: { ownerId: 'mallory', userId: 'mallory' },
      }));

      it.each(['string', 'json', 'absent'])(
        'reads only the requested request fields from a %s record',
        async (format) => {
          const { readJsonFields } = await import(
            '@/server/session/redisShared'
          );
          const target = key(prefix, 'request', format);
          const request = {
            jobId: 'job-1',
            messages: history,
            userId: 'alice',
            executionMode: 'stream',
            natBaseUrl: 'http://backend:8000',
          };
          if (format === 'string')
            await client.set(target, JSON.stringify(request));
          if (format === 'json')
            await client.call('JSON.SET', target, '$', JSON.stringify(request));
          const fields = await readJsonFields<typeof request>(client, target, [
            'userId',
            'executionMode',
            'timezone' as any,
          ]);
          expect(fields).toEqual(
            format === 'absent'
              ? null
              : { userId: 'alice', executionMode: 'stream' },
          );
          const single = await readJsonFields<typeof request>(client, target, [
            'userId',
          ]);
          expect(single).toEqual(
            format === 'absent' ? null : { userId: 'alice' },
          );
        },
      );

      it('binds identity first so the owner is read from the record head', async () => {
        const { saveConversationForUser } = await import(
          '@/server/session/conversationStore'
        );
        const { readConversationOwner } = await import(
          '@/server/session/redisShared'
        );
        const id = `${prefix}-owned`;
        key('conversation', id);
        key('user', prefix, 'conversations');
        await saveConversationForUser(
          prefix,
          id,
          () => ({
            name: 'Owned',
            messages: history,
            ownerId: 'spoofed',
            id: 'spoofed-id',
          }),
          true,
        );
        const raw = await client.get(redis.sessionKey(['conversation', id]));
        expect(raw!.startsWith(`{"id":"${id}","ownerId":"${prefix}",`)).toBe(
          true,
        );
        const { recordRedisLayers } = await import(
          '../../fixtures/redisLayers'
        );
        // The first read may send the script body once; later reads send its
        // digest only.
        await readConversationOwner(client, prefix, id);
        const recorder = recordRedisLayers(client);
        try {
          await expect(
            readConversationOwner(client, prefix, id),
          ).resolves.toEqual({ member: true, ownerId: prefix });
        } finally {
          recorder.stop();
        }
        // One round trip; the reply is the owner, not the history.
        expect(
          recorder.steady().map((command) => [command.name, command.tag]),
        ).toEqual([['EVALSHA', 'READ_CONVERSATION_OWNER']]);
        expect(recorder.steady()[0].replyBytes).toBeLessThan(200);
        await expect(
          readConversationOwner(client, 'someone-else', id),
        ).resolves.toEqual({ member: false, ownerId: null });
      });

      it.each(['legacy order', 'json', 'missing'])(
        'reads the owner of a %s conversation record',
        async (format) => {
          const { readConversationOwner } = await import(
            '@/server/session/redisShared'
          );
          const id = `${prefix}-${format.replace(' ', '-')}`;
          const target = key('conversation', id);
          await client.sadd(key('user', prefix, 'conversations'), id);
          // Older saves appended the identity after the history.
          const record = {
            name: 'Legacy',
            messages: history,
            id,
            ownerId: 'bob',
          };
          if (format === 'legacy order')
            await client.set(target, JSON.stringify(record));
          if (format === 'json')
            await client.call('JSON.SET', target, '$', JSON.stringify(record));
          await expect(
            readConversationOwner(client, prefix, id),
          ).resolves.toEqual({
            member: true,
            ownerId: format === 'missing' ? null : 'bob',
          });
        },
      );
    });
  },
);
