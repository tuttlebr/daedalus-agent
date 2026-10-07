// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(process.env.RUN_REDIS_STREAM_INTEGRATION !== '1')(
  'durable conversation history with real Redis',
  () => {
    let redis: typeof import('@/server/session/redis');
    let history: typeof import('@/server/session/conversationHistory');
    let store: typeof import('@/server/session/conversationStore');
    let deletion: typeof import('@/server/session/conversationDeletion');
    let client: ReturnType<typeof redis.getRedis>;
    const keys = new Set<string>();
    const key = (...parts: string[]) => {
      const value = redis.sessionKey(parts);
      keys.add(value);
      return value;
    };
    const fixture = () => {
      const user = `history-${randomUUID()}`;
      return {
        user,
        membership: key('user', user, 'conversations'),
        history: key('user', user, 'conversationHistory'),
        selected: key('user', user, 'selectedConversation'),
      };
    };
    const conversation = (id = randomUUID(), count = 1, updatedAt = 1) => ({
      id,
      name: 'Saved conversation',
      folderId: null,
      updatedAt,
      messages: Array.from({ length: count }, (_, index) => ({
        role: 'user' as const,
        content: `Message ${index}`,
        intermediateSteps: [],
      })),
    });

    beforeAll(async () => {
      if (!process.env.REDIS_URL) throw new Error('Disposable Redis required');
      redis = await import('@/server/session/redis');
      history = await import('@/server/session/conversationHistory');
      store = await import('@/server/session/conversationStore');
      deletion = await import('@/server/session/conversationDeletion');
      client = redis.getRedis();
      await client.ping();
    });
    afterAll(async () => {
      if (client) {
        if (keys.size) await client.del(...keys);
        client.disconnect();
      }
    });

    async function seed(k: string, value: unknown, json: boolean) {
      if (json) await client.call('JSON.SET', k, '$', JSON.stringify(value));
      else await client.set(k, JSON.stringify(value));
      await client.expire(k, 120);
    }

    for (const json of [false, true]) {
      describe(json ? 'RedisJSON' : 'plain JSON strings', () => {
        it('recovers an unlisted complete conversation and removes old expiries without rewriting history', async () => {
          const f = fixture();
          const hidden = {
            ...conversation(randomUUID(), 130),
            ownerId: f.user,
          };
          const legacy = conversation();
          const ck = key('conversation', hidden.id);
          await seed(ck, hidden, json);
          await seed(f.history, [legacy], json);
          await client.sadd(f.membership, hidden.id, 'expired-id');
          const before = await client.dump(f.history);

          const result = await history.listConversationHistoryForUser(f.user);

          expect(result).toEqual([legacy, hidden]);
          expect(await client.ttl(ck)).toBe(-1);
          expect(await client.ttl(f.history)).toBe(-1);
          expect(await client.dump(f.history)).toBe(before);
        });

        it('keeps full messages and every entry beyond the old 50-conversation limit', async () => {
          const f = fixture();
          const legacy = Array.from({ length: 55 }, () => conversation());
          await seed(f.history, legacy, json);
          const complete = conversation(randomUUID(), 130, 10);
          await history.mergeConversationHistoryForUser(f.user, [complete]);
          await history.mergeConversationHistoryForUser(f.user, [
            { ...complete, updatedAt: 9, messages: [] },
          ]);
          const result = await history.listConversationHistoryForUser(f.user);
          expect(result).toHaveLength(56);
          expect(result.find((c) => c.id === complete.id)).toEqual(complete);
          expect(await client.ttl(f.history)).toBe(-1);
        });

        it('prefers the newest complete record over a truncated or duplicate history copy', async () => {
          const f = fixture();
          const full = conversation(randomUUID(), 130, 10);
          const short = { ...full, messages: full.messages.slice(-100) };
          await seed(f.history, [short, { ...short, updatedAt: 1 }], json);
          await seed(key('conversation', full.id), full, json);
          await client.sadd(f.membership, full.id);
          expect(await history.listConversationHistoryForUser(f.user)).toEqual([
            full,
          ]);
        });

        it('does not expose another owner through stale membership or a caller-supplied history id', async () => {
          const f = fixture();
          const other = { ...conversation(), ownerId: 'different-user' };
          const ck = key('conversation', other.id);
          await seed(ck, other, json);
          const copy = { ...conversation(other.id, 0), name: 'Client copy' };
          await seed(f.history, [copy], json);
          await client.sadd(f.membership, other.id);
          expect(await history.listConversationHistoryForUser(f.user)).toEqual([
            copy,
          ]);
          expect(await client.ttl(ck)).toBeGreaterThan(0);
        });

        it('preserves concurrent imports and independent conversation saves', async () => {
          const f = fixture();
          await seed(f.history, [], json);
          const incoming = Array.from({ length: 16 }, () => conversation());
          const saved = Array.from({ length: 16 }, () => conversation());
          saved.forEach((c) => key('conversation', c.id));
          await Promise.all([
            ...incoming.map((c) =>
              history.mergeConversationHistoryForUser(f.user, [c]),
            ),
            ...saved.map((c) =>
              store.saveConversationForUser(f.user, c.id, () => c, true),
            ),
          ]);
          const result = await history.listConversationHistoryForUser(f.user);
          expect(new Set(result.map((c) => c.id))).toEqual(
            new Set([...incoming, ...saved].map((c) => c.id)),
          );
          for (const c of saved)
            expect(await client.ttl(key('conversation', c.id))).toBe(-1);
        });

        it('keeps explicit deletion effective after recovery and concurrent reads', async () => {
          const f = fixture();
          const c = conversation();
          const ck = key('conversation', c.id);
          await seed(ck, { ...c, ownerId: f.user }, json);
          await client.sadd(f.membership, c.id);
          await history.listConversationHistoryForUser(f.user);
          await Promise.all([
            history.listConversationHistoryForUser(f.user),
            deletion.deleteConversationForUser(f.user, c.id),
          ]);
          expect(await history.listConversationHistoryForUser(f.user)).toEqual(
            [],
          );
          expect(await client.exists(ck)).toBe(0);
        });

        it('fails closed on malformed history instead of overwriting it', async () => {
          const f = fixture();
          await seed(f.history, { unexpected: true }, json);
          await expect(
            history.listConversationHistoryForUser(f.user),
          ).rejects.toThrow('Invalid conversation history');
          await expect(
            history.mergeConversationHistoryForUser(f.user, []),
          ).rejects.toThrow('Invalid conversation history');
          expect(await redis.jsonGet(f.history)).toEqual({ unexpected: true });
        });

        it('makes both new and previously expiring conversation writes durable', async () => {
          const f = fixture();
          const c = conversation();
          const ck = key('conversation', c.id);
          await seed(ck, c, json);
          await client.sadd(f.membership, c.id);
          await store.saveConversationForUser(f.user, c.id, (current) => ({
            ...current,
            name: 'Renamed',
          }));
          expect(await client.ttl(ck)).toBe(-1);
          expect(
            (await store.readConversationForUser(f.user, c.id))?.messages,
          ).toEqual(c.messages);
        });
      });
    }
  },
);
