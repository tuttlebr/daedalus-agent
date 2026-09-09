// @vitest-environment node
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const session = vi.hoisted(() => ({ username: '' }));
vi.mock('@/utils/auth/session', () => ({
  getSession: async () => ({ username: session.username }),
}));
vi.mock('@/pages/api/session/imageStorage', () => ({ touchImage: vi.fn() }));

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'conversation deletion in real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let handler: typeof import('@/pages/api/conversations/[id]').default;
    let client: ReturnType<typeof redis.getRedis>;
    const keys = new Set<string>();
    let serial = 0;

    beforeAll(async () => {
      if (!process.env.REDIS_URL)
        throw new Error('Disposable REDIS_URL required');
      redis = await import('@/server/session/redis');
      handler = (await import('@/pages/api/conversations/[id]')).default;
      client = redis.getRedis();
      await client.ping();
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      if (client) {
        if (keys.size) await client.del(...keys);
        client.disconnect();
      }
    });

    function fixture() {
      const prefix = `delete-regression-${
        process.pid
      }-${Date.now()}-${serial++}`;
      session.username = `${prefix}-user`;
      const id = `${prefix}-conversation`;
      const result = {
        id,
        conversation: redis.sessionKey(['conversation', id]),
        membership: redis.sessionKey([
          'user',
          session.username,
          'conversations',
        ]),
        history: redis.sessionKey([
          'user',
          session.username,
          'conversationHistory',
        ]),
        selected: redis.sessionKey([
          'user',
          session.username,
          'selectedConversation',
        ]),
      };
      for (const key of Object.values(result)) keys.add(key);
      return result;
    }

    async function seed(key: string, value: unknown, json: boolean) {
      keys.add(key);
      if (json) await client.call('JSON.SET', key, '$', JSON.stringify(value));
      else await client.set(key, JSON.stringify(value));
      await client.expire(key, 120);
    }

    async function remove(id: string) {
      const req = { method: 'DELETE', query: { id } } as any;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as any;
      await handler(req, res);
      return res;
    }

    for (const json of [false, true]) {
      describe(json ? 'RedisJSON documents' : 'legacy string documents', () => {
        it('deletes a history-only conversation without requiring an ownership entry', async () => {
          const f = fixture();
          const survivor = {
            id: `${f.id}-keep`,
            messages: [],
            metadata: { empty: {}, n: 9007199254740991 },
          };
          await seed(
            f.history,
            [{ id: f.id, messages: [] }, survivor, { id: f.id }],
            json,
          );
          await seed(f.selected, survivor, json);
          const selectedBefore = await client.dump(f.selected);
          const expiryBefore = await client.pexpiretime(f.history);

          const res = await remove(f.id);

          expect(res.status).toHaveBeenCalledWith(200);
          expect(await redis.jsonGet(f.history)).toEqual([survivor]);
          expect(await client.pexpiretime(f.history)).toBe(expiryBefore);
          expect(await client.dump(f.selected)).toBe(selectedBefore);
          expect(await client.exists(f.conversation, f.membership)).toBe(0);
        });

        it('removes an owned conversation and its selected snapshot, retaining other history', async () => {
          const f = fixture();
          const target = { id: f.id, messages: [] };
          const survivor = { id: `${f.id}-keep`, messages: [] };
          await seed(f.conversation, target, json);
          await seed(f.history, [target, survivor], json);
          await seed(f.selected, target, json);
          await client.sadd(f.membership, f.id, survivor.id);

          const res = await remove(f.id);

          expect(res.status).toHaveBeenCalledWith(200);
          expect(await client.exists(f.conversation, f.selected)).toBe(0);
          expect(await client.smembers(f.membership)).toEqual([survivor.id]);
          expect(await redis.jsonGet(f.history)).toEqual([survivor]);
        });

        it('does not grant ownership from a caller-supplied history entry', async () => {
          const f = fixture();
          const victim = { id: f.id, messages: [{ content: 'Private' }] };
          const victimMembership = `${f.membership}-victim`;
          keys.add(victimMembership);
          await client.sadd(victimMembership, f.id);
          await seed(f.conversation, victim, json);
          await seed(f.history, [{ id: f.id }], json);
          await seed(f.selected, { id: f.id }, json);
          const victimBefore = await client.dump(f.conversation);

          const res = await remove(f.id);

          expect(res.status).toHaveBeenCalledWith(200);
          expect(await redis.jsonGet(f.history)).toEqual([]);
          expect(await client.exists(f.selected)).toBe(0);
          expect(await client.dump(f.conversation)).toBe(victimBefore);
          expect(await client.sismember(victimMembership, f.id)).toBe(1);
          expect(await client.exists(f.membership)).toBe(0);
        });

        it('rejects an unrelated conversation without touching its data', async () => {
          const f = fixture();
          await seed(f.conversation, { id: f.id }, json);
          const before = await client.dump(f.conversation);
          const res = await remove(f.id);
          expect(res.status).toHaveBeenCalledWith(403);
          expect(await client.dump(f.conversation)).toBe(before);
          expect(await client.exists(f.history, f.selected, f.membership)).toBe(
            0,
          );
        });

        it('removes a selected-only copy without touching a shared conversation', async () => {
          const f = fixture();
          await seed(f.selected, { id: f.id }, json);
          await seed(f.conversation, { id: f.id, messages: [] }, json);
          const before = await client.dump(f.conversation);
          const res = await remove(f.id);
          expect(res.status).toHaveBeenCalledWith(200);
          expect(await client.exists(f.selected, f.history, f.membership)).toBe(
            0,
          );
          expect(await client.dump(f.conversation)).toBe(before);
        });

        it('recomputes removal after a concurrent history save and selection change', async () => {
          const f = fixture();
          const target = { id: f.id };
          const added = { id: `${f.id}-new`, messages: [] };
          await seed(f.history, [target], json);
          await seed(f.selected, target, json);
          const evaluate = client.eval.bind(client);
          let raced = false;
          vi.spyOn(client, 'eval').mockImplementation(
            async (...args: any[]) => {
              if (
                !raced &&
                String(args[0]).includes('-- APPLY_CONVERSATION_DELETION')
              ) {
                raced = true;
                await seed(f.history, [target, added], json);
                await seed(f.selected, added, json);
              }
              return evaluate(...(args as [string, number, ...any[]]));
            },
          );
          const res = await remove(f.id);
          expect(raced).toBe(true);
          expect(res.status).toHaveBeenCalledWith(200);
          expect(await redis.jsonGet(f.history)).toEqual([added]);
          expect(await redis.jsonGet(f.selected)).toEqual(added);
        });

        it('rechecks ownership before deleting a shared conversation', async () => {
          const f = fixture();
          await seed(f.history, [{ id: f.id }], json);
          await seed(f.conversation, { id: f.id }, json);
          await client.sadd(f.membership, f.id);
          const before = await client.dump(f.conversation);
          const evaluate = client.eval.bind(client);
          let raced = false;
          vi.spyOn(client, 'eval').mockImplementation(
            async (...args: any[]) => {
              if (
                !raced &&
                String(args[0]).includes('-- APPLY_CONVERSATION_DELETION')
              ) {
                raced = true;
                await client.srem(f.membership, f.id);
              }
              return evaluate(...(args as [string, number, ...any[]]));
            },
          );
          const res = await remove(f.id);
          expect(raced).toBe(true);
          expect(res.status).toHaveBeenCalledWith(200);
          expect(await redis.jsonGet(f.history)).toEqual([]);
          expect(await client.dump(f.conversation)).toBe(before);
        });

        it('preserves every deletion when clear-all sends concurrent requests', async () => {
          const f = fixture();
          const targets = Array.from({ length: 32 }, (_, index) => ({
            id: `${f.id}-${index}`,
          }));
          const survivor = { id: `${f.id}-keep`, messages: [] };
          await seed(f.history, [...targets, survivor], json);
          const results = await Promise.all(
            targets.map((target) => remove(target.id)),
          );
          for (const result of results)
            expect(result.status).toHaveBeenCalledWith(200);
          expect(await redis.jsonGet(f.history)).toEqual([survivor]);
        });

        it('retains all data and reports failure when history cannot be updated', async () => {
          const f = fixture();
          await seed(f.history, [{ id: f.id }], json);
          await seed(f.conversation, { id: f.id }, json);
          await seed(f.selected, { id: f.id }, json);
          await client.sadd(f.membership, f.id);
          const before = await Promise.all(
            [f.history, f.conversation, f.selected, f.membership].map((key) =>
              client.dump(key),
            ),
          );
          const evaluate = client.eval.bind(client);
          vi.spyOn(client, 'eval').mockImplementation(
            async (...args: any[]) => {
              if (String(args[0]).includes('-- APPLY_CONVERSATION_DELETION'))
                throw new Error('Redis unavailable before write');
              return evaluate(...(args as [string, number, ...any[]]));
            },
          );
          vi.spyOn(console, 'error').mockImplementation(() => {});
          const res = await remove(f.id);
          expect(res.status).toHaveBeenCalledWith(500);
          expect(
            await Promise.all(
              [f.history, f.conversation, f.selected, f.membership].map((key) =>
                client.dump(key),
              ),
            ),
          ).toEqual(before);
        });
      });
    }

    it.each(['invalid-json', 'wrong-type', 'non-array-json'])(
      'does not delete owned data when history is %s',
      async (kind) => {
        const f = fixture();
        await seed(f.conversation, { id: f.id }, false);
        await client.sadd(f.membership, f.id);
        if (kind === 'wrong-type') await client.sadd(f.history, 'unexpected');
        else
          await client.set(
            f.history,
            kind === 'invalid-json' ? '{broken' : '{}',
          );
        const before = await client.dump(f.history);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await remove(f.id);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(await client.exists(f.conversation)).toBe(1);
        expect(await client.sismember(f.membership, f.id)).toBe(1);
        expect(await client.dump(f.history)).toBe(before);
      },
    );
  },
);
